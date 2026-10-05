// FILM-2014 over MCP: an SDK client with the bearer against the real local
// server and the real renderer code (FILM-2013's headless harness), with
// FFmpeg-made media on disk and main.js's reviewTools. studio_review finds
// the planted loud music, studio_repair previews and applies one plan into a
// version, a second review passes the music; studio_edit's autoRepair loop
// runs on the same handlers; studio_render_preview renders a scene.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, afterEach, before, beforeEach, test } from 'node:test'

import { connectSdkClient, loadRendererModules, parseToolResult, startStudioHarness } from './helpers/studio-harness.mjs'
import { FFMPEG, FFPROBE } from './helpers/review-media.mjs'

const require = createRequire(import.meta.url)
const { createReviewTools } = require('../../electron/studio/reviewTools.js')

let m
let harness
let client

before(async () => { m = await loadRendererModules() })
after(async () => { await m?.vite.close() })
beforeEach(async () => {
  harness = await startStudioHarness(m, { media: true, review: (bridge) => createReviewTools({ ...bridge, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, env: {} }) })
  client = await connectSdkClient(harness)
})
afterEach(async () => {
  await client?.close()
  await harness?.close()
})

// Reviews render the whole cut; a 3-core CI runner needs more than the SDK's 60 s default.
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000

const call = async (name, args, { profile = null } = {}) => {
  const target = profile ? await connectSdkClient(harness, { profile }) : client
  const result = await target.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS })
  if (profile) await target.close()
  return { result, body: parseToolResult(result) }
}

// The music bed 20 dB hot, as a hand edit through the upstream editor's own primitive.
const plantLoudMusic = () => call('set_clip_audio', { clipId: 'clip-80', gainDb: 20, previewOnly: false }, { profile: 'expert' })

test('studio_review finds the loud music; studio_repair previews and applies one plan into a version; the next review passes it', async () => {
  const planted = await plantLoudMusic()
  assert.equal(planted.result.isError, undefined, JSON.stringify(planted.body))

  const { result: reviewed, body: review } = await call('studio_review', { scope: { scenes: [1, 2] } })
  assert.equal(reviewed.isError, undefined, JSON.stringify(review))
  assert.equal(review.pass, false)
  assert.deepEqual(review.range, [0, 39])
  assert.deepEqual(review.skipped.map((entry) => entry.analyser), ['visual'])
  const types = review.issues.map((issue) => issue.type)
  assert.ok(types.includes('music_over_dialogue'), types.join(','))
  assert.ok(types.includes('missing_media'), 'dialogue line 3 has no audio')
  assert.ok(review.issues.every((issue) => issue.severity >= 0 && issue.severity <= 1))

  // The review is the Studio's last QA now: studio_get_context reports it.
  const { body: context } = await call('studio_get_context', {})
  assert.equal(context.lastQa.pass, false)
  assert.equal(context.lastQa.issues.length, review.issues.length)

  const fixable = review.issues.filter((issue) => issue.repairIntent)
  const { result: previewed, body: preview } = await call('studio_repair', { issues: fixable })
  assert.equal(previewed.isError, undefined, JSON.stringify(preview))
  assert.equal(preview.previewOnly, true)
  assert.ok(preview.stepPreviews.every((step) => step.ok), JSON.stringify(preview.stepPreviews))
  assert.ok(preview.plan.steps.some((step) => step.tool === 'set_audio_buses'), JSON.stringify(preview.plan.steps.map((s) => s.tool)))
  assert.ok(preview.notes.some((note) => /Not repaired \(missing_media\)/.test(note.text)), 'the missing line is a card, not a guess')

  const { result: appliedResult, body: applied } = await call('studio_repair', { issues: fixable, previewOnly: false, planId: preview.planId })
  assert.equal(appliedResult.isError, undefined, JSON.stringify(applied))
  assert.equal(applied.applied, true)
  assert.equal(applied.version.name, 'AI: repair')
  const log = await harness.readLog()
  const repairOps = log.filter((entry) => entry.session === `studio-plan-${preview.planId}`)
  assert.equal(repairOps.length, preview.plan.steps.length, 'one logged line per applied step')
  assert.ok(repairOps.every((entry, index) => entry.reason === preview.plan.reasons[index]))

  const { body: again } = await call('studio_review', { scope: { scenes: [1, 2] } })
  assert.ok(!again.issues.some((issue) => issue.type === 'music_over_dialogue'), JSON.stringify(again.issues.filter((i) => i.type === 'music_over_dialogue')))
  console.log(`# studio_review over MCP: ${review.issues.length} issues → repair (${preview.plan.steps.map((s) => s.tool).join(', ')}) → ${again.issues.length} issues; blocking left: ${JSON.stringify(again.issues.filter((i) => i.severity >= 0.5).map((i) => i.type))}`)
})

test('studio_edit autoRepair: the loop reviews and repairs with FILM-2014\'s handlers inside the one version', async () => {
  await plantLoudMusic()
  const args = { intent: 'remove_dead_air', scope: { scene: 2 } }
  const { body: preview } = await call('studio_edit', args)
  const { result, body: applied } = await call('studio_edit', { ...args, previewOnly: false, planId: preview.planId, autoRepair: true })
  assert.equal(result.isError, undefined, JSON.stringify(applied))
  const { rounds, stoppedBecause, qa } = applied.autoRepair
  assert.ok(!/not available yet/.test(stoppedBecause), stoppedBecause)
  assert.ok(rounds.length >= 2 && rounds.length <= 3, JSON.stringify(rounds))
  assert.equal(rounds[1].kind, 'repair')
  assert.ok(qa && Array.isArray(qa.issues))
  assert.ok(!qa.issues.some((issue) => issue.type === 'music_over_dialogue'), JSON.stringify({ rounds, stoppedBecause, music: qa.issues.filter((i) => i.type === 'music_over_dialogue') }))
  console.log(`# autoRepair: ${JSON.stringify(rounds)}; stopped: ${stoppedBecause}`)
})

test('studio_render_preview: scene 3 as a 720p file with its keyframes and a QA result, over MCP', async () => {
  const { result, body } = await call('studio_render_preview', { scope: { scene: 3 } })
  assert.equal(result.isError, undefined, JSON.stringify(body))
  assert.equal(body.quality, 'scene')
  assert.deepEqual(body.range, [39, 60])
  assert.match(body.file, /cache\/preview\/range-39000-60000\.mp4$/)
  assert.ok(body.keyframes.count >= 10)
  assert.ok(body.keyframes.files.every((frame) => frame.time >= 39 && frame.time < 60 && /cache\/kf\/kf-\d+\.jpg$/.test(frame.file)))
  assert.equal(typeof body.qa.pass, 'boolean')
  const { body: refused } = await call('studio_render_preview', { quality: 'ultra' })
  assert.match(refused.error.message, /quality must be one of keyframes, scene, audio, full/)
})
