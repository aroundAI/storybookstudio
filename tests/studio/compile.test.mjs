// FILM-2013: every intent compiler on the 20-shot fixture rough cut: the
// steps and reasons, the policy bounds, user-edited clips left alone or
// listed, and the plan shape run_mcp_action_plan accepts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { COMPILER_TOOLS, STUDIO_EDIT_INTENTS, buildDraftReport, buildPlanCards, compileIntent, previewIntent, readsFor, validatePlan } from '../../src/studio/compile.js'
import { simulatePlan } from '../../src/studio/simulate.js'
import { clipEnd, clipStart, dialogueClips, pictureClips, sceneDuration, sceneOfClip, voicedIntervals } from '../../src/studio/intents/shared.js'
import { lineImportance } from '../../src/studio/intents/common.js'
import { ExplainWhyReportSchema } from '../../src/studio/contracts/explain-why-report.schema.mjs'
import { extractWritable } from '../../scripts/capability-matrix.mjs'
import { clipByName, contextFor } from './helpers/compile-fixture.mjs'

const writable = extractWritable(readFileSync(new URL('../../electron/mcpServer.js', import.meta.url), 'utf8'))
const after = (context, plan) => simulatePlan(context.timeline, plan.steps, { fps: context.fps, assets: context.assets }).timeline
const overlaps = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]))
const cutsOf = (plan) => plan.steps.filter((step) => step.tool === 'extract_range').map((step) => [step.arguments.startSeconds, step.arguments.endSeconds])

test('every tool a compiler may emit is in MCP_ACTION_PLAN_WRITABLE_TOOLS (G3: split_clip, extract_range, set_clip_speed, set_clip_audio, update_caption_cues added)', () => {
  assert.deepEqual(COMPILER_TOOLS.filter((tool) => !writable.has(tool)), [])
  for (const tool of ['split_clip', 'extract_range', 'set_clip_speed', 'set_clip_audio', 'update_caption_cues']) assert.ok(writable.has(tool), tool)
  assert.ok(!writable.has('studio_deliver'), 'studio_deliver stays a separate confirmed step')
  assert.deepEqual(STUDIO_EDIT_INTENTS, ['hit_duration', 'tighten_pacing', 'remove_dead_air', 'open_with_strongest_line', 'keep_music_under_dialogue', 'add_broll', 'emphasize', 'add_cta', 'match_brand', 'reorder_scenes', 'recut_around_drops', 'punch_in', 'ken_burns', 'speed_ramp', 'freeze_frame', 'color_grade'])
})

test('tighten_pacing(scene 3, 12 s): get_audio_analysis on its dialogue, ripple cuts of the silences only, captions, beds and markers re-timed, and the card says why 12 s is not reached', () => {
  const context = contextFor()
  const reads = readsFor('tighten_pacing', context, { scene: 3 })
  assert.equal(reads.length, 8)
  assert.ok(reads.every((read) => read.tool === 'get_audio_analysis' && read.arguments.clipId))

  const plan = compileIntent({ intent: 'tighten_pacing', context, scope: { scene: 3 }, params: { targetSeconds: 12 }, writable: [...writable] })
  assert.deepEqual(plan.steps.map((step) => step.tool), [
    'extract_range', 'extract_range', 'extract_range', 'extract_range', 'extract_range', 'extract_range',
    'update_caption_cues', 'trim_clips', 'trim_clips', 'trim_clips', 'set_timeline_marker_properties', 'set_timeline_marker_properties',
  ])
  assert.equal(plan.reasons.length, plan.steps.length)
  assert.ok(plan.reasons.every(Boolean))
  assert.deepEqual(cutsOf(plan).map(([a, b]) => [a, Math.round(b * 24) / 24].map((v) => Math.round(v * 1000) / 1000)), [[59, 60], [56, 57.417], [53.5, 54.417], [51, 51.917], [44, 45.417], [41, 42.417]])
  assert.deepEqual(cutsOf(plan), [...cutsOf(plan)].sort((a, b) => b[0] - a[0]), 'latest cut first, so each one runs in the timeline it was planned on')
  assert.match(plan.reasons[0], /Dead air of 1\.0 s between line 24 and line 25; pauses over 0\.6 s are cut/)
  assert.match(plan.changes[4], /S3\.1 \/ S3\.2/)
  assert.match(plan.changes[5], /inside S3\.1, a jump cut/)
  // No cut touches a voiced dialogue span.
  const voiced = voicedIntervals(context.timeline)
  for (const cut of cutsOf(plan)) assert.equal(voiced.reduce((sum, span) => sum + overlaps(span, cut), 0), 0, `cut ${cut} overlaps dialogue`)
  // Captions are re-timed, never cut; the music and ambience beds end with the picture.
  const extractTracks = plan.steps[0].arguments.trackIds
  assert.ok(!extractTracks.includes('video-2'), 'the captions track is re-timed, not cut')
  assert.ok(!extractTracks.includes('audio-3') && !extractTracks.includes('audio-5'), 'music and ambience beds are not cut mid-phrase')

  assert.equal(plan.expected.durationBefore, 99)
  assert.equal(plan.expected.perScene.find((entry) => entry.scene === 3).before, 21)
  assert.equal(plan.expected.perScene.find((entry) => entry.scene === 3).after, 13.917)
  assert.equal(plan.expected.durationAfter, 91.917)
  assert.ok(plan.notes.some((note) => note.scene === 3 && /21\.0 s -> 13\.9 s; the 12\.0 s target is not reached without cutting dialogue: 8 lines run 12\.7 s/.test(note.text)), JSON.stringify(plan.notes))

  const timeline = after(context, plan)
  for (const clip of pictureClips(timeline)) assert.ok(clip.duration >= context.policy.minShotLength - 1e-6, `${clip.id} ${clip.duration}`)
  // Every other scene keeps its length and its marker stays on its first shot.
  for (const scene of [1, 2, 4, 5]) assert.equal(sceneDuration(timeline, scene), sceneDuration(context.timeline, scene))
  const scene4 = Math.min(...pictureClips(timeline).filter((clip) => sceneOfClip(clip) === 4).map(clipStart))
  assert.equal(Math.round(timeline.markers.find((marker) => marker.scene === 4).time * 1000), Math.round(scene4 * 1000))
})

