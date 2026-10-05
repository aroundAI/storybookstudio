// FILM-2018 AC5: the semantic effects compile to set_clip_keyframes,
// split_clip and add_glsl_effect on the 20-shot fixture rough cut, with a
// reason per step, inside the policy, leaving hand-edited shots alone; and
// what the steps do to playback (src/utils/clipPlaybackTiming.js, the timing
// the preview and the exporter share) is what the reasons say.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { COMPILER_TOOLS, STUDIO_EDIT_INTENTS, buildPlanCards, compileIntent, previewIntent } from '../../src/studio/compile.js'
import { simulatePlan } from '../../src/studio/simulate.js'
import { EFFECT_INTENTS, FILM_LOOKS, MIN_RAMP_SPEED } from '../../src/studio/intents/effects.js'
import { clipEnd, clipStart, pictureClips, sceneOfClip } from '../../src/studio/intents/shared.js'
import { getClipPlaybackTimingAtTimeline } from '../../src/utils/clipPlaybackTiming.js'
import { extractWritable } from '../../scripts/capability-matrix.mjs'
import { clipByName, contextFor } from './helpers/compile-fixture.mjs'

const writable = extractWritable(readFileSync(new URL('../../electron/mcpServer.js', import.meta.url), 'utf8'))
const compile = (intent, scope = {}, params = {}, context = contextFor()) => compileIntent({ intent, context, scope, params, writable: [...writable] })
const after = (context, plan) => simulatePlan(context.timeline, plan.steps, { fps: context.fps, assets: context.assets }).timeline
const sourceAt = (clip, time) => getClipPlaybackTimingAtTimeline(clip, time, 0).time
const frames = (plan, property) => plan.steps.find((step) => step.tool === 'set_clip_keyframes').arguments.keyframes
  .filter((frame) => frame.property === property).map((frame) => [frame.timeSeconds, frame.value, frame.easing])

test('the five effects are studio_edit intents, and every tool they emit is plan-writable (add_glsl_effect added)', () => {
  assert.deepEqual(EFFECT_INTENTS, ['punch_in', 'ken_burns', 'speed_ramp', 'freeze_frame', 'color_grade'])
  for (const intent of EFFECT_INTENTS) assert.ok(STUDIO_EDIT_INTENTS.includes(intent), intent)
  assert.ok(COMPILER_TOOLS.includes('add_glsl_effect'))
  assert.deepEqual(COMPILER_TOOLS.filter((tool) => !writable.has(tool)), [])
})

test('punch_in: a cut to 110% on the frame the strongest line of scene 4 starts, back at its end, capped by the policy', () => {
  const context = contextFor()
  const plan = compile('punch_in', { scene: 4 }, { zoomPercent: 150 }, context)
  assert.deepEqual(plan.steps.map((step) => step.tool), ['set_clip_keyframes'])
  const shot = context.timeline.clips.find((clip) => clip.id === plan.steps[0].arguments.clipId)
  assert.equal(sceneOfClip(shot), 4)
  const scale = frames(plan, 'scaleX')
  assert.deepEqual(scale.map(([, value]) => value), scale.length === 3 ? [100, 110, 100] : [110, 100])
  assert.ok(scale.every(([, , easing]) => easing === 'hold'), 'a cut, not a push')
  assert.deepEqual(frames(plan, 'scaleY'), scale)
  assert.match(plan.reasons[0], /^Punch-in: a cut to 110% on line \d+ \(importance [\d.]+, the strongest in scope\), held until \d:\d\d\.\d; capped by the policy \(avoid extreme zoom\)$/)
  const free = compile('punch_in', { scene: 4 }, { zoomPercent: 115 }, contextFor({ policy: { visual: { avoidExtremeZoom: false } } }))
  assert.ok(frames(free, 'scaleX').some(([, value]) => value === 115))
  // After the plan the shot reads 100% before the line, 110% during it.
  const timeline = after(context, plan)
  const punched = timeline.clips.find((clip) => clip.id === shot.id)
  assert.deepEqual(punched.keyframes.scaleX.map((frame) => frame.value), scale.map(([, value]) => value))
})

