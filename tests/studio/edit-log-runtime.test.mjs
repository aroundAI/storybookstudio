// The op log and versions wired into Velorn's real stores and MCP handlers.
// The stores use extension-less imports, so they load through Vite's SSR
// loader; the edits bridge is electron/studio/editsFiles.js over a temp dir.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createServer } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const editsFiles = require('../../electron/studio/editsFiles.js')
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

const noop = () => {}
globalThis.window ??= { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) }
// Node 25 defines a localStorage global that throws without --localstorage-file.
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: noop, removeItem: noop }, configurable: true, writable: true })

let server
let m
let dir
let timers

const bridge = () => {
  const handlers = new Map()
  editsFiles.registerStudioEditsHandlers({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } })
  const call = (channel) => (...args) => handlers.get(channel)({}, ...args)
  return { append: call('studioEdits:append'), read: call('studioEdits:read'), write: call('studioEdits:write'), sync: call('studioEdits:sync') }
}

const manualTimers = () => {
  let pending = null
  return { setTimeout: (fn) => { pending = fn; return 1 }, clearTimeout: () => { pending = null }, fire: () => { const fn = pending; pending = null; fn?.() } }
}

const readLog = async () => {
  const text = await editsFiles.readText(dir, 'edits/oplog.jsonl')
  return (text || '').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

const openProject = async (project) => {
  const { projectData, currentTimelineId, currentTimeline } = m.projectStore.normalizeOpenedProjectData(project)
  m.timelineStore.useTimelineStore.getState().loadFromProject(currentTimeline, projectData.assets, 24)
  m.assetsStore.useAssetsStore.setState({ assets: projectData.assets, folders: [] })
  m.projectStore.useProjectStore.setState({ currentProject: projectData, currentTimelineId, currentProjectHandle: dir })
  timers = manualTimers()
  return m.runtime.startStudioEditLog({ projectPath: dir, projectStore: m.projectStore.useProjectStore, api: bridge(), timers })
}

const clipIds = () => m.timelineStore.useTimelineStore.getState().clips.map((clip) => clip.id).sort()

before(async () => {
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  const load = (file) => server.ssrLoadModule(file)
  m = {
    timelineStore: await load('/src/stores/timelineStore.js'),
    assetsStore: await load('/src/stores/assetsStore.js'),
    projectStore: await load('/src/stores/projectStore.js'),
    runtime: await load('/src/studio/editLogRuntime.js'),
    mcp: await load('/src/services/mcpActions.js'),
    oplog: await load('/src/studio/oplog.js'),
  }
})

after(async () => {
  await m?.runtime.stopStudioEditLog()
  await server?.close()
})

beforeEach(async () => {
  await m.runtime.stopStudioEditLog()
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = await mkdtemp(path.join(os.tmpdir(), 'studio-runtime-'))
})

test('normalizeOpenedProjectData accepts 1.0, 1.1 and 1.2 and keeps stock projects loading', () => {
  const { normalizeOpenedProjectData } = m.projectStore
  const legacy = normalizeOpenedProjectData(fixture('velorn-legacy-1.0-project.json'))
  assert.equal(legacy.projectData.version, '1.0')
  assert.equal(legacy.projectData.timelines.length, 1)
  assert.equal(legacy.currentTimelineId, 'timeline-1')

  const stock = fixture('velorn-sample-project.json')
  for (const version of ['1.0', '1.1']) {
    const opened = normalizeOpenedProjectData({ ...stock, version })
    assert.equal(opened.projectData.version, version)
    assert.deepEqual(opened.projectData.timelines, stock.timelines)
    assert.deepEqual(opened.projectData.assets, stock.assets)
  }
  const studio = normalizeOpenedProjectData({ ...stock, version: '1.2', studio: { schema: 'editgraph/1' } })
  assert.equal(studio.projectData.version, '1.2')
  const savedByStockVelorn = normalizeOpenedProjectData({ ...stock, version: '1.0', studio: { schema: 'editgraph/1', episodeId: 'e' } })
  assert.equal(savedByStockVelorn.projectData.version, '1.2')
  assert.equal(savedByStockVelorn.projectData.studio.episodeId, 'e')

  const warnings = []
  const warn = console.warn
  console.warn = (message) => warnings.push(message)
  try {
    assert.equal(normalizeOpenedProjectData({ ...stock, version: '2.0' }).projectData.version, '2.0')
  } finally {
    console.warn = warn
  }
  assert.match(warnings[0], /Project format 2\.0 is newer/)
})

test('every logged hand-edit mutator exists in the real stores', () => {
  const timeline = m.timelineStore.useTimelineStore.getState()
  const assets = m.assetsStore.useAssetsStore.getState()
  assert.deepEqual(m.runtime.TIMELINE_HAND_EDIT_MUTATORS.filter((name) => typeof timeline[name] !== 'function'), [])
  assert.deepEqual(m.runtime.ASSET_HAND_EDIT_MUTATORS.filter((name) => typeof assets[name] !== 'function'), [])
})

test('a hand edit in the real timeline store is logged by: user, with a working inverse', async () => {
  await openProject(fixture('velorn-sample-project.json'))
  const active = m.runtime.getStudioEditLog()
  const before = active.getDocument()
  m.timelineStore.useTimelineStore.getState().removeClip('clip-3')
  timers.fire()
  await active.oplog.idle()
  const log = await readLog()
  assert.deepEqual(log.map((e) => [e.op, e.by, e.tool]), [[1, 'user', 'removeClip']])
  assert.equal(JSON.stringify(m.oplog.applyInverse(active.getDocument(), log[0].inverse).timelines[0].clips), JSON.stringify(before.timelines[0].clips))
})

test('a real MCP write: preview appends nothing, apply appends one ai line, the mutators it calls are not logged again', async () => {
  await openProject(fixture('velorn-sample-project.json'))
  const { runMcpAction } = m.mcp

  const preview = await runMcpAction('delete_clips', { clipIds: ['clip-1'] })
  assert.equal(preview.previewOnly, true)
  await runMcpAction('add_timeline_markers', { markers: [{ time: 1, label: 'Hook' }], previewOnly: true, studioMeta: { reason: 'x' } })
  // add_timeline_markers has no renderer preview branch (Velorn previews in the
  // main process), so the renderer only sees applied calls of it; a previewOnly
  // flag still keeps it out of the log.
  assert.deepEqual(await readLog(), [])

  await runMcpAction('delete_clips', { clipIds: ['clip-1'], previewOnly: false, studioMeta: { reason: 'Duplicate establishing shot', scene: 1 } })
  timers.fire()
  await m.runtime.getStudioEditLog().oplog.idle()
  const log = await readLog()
  assert.deepEqual(log.map((e) => [e.by, e.tool, e.reason, e.scene]), [['ai', 'delete_clips', 'Duplicate establishing shot', 1]])
  assert.deepEqual(log[0].args, { clipIds: ['clip-1'], previewOnly: false })
  assert.equal(clipIds().includes('clip-1'), false)
})

test('versions on the real stores: snapshot, hand edit, restore (document equals the snapshot), restart', async () => {
  const project = fixture('velorn-sample-project.json')
  project.studio = { schema: 'editgraph/1', episodeId: 'ep-1', currentVersion: null }
  await openProject(project)
  const v1 = await m.runtime.createStudioVersion('Rough cut', { by: 'ai' })
  assert.equal(m.projectStore.useProjectStore.getState().currentProject.studio.currentVersion, 'v1')
  const snapshot = JSON.parse(await readFile(path.join(dir, v1.snapshotPath), 'utf8'))

  m.timelineStore.useTimelineStore.getState().removeClip('clip-2')
  await m.runtime.restoreStudioVersion('v1', { reason: 'Back to the rough cut' })
  timers.fire()
  await m.runtime.getStudioEditLog().oplog.idle()

  assert.deepEqual(clipIds(), snapshot.timelines[0].clips.map((c) => c.id).sort())
  const restored = m.runtime.timelineDocument(m.projectStore.useProjectStore.getState())
  assert.deepEqual(restored.timelines[0].clips.map((c) => [c.id, c.startTime, c.duration]), snapshot.timelines[0].clips.map((c) => [c.id, c.startTime, c.duration]))
  assert.deepEqual((await readLog()).map((e) => [e.op, e.by, e.tool]), [
    [1, 'ai', 'studio_create_version'],
    [2, 'user', 'removeClip'],
    [3, 'user', 'studio_restore_version'],
  ])

  await m.runtime.stopStudioEditLog()
  await m.runtime.startStudioEditLog({ projectPath: dir, projectStore: m.projectStore.useProjectStore, api: bridge(), timers: manualTimers() })
  const reopened = m.runtime.getStudioEditLog()
  assert.deepEqual(reopened.versions.list().map((v) => v.id), ['v1'])
  assert.equal(reopened.oplog.lastOpId(), 3)
})

test('after close, nothing is logged', async () => {
  await openProject(fixture('velorn-sample-project.json'))
  await m.runtime.stopStudioEditLog()
  m.timelineStore.useTimelineStore.getState().removeClip('clip-3')
  await m.mcp.runMcpAction('delete_clips', { clipIds: ['clip-1'], previewOnly: false, studioMeta: { reason: 'x' } })
  assert.deepEqual(await readLog(), [])
})