test('tighten_pacing reaches a target it can reach, within 5%, cutting only as much as it needs', () => {
  // get_audio_analysis found 0.3 s of silence at the end of every scene-3 line.
  const base = contextFor()
  const analysis = new Map(dialogueClips(base.timeline).filter((clip) => sceneOfClip(clip) === 3)
    .map((clip) => [clip.id, { clip: { silencesTimeline: [{ start: clipEnd(clip) - 0.3, end: clipEnd(clip) }] } }]))
  const context = contextFor({ audioAnalysis: analysis })
  const plan = compileIntent({ intent: 'tighten_pacing', context, scope: { scene: 3 }, params: { targetSeconds: 12 } })
  const scene3 = plan.expected.perScene.find((entry) => entry.scene === 3).after
  assert.ok(Math.abs(scene3 - 12) <= 0.6, `scene 3 is ${scene3}`)
  assert.ok(scene3 >= 12 - 1 / 24, 'does not overshoot the target')
  assert.ok(plan.notes.some((note) => note.scene === 3 && /21\.0 s -> 12\.0 s, within 5% of the 12\.0 s target/.test(note.text)), JSON.stringify(plan.notes))
})

test('tighten_pacing respects the policy: no shot ends under minShotLength, and the card says which pauses stayed', () => {
  const context = contextFor({ policy: { minShotLength: 3.6, maxShotLength: 6 } })
  const plan = compileIntent({ intent: 'tighten_pacing', context, scope: { scene: 3 }, params: { targetSeconds: 12 } })
  const timeline = after(context, plan)
  // Every piece, including the ones a jump cut leaves, is at least the minimum.
  for (const clip of pictureClips(timeline).filter((candidate) => sceneOfClip(candidate) === 3)) {
    assert.ok(clip.duration >= 3.6 - 1e-6, `${clip.name} ${clip.id} ${clip.duration}`)
  }
  const kept = pictureClips(context.timeline).filter((clip) => sceneOfClip(clip) === 3).map((clip) => {
    const lost = cutsOf(plan).reduce((sum, cut) => sum + overlaps([clipStart(clip), clipEnd(clip)], cut), 0)
    return clip.duration - lost
  })
  assert.ok(kept.every((length) => length >= 3.6 - 1e-6), JSON.stringify(kept))
  assert.ok(plan.expected.perScene.find((entry) => entry.scene === 3).after > 13.917, 'the policy stops some cuts')
})

