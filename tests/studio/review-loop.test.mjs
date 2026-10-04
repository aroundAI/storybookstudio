// FILM-2014 integration (AC5, AC6; test plan "apply → keyframes → QA →
// repair → QA passes ... in under 3 rounds"): the 20-shot rough cut with
// planted silence and loud music, reviewed by studio_review's handler,
// repaired by the repair intent, applied, and reviewed again, the way
// FILM-2013's autoRepair loop drives it (at most 3 rounds).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'

import { compile } from '../../src/studio/intents/repair.js'
import { applyPlan, insertGap } from './helpers/apply-plan.mjs'
import { buildMediaProject, FFMPEG, FFPROBE, removeDir, tempDir, withoutOfflineClips } from './helpers/review-media.mjs'

const require = createRequire(import.meta.url)
const { createReviewTools } = require('../../electron/studio/reviewTools.js')

const MAX_ROUNDS = 3
let dir
let fixture

before(async () => {
  dir = await tempDir('loop')
  fixture = await buildMediaProject(dir)
})
after(() => removeDir(dir))

// The editor removed the clips with no media; the op log holds each removal
// with the removed clip in its inverse, as FILM-2012's wrapper records it.
function plantedCut() {
  const removed = fixture.project.timelines[0].clips.filter((clip) => !withoutOfflineClips(fixture.project).timelines[0].clips.includes(clip))
  let project = withoutOfflineClips(fixture.project)
  const opLog = removed.map((clip, i) => ({ op: i + 1, by: 'user', session: 'app-1', tool: 'delete_clips', args: { clipIds: [clip.id] }, inverse: { tool: 'studio_apply_patch', args: { restore: clip } }, reason: null, scene: clip.metadata?.semantic?.scene ?? null, versionId: null }))
  // Plant: music 20 dB too loud, and 3 s of nothing at 45 s (silence and black).
  for (const clip of project.timelines[0].clips) if (clip.trackId === 'audio-3') clip.gainDb = 20
  project = insertGap(project, 45, 3)
  return { project, opLog }
}

test('review → repair → apply converges: QA passes within 3 rounds on planted silence and loud music', async () => {
  const state = plantedCut()
  const opLogWrites = []
  const tools = createReviewTools({
    getReviewContext: async () => ({ project: state.project, projectPath: dir, policy: fixture.policy, pkg: fixture.pkg, opLog: state.opLog }),
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    env: {},
    appendOpLog: async (entry) => opLogWrites.push(entry),
  })
  const rounds = []
  let review = await tools.review({})
  const first = review
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    rounds.push({ round, pass: review.qa.pass, issues: review.issues.map((i) => `${i.type}:${i.repairIntent || '-'}:${i.severity}`) })
    if (review.qa.pass && !review.critic.issues.some((i) => i.severity >= 0.5 && i.repairIntent)) break
    const plan = compile({ timeline: state.project.timelines[0], assets: state.project.assets, fps: 24, audioBuses: state.project.studio.audioBuses }, {}, { issues: review.issues }, fixture.policy)
    assert.ok(plan.steps.length > 0, `round ${round} found issues but no plan: ${JSON.stringify(plan.unrepaired)}`)
    state.project = applyPlan(state.project, plan)
    review = await tools.review({})
  }

  // Round 1 saw both plants.
  const firstTypes = first.issues.map((i) => i.type)
  assert.ok(firstTypes.includes('silence'), firstTypes.join(','))
  assert.ok(firstTypes.includes('black_frames'))
  assert.ok(firstTypes.includes('music_over_dialogue'))
  assert.equal(first.qa.pass, false)
  assert.deepEqual(first.skipped, [{ analyser: 'visual', reason: first.skipped[0].reason }])
  assert.match(first.skipped[0].reason, /No hosted vision model/)

  // Converged inside the limit: QA passes and nothing blocking is left that a repair could fix.
  assert.ok(rounds.length <= MAX_ROUNDS, JSON.stringify(rounds, null, 1))
  assert.equal(review.qa.pass, true, JSON.stringify(review.qa.issues))
  assert.deepEqual(review.critic.issues.filter((i) => i.severity >= 0.5 && i.repairIntent), [])
  assert.ok(!review.issues.some((i) => i.type === 'silence' || i.type === 'music_over_dialogue'))
  // The music bus now ducks deeper under dialogue than the policy's -8 dB (FILM-2016's set_audio_buses).
  assert.ok(state.project.studio.audioBuses.music.duckDb < -8, JSON.stringify(state.project.studio.audioBuses.music))
  assert.deepEqual(opLogWrites, [], 'no vision model, no token cost to record')
  console.log(`# rounds: ${JSON.stringify(rounds.map((r) => ({ round: r.round, pass: r.pass, blocking: r.issues.filter((s) => Number(s.split(':')[2]) >= 0.5) })))}`)
})

test('studio_review records the vision model\'s token cost in the op log and caps it at 40 keyframes', async () => {
  const { project, opLog } = plantedCut()
  const opLogWrites = []
  let sent = 0
  const tools = createReviewTools({
    getReviewContext: async () => ({ project, projectPath: dir, policy: fixture.policy, pkg: fixture.pkg, opLog }),
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    appendOpLog: async (entry) => opLogWrites.push(entry),
    visionClient: { configured: true, name: 'fake', model: 'fake-vision', describe: async ({ images }) => { sent = images.length; return { text: '[]', usage: { inputTokens: 40000, outputTokens: 50, costUsd: 0.16 } } } },
  })
  const result = await tools.review({ scope: { scenes: [1, 2, 3, 4, 5] } })
  assert.deepEqual(result.skipped, [])
  assert.equal(sent, 40, 'the 101 s cut has more than 40 keyframes; 40 are sent')
  assert.deepEqual(opLogWrites, [{ tool: 'studio_review', args: { vision: { provider: 'fake', model: 'fake-vision', framesSent: 40, inputTokens: 40000, outputTokens: 50, costUsd: 0.16 } }, reason: 'Vision critic on 40 keyframes', scene: null }])
})

test('studio_render_preview: a scene tier with its keyframes and a QA result for that range', async () => {
  const tools = createReviewTools({ getReviewContext: async () => ({ project: fixture.project, projectPath: dir, policy: fixture.policy, pkg: fixture.pkg, opLog: [] }), ffmpegPath: FFMPEG, ffprobePath: FFPROBE, env: {} })
  const result = await tools.renderPreview({ scope: { scene: 1 } })
  assert.equal(result.quality, 'scene')
  assert.deepEqual(result.range, [0, 19])
  assert.match(result.file, /cache\/preview\/range-0-19000\.mp4$/)
  assert.ok(result.keyframes.count >= 10 && result.keyframes.files.every((f) => f.time < 19))
  assert.ok(result.realtimeFactor > 1)
  // Scene 1 holds dialogue line 3, whose audio is missing: QA names it.
  assert.ok(result.qa.issues.some((i) => i.type === 'missing_media' && i.scene === 1))
  assert.ok(!result.qa.issues.some((i) => i.type === 'duration'), 'a scene is not held to the whole cut\'s target length')
  await assert.rejects(tools.renderPreview({ quality: 'ultra' }), /quality must be one of keyframes, scene, audio, full/)
})
