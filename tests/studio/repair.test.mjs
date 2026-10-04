// FILM-2014 V3 (AC6): studio_repair compiles each repairIntent into steps of
// one plan, with a reason per step, targets found in the document.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildProject } from '../../src/studio/projectBuilder.js'
import { compile, INTENT, KEEP_PAUSE_SECONDS, LIMITER_CEILING_DB } from '../../src/studio/intents/repair.js'
import { REPAIR_INTENTS } from '../../src/studio/contracts/qa-result.schema.mjs'
import { loadFixture, probesFor } from './helpers/rough-cut.mjs'
import { miniProject } from './helpers/qa-fixtures.mjs'
import { applyPlan } from './helpers/apply-plan.mjs'
import { clone } from './helpers/review-media.mjs'
import { checkCaptionSafeArea } from '../../src/studio/captions/style.js'

const pkg = loadFixture(20)
const { project } = buildProject({ package: pkg, probedAssets: probesFor(pkg) })
const policy = JSON.parse(JSON.stringify(pkg.editPolicy))
const context = (doc = project) => ({ timeline: doc.timelines[0], assets: doc.assets, fps: 24, audioBuses: doc.studio?.audioBuses })
const run = (issues, doc = project) => compile(context(doc), {}, { issues }, policy)
const issue = (fields) => ({ severity: 0.7, scene: null, timeRange: null, ...fields })

test('the plan has FILM-2013 intent compiler shape: aligned steps, reasons, scenes and changes, plus expected durations', () => {
  const plan = run([issue({ type: 'silence', repairIntent: 'trim_silence', timeRange: { start: 40, end: 43 }, scene: 3, detail: '3.0 s of silence from 40.0 s; the limit is 1.5 s.' })])
  assert.equal(plan.intent, INTENT)
  assert.equal(plan.steps.length, plan.reasons.length)
  assert.equal(plan.steps.length, plan.scenes.length)
  assert.equal(plan.steps.length, plan.changes.length)
  assert.deepEqual(plan.expected.durationBefore - plan.expected.durationAfter, 3 - 2 * KEEP_PAUSE_SECONDS)
  assert.deepEqual(plan.expected.perScene.find((s) => s.scene === 3), { scene: 3, before: 21, after: 18.5 })
})

test('normalize_loudness: a Studio project sets the master bus target; a plain project moves the fader with a limiter', () => {
  const quiet = issue({ type: 'loudness', repairIntent: 'normalize_loudness', detail: 'Integrated loudness is -18.0 LUFS; the reels_9x16 target is -16 LUFS (±1 LU), 2.0 LU too quiet.' })
  assert.deepEqual(run([quiet]).steps, [{ tool: 'set_audio_buses', arguments: { buses: { master: { limiterLufs: -16 } } } }])
  const atTarget = run([issue({ ...quiet, detail: 'Integrated loudness is -18.0 LUFS; the policy target is -14 LUFS (±1 LU), 4.0 LU too quiet.' })])
  assert.deepEqual(atTarget.steps, [])
  assert.match(atTarget.unrepaired[0].why, /already normalises to -14 LUFS/)
  const plain = clone(project)
  delete plain.studio.audioBuses
  const plan = run([issue({ ...quiet, detail: 'Integrated loudness is -18.0 LUFS; the policy target is -14 LUFS (±1 LU), 4.0 LU too quiet.' })], plain)
  assert.equal(plan.steps.length, 1)
  const [step] = plan.steps
  assert.equal(step.tool, 'set_master_audio')
  assert.equal(step.arguments.volume, 158.5, '+4 dB on a unity fader')
  assert.deepEqual(step.arguments.inserts, [{ type: 'limiter', enabled: true, ceilingDb: LIMITER_CEILING_DB, releaseMs: 50 }])
  assert.match(plan.reasons[0], /-18\.0 LUFS against a -14 LUFS target: master \+4\.0 dB/)
  const capped = run([issue({ type: 'loudness', repairIntent: 'normalize_loudness', detail: 'Integrated loudness is -30.0 LUFS; the policy target is -14 LUFS (±1 LU), 16.0 LU too quiet.' })], plain)
  assert.equal(capped.steps[0].arguments.volume, 200)
  assert.match(capped.reasons[0], /stops at \+6 dB, 10\.0 dB short/)
  const clipping = run([issue({ type: 'clipping', repairIntent: 'normalize_loudness', timeRange: { start: 3, end: 5 }, detail: 'The mix clips' })], plain)
  assert.equal(clipping.steps[0].arguments.volume, 70.8, '-3 dB when only peaks are wrong')
  const studioClipping = run([issue({ type: 'clipping', repairIntent: 'normalize_loudness', timeRange: { start: 3, end: 5 }, detail: 'The mix clips' })])
  assert.match(studioClipping.unrepaired[0].why, /in a source clip/)
})