test('tighten_pacing leaves clips you edited since the last plan alone, or lists them under "touches your edits" with includeUserEdits', () => {
  const base = contextFor()
  const s32 = clipByName(base, 'S3.2')
  const userEdited = { userEditedClipIds: [s32.id] }
  const context = { ...base, ...userEdited }
  const plan = compileIntent({ intent: 'tighten_pacing', context, scope: { scene: 3 } })
  for (const cut of cutsOf(plan)) assert.equal(overlaps([clipStart(s32), clipEnd(s32)], cut), 0, `cut ${cut} touches S3.2`)
  assert.deepEqual(plan.touchesUserEdits, [])
  assert.ok(plan.notes.some((note) => /you edited by hand since the last plan/.test(note.text)))

  const forced = compileIntent({ intent: 'tighten_pacing', context, scope: { scene: 3 }, params: { includeUserEdits: true } })
  assert.ok(forced.touchesUserEdits.includes(s32.id))
  const card = buildPlanCards(forced, context).find((entry) => entry.scene === 3)
  assert.deepEqual(card.touchesYourEdits.map((entry) => entry.label), ['S3.2'])
})

test('the user-edit window starts at the last AI plan: an edit before it no longer counts', () => {
  const base = contextFor()
  const s32 = clipByName(base, 'S3.2')
  const patch = { fields: {}, collections: { timelines: { restore: [], remove: [], revert: [{ id: base.timeline.id, patch: { fields: {}, collections: { clips: { restore: [], remove: [], revert: [{ id: s32.id, item: s32 }] } } } }] } } }
  const edit = { op: 2, by: 'user', tool: 'resizeClip', args: {}, inverse: { tool: 'studio_apply_patch', args: { patch } }, versionId: 'v1' }
  const versionOp = (op, id) => ({ op, by: 'ai', tool: 'studio_create_version', args: { versionId: id }, inverse: null, versionId: id })
  assert.deepEqual(contextFor({ log: [versionOp(1, 'v1'), edit] }).userEditedClipIds, [s32.id])
  assert.deepEqual(contextFor({ log: [versionOp(1, 'v1'), edit, versionOp(3, 'v2')] }).userEditedClipIds, [])
})

test('remove_dead_air cuts only spans with no voiced dialogue, over the whole episode', () => {
  const context = contextFor()
  const plan = compileIntent({ intent: 'remove_dead_air', context, scope: {} })
  const voiced = voicedIntervals(context.timeline)
  assert.ok(cutsOf(plan).length > 5)
  for (const cut of cutsOf(plan)) assert.equal(voiced.reduce((sum, span) => sum + overlaps(span, cut), 0), 0)
  assert.ok(plan.reasons.every(Boolean))
  assert.ok(plan.expected.durationAfter < plan.expected.durationBefore)
})

test('hit_duration brings the episode within 5% of the target or says why, and every scene keeps a shot', () => {
  const context = contextFor()
  const plan = compileIntent({ intent: 'hit_duration', context, scope: {}, params: { targetSeconds: 80 } })
  const timeline = after(context, plan)
  for (const scene of [1, 2, 3, 4, 5]) assert.ok(pictureClips(timeline).some((clip) => sceneOfClip(clip) === scene), `scene ${scene} has a shot`)
  const reached = Math.abs(plan.expected.durationAfter - 80) <= 4
  assert.ok(reached || plan.notes.some((note) => /not reached/.test(note.text)), JSON.stringify(plan.notes))
  assert.throws(() => compileIntent({ intent: 'hit_duration', context, scope: { scene: 3 } }), /needs params\.targetSeconds/)
})

test('open_with_strongest_line moves the highest-importance line and its shot to 0:00, beds stay, the hook type is reported', () => {
  const context = contextFor()
  // Over the whole episode the strongest line (line 1) already opens it.
  assert.match(compileIntent({ intent: 'open_with_strongest_line', context, scope: {} }).notes[0].text, /Line 1 \(importance 0\.4\) already opens the episode/)
  const lines = context.screenplay.filter((scene) => scene.scene === 3).flatMap((scene) => scene.dialogue)
  const best = lines.reduce((top, line) => (lineImportance(line) > lineImportance(top) ? line : top))
  const plan = compileIntent({ intent: 'open_with_strongest_line', context, scope: { scene: 3 } })
  assert.equal(plan.hookType, 'strongest_line')
  const timeline = after(context, plan)
  const lineClip = timeline.clips.find((clip) => clip.id === best.clipIds[0])
  const shot = pictureClips(timeline).find((clip) => clipStart(clip) <= clipStart(lineClip) + 1e-6 && clipEnd(clip) > clipStart(lineClip))
  assert.equal(clipStart(shot), 0)
  assert.match(plan.reasons[0], new RegExp(`line ${best.sequenceNumber} .*importance ${lineImportance(best)}`))
  assert.equal(plan.expected.durationAfter, plan.expected.durationBefore)
  const draft = buildDraftReport(plan, context, { prompt: 'Open with the strongest line' })
  assert.equal(draft.report.style.hookType, 'strongest_line')
})

