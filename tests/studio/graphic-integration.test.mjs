// FILM-2018 AC3/AC4 over MCP: an SDK client with the bearer against the real
// local server and the real renderer code (headless harness).
//
//   "At 32 s show a counter to 87" produces a composition clip, a cached
//   render, a pop SFX, and passes safe-area QA on 16:9 and 9:16 (the spec's
//   integration row). The render runs through the real composition renderer
//   and render sync with the test-card engine (no browser here; the Remotion
//   engine draws every primitive in composition-remotion.test.mjs).
//
// Also: studio_get_context carries the catalogue; a graphic with no anchor
// moves clear of a caption, one given an anchor that covers a caption is
// flagged by QA; bad props are refused before anything changes.
//
// STUDIO_EVIDENCE_DIR=<dir> writes the counter's cards, op log and report per aspect.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { after, afterEach, before, test } from 'node:test'

import { styleCaptionCues } from '../../src/studio/captions/style.js'
import { COMPOSITION_ANCHORS, COMPOSITION_IDS } from '../../src/studio/compositions/catalogue.js'
import { createCompositionRenderSync } from '../../src/studio/compositions/renderSync.js'
import { POP_FILE } from '../../src/studio/compositions/sfx.js'
import { connectSdkClient, loadRendererModules, parseToolResult, startStudioHarness } from './helpers/studio-harness.mjs'
import { createTestcardEngine } from './helpers/testcard-engine.mjs'

const require = createRequire(import.meta.url)
const { createCompositionRenderer } = require('../../electron/studio/compositionRenderer.js')
const { createQa } = require('../../electron/studio/qa.js')
const { CAPABILITY_TOOLS } = require('../../electron/studio/mcpCapabilities.js')

let m
let harness
let client

before(async () => { m = await loadRendererModules() })
after(async () => { await m?.vite.close() })
afterEach(async () => {
  await client?.close()
  await harness?.close()
  client = null
  harness = null
})

async function open(options = {}) {
  harness = await startStudioHarness(m, options)
  client = await connectSdkClient(harness)
}

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  const body = parseToolResult(result)
  assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(body.error)}`)
  return body
}

async function previewAndApply(args) {
  const before = JSON.stringify(harness.timeline().clips)
  const logBefore = (await harness.readLog()).length
  const preview = await call('studio_add_graphic', args)
  assert.equal(preview.previewOnly, true)
  assert.equal(JSON.stringify(harness.timeline().clips), before, 'a preview changes nothing')
  assert.equal((await harness.readLog()).length, logBefore, 'and logs nothing')
  assert.ok(preview.stepPreviews.every((step) => step.ok), JSON.stringify(preview.stepPreviews))
  assert.ok(preview.cards.length > 0)
  const applied = await call('studio_add_graphic', { ...args, previewOnly: false, planId: preview.planId })
  assert.equal(applied.applied, true, JSON.stringify(applied))
  const lines = (await harness.readLog()).filter((entry) => entry.versionId === applied.version.id && entry.tool !== 'studio_create_version')
  assert.deepEqual(lines.map((entry) => entry.tool), preview.plan.steps.map((step) => step.tool), 'one op-log line per step')
  assert.deepEqual(lines.map((entry) => entry.reason), preview.plan.reasons)
  return { preview, applied }
}

// The app's render sync over the harness's store, with the main process's
// renderer behind the bridge as studioMain.js wires it.
async function renderGraphics(engine) {
  const renderer = createCompositionRenderer({ engines: { remotion: engine } })
  const bridge = (fn) => async (request) => ({ success: true, ...(await fn(request)) })
  const frame = await reviewFrame()
  const sync = createCompositionRenderSync({
    store: m.timelineStore.useTimelineStore,
    api: { compositionResolve: bridge(renderer.resolve), compositionRender: bridge(renderer.render) },
    getProjectPath: () => harness.dir,
    getFrame: () => ({ ...frame, fps: 24 }),
    getFileUrl: async (dir, relative) => `file://${path.join(dir, relative)}`,
    schedule: () => {},
  })
  await sync.sync()
  sync.stop()
  return { renderer, frame }
}

const reviewContext = () => m.mcp.runMcpAction('studio_review_context', {})
async function reviewFrame() {
  const { project } = await reviewContext()
  return project.timelines[0].studio.aspect === '9:16' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }
}

