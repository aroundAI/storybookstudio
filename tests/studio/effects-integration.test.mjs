// FILM-2018 AC5/AC6 over MCP: an SDK client with the bearer against the real
// local server and the real renderer code (headless harness). Each effect's
// preview changes nothing and logs nothing; its apply runs the editor's own
// split_clip, set_clip_keyframes and add_glsl_effect handlers into a new
// version with one op-log line per step and the preview's reasons; and
// studio_choose_visual_representation answers with a ranking.
//
// STUDIO_EVIDENCE_DIR=<dir> writes the freeze_frame cards, op log and report.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, afterEach, before, beforeEach, test } from 'node:test'

import { connectSdkClient, loadRendererModules, parseToolResult, startStudioHarness } from './helpers/studio-harness.mjs'

let m
let harness
let client

before(async () => { m = await loadRendererModules() })
after(async () => { await m?.vite.close() })
beforeEach(async () => {
  harness = await startStudioHarness(m)
  client = await connectSdkClient(harness)
})
afterEach(async () => {
  await client?.close()
  await harness?.close()
})

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  const body = parseToolResult(result)
  assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(body.error)}`)
  return body
}
const shot = (name) => harness.timeline().clips.find((clip) => clip.trackId === 'video-1' && clip.name.startsWith(name))

async function previewAndApply(args) {
  const before = JSON.stringify(harness.timeline().clips)
  const logBefore = (await harness.readLog()).length
  const preview = await call('studio_edit', args)
  assert.equal(preview.previewOnly, true)
  assert.equal(JSON.stringify(harness.timeline().clips), before, `${args.intent}: a preview changes nothing`)
  assert.equal((await harness.readLog()).length, logBefore, `${args.intent}: and logs nothing`)
  assert.ok(preview.stepPreviews.every((step) => step.ok), JSON.stringify(preview.stepPreviews))
  const applied = await call('studio_edit', { ...args, previewOnly: false, planId: preview.planId })
  assert.equal(applied.applied, true, JSON.stringify(applied.error))
  assert.ok(applied.steps.every((step) => step.success), JSON.stringify(applied.steps))
  const lines = (await harness.readLog()).filter((entry) => entry.versionId === applied.version.id && entry.tool !== 'studio_create_version')
  assert.deepEqual(lines.map((entry) => entry.tool), preview.plan.steps.map((step) => step.tool), `${args.intent}: one op-log line per step`)
  assert.deepEqual(lines.map((entry) => entry.reason), preview.plan.reasons)
  assert.ok(lines.every((entry) => entry.by === 'ai' && entry.session === `studio-plan-${preview.planId}`))
  return { preview, applied, lines }
}

test('freeze_frame over MCP: split and speed keyframes applied by the editor, the shot keeps its place, one logged line per step', async () => {
  const s32 = shot('S3.2')
  const at = s32.startTime + 1.5
  const args = { intent: 'freeze_frame', scope: {}, params: { atSeconds: at, instruction: 'freeze on S3.2 for a second' } }
  const { preview, applied, lines } = await previewAndApply(args)
  assert.deepEqual(preview.plan.steps.map((step) => step.tool), ['split_clip', 'set_clip_keyframes'])
  assert.equal(applied.version.name, 'AI: freeze on S3.2 for a second')
  const left = harness.timeline().clips.find((clip) => clip.id === s32.id)
  const right = harness.timeline().clips.find((clip) => clip.trackId === 'video-1' && clip.id !== s32.id && Math.abs(clip.startTime - (at + 1)) < 1e-6)
  assert.ok(right, 'the right piece starts where the hold ends')
  assert.equal(Math.round((left.duration + right.duration) * 1000), Math.round(s32.duration * 1000))
  assert.deepEqual(left.keyframes.speed.map((frame) => [frame.time, frame.value, frame.easing]), [[0, 1, 'hold'], [1.5, 0.05, 'hold']])
  assert.equal(Math.round(right.trimStart * 1000), Math.round((s32.trimStart + 2.5) * 1000), 'the rest is on its own source time')
  assert.equal(right.metadata?.semantic?.scene, 3)

  if (process.env.STUDIO_EVIDENCE_DIR) {
    const dir = process.env.STUDIO_EVIDENCE_DIR
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'freeze-cards.json'), `${JSON.stringify(preview.cards, null, 2)}\n`)
    await writeFile(path.join(dir, 'freeze-oplog.jsonl'), `${lines.map((entry) => JSON.stringify({ ...entry, args: undefined, inverse: undefined })).join('\n')}\n`)
    await writeFile(path.join(dir, 'freeze-report.txt'), applied.reportText)
  }
})

test('color_grade, punch_in, speed_ramp and ken_burns over MCP: each applies through the editor\'s handlers with a line per step', async () => {
  const graded = await previewAndApply({ intent: 'color_grade', scope: { scene: 3 }, params: { look: 'agfa1978' } })
  const scene3 = harness.timeline().clips.filter((clip) => clip.trackId === 'video-1' && clip.metadata?.semantic?.scene === 3)
  assert.equal(graded.lines.length, scene3.length)
  assert.ok(scene3.every((clip) => clip.effects.filter((effect) => effect.type === 'glslFilmLook').length === 1 && clip.effects.at(-1).settings.look === 4), 'Agfa 1978 is look 4')

  const punched = await previewAndApply({ intent: 'punch_in', scope: { scene: 4 }, params: {} })
  const target = harness.timeline().clips.find((clip) => clip.id === punched.preview.plan.steps[0].arguments.clipId)
  assert.deepEqual(target.keyframes.scaleX.map((frame) => frame.value).slice(-2), [110, 100])

  const s21 = shot('S2.1')
  await previewAndApply({ intent: 'speed_ramp', scope: {}, params: { atSeconds: s21.startTime + 1 } })
  assert.deepEqual(harness.timeline().clips.find((clip) => clip.id === s21.id).keyframes.speed.map((frame) => frame.value), [1, 1, 0.5, 0.5, 1])

  const s11 = shot('S1.1')
  await previewAndApply({ intent: 'ken_burns', scope: {}, params: { clipId: s11.id, pan: 'left' } })
  assert.deepEqual(harness.timeline().clips.find((clip) => clip.id === s11.id).keyframes.positionX.map((frame) => frame.value), [-43, 43])
})

test('studio_choose_visual_representation over MCP ranks the eight kinds and changes nothing', async () => {
  const before = JSON.stringify(harness.timeline().clips)
  const body = await call('studio_choose_visual_representation', { sceneOrPoint: { text: 'The route ran across the border to the coast', scene: 3 } })
  assert.equal(body.ranked.length, 8)
  assert.equal(body.ranked[0].kind, 'map')
  assert.equal(body.ranked[0].act.tool, 'studio_add_graphic')
  assert.equal(body.decidedBy, 'agent')
  assert.equal(JSON.stringify(harness.timeline().clips), before)
  const refused = await client.callTool({ name: 'studio_choose_visual_representation', arguments: { sceneOrPoint: { scene: 9 } } })
  assert.equal(refused.isError, true)
  assert.match(parseToolResult(refused).error.message, /scene 9 is not in this episode/)
})