test('keep_music_under_dialogue reports the music bus ducking (FILM-2016 renders it) and plans no primitive', () => {
  const plan = compileIntent({ intent: 'keep_music_under_dialogue', context: contextFor(), scope: {} })
  assert.equal(plan.steps.length, 0)
  assert.match(plan.notes[0].text, /duck -8 dB under dialogue.*dialogue bus is never ducked/)
})

test('add_broll: nothing to place without b-roll in the library; with one, it goes on a B-roll track after the scene\'s first line', () => {
  assert.match(compileIntent({ intent: 'add_broll', context: contextFor(), scope: { scene: 2 } }).notes[0].text, /No b-roll in the library/)
  const context = contextFor({
    mutate: (project) => project.assets.push({ id: 'broll-1', name: 'Rain on the lab window', type: 'video', role: 'broll', duration: 6, semantic: { scene: null, purpose: 'rain on window, research lab', characters: [] } }),
  })
  const plan = compileIntent({ intent: 'add_broll', context, scope: { scene: 2 }, params: { query: 'rain window' } })
  assert.deepEqual(plan.steps.map((step) => step.tool), ['add_track', 'add_asset_to_timeline'])
  const firstLine = dialogueClips(context.timeline).find((clip) => sceneOfClip(clip) === 2)
  assert.ok(plan.steps[1].arguments.startSeconds >= clipEnd(firstLine) - 1 / 24)
  assert.equal(plan.steps[1].arguments.trackId, 'video-3')
})

test('emphasize: a punch-in over the strongest line, capped at 110% while the policy avoids extreme zoom', () => {
  const plan = compileIntent({ intent: 'emphasize', context: contextFor(), scope: { scene: 4 }, params: { zoomPercent: 150 } })
  assert.equal(plan.steps[0].tool, 'set_clip_keyframes')
  assert.equal(Math.max(...plan.steps[0].arguments.keyframes.map((frame) => frame.value)), 110)
  assert.match(plan.reasons[0], /capped by the policy/)
  const free = compileIntent({ intent: 'emphasize', context: contextFor({ policy: { visual: { avoidExtremeZoom: false } } }), scope: { scene: 4 }, params: { zoomPercent: 150 } })
  assert.equal(Math.max(...free.steps[0].arguments.keyframes.map((frame) => frame.value)), 120)
})

test('add_cta: needs text (no brand outro); placed in the last 10 s from the end of the final line, in the brand heading font', () => {
  const context = contextFor()
  assert.throws(() => compileIntent({ intent: 'add_cta', context, scope: {} }), /needs params\.text/)
  const plan = compileIntent({ intent: 'add_cta', context, scope: {}, params: { text: 'Watch episode 2' } })
  const text = plan.steps.find((step) => step.tool === 'add_text_clip').arguments
  const finalLineEnd = clipEnd(dialogueClips(context.timeline).at(-1))
  assert.ok(text.startSeconds >= 99 - 10 - 1e-6)
  assert.ok(Math.abs(text.startSeconds - Math.max(finalLineEnd, 89)) <= 1 / 24 + 1e-6 || text.startSeconds === 97)
  assert.equal(text.style.fontFamily, context.brand.fonts.heading)
})

test('match_brand: a dissolve brand adds one dissolve per scene change at the policy maximum; a cut brand changes nothing here', () => {
  const plan = compileIntent({ intent: 'match_brand', context: contextFor({ brand: { transitionStyle: 'dissolve' } }), scope: {} })
  assert.equal(plan.steps.length, 4)
  assert.ok(plan.steps.every((step) => step.tool === 'add_transition' && step.arguments.durationSeconds === 0.4))
  assert.ok(plan.reasons.every((reason) => /brand\.transitionStyle is "dissolve"/.test(reason)))
  assert.equal(compileIntent({ intent: 'match_brand', context: contextFor(), scope: {} }).steps.length, 0)
})