test('ken_burns: no stills in the fixture, so it says so; on a named shot it zooms 105% -> 110% and pans right inside the frame', () => {
  const none = compile('ken_burns', { scene: 2 })
  assert.equal(none.steps.length, 0)
  assert.match(none.notes[0].text, /No still images in scope; pass params\.clipId/)
  const context = contextFor()
  const s21 = clipByName(context, 'S2.1')
  const plan = compile('ken_burns', {}, { clipId: s21.id }, context)
  assert.deepEqual(frames(plan, 'scaleX'), [[0, 105, 'linear'], [s21.duration, 110, 'linear']])
  // 1920 px at 105% leaves 48 px a side; 90% of it is used.
  assert.deepEqual(frames(plan, 'positionX'), [[0, 43, 'linear'], [s21.duration, -43, 'linear']])
  assert.match(plan.reasons[0], /105% -> 110%, panning right 86 px, inside the 105% frame so no edge shows \(direction in, the default when it is left out\) \(pan right, the default when it is left out\); capped by the policy/)
  const out = compile('ken_burns', {}, { clipId: s21.id, direction: 'out', pan: 'up' }, context)
  assert.deepEqual(frames(out, 'scaleX').map(([, value]) => value), [110, 105])
  assert.deepEqual(frames(out, 'positionY'), [[0, -24, 'linear'], [s21.duration, 24, 'linear']])
  assert.throws(() => compile('ken_burns', {}, { clipId: s21.id, pan: 'diagonal' }), /params\.pan is one of/)
  assert.throws(() => compile('ken_burns', {}, { clipId: 'clip-21' }), /not a picture clip/)
})

test('speed_ramp: eases to 0.5x on the moment, holds 1 s, eases out, and splits there so the rest of the shot is back on its sound', () => {
  const context = contextFor()
  const s21 = clipByName(context, 'S2.1')
  const at = clipStart(s21) + 1
  const plan = compile('speed_ramp', {}, { atSeconds: at }, context)
  assert.deepEqual(plan.steps.map((step) => step.tool), ['split_clip', 'set_clip_keyframes'])
  assert.deepEqual(plan.steps[0].arguments, { clipIds: [s21.id], timeSeconds: at + 1.25 })
  assert.deepEqual(frames(plan, 'speed'), [[0, 1, 'linear'], [0.75, 1, 'linear'], [1, 0.5, 'linear'], [2, 0.5, 'linear'], [2.25, 1, 'linear']])
  assert.match(plan.reasons[0], /^Splits S2\.1 at \d:\d\d\.\d where the speed ramp ends, so the rest of the shot plays in sync with its sound$/)
  assert.match(plan.reasons[1], /Slow motion at 0\.5x on \d:\d\d\.\d as asked: eases in over 0\.3 s, holds 1\.0 s, eases out \(speed 0\.5x, the default when it is left out\) \(holdSeconds 1 s, the default when it is left out\); the shot keeps its length$/)
  assert.equal(plan.expected.durationAfter, plan.expected.durationBefore, 'a ramp keeps the timeline length')

  // Playback: the left piece is slow over the hold; the right piece starts on
  // the source time the shot had there before the ramp (in sync).
  const timeline = after(context, plan)
  const left = timeline.clips.find((clip) => clip.id === s21.id)
  const right = timeline.clips.find((clip) => clip.id.startsWith(`${s21.id}~`))
  assert.equal(clipEnd(left), at + 1.25)
  assert.ok(Math.abs((sourceAt(left, at + 1) - sourceAt(left, at)) - 0.5) < 0.01, 'half speed over the hold')
  assert.ok(Math.abs(sourceAt(right, clipStart(right)) - sourceAt(s21, at + 1.25)) < 1e-6, 'the rest resumes in sync')
  assert.equal(clipEnd(right), clipEnd(s21))

  const lagging = compile('speed_ramp', {}, { atSeconds: at, resync: false }, context)
  assert.deepEqual(lagging.steps.map((step) => step.tool), ['set_clip_keyframes'])
  assert.match(lagging.reasons[0], /its picture runs 0\.6 s behind its sound after the ramp/)
  assert.throws(() => compile('speed_ramp', {}, { atSeconds: at, speed: 2 }), /slow-motion speed from 0\.05.*would freeze/)
})

