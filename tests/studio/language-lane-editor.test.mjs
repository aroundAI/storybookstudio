// FILM-2019 AC3 in the editor: studio_apply_language_lane (the renderer
// action studio_create_variant {kind: language} calls when a window is open)
// puts the Hindi lane on the open master as one undo step, adds the dub files
// to the library with playable URLs, and a save keeps it. The app's own
// stores, through Vite's SSR loader and a node:fs desktop bridge, as in
// rough-cut-opens.test.mjs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

import { buildLanguageLane } from '../../src/studio/localization/lanes.js'
import { loadFixture, probesFor } from './helpers/rough-cut.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const editsFiles = require('../../electron/studio/editsFiles.js')
const noop = () => {}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'language-lane-editor-'))

const studioEdits = (() => {
  const handlers = new Map()
  editsFiles.registerStudioEditsHandlers({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } })
  const call = (channel) => (...args) => handlers.get(channel)({}, ...args)
  return { append: call('studioEdits:append'), read: call('studioEdits:read'), write: call('studioEdits:write'), sync: call('studioEdits:sync') }
})()
globalThis.window ??= { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) }
globalThis.window.electronAPI = {
  isElectron: true,
  exists: async (target) => fs.existsSync(target),
  isDirectory: async (target) => fs.existsSync(target) && fs.statSync(target).isDirectory(),
  pathJoin: async (...parts) => path.join(...parts),
  pathDirname: async (target) => path.dirname(target),
  pathBasename: async (target) => path.basename(target),
  createDirectory: async (target) => { fs.mkdirSync(target, { recursive: true }); return { success: true } },
  readFile: async (target, options = {}) => ({ success: true, data: fs.readFileSync(target, options.encoding || null) }),
  writeFile: async (target, data) => { fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); return { success: true } },
  listDirectory: async (target) => ({ success: true, items: fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({ name: entry.name, path: path.join(target, entry.name), isFile: entry.isFile(), isDirectory: entry.isDirectory(), modified: new Date().toISOString() })) }),
  deleteFile: async (target) => { fs.rmSync(target, { force: true }); return { success: true } },
  setSetting: async () => ({ success: true }),
  getSetting: async () => null,
  getFileUrlDirect: async (target) => `storybookstudio-file://${target}`,
  studioEdits,
}
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: noop, removeItem: noop }, configurable: true, writable: true })

let server
let app
before(async () => {
  server = await createServer({ root, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } })
  const load = (file) => server.ssrLoadModule(file)
  app = {
    projectStore: (await load('/src/stores/projectStore.js')).useProjectStore,
    timelineStore: (await load('/src/stores/timelineStore.js')).useTimelineStore,
    assetsStore: (await load('/src/stores/assetsStore.js')).useAssetsStore,
    runtime: await load('/src/studio/editLogRuntime.js'),
    actions: await load('/src/studio/delivery/rendererActions.js'),
  }
})
after(async () => {
  await app?.runtime.stopStudioEditLog()
  await server?.close()
  fs.rmSync(scratch, { recursive: true, force: true })
})

const quietly = async (fn) => {
  const error = console.error
  const warn = console.warn
  console.error = noop
  console.warn = noop
  try { return await fn() } finally { console.error = error; console.warn = warn }
}

test('the Hindi lane lands on the open master as one undo step, its dubs in the library, and survives a save', async () => {
  const pkg = loadFixture(60)
  const english = { ...pkg, dubbed: [], captions: pkg.captions.filter((entry) => entry.language === 'en'), episode: { ...pkg.episode, languages: ['en'] } }
  const projectPath = path.join(scratch, 'episode')
  await quietly(() => app.runtime.openStudioProjectFromPackage(english, probesFor(english), { projectPath }))
  const opened = app.projectStore.getState().currentProject
  const before = { tracks: app.timelineStore.getState().tracks.map((track) => track.id), clips: app.timelineStore.getState().clips.length, assets: app.assetsStore.getState().assets.length }

  const lane = buildLanguageLane({ document: opened, pkg, language: 'hi', probes: probesFor(pkg) })
  const preview = await app.actions.applyStudioLanguageLane({ lane })
  assert.equal(preview.previewOnly, true)
  assert.equal(app.timelineStore.getState().clips.length, before.clips, 'a preview changes nothing')

  const applied = await quietly(() => app.actions.applyStudioLanguageLane({ lane, previewOnly: false }))
  assert.equal(applied.applied, true)
  const state = app.timelineStore.getState()
  assert.deepEqual(state.tracks.filter((track) => track.language === 'hi').map((track) => [track.name, track.muted, track.visible]), [['Captions (hi)', false, false], ['Dialogue (hi)', true, true]])
  assert.equal(state.clips.length, before.clips + 121)
  assert.equal(new Set(state.clips.map((clip) => clip.id)).size, state.clips.length)
  const library = app.assetsStore.getState().assets
  const dubs = library.filter((asset) => asset.language === 'hi')
  assert.equal(dubs.length, 120)
  assert.ok(dubs.filter((asset) => !asset.offline).every((asset) => asset.url?.startsWith('storybookstudio-file://')), 'downloaded dubs play')

  // One undo takes the whole lane off.
  state.undo()
  assert.equal(app.timelineStore.getState().clips.length, before.clips)
  assert.deepEqual(app.timelineStore.getState().tracks.map((track) => track.id), before.tracks)
  app.timelineStore.getState().redo()
  assert.equal(app.timelineStore.getState().clips.length, before.clips + 121)

  const saved = await quietly(() => app.projectStore.getState().saveProject())
  assert.equal(saved, true)
  const onDisk = JSON.parse(fs.readFileSync(path.join(projectPath, 'project.storybookstudio'), 'utf8'))
  const master = onDisk.timelines.find((timeline) => timeline.id === lane.timelineId)
  assert.equal(master.clips.filter((clip) => clip.metadata?.language === 'hi').length, 121)
  assert.equal(onDisk.assets.filter((asset) => asset.language === 'hi').length, 120)
  assert.equal(onDisk.assets.length, before.assets + 120)
})
