// FILM-2016 AC1: the bus model. Tracks carry a bus; project.studio.audioBuses
// holds per-bus gain, ducking under dialogue (policy duckDb, 120 ms attack,
// 400 ms release) and the master's loudness target; the dialogue bus is
// never ducked; the rough-cut builder writes exactly what buses.js says.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AUDIO_BUSES,
  applyBusPatch,
  busForTrack,
  dbToGain,
  DEFAULT_DUCK_DB,
  defaultAudioBuses,
  DUCK_ATTACK_MS,
  DUCK_RELEASE_MS,
  duckedBuses,
  gainToDb,
  loudnessTargetFor,
  resolveAudioBuses,
  validateBusPatch,
} from '../../src/studio/audio/buses.js'
import { buildProject } from '../../src/studio/projectBuilder.js'
import { EditPolicySchema } from '../../src/studio/contracts/edit-policy.schema.mjs'
import { loadFixture, probesFor } from './helpers/rough-cut.mjs'

const policy = (patch = {}) => EditPolicySchema.parse(patch)

test('the five buses, in the order the builder lays tracks out', () => {
  assert.deepEqual([...AUDIO_BUSES], ['dialogue', 'music', 'sfx', 'ambience', 'shotaudio'])
})

test('defaults: music and shot audio duck under dialogue at the policy duckDb with 120 ms attack and 400 ms release; master carries the loudness target', () => {
  const buses = defaultAudioBuses(policy({ music: { duckDb: -11 }, loudnessTargetLufs: -16 }))
  assert.deepEqual(buses.music, { gainDb: 0, duckUnder: 'dialogue', duckDb: -11, attackMs: 120, releaseMs: 400 })
  assert.deepEqual(buses.shotaudio, { gainDb: 0, duckUnder: 'dialogue', duckDb: -11, attackMs: 120, releaseMs: 400 })
  assert.deepEqual(buses.dialogue, { gainDb: 0 })
  assert.deepEqual(buses.sfx, { gainDb: 0 })
  assert.deepEqual(buses.ambience, { gainDb: 0 })
  assert.deepEqual(buses.master, { limiterLufs: -16 })
  assert.equal(DEFAULT_DUCK_DB, -8)
  assert.equal(DUCK_ATTACK_MS, 120)
  assert.equal(DUCK_RELEASE_MS, 400)
})

test('the policy default duckDb is -8; music.duckUnderDialogue false leaves music unducked but shot audio still ducks', () => {
  assert.equal(defaultAudioBuses(policy()).music.duckDb, -8)
  const buses = defaultAudioBuses(policy({ music: { duckUnderDialogue: false } }))
  assert.equal(buses.music.duckUnder, null)
  assert.equal(buses.shotaudio.duckUnder, 'dialogue')
  assert.deepEqual(duckedBuses(buses), ['shotaudio'])
})

test('a preset loudness target wins over the policy; a preset name maps to the platform target', () => {
  assert.equal(loudnessTargetFor({ policy: policy() }), -14)
  assert.equal(loudnessTargetFor({ policy: policy({ loudnessTargetLufs: -18 }) }), -18)
  assert.equal(loudnessTargetFor({ preset: 'reels_9x16', policy: policy() }), -16)
  assert.equal(loudnessTargetFor({ preset: 'youtube_16x9', policy: policy({ loudnessTargetLufs: -18 }) }), -14)
  assert.equal(loudnessTargetFor({ preset: { name: 'x', audioLufs: -23 }, policy: policy() }), -23)
  assert.equal(loudnessTargetFor({ preset: 'master', policy: policy({ loudnessTargetLufs: -18 }) }), -18)
  assert.equal(defaultAudioBuses(policy(), { preset: 'reels_9x16' }).master.limiterLufs, -16)
})

test('resolve fills what a stored config leaves out and strips any ducking off the dialogue bus', () => {
  const resolved = resolveAudioBuses({ music: { gainDb: -3 }, dialogue: { gainDb: 1, duckUnder: 'music', duckDb: -6 } }, { policy: policy() })
  assert.deepEqual(resolved.dialogue, { gainDb: 1 })
  assert.deepEqual(resolved.music, { gainDb: -3, duckUnder: 'dialogue', duckDb: -8, attackMs: 120, releaseMs: 400 })
  assert.deepEqual(resolved.master, { limiterLufs: -14 })
  assert.equal(resolveAudioBuses(null), null)
})

test('a patch that ducks the dialogue bus is refused with a reason; a valid patch merges', () => {
  const current = defaultAudioBuses(policy())
  assert.match(validateBusPatch({ dialogue: { duckUnder: 'music' } }).join(' '), /dialogue bus is never ducked/)
  assert.match(validateBusPatch({ dialogue: { duckDb: -6 } }).join(' '), /dialogue bus is never ducked/)
  assert.match(validateBusPatch({ choir: { gainDb: 1 } }).join(' '), /unknown bus/)
  assert.match(validateBusPatch({ music: { duckDb: 4 } }).join(' '), /duckDb/)
  assert.match(validateBusPatch({ music: { gainDb: 40 } }).join(' '), /gainDb/)
  assert.match(validateBusPatch({ master: { limiterLufs: -2 } }).join(' '), /limiterLufs/)
  assert.throws(() => applyBusPatch(current, { dialogue: { duckUnder: 'music' } }), /never ducked/)
  const next = applyBusPatch(current, { music: { duckDb: -12, gainDb: -2 }, master: { limiterLufs: -16 } })
  assert.equal(next.music.duckDb, -12)
  assert.equal(next.music.gainDb, -2)
  assert.equal(next.music.attackMs, 120)
  assert.equal(next.master.limiterLufs, -16)
  assert.equal(current.music.duckDb, -8, 'the input is not mutated')
  assert.equal(applyBusPatch(current, { music: { duckUnder: null } }).music.duckUnder, null)
})

test('a track bus: its own field when valid, else none (unbussed tracks go straight to master)', () => {
  assert.equal(busForTrack({ type: 'audio', bus: 'music' }), 'music')
  assert.equal(busForTrack({ type: 'audio', bus: 'choir' }), null)
  assert.equal(busForTrack({ type: 'audio' }), null)
  assert.equal(busForTrack({ type: 'video', bus: 'music' }), null)
})

test('dB conversions', () => {
  assert.equal(dbToGain(0), 1)
  assert.ok(Math.abs(dbToGain(-8) - 0.398107) < 1e-6)
  assert.ok(Math.abs(gainToDb(0.5) + 6.0206) < 1e-4)
  assert.equal(gainToDb(0), -Infinity)
})

test('the rough-cut builder writes buses.js defaults onto the project and a bus onto every audio track', () => {
  for (const shots of [5, 20, 60]) {
    const pkg = loadFixture(shots)
    const { project } = buildProject({ package: pkg, probedAssets: probesFor(pkg) })
    const expected = defaultAudioBuses(EditPolicySchema.parse(pkg.editPolicy ?? {}))
    assert.deepEqual(project.studio.audioBuses, expected, `${shots} shots`)
    const audioTracks = project.timelines[0].tracks.filter((track) => track.type === 'audio')
    assert.ok(audioTracks.length > 0)
    for (const track of audioTracks) assert.ok(AUDIO_BUSES.includes(busForTrack(track)), `${shots}: ${track.id} ${track.bus}`)
    assert.equal(project.studio.audioBuses.dialogue.duckUnder, undefined)
  }
})