test('freeze_frame: holds the frame at the moment for 1 s at the ramp floor while the sound plays on, then the shot resumes in sync', () => {
  const context = contextFor()
  const s32 = clipByName(context, 'S3.2')
  const at = clipStart(s32) + 1.5
  const plan = compile('freeze_frame', {}, { atSeconds: at }, context)
  assert.deepEqual(plan.steps.map((step) => step.tool), ['split_clip', 'set_clip_keyframes'])
  assert.equal(plan.steps[0].arguments.timeSeconds, at + 1)
  assert.deepEqual(frames(plan, 'speed'), [[0, 1, 'hold'], [1.5, MIN_RAMP_SPEED, 'hold']])
  assert.match(plan.reasons[1], /^Freezes the picture on \d:\d\d\.\d as asked for 1\.0 s while the sound plays on \(holdSeconds 1 s, the default when it is left out\); the hold is the speed ramp's floor \(0\.05x, 1\.2 source frames over the hold\)$/)
  assert.deepEqual(buildPlanCards(plan, context).map((card) => card.changes.length), [2])

  const timeline = after(context, plan)
  const left = timeline.clips.find((clip) => clip.id === s32.id)
  const right = timeline.clips.find((clip) => clip.id.startsWith(`${s32.id}~`))
  const held = sourceAt(left, at + 1 - 1e-3) - sourceAt(left, at)
  assert.ok(held <= MIN_RAMP_SPEED + 1e-3, `the picture moves ${held} s of source over the 1 s hold`)
  assert.ok(Math.abs(sourceAt(right, at + 1) - sourceAt(s32, at + 1)) < 1e-6, 'after the hold the shot is where it would have been')
  // At a shot's last second the hold runs to the end and there is no split.
  const tail = compile('freeze_frame', {}, { atSeconds: clipEnd(s32) - 0.5 }, context)
  assert.deepEqual(tail.steps.map((step) => step.tool), ['set_clip_keyframes'])
  assert.match(tail.reasons[0], /for 0\.5 s .*, to the end of the shot$/)
})

test('color_grade: one film look per shot of scene 3, replacing an earlier one; an unknown look is refused with the list', () => {
  const context = contextFor()
  const plan = compile('color_grade', { scene: 3 }, {}, context)
  const shots = pictureClips(context.timeline).filter((clip) => sceneOfClip(clip) === 3)
  assert.equal(plan.steps.length, shots.length)
  assert.ok(plan.steps.every((step) => step.tool === 'add_glsl_effect' && step.arguments.effectType === 'glslFilmLook' && step.arguments.presetId === 'kodak2395' && step.arguments.replaceExisting === true))
  assert.match(plan.reasons[0], /^Grades S3\.1 with the Kodak 2395 film look \(look kodak2395, the default when it is left out\); an earlier film look on the shot is replaced, not stacked$/)
  const twice = after({ ...context, timeline: after(context, plan) }, plan)
  assert.ok(twice.clips.filter((clip) => sceneOfClip(clip) === 3 && clip.trackId === 'video-1').every((clip) => clip.effects.length === 1), 're-grading does not stack')
  const bw = compile('color_grade', { scene: 1 }, { look: 'bw', blend: 60 }, context)
  assert.deepEqual(bw.steps[0].arguments.settings, { blend: 60 })
  assert.match(bw.reasons[0], /B&W film look at 60% blend; an earlier/)
  assert.throws(() => compile('color_grade', {}, { look: 'teal_orange' }), /params\.look is one of kodak2395, agfa1978, polaroid, bw/)
})

test('the film looks are glslFilmLook\'s presets in src/utils/effects.js', () => {
  const source = readFileSync(new URL('../../src/utils/effects.js', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf("id: 'glslFilmLook'"), source.indexOf("id: 'glslFlicker'"))
  const presets = [...block.matchAll(/\{ id: '([a-z0-9]+)', label: '([^']+)'/g)].map((match) => [match[1], match[2]])
  assert.deepEqual(presets, Object.entries(FILM_LOOKS))
})

test('a shot edited by hand is left alone with a note, or graded and listed under "touches your edits" with includeUserEdits', () => {
  const base = contextFor()
  const s31 = clipByName(base, 'S3.1')
  const context = { ...base, userEditedClipIds: [s31.id] }
  const plan = compile('color_grade', { scene: 3 }, {}, context)
  assert.ok(!plan.steps.some((step) => step.arguments.clipId === s31.id))
  assert.ok(plan.notes.some((note) => /S3\.1 was edited by hand since the last plan; pass includeUserEdits to color grade it anyway/.test(note.text)))
  const forced = compile('color_grade', { scene: 3 }, { includeUserEdits: true }, context)
  assert.deepEqual(forced.touchesUserEdits, [s31.id])
  const frozen = compile('freeze_frame', {}, { clipId: s31.id }, context)
  assert.equal(frozen.steps.length, 0)
})

test('every effect previews to cards and a draft report with one change per step and a reason each', () => {
  const context = contextFor()
  const s21 = clipByName(context, 'S2.1')
  const cases = { punch_in: [{ scene: 4 }, {}], ken_burns: [{}, { clipId: s21.id }], speed_ramp: [{ scene: 2 }, {}], freeze_frame: [{ scene: 2 }, {}], color_grade: [{ scene: 2 }, {}] }
  for (const [intent, [scope, params]] of Object.entries(cases)) {
    const preview = previewIntent({ intent, context, scope, params })
    const changes = preview.cards.flatMap((card) => card.changes)
    assert.equal(changes.length, preview.plan.steps.length, intent)
    assert.ok(changes.every((change) => change.text && change.reason), intent)
    assert.equal(preview.report.aiOps, preview.plan.steps.length, intent)
  }
})
