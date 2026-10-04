// FILM-2015: the instruction box turns the common requests into a FILM-2013
// studio_edit intent; anything else asks the user to rephrase (the in-app
// LLM agent, when wired, takes over).
import test from 'node:test'
import assert from 'node:assert/strict'
import { instructionToIntent, scopeArgument } from '../../../src/studio/ui/instructions.js'

test('durations: seconds, minutes and m:ss become hit_duration with targetSeconds', () => {
  assert.deepEqual(instructionToIntent('make it 90 seconds'), { intent: 'hit_duration', params: { targetSeconds: 90 } })
  assert.deepEqual(instructionToIntent('Cut it to 1.5 minutes'), { intent: 'hit_duration', params: { targetSeconds: 90 } })
  assert.deepEqual(instructionToIntent('trim to 1:30'), { intent: 'hit_duration', params: { targetSeconds: 90 } })
  assert.deepEqual(instructionToIntent('get this under 60s'), { intent: 'hit_duration', params: { targetSeconds: 60 } })
})

test('pacing, dead air, the hook and music under dialogue map to their intents', () => {
  assert.deepEqual(instructionToIntent('tighten this'), { intent: 'tighten_pacing', params: {} })
  assert.deepEqual(instructionToIntent('remove the dead air'), { intent: 'remove_dead_air', params: {} })
  assert.deepEqual(instructionToIntent('cut the long pauses'), { intent: 'remove_dead_air', params: {} })
  assert.deepEqual(instructionToIntent('open with the strongest line'), { intent: 'open_with_strongest_line', params: {} })
  assert.deepEqual(instructionToIntent('keep the music under the dialogue'), { intent: 'keep_music_under_dialogue', params: {} })
})

test('anything else is not guessed', () => {
  assert.equal(instructionToIntent('make it more emotional'), null)
  assert.equal(instructionToIntent(''), null)
})

test('the strip scope becomes FILM-2013’s scope argument: scenes win over clip ids', () => {
  assert.deepEqual(scopeArgument({ scenes: [3], clipIds: ['clip-9'] }), { scenes: [3] })
  assert.deepEqual(scopeArgument({ clipIds: ['clip-9'] }), { clipIds: ['clip-9'] })
  assert.deepEqual(scopeArgument(null), {})
})
