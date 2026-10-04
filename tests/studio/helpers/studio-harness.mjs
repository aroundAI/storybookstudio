// A headless StorybookStudio for the FILM-2013 integration tests: the real
// MCP server (electron/mcpServer.js) on a loopback port with a bearer, and
// in place of the window the real renderer code it talks to over mcp:action,
// loaded through Vite's SSR loader: the stores, runMcpAction (and with it the
// op log and versions of FILM-2012), the capability runtime and the snapshot
// builder. The project is the FILM-2012 rough cut of a FILM-2001 fixture
// package, written to a temp folder with its storybook/ files.
//
// Replaced, because Node has no window: the preload (an object that calls the
// same main-process handlers: editsFiles.js, fs:readFile, path:join) and
// get_audio_analysis, which decodes with Web Audio. The analysis stub reports
// no silence inside a dialogue clip unless a test passes one, so silence is
// what lies between the fixture's dialogue lines.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from 'vite'

import { buildProject } from '../../../src/studio/projectBuilder.js'
import { loadFixture, probesFor } from './rough-cut.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(import.meta.url)
const editsFiles = require('../../../electron/studio/editsFiles.js')
const { createComfyStudioMcpServer } = require('../../../electron/mcpServer.js')

const noop = () => {}

export const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

export const manualTimers = () => {
  let pending = null
  return { setTimeout: (fn) => { pending = fn; return 1 }, clearTimeout: () => { pending = null }, fire: () => { const fn = pending; pending = null; fn?.() } }
}

const editsBridge = () => {
  const handlers = new Map()
  editsFiles.registerStudioEditsHandlers({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } })
  const call = (channel) => (...args) => handlers.get(channel)({}, ...args)
  return { append: call('studioEdits:append'), read: call('studioEdits:read'), write: call('studioEdits:write'), sync: call('studioEdits:sync') }
}

export const silentLinesAnalysis = (silencesByClip = new Map()) => async (tool, args) => ({
  success: true,
  analysis: { silences: [], stub: 'headless harness: no Web Audio' },
  clip: { clipId: args.clipId, timelineMapping: 'constant-speed', silencesTimeline: silencesByClip.get(args.clipId) || [] },
})

export async function loadRendererModules() {
  globalThis.window ??= { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) }
  // Node 25 defines a localStorage global that throws without --localstorage-file.
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: noop, removeItem: noop }, configurable: true, writable: true })
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  const load = (file) => vite.ssrLoadModule(file)
  return {
    vite,
    timelineStore: await load('/src/stores/timelineStore.js'),
    assetsStore: await load('/src/stores/assetsStore.js'),
    projectStore: await load('/src/stores/projectStore.js'),
    runtime: await load('/src/studio/editLogRuntime.js'),
    mcp: await load('/src/services/mcpActions.js'),
    snapshot: await load('/src/services/mcpSnapshot.js'),
    capability: await load('/src/studio/capabilityRuntime.js'),
    agentTools: await load('/src/services/agentTools.js'),
  }
}

// FILM-2014: `media: true` writes FFmpeg-made media for every asset (the
// preview tiers read real files), and `review` passes main.js's reviewTools
// to the server, reading the document over the same bridge.
export async function startStudioHarness(m, { shots = 20, runRead = silentLinesAnalysis(), packageTransform = null, media = false, review = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-capabilities-'))
  const pkg = packageTransform ? packageTransform(loadFixture(shots)) : loadFixture(shots)
  const { project, files } = buildProject({ package: pkg, probedAssets: probesFor(pkg) })
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, relative)), { recursive: true })
    await writeFile(path.join(dir, relative), text)
  }
  await writeFile(path.join(dir, 'project.comfystudio'), `${JSON.stringify(project, null, 2)}\n`)
  if (media) await (await import('./review-media.mjs')).writeMediaFor(project, dir)

  const proposals = []
  const secret = 'harness-bearer-secret'
  const port = await freePort()
  let server = null
  const publishSnapshot = () => server?.updateSnapshot(m.snapshot.buildMcpSnapshot())
  const studioEdits = editsBridge()
  globalThis.window.electronAPI = {
    studioEdits,
    // main.js fs:readFile and path:join, as the preload calls them
    readFile: async (filePath, options = {}) => {
      try {
        return { success: true, data: await readFile(filePath, options.encoding || 'utf8'), encoding: options.encoding }
      } catch (error) {
        return { success: false, error: error.message }
      }
    },
    pathJoin: async (...parts) => path.join(...parts),
    mcp: { updateSnapshot: async (snapshot) => ({ success: Boolean(server?.updateSnapshot(snapshot)) }) },
    studio: { callCapability: (name, args) => server.callCapabilityTool(name, args, { source: 'in-app' }) },
  }
  const restoreSeams = m.capability.configureStudioRuntime({ runRead, publishSnapshot })

  const opened = m.projectStore.normalizeOpenedProjectData(JSON.parse(await readFile(path.join(dir, 'project.comfystudio'), 'utf8')))
  m.timelineStore.useTimelineStore.getState().loadFromProject(opened.currentTimeline, opened.projectData.assets, opened.currentTimeline.fps || 24)
  m.assetsStore.useAssetsStore.setState({ assets: opened.projectData.assets, folders: opened.projectData.folders || [] })
  m.projectStore.useProjectStore.setState({ currentProject: opened.projectData, currentTimelineId: opened.currentTimelineId, currentProjectHandle: dir })
  const timers = manualTimers()
  await m.runtime.startStudioEditLog({ projectPath: dir, projectStore: m.projectStore.useProjectStore, api: studioEdits, timers })
  const roughCut = await m.runtime.createStudioVersion('Rough cut', { by: 'ai', prompt: null })

  server = createComfyStudioMcpServer({
    port,
    authSecret: secret,
    version: 'harness',
    // The renderer bridge (startMcpActionBridge) plus the snapshot publisher.
    performAction: async ({ action, payload }) => {
      const result = await m.mcp.runMcpAction(action, payload || {})
      publishSnapshot()
      return result
    },
    emitPlanProposed: (proposal) => proposals.push(proposal),
    reviewTools: review ? review({
      getReviewContext: async (payload) => {
        const result = await m.mcp.runMcpAction('studio_review_context', payload || {})
        if (result?.studioError) throw Object.assign(new Error(result.studioError.message), { code: result.studioError.code })
        return result
      },
      appendOpLog: (entry) => m.mcp.runMcpAction('studio_append_oplog', entry),
    }) : null,
  })
  publishSnapshot()
  await server.start()

  const readLog = async () => {
    await m.runtime.getStudioEditLog()?.oplog.idle()
    const text = await editsFiles.readText(dir, 'edits/oplog.jsonl')
    return (text || '').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }

  return {
    dir,
    pkg,
    url: `http://127.0.0.1:${port}/mcp`,
    secret,
    server,
    proposals,
    timers,
    roughCut,
    readLog,
    timeline: () => m.timelineStore.useTimelineStore.getState(),
    async close() {
      server.server?.closeAllConnections?.()
      await server.stop()
      restoreSeams()
      await m.runtime.stopStudioEditLog()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

// An MCP SDK client over Streamable HTTP with the bearer.
export async function connectSdkClient(harness, { profile = null, secret = harness.secret } = {}) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const url = new URL(harness.url)
  if (profile) url.searchParams.set('profile', profile)
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${secret}` } } })
  const client = new Client({ name: 'film-2013-harness', version: '1.0.0' })
  await client.connect(transport)
  return client
}

export const parseToolResult = (result) => JSON.parse(result.content[0].text)
