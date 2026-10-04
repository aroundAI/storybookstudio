// FILM-2016 AC4: studio_edit_audio intents compile to primitives and bus
// changes, each step with a reason, over the 20-shot rough cut. Steps are
// then applied to a copy of the project the way the tools would (bus patch
// through buses.js, set_clip_audio as gain and fades) to check the outcome
// the plan promised.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compileAudioIntent, DEFAULT_DIALOGUE_OVER_MUSIC_DB, FADE_AT_CUT_SECONDS } from '../../src/studio/intents/audio.js'
import { applyBusPatch, resolveAudioBuses } from '../../src/studio/audio/buses.js'
import { buildProject } from '../../src/studio/projectBuilder.js'
import { loadFixture, probesFor } from './helpers/rough-cut.mjs'

const roughCut = () => {
  const pkg = loadFixture(20)
  const { project } = buildProject({ package: pkg, probedAssets: probesFor(pkg) })
  const timeline = project.timelines[0]
  return { project, timeline, context: { timeline, audioBuses: project.studio.audioBuses } }
}
const busOf = (timeline, clip) => timeline.tracks.find((track) => track.id === clip.trackId)?.bus
const clipsOn = (timeline, bus) => timeline.clips.filter((clip) => clip.type === 'audio' && busOf(timeline, clip) === bus)
const everyStepHasAReason = (plan) => {
  for (const entry of plan.steps) {
    assert.ok(typeof entry.arguments.studioMeta?.reason === 'string' && entry.arguments.studioMeta.reason.length > 10, JSON.stringify(entry))
    assert.equal('previewOnly' in entry.arguments, false, 'the runner decides preview vs apply')
  }
  assert.equal(plan.reasons.length >= plan.steps.length, true)
}

// Apply a plan to a copy the way set_audio_buses and set_clip_audio would.
const apply = (plan, { timeline, audioBuses }) => {
  const next = { timeline: JSON.parse(JSON.stringify(timeline)), audioBuses: resolveAudioBuses(audioBuses) }
  for (const { tool, arguments: args } of plan.steps) {
    if (tool === 'set_audio_buses') next.audioBuses = applyBusPatch(next.audioBuses, args.buses)
    else if (tool === 'set_clip_audio') {
      for (const id of args.clipIds || [args.clipId]) {
        const clip = next.timeline.clips.find((entry) => entry.id === id)
        if ('gainDb' in args) clip.gainDb = args.gainDb
        if ('fadeInSeconds' in args) clip.fadeIn = args.fadeInSeconds
        if ('fadeOutSeconds' in args) clip.fadeOut = args.fadeOutSeconds
      }
    } else throw new Error(`unexpected tool ${tool}`)
  }
  return next
}

test('duck: compiles to one set_audio_buses with the policy duckDb, 120 ms attack, 400 ms release; the dialogue bus is refused', () => {
  const { context } = roughCut()
  const off = { ...context, audioBuses: applyBusPatch(resolveAudioBuses(context.audioBuses), { music: { duckUnder: null } }) }
  const plan = compileAudioIntent({ intent: 'duck', context: off, policy: { music: { duckDb: -10 } } })
  everyStepHasAReason(plan)
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0].tool, 'set_audio_buses')
  assert.deepEqual(plan.steps[0].arguments.buses, { music: { duckUnder: 'dialogue', duckDb: -10, attackMs: 120, releaseMs: 400 } })
  assert.match(plan.reasons[0], /policy music\.duckDb -10 dB/)
  // adjust depth on music and shot audio
  const deeper = compileAudioIntent({ intent: 'duck', params: { duckDb: -14, buses: ['music', 'shotaudio'] }, context })
  assert.deepEqual(Object.keys(deeper.steps[0].arguments.buses), ['music', 'shotaudio'])
  assert.equal(apply(deeper, context).audioBuses.shotaudio.duckDb, -14)
  // already so: no step
  assert.equal(compileAudioIntent({ intent: 'duck', context }).steps.length, 0)
  // never the dialogue bus; out-of-range duck refused
  assert.equal(compileAudioIntent({ intent: 'duck', params: { buses: ['dialogue'] }, context }).refused.code, 'VALIDATION_FAILED')
  assert.match(compileAudioIntent({ intent: 'duck', params: { duckDb: 6 }, context }).refused.reason, /duckDb/)
  // off
  const stop = compileAudioIntent({ intent: 'duck', params: { enabled: false }, context })
  assert.deepEqual(stop.steps[0].arguments.buses, { music: { duckUnder: null } })
})