async function documentQa(preset) {
  const { project, timelineId, policy, pkg, opLog } = await reviewContext()
  const qa = createQa({ fileExists: () => true })
  return (await qa.runQa({ project, timelineId, policy, preset, pkg, opLog })).qa
}

// The fixture's captions as FILM-2016's studio_add_captions leaves them:
// styled for the aspect's safe area (unplaced cues fail caption QA on their own).
function placeCaptions(aspect) {
  const store = m.timelineStore.useTimelineStore
  store.setState({ clips: store.getState().clips.map((clip) => (clip.type === 'captions' ? { ...clip, captions: { ...clip.captions, cues: styleCaptionCues({ cues: clip.captions.cues, aspect }).cues } } : clip)) })
}

const SAFE_AREA_CHECKS = ['caption_safe_area', 'caption_overlap', 'graphic_caption_overlap']

async function counterTo87(preset, aspect) {
  placeCaptions(aspect)
  const context = await call('studio_get_context', {})
  assert.deepEqual(context.compositions.map((entry) => entry.id), COMPOSITION_IDS, 'studio_get_context carries the catalogue')

  const { preview, applied } = await previewAndApply({ kind: 'counter', text: '87', at: 32, duration: 4 })
  const tools = preview.plan.steps.map((step) => step.tool)
  assert.deepEqual(tools.filter((tool) => tool !== 'add_track'), ['add_composition_clip', 'add_sfx_clip'])
  assert.equal(applied.version.name, 'AI: counter "87" at 32 s')

  const clips = harness.timeline().clips
  const graphic = clips.find((clip) => clip.type === 'composition')
  assert.ok(graphic, 'a composition clip')
  assert.deepEqual([graphic.startTime, graphic.duration, graphic.composition.compositionId, graphic.composition.props.to], [32, 4, 'counter', 87])
  assert.equal(harness.timeline().tracks.find((track) => track.id === graphic.trackId).name, 'Graphics')
  const pop = clips.find((clip) => clip.type === 'audio' && clip.startTime === 32 && m.assetsStore.useAssetsStore.getState().assets.find((asset) => asset.id === clip.assetId)?.settings?.studioSfx === 'pop')
  assert.ok(pop, 'a pop SFX at 32 s')
  assert.ok(Math.abs(pop.duration - 0.3) < 1 / 24 + 1e-6)
  assert.equal(readFileSync(path.join(harness.dir, POP_FILE)).subarray(0, 4).toString(), 'RIFF')

  const engine = createTestcardEngine()
  const { renderer, frame } = await renderGraphics(engine)
  const rendered = harness.timeline().clips.find((clip) => clip.id === graphic.id).composition
  assert.match(rendered.renderPath, /^compositions\/counter-[0-9a-f]{64}\.webm$/)
  assert.ok(existsSync(path.join(harness.dir, rendered.renderPath)), 'the render is on disk')
  assert.deepEqual([engine.calls.length, engine.calls[0].width, engine.calls[0].height], [1, frame.width, frame.height])
  const again = await renderer.resolve({ projectDir: harness.dir, engine: 'remotion', compositionId: 'counter', props: rendered.props, durationSeconds: 4, ...frame, fps: 24 })
  assert.deepEqual([again.cached, again.propsHash], [true, rendered.propsHash], 'the render is cached by its key')

  const qa = await documentQa(preset)
  // Safe-area QA: the counter inside the safe area and clear of the captions,
  // the captions inside it. (The fixture's media is not downloaded, so the
  // media-health check has its own issues; they are not safe-area ones.)
  assert.deepEqual(qa.issues.filter((entry) => SAFE_AREA_CHECKS.includes(entry.type)), [], JSON.stringify(qa.issues))
  assert.ok(qa.issues.every((entry) => entry.type === 'missing_media'), JSON.stringify(qa.issues.map((entry) => entry.type)))

  if (process.env.STUDIO_EVIDENCE_DIR) {
    const dir = path.join(process.env.STUDIO_EVIDENCE_DIR, preset)
    await mkdir(dir, { recursive: true })
    const lines = (await harness.readLog()).filter((entry) => entry.versionId === applied.version.id)
    await writeFile(path.join(dir, 'counter-preview.json'), `${JSON.stringify({ plan: preview.plan, cards: preview.cards, notes: preview.notes }, null, 2)}\n`)
    await writeFile(path.join(dir, 'counter-oplog.jsonl'), `${lines.map((entry) => JSON.stringify({ ...entry, args: undefined, inverse: undefined })).join('\n')}\n`)
    await writeFile(path.join(dir, 'counter-report.txt'), applied.reportText)
    await writeFile(path.join(dir, 'qa.json'), `${JSON.stringify(qa, null, 2)}\n`)
  }
  return { graphic, qa }
}