test('reorder_scenes moves scene blocks and keeps the clips of a scene in their order', () => {
  const context = contextFor()
  const plan = compileIntent({ intent: 'reorder_scenes', context, scope: {}, params: { order: [2, 1, 3, 4, 5] } })
  const timeline = after(context, plan)
  const firstOf = (scene) => Math.min(...pictureClips(timeline).filter((clip) => sceneOfClip(clip) === scene).map(clipStart))
  assert.equal(firstOf(2), 0)
  assert.equal(firstOf(1), 20)
  assert.equal(firstOf(3), 39)
  const order = (tl, scene) => pictureClips(tl).filter((clip) => sceneOfClip(clip) === scene).sort((a, b) => clipStart(a) - clipStart(b)).map((clip) => clip.id)
  assert.deepEqual(order(timeline, 1), order(context.timeline, 1))
  assert.throws(() => compileIntent({ intent: 'reorder_scenes', context, scope: {}, params: { order: [2, 1] } }), /every placed scene once/)
})

test('recut_around_drops: no measured drops, no plan, and it says so; with drops it cuts silence within 5 s of each', () => {
  const none = compileIntent({ intent: 'recut_around_drops', context: contextFor(), scope: {} })
  assert.equal(none.steps.length, 0)
  assert.match(none.notes[0].text, /No measured audience drops for this episode \(no_published_video\).*never guessed/)
  const base = contextFor()
  const context = { ...base, analyticsHints: { retention: [{ atSeconds: 44.5, dropPercent: 12 }], reason: null } }
  const plan = compileIntent({ intent: 'recut_around_drops', context, scope: {} })
  assert.ok(cutsOf(plan).length > 0)
  for (const [a, b] of cutsOf(plan)) assert.ok(a >= 39.5 - 1e-6 && b <= 49.5 + 1e-6)
  assert.match(plan.reasons[0], /viewers dropped at 0:44\.5 \(-12%\)/)
})

test('a plan that breaks the A1 shape is refused: misaligned reasons, a read tool, too many steps', () => {
  assert.deepEqual(validatePlan({ steps: [{ tool: 'extract_range', arguments: {} }], reasons: [] }).length, 2)
  assert.match(validatePlan({ steps: [{ tool: 'find_timeline_items', arguments: {} }], reasons: ['x'] })[0], /not a plan-writable tool/)
  const many = Array.from({ length: 51 }, () => ({ tool: 'trim_clips', arguments: {} }))
  assert.match(validatePlan({ steps: many, reasons: many.map(() => 'r') })[0], /over the 50-step limit/)
  assert.throws(() => compileIntent({ intent: 'tighten_pacing', context: contextFor(), scope: { scene: 9 } }), /Scene 9 is not in this episode/)
  assert.throws(() => compileIntent({ intent: 'make_it_pop', context: contextFor(), scope: {} }), /Unknown intent/)
})

test('cards and the draft report are deterministic and the report parses as ExplainWhyReportSchema', () => {
  const one = previewIntent({ intent: 'tighten_pacing', context: contextFor(), scope: { scene: 3 }, params: { targetSeconds: 12 } })
  const two = previewIntent({ intent: 'tighten_pacing', context: contextFor(), scope: { scene: 3 }, params: { targetSeconds: 12 } })
  assert.deepEqual(one.cards, two.cards)
  const scene3 = one.cards.find((card) => card.scene === 3)
  assert.deepEqual([scene3.durationBefore, scene3.durationAfter, scene3.targetDuration, scene3.changes.length], [21, 13.917, 12, 6])
  assert.ok(scene3.changes.every((change) => change.text && change.reason))
  const parsed = ExplainWhyReportSchema.safeParse(one.report)
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 2)))
  assert.match(one.reportText, /Scene 3 {2}21\.0 s -> 13\.9 s/)
  assert.match(one.reportText, /Trimmed {2}S3\.1 .* 6\.0 s -> 3\.6 s {2}Dead air of 1\.4 s between line 17 and line 18/)
})

test('the report\'s durations are where the picture ends, not a captions clip that outlasts it', () => {
  const context = contextFor({ mutate: (project) => { project.timelines[0].clips.find((clip) => clip.type === 'captions').duration = 120 } })
  const { report, text } = buildDraftReport(compileIntent({ intent: 'tighten_pacing', context, scope: { scene: 3 }, params: { targetSeconds: 12 } }), context)
  assert.equal(report.explain.durationBefore, 99)
  assert.match(text, /Duration: 99\.0 s -> 91\.9 s/)
})
