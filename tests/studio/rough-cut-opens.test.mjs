// FILM-2012 AC4: a built rough cut opens in this app and in stock Velorn
// v0.3.36 without error.
//
// Both sides run the real code paths over a real project folder, through a
// desktop file bridge backed by node:fs in place of Electron's IPC:
// - this app: openStudioProjectFromPackage (the studio:buildProject entry
//   FILM-2011's pull job calls) writes the folder, opens it with
//   projectStore.openProject and saves the 'Rough cut' version;
// - stock Velorn: upstream's src/ and electron/ at fdd8255 (v0.3.36, where
//   the fork branched), extracted with `git archive`, open the same folder
//   with its own projectStore.openProject and save it with saveProject; this
//   app then reopens what stock Velorn saved.
// Stores load through Vite's SSR loader (extension-less imports), as in
// edit-log-runtime.test.mjs. CI fetches the stock commit; the stock tests
// skip only where git cannot produce it.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createServer } from 'vite'

import { buildProject } from '../../src/studio/projectBuilder.js'
import { createElectronProjectFs, writeRoughCutProject } from '../../src/studio/openFromPackage.js'
import { FIXTURE_SIZES, loadFixture, probesFor } from './helpers/rough-cut.mjs'

export const STOCK_VELORN_COMMIT = 'fdd8255fb717db024688a2582022aa048dd16e84'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const editsFiles = require('../../electron/studio/editsFiles.js')
const noop = () => {}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rough-cut-'))

// Electron's preload API, the calls opening and saving a project make.
const studioEdits = (() => {
  const handlers = new Map()
  editsFiles.registerStudioEditsHandlers({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } })
  const call = (channel) => (...args) => handlers.get(channel)({}, ...args)
  return { append: call('studioEdits:append'), read: call('studioEdits:read'), write: call('studioEdits:write'), sync: call('studioEdits:sync') }
})()
const bridge = {
  isElectron: true,
  exists: async (target) => fs.existsSync(target),
  isDirectory: async (target) => fs.existsSync(target) && fs.statSync(target).isDirectory(),
  pathJoin: async (...parts) => path.join(...parts),
  pathDirname: async (target) => path.dirname(target),
  pathBasename: async (target) => path.basename(target),
  createDirectory: async (target) => { fs.mkdirSync(target, { recursive: true }); return { success: true } },
  readFile: async (target, options = {}) => ({ success: true, data: fs.readFileSync(target, options.encoding || null) }),
  writeFile: async (target, data) => { fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); return { success: true } },
  listDirectory: async (target) => ({
    success: true,
    items: fs.readdirSync(target, { withFileTypes: true }).map((entry) => {
      const full = path.join(target, entry.name)
      return { name: entry.name, path: full, isFile: entry.isFile(), isDirectory: entry.isDirectory(), modified: fs.statSync(full).mtime.toISOString() }
    }),
  }),
  deleteFile: async (target) => { fs.rmSync(target, { force: true }); return { success: true } },
  setSetting: async () => ({ success: true }),
  getSetting: async () => null,
  getFileUrlDirect: async (target) => `comfystudio://${target}`,
  studioEdits,
}

globalThis.window ??= { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) }
globalThis.window.electronAPI = bridge
// Node 25 defines a localStorage global that throws without --localstorage-file.
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: noop, removeItem: noop }, configurable: true, writable: true })