test('normalize: the master target from the preset (or policy) on the master bus, dialogue lines levelled with set_clip_audio', () => {
  const { context, timeline } = roughCut()
  const lines = clipsOn(timeline, 'dialogue').slice(0, 4)
  const loudness = Object.fromEntries(lines.map((clip, index) => [clip.id, { integratedLufs: [-14, -20, -9, -14.3][index] }]))
  const plan = compileAudioIntent({ intent: 'normalize', params: { preset: 'reels_9x16' }, context: { ...context, loudness } })
  everyStepHasAReason(plan)
  assert.deepEqual(plan.steps[0], { tool: 'set_audio_buses', arguments: { buses: { master: { limiterLufs: -16 } }, studioMeta: plan.steps[0].arguments.studioMeta } })
  assert.equal(plan.expected.masterLufs, -16)
  assert.equal(plan.expected.toleranceLu, 1)
  const gains = Object.fromEntries(plan.steps.filter((entry) => entry.tool === 'set_clip_audio').map((entry) => [entry.arguments.clipId, entry.arguments.gainDb]))
  assert.deepEqual(gains, { [lines[0].id]: -2, [lines[1].id]: 4, [lines[2].id]: -7, [lines[3].id]: -1.7 })
  assert.ok(plan.reasons.some((reason) => /no loudness measurement/.test(reason)), 'unmeasured lines are said, not guessed')
  // policy target when no preset; nothing to do at target
  const policyPlan = compileAudioIntent({ intent: 'normalize', context, policy: { loudnessTargetLufs: -18 } })
  assert.equal(policyPlan.steps[0].arguments.buses.master.limiterLufs, -18)
  assert.equal(compileAudioIntent({ intent: 'normalize', context }).steps.length, 0, 'master already -14, no measured lines')
})

test('balance: per-scene dialogue-to-music ratio to 12 dB, via the music bus and dialogue clip gain; refused without measurements', () => {
  const { context, timeline } = roughCut()
  assert.equal(compileAudioIntent({ intent: 'balance', context }).refused.reason.startsWith('unmeasured'), true)
  const scenes = [1, 2]
  const dialogue = clipsOn(timeline, 'dialogue').filter((clip) => scenes.includes(clip.metadata.semantic.scene))
  const [bed] = clipsOn(timeline, 'music')
  // Music bed measured at -20 LUFS (clip gain -4.44 dB, ducked -8): heard at -32.44.
  // Scene 1 lines at -26 LUFS (6.4 dB over), scene 2 lines at -22 (10.4 dB over).
  const loudness = { [bed.id]: { integratedLufs: -20 } }
  for (const clip of dialogue) loudness[clip.id] = { integratedLufs: clip.metadata.semantic.scene === 1 ? -26 : -22 }
  const scope = { scenes }
  const plan = compileAudioIntent({ intent: 'balance', scope, context: { ...context, loudness } })
  everyStepHasAReason(plan)
  assert.equal(plan.expected.targetRatioDb, DEFAULT_DIALOGUE_OVER_MUSIC_DB)
  assert.equal(plan.steps[0].tool, 'set_audio_buses')
  // median ratio 8.44 → music bus −3.56 dB; then scene 1 (−2 dB residual) raises its lines 2 dB, scene 2 (+2) lowers 2 dB
  assert.equal(plan.steps[0].arguments.buses.music.gainDb, -3.56)
  for (const segment of plan.expected.segments) assert.ok(Math.abs(segment.ratioDbAfter - 12) <= 1, JSON.stringify(segment))
  const lineSteps = plan.steps.filter((entry) => entry.tool === 'set_clip_audio')
  assert.ok(lineSteps.length > 0)
  for (const entry of lineSteps) assert.ok([1, 2].includes(entry.arguments.studioMeta.scene))
  // Applying the plan and re-measuring by the same arithmetic meets the target.
  const after = apply(plan, { ...context, loudness })
  const heard = (clip, bus) => loudness[clip.id].integratedLufs + (after.timeline.clips.find((entry) => entry.id === clip.id).gainDb || 0) + after.audioBuses[bus].gainDb
  for (const scene of scenes) {
    const line = dialogue.find((clip) => clip.metadata.semantic.scene === scene)
    const ratio = heard(line, 'dialogue') - (heard(bed, 'music') + after.audioBuses.music.duckDb)
    assert.ok(Math.abs(ratio - 12) <= 1, `scene ${scene} at ${ratio}`)
  }
  // a custom ratio
  assert.equal(compileAudioIntent({ intent: 'balance', scope, params: { ratioDb: 8.44 }, context: { ...context, loudness } }).steps.filter((entry) => entry.tool === 'set_audio_buses').length, 0)
})