test('duck_music: a Studio project ducks the music bus deeper by the shortfall to 12 dB clear; a plain project lowers the music clip', () => {
  const masking = issue({ type: 'music_over_dialogue', repairIntent: 'duck_music', timeRange: { start: 0.4, end: 11 }, detail: 'Dialogue sits 1.9 dB above the music from 0.4 s to 11.0 s (dialogue -19.6 dB, music -21.5 dB RMS); it needs 8 dB to stay clear.' })
  const plan = run([masking])
  assert.deepEqual(plan.steps, [{ tool: 'set_audio_buses', arguments: { buses: { music: { duckUnder: 'dialogue', duckDb: -18.1, attackMs: 120, releaseMs: 400 } } } }])
  assert.match(plan.reasons[0], /10\.1 dB short of 12 dB clear\); duck the music bus to -18\.1 dB under dialogue/)
  // At the -40 dB floor the rest comes off the bus gain.
  const deep = clone(project)
  deep.studio.audioBuses.music.duckDb = -35
  const floor = run([masking], deep)
  assert.deepEqual(floor.steps[0].arguments.buses.music, { duckUnder: 'dialogue', duckDb: -40, attackMs: 120, releaseMs: 400, gainDb: -5.1 })
  const plain = clone(project)
  delete plain.studio.audioBuses
  const lowered = run([masking], plain)
  assert.deepEqual(lowered.steps, [{ tool: 'set_clip_audio', arguments: { clipId: 'clip-80', gainDb: -14.54 } }])
})

test('trim_silence: ripple extracts keep a pause each side and run latest first', () => {
  const plan = run([
    issue({ type: 'silence', repairIntent: 'trim_silence', timeRange: { start: 10, end: 12 } }),
    issue({ type: 'silence', repairIntent: 'trim_silence', timeRange: { start: 50, end: 54 } }),
    issue({ type: 'silence', repairIntent: 'trim_silence', timeRange: { start: 70, end: 70.4 } }),
  ])
  assert.deepEqual(plan.steps.map((s) => [s.tool, s.arguments.startSeconds, s.arguments.endSeconds, s.arguments.ripple]), [
    ['extract_range', 50.25, 53.75, true],
    ['extract_range', 10.25, 11.75, true],
  ])
  assert.equal(plan.unrepaired.length, 1)
  assert.match(plan.unrepaired[0].why, /Too short/)
})

test('move_caption: the captions clip is re-placed inside the 9:16 safe area by FILM-2016 placement', () => {
  const doc = miniProject({ aspect: '9:16', shots: [{ start: 0, duration: 4 }], captions: { duration: 4, cues: [{ id: 'a', start: 0, end: 3, text: 'Short line' }] } })
  const plan = compile({ timeline: doc.timelines[0], assets: doc.assets }, {}, { issues: [issue({ type: 'caption_safe_area', repairIntent: 'move_caption', timeRange: { start: 0, end: 3 } })] }, policy)
  const [step] = plan.steps
  assert.equal(step.tool, 'update_caption_cues')
  assert.equal(step.arguments.clipId, 'clip-captions')
  assert.deepEqual(step.arguments.cues[0].globalOverrides.safeArea, { left: 0.05, right: 0.15, top: 0.08, bottom: 0.25 })
  assert.equal(step.arguments.cues[0].globalOverrides.aspect, '9:16')
  assert.match(plan.reasons[0], /not placed for the safe area; Style 1 cue\(s\) .*inside the 9:16 safe area/)
  // Applied, the clip passes FILM-2016's check.
  const fixed = applyPlan(doc, plan).timelines[0].clips.find((c) => c.id === 'clip-captions')
  assert.deepEqual(checkCaptionSafeArea({ cues: fixed.captions.cues, width: 1080, height: 1920, aspect: '9:16' }), [])
})