const stockAvailable = (() => {
  try {
    execFileSync('git', ['-C', root, 'cat-file', '-e', `${STOCK_VELORN_COMMIT}^{commit}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// src/ imports a few electron/*.mjs helpers, so both folders come along.
const extractStock = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-stock-'))
  const archive = execFileSync('git', ['-C', root, 'archive', STOCK_VELORN_COMMIT, 'src', 'electron', 'package.json'], { maxBuffer: 1 << 30 })
  execFileSync('tar', ['-x', '-C', dir], { input: archive })
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  return dir
}

const servers = []
const loadApp = async (appRoot, extra = {}) => {
  const server = await createServer({
    root: appRoot,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  servers.push(server)
  const load = (file) => server.ssrLoadModule(file)
  const app = {
    projectStore: await load('/src/stores/projectStore.js'),
    timelineStore: await load('/src/stores/timelineStore.js'),
    assetsStore: await load('/src/stores/assetsStore.js'),
  }
  for (const [name, file] of Object.entries(extra)) app[name] = await load(file)
  return app
}

let fork
let stock
let stockDir

before(async () => {
  fork = await loadApp(root, { runtime: '/src/studio/editLogRuntime.js' })
  if (stockAvailable) {
    stockDir = extractStock()
    stock = await loadApp(stockDir)
  }
})

after(async () => {
  await fork?.runtime.stopStudioEditLog()
  for (const server of servers) await server.close()
  if (stockDir) fs.rmSync(stockDir, { recursive: true, force: true })
  fs.rmSync(scratch, { recursive: true, force: true })
})

const inputs = (shots) => {
  const pkg = loadFixture(shots)
  return { pkg, probes: probesFor(pkg), project: buildProject({ package: pkg, probedAssets: probesFor(pkg) }).project }
}

// A failed open shows in Velorn as a console error and a store error.
const quietly = async (fn) => {
  const errors = []
  const error = console.error
  console.error = (...args) => errors.push(args.map(String).join(' '))
  try {
    return { result: await fn(), errors }
  } finally {
    console.error = error
  }
}

const timing = (clip) => [clip.id, clip.trackId, clip.type, clip.startTime, clip.duration, clip.trimStart, clip.trimEnd]

const assertLoaded = (app, project) => {
  const [expected] = project.timelines
  const state = app.timelineStore.useTimelineStore.getState()
  assert.equal(state.clips.length, expected.clips.length)
  assert.equal(state.tracks.length, expected.tracks.length)
  assert.equal(state.markers.length, expected.markers.length)
  assert.equal(state.timelineFps, expected.fps)
  // Built on frames and within each file, so loading moves nothing.
  const byId = new Map(state.clips.map((clip) => [clip.id, clip]))
  for (const clip of expected.clips) {
    const loaded = byId.get(clip.id)
    assert.ok(loaded, `clip ${clip.id} did not load`)
    assert.deepEqual(timing(loaded), timing(clip), `clip ${clip.id} moved on load`)
  }
  const library = app.assetsStore.useAssetsStore.getState()
  assert.equal(library.assets.length, project.assets.length)
  assert.equal(library.folders.length, project.folders.length)
  const offline = library.assets.filter((asset) => asset.offline)
  assert.ok(offline.length > 0 && offline.every((asset) => asset.url === null))
  assert.ok(library.assets.filter((asset) => !asset.offline).every((asset) => asset.url?.startsWith('comfystudio://')))
}

for (const shots of FIXTURE_SIZES) {
  test(`${shots}-shot package: studio:buildProject writes the folder, opens it in this app and saves the Rough cut version`, async () => {
    const { pkg, probes, project } = inputs(shots)
    const projectPath = path.join(scratch, `studio-${shots}`)
    const { result, errors } = await quietly(() => fork.runtime.openStudioProjectFromPackage(pkg, probes, { projectPath }))
    assert.deepEqual(errors, [])
    assert.deepEqual(result.written, ['storybook/package.json', 'storybook/link.json', 'storybook/brand.json', 'storybook/policy.json', 'project.comfystudio'])
    for (const file of result.written) assert.ok(fs.existsSync(path.join(projectPath, file)), file)
    assert.deepEqual(result.project, project)
    assert.ok(result.warnings.some((warning) => warning.code === 'media_offline'))

    const state = fork.projectStore.useProjectStore.getState()
    assert.equal(state.error, null)
    assert.equal(state.currentProjectHandle, projectPath)
    assert.equal(state.currentProject.version, '1.2')
    assert.equal(state.currentTimelineId, 'tl-master')
    assertLoaded(fork, project)

    assert.equal(result.version.name, 'Rough cut')
    assert.equal(result.version.createdBy, 'ai')
    assert.equal(state.currentProject.studio.currentVersion, result.version.id)
    const versions = JSON.parse(fs.readFileSync(path.join(projectPath, 'edits/versions.json'), 'utf8'))
    assert.deepEqual(versions.versions.map((version) => version.name), ['Rough cut'])
    assert.ok(fs.existsSync(path.join(projectPath, `edits/snapshots/${result.version.id}.json`)))
  })

  test(`${shots}-shot package: the rough cut opens in stock Velorn v0.3.36 without error, and its Studio fields survive a stock save`, { skip: stockAvailable ? false : `stock Velorn ${STOCK_VELORN_COMMIT.slice(0, 7)} is not in this clone (git fetch origin ${STOCK_VELORN_COMMIT})` }, async () => {
    const { pkg, probes, project } = inputs(shots)
    const projectPath = path.join(scratch, `stock-${shots}`)
    await writeRoughCutProject({ package: pkg, probedAssets: probes, projectPath, fs: createElectronProjectFs(bridge) })

    const stockStore = stock.projectStore.useProjectStore
    const { result: opened, errors } = await quietly(() => stockStore.getState().openProject(projectPath))
    assert.deepEqual(errors, [])
    assert.equal(stockStore.getState().error, null)
    assert.ok(opened, 'stock Velorn returned no project')
    assert.equal(stockStore.getState().currentTimelineId, 'tl-master')
    assertLoaded(stock, project)

    const { result: saved, errors: saveErrors } = await quietly(() => stockStore.getState().saveProject())
    assert.equal(saved, true)
    assert.deepEqual(saveErrors, [])
    const onDisk = JSON.parse(fs.readFileSync(path.join(projectPath, 'project.comfystudio'), 'utf8'))
    assert.equal(onDisk.version, '1.0') // stock Velorn stamps 1.0 on every save

    // Reopened here: still a 1.2 Studio project with every Studio field.
    const reopened = await quietly(() => fork.projectStore.useProjectStore.getState().openProject(projectPath))
    assert.deepEqual(reopened.errors, [])
    const current = fork.projectStore.useProjectStore.getState().currentProject
    assert.equal(current.version, '1.2')
    assert.deepEqual(current.studio, project.studio)
    const [timeline] = current.timelines
    assert.deepEqual(timeline.studio, project.timelines[0].studio)
    const trackFields = (tracks) => tracks.map((track) => [track.id, track.bus ?? null, track.language ?? null, track.role ?? null, track.muted, track.visible])
    assert.deepEqual(trackFields(timeline.tracks), trackFields(project.timelines[0].tracks))
    const metadataOf = (clips) => Object.fromEntries(clips.map((clip) => [clip.id, clip.metadata]))
    assert.deepEqual(metadataOf(timeline.clips), metadataOf(project.timelines[0].clips))
    assert.deepEqual(timeline.markers, project.timelines[0].markers)
    const studioFieldsOf = (assets) => assets.map(({ id, role, semantic, languageDependency, offline, storybook }) => ({ id, role, semantic, languageDependency, offline, storybook }))
    assert.deepEqual(studioFieldsOf(current.assets), studioFieldsOf(project.assets))
  })
}