test('fade: set_clip_audio fades where audio meets a picture cut, never longer than half the clip, grouped by bus', () => {
  const { context, timeline } = roughCut()
  const plan = compileAudioIntent({ intent: 'fade', context })
  everyStepHasAReason(plan)
  assert.ok(plan.steps.length > 0)
  for (const entry of plan.steps) {
    assert.equal(entry.tool, 'set_clip_audio')
    for (const id of entry.arguments.clipIds) {
      const clip = timeline.clips.find((candidate) => candidate.id === id)
      for (const key of ['fadeInSeconds', 'fadeOutSeconds']) if (key in entry.arguments) assert.ok(entry.arguments[key] <= clip.duration / 2 + 1e-9)
    }
  }
  const shot = plan.steps.find((entry) => /shotaudio/.test(entry.arguments.studioMeta.reason))
  assert.ok(shot, 'shot audio is cut with its picture')
  assert.equal(shot.arguments.fadeInSeconds ?? shot.arguments.fadeOutSeconds, FADE_AT_CUT_SECONDS.shotaudio)
  // applied: a second compile has nothing left to do
  const after = apply(plan, context)
  assert.equal(compileAudioIntent({ intent: 'fade', context: { ...context, timeline: after.timeline } }).steps.length, 0)
  // explicit length, capped at half a 1.58 s line
  const long = compileAudioIntent({ intent: 'fade', params: { seconds: 5 }, context })
  for (const entry of long.steps) for (const key of ['fadeInSeconds', 'fadeOutSeconds']) if (key in entry.arguments) assert.ok(entry.arguments[key] <= 99 / 2)
})

test('an unknown intent or a project without buses is refused, never a partial plan', () => {
  const { context } = roughCut()
  assert.equal(compileAudioIntent({ intent: 'louder', context }).refused.code, 'VALIDATION_FAILED')
  const plain = { timeline: context.timeline, audioBuses: null }
  for (const intent of ['duck', 'normalize', 'balance']) assert.ok(compileAudioIntent({ intent, context: plain }).refused, intent)
})

test("FILM-2013's call form: positional args, loudness from get_audio_analysis reads, reads() lists what is unmeasured, touchesUserEdits", async () => {
  const { reads } = await import('../../src/studio/intents/audio.js')
  const { context, timeline } = roughCut()
  const scope = { scenes: [1] }
  const wanted = reads(context, scope, { intent: 'balance' })
  assert.ok(wanted.length > 0)
  assert.ok(wanted.every((entry) => entry.tool === 'get_audio_analysis' && entry.arguments.includeLoudnessCurve === false))
  const [bed] = clipsOn(timeline, 'music')
  assert.ok(wanted.some((entry) => entry.arguments.clipId === bed.id), 'the bed is read for a scene-scoped balance')
  assert.deepEqual(reads(context, scope, { intent: 'duck' }), [])
  // compile.js passes the analysis results as a Map
  const audioAnalysis = new Map(wanted.map((entry) => [entry.arguments.clipId, { loudness: { integratedLufsApprox: entry.arguments.clipId === bed.id ? -20 : -26 } }]))
  const firstLine = clipsOn(timeline, 'dialogue').find((clip) => clip.metadata.semantic.scene === 1)
  const full = { ...context, reads: { audioAnalysis }, userEditedClipIds: new Set([firstLine.id]) }
  assert.deepEqual(reads(full, scope, { intent: 'balance' }), [], 'nothing left to read')
  const plan = compileAudioIntent('balance', full, scope, {}, {})
  assert.equal(plan.refused, undefined)
  everyStepHasAReason(plan)
  assert.deepEqual(plan.touchesUserEdits, [], 'one scene: only the music bus moves')
  const levelled = compileAudioIntent('normalize', full, scope, {}, {})
  assert.ok(levelled.touchesUserEdits.includes(firstLine.id), 'levelling the hand-edited line is flagged')
  assert.deepEqual(compileAudioIntent('duck', context, 'episode', { duckDb: -12 }, {}).steps[0].arguments.buses.music.duckDb, -12)
})