test('replace_missing_media: a missing shot holds on its own still; a missing line becomes a card', () => {
  const plan = run([
    issue({ type: 'missing_media', repairIntent: 'replace_missing_media', timeRange: { start: 94, end: 99 }, scene: 5 }),
    issue({ type: 'missing_media', repairIntent: 'replace_missing_media', timeRange: { start: 4.417, end: 6 }, scene: 1 }),
  ])
  assert.deepEqual(plan.steps, [{ tool: 'replace_clip_with_asset', arguments: { clipId: 'clip-20', assetId: 'sb-first-722805af-dcbd-43db-9a69-da86300d187d' } }])
  assert.match(plan.reasons[0], /no media \(not_generated\); its first frame holds the shot's place/)
  // Lines 3, 39 and 40 have no audio and no stand-in.
  assert.equal(plan.unrepaired.length, 3)
  assert.ok(plan.unrepaired.every((entry) => /regenerate it in StoryBook/.test(entry.why)))
})

test('add_fade: the FILM-2016 fade length per bus on the clip edges at the issue, never on dialogue', () => {
  const plan = run([issue({ type: 'hard_audio_edge', repairIntent: 'add_fade', timeRange: { start: 2.9, end: 3.1 } }), issue({ type: 'hard_audio_edge', repairIntent: 'add_fade', timeRange: { start: 4.9, end: 5.1 } })])
  assert.deepEqual(plan.steps, [{ tool: 'set_clip_audio', arguments: { clipId: 'clip-81', fadeInSeconds: 0.02, fadeOutSeconds: 0.02 } }])
  const end = run([issue({ type: 'hard_audio_edge', repairIntent: 'add_fade', timeRange: { start: 98.9, end: 99.1 } })])
  assert.ok(end.steps.some((s) => s.arguments.clipId === 'clip-80' && s.arguments.fadeOutSeconds === 0.5), JSON.stringify(end.steps))
  const dialogueOnly = run([issue({ type: 'abrupt_level_change', repairIntent: 'add_fade', timeRange: { start: 0.3, end: 0.5 } })])
  assert.ok(dialogueOnly.steps.every((s) => s.arguments.clipId !== 'clip-21'), 'the dialogue line is not faded')
})

test('re-time: a black gap is closed, an overlapping cue ends as the next begins, a long cut is handed to hit_duration', () => {
  const gap = run([issue({ type: 'black_frames', repairIntent: 're-time', timeRange: { start: 30, end: 31 } })])
  assert.deepEqual(gap.steps[0], { tool: 'extract_range', arguments: { startSeconds: 30, endSeconds: 31, trackIds: project.timelines[0].tracks.map((t) => t.id), ripple: true } })
  const doc = miniProject({ shots: [{ start: 0, duration: 4 }], captions: { duration: 4, cues: [{ id: 'a', start: 0, end: 3, text: 'one' }, { id: 'b', start: 2.5, end: 4, text: 'two' }] } })
  const overlap = compile({ timeline: doc.timelines[0], assets: doc.assets }, {}, { issues: [issue({ type: 'caption_overlap', repairIntent: 're-time', timeRange: { start: 2.5, end: 3 } })] }, policy)
  assert.deepEqual(overlap.steps, [{ tool: 'update_caption_cues', arguments: { clipId: 'clip-captions', edits: [{ id: 'a', endSeconds: 2.46 }] } }])
  const fixed = applyPlan(doc, overlap)
  assert.equal(fixed.timelines[0].clips.find((c) => c.id === 'clip-captions').captions.cues[0].end, 2.46)
  const long = run([issue({ type: 'duration', repairIntent: 're-time', detail: 'The cut runs 120.0 s' })])
  assert.deepEqual(long.steps, [])
  assert.match(long.unrepaired[0].why, /hit_duration/)
})

test('one plan for every issue: non-ripple edits first, ripple cuts last and latest first; no read tools; judgment issues become cards', () => {
  const doc = clone(project)
  doc.timelines[0].clips.find((c) => c.id === 'clip-80').metadata.origin.by = 'user'
  const plan = run([
    issue({ type: 'silence', repairIntent: 'trim_silence', timeRange: { start: 10, end: 12 } }),
    issue({ type: 'music_over_dialogue', repairIntent: 'duck_music', timeRange: { start: 0.4, end: 11 }, detail: 'Dialogue sits 4.0 dB above' }),
    issue({ type: 'loudness', repairIntent: 'normalize_loudness', detail: 'Integrated loudness is -12.0 LUFS; the reels_9x16 target is -16 LUFS' }),
    issue({ type: 'repeated_shot', detail: 'S1.3 repeats S1.1' }),
  ], doc)
  assert.deepEqual(plan.steps.map((s) => s.tool), ['set_audio_buses', 'set_audio_buses', 'extract_range'])
  assert.deepEqual(plan.touchesUserEdits, ['clip-80'], 'the hand-edited music clip is listed as touched')
  assert.equal(plan.unrepaired.length, 1)
  const writable = new Set(['set_audio_buses', 'set_master_audio', 'set_clip_audio', 'update_caption_cues', 'replace_clip_with_asset', 'extract_range'])
  for (const step of plan.steps) assert.ok(writable.has(step.tool))
  // Every intent the contract names compiles to something or to a card with a reason.
  for (const intent of REPAIR_INTENTS) {
    const result = run([issue({ type: 'x', repairIntent: intent, timeRange: { start: 2.9, end: 3.1 }, detail: 'Integrated loudness is -20.0 LUFS; the policy target is -14 LUFS. Dialogue sits 2.0 dB above' })])
    assert.ok(result.steps.length + result.unrepaired.length >= 1, intent)
  }
})