test('"At 32 s show a counter to 87" on 16:9: a composition clip, a cached render, a pop SFX, and safe-area QA passes', async () => {
  await open()
  await counterTo87('youtube_16x9', '16:9')
})

test('"At 32 s show a counter to 87" on 9:16: the same, inside the vertical safe area', async () => {
  await open({ packageTransform: (pkg) => ({ ...pkg, episode: { ...pkg.episode, aspect: '9:16' } }) })
  await counterTo87('shorts_9x16', '9:16')
})

test('a lower third with no anchor moves clear of the caption on screen; given an anchor over it, QA flags the overlap', async () => {
  await open()
  placeCaptions('16:9')
  const captions = harness.timeline().clips.find((clip) => clip.type === 'captions')
  const cue = captions.captions.cues.find((entry) => entry.end - entry.start >= 1.5)
  const at = captions.startTime - (captions.trimStart || 0) + cue.start

  const moved = await call('studio_add_graphic', { kind: 'lower_third', text: 'Maya Rao, Lead engineer', at, duration: 1 })
  const placed = moved.plan.steps.find((step) => step.tool === 'add_composition_clip').arguments
  assert.equal(placed.compositionId, 'lower-third')
  assert.notEqual(placed.props.anchor, 'bottom-left', 'moved off its own anchor')
  assert.match(moved.plan.reasons.join(' '), /clear of the caption/)
  assert.ok(!moved.plan.steps.some((step) => step.tool === 'add_sfx_clip'), 'only counters and callouts pop')

  await previewAndApply({ kind: 'lower_third', text: 'Maya Rao, Lead engineer', at, duration: 1, anchor: 'bottom' })
  const qa = await documentQa('youtube_16x9')
  const overlap = qa.issues.filter((entry) => entry.type === 'graphic_caption_overlap')
  assert.equal(overlap.length, 1, JSON.stringify(qa.issues.map((entry) => entry.type)))
  assert.ok(overlap[0].severity >= 0.5, 'it fails the render')
  assert.match(overlap[0].detail, /lower-third graphic .* covers 1 caption cue/)
})

test('studio_add_graphic refuses an unknown kind, bad props and an unknown prop before anything changes', async () => {
  await open()
  const before = JSON.stringify(harness.timeline().clips)
  for (const [args, pattern] of [
    [{ kind: 'diagram', text: 'x', at: 1, duration: 2 }, /No graphic primitive for kind "diagram"/],
    [{ kind: 'counter', text: 'eighty', at: 1, duration: 2 }, /needs a number/],
    [{ kind: 'progress', text: '140%', at: 1, duration: 2 }, /value .*100/],
    [{ kind: 'chart', text: 'a 1, b 2, c 3, d 4, e 5, f 6, g 7', at: 1, duration: 2 }, /items .*6/],
    [{ kind: 'map', text: 'Lisbon', at: 1, duration: 2, props: { zoom: 3 } }, /Unrecognized key/],
    [{ kind: 'counter', text: '87', at: 1, duration: 0 }, /duration/],
    [{ kind: 'counter', text: '87', at: 1, duration: 2, anchor: 'middle' }, /anchor must be one of/],
  ]) {
    const result = await client.callTool({ name: 'studio_add_graphic', arguments: args })
    assert.equal(result.isError, true, JSON.stringify(args))
    const { error } = parseToolResult(result)
    assert.equal(error.code, 'VALIDATION_FAILED')
    assert.match(error.message, pattern, JSON.stringify(args))
  }
  assert.equal(JSON.stringify(harness.timeline().clips), before)
})

test('the tool\'s anchor list is the catalogue\'s', () => {
  const tool = CAPABILITY_TOOLS.find((entry) => entry.name === 'studio_add_graphic')
  assert.deepEqual(tool.inputSchema.properties.anchor.enum, [...COMPOSITION_ANCHORS])
  assert.equal(tool.available, true)
})
