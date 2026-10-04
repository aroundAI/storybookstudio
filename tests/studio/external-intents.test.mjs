// FILM-2013: FILM-2016's compilers register into compile.js when the build
// has them, and their results are adapted to the A1 plan shape. A fake module
// with FILM-2016's exported call forms stands in for intents/audio.js here;
// the real one is exercised once both branches are on main.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compileIntent, hasIntent, readsFor } from '../../src/studio/compile.js'
import { AUDIO_MODULE, CAPTIONS_MODULE, externalScope, registerExternalIntents } from '../../src/studio/externalIntents.js'
import { contextFor } from './helpers/compile-fixture.mjs'

test('scope converts to FILM-2016\'s form', () => {
  assert.equal(externalScope({}), 'episode')
  assert.deepEqual(externalScope({ scene: 3 }), { scenes: [3] })
  assert.deepEqual(externalScope({ range: [1, 4], clipIds: ['c'] }), { range: { start: 1, end: 4 }, clipIds: ['c'] })
})

test('a build without FILM-2016 registers nothing; with its modules, audio:<intent> and captions:add_captions compile to A1 plans', () => {
  assert.deepEqual(registerExternalIntents({}), [])
  assert.equal(hasIntent('audio:duck'), false)
  const calls = []
  const audio = {
    AUDIO_INTENTS: ['balance', 'duck', 'normalize', 'fade'],
    reads: (context, scope, params) => [{ tool: 'get_audio_analysis', arguments: { clipId: 'x', intent: params.intent, scope } }],
    compileAudioIntent: (intent, context, scope, params, policy) => {
      calls.push({ intent, scope, hasSet: context.userEditedClipIds instanceof Set, buses: Boolean(context.audioBuses), duck: policy.music.duckDb })
      const music = context.timeline.clips.find((clip) => clip.metadata?.bus === 'music')
      return {
        steps: [
          { tool: 'set_audio_buses', arguments: { buses: { music: { duckDb: -10 } }, studioMeta: { reason: 'Music masks dialogue', scene: null } } },
          { tool: 'set_clip_audio', arguments: { clipIds: [music.id], fadeOutSeconds: 0.5, studioMeta: { reason: 'Fade the bed out', scene: 5 } } },
        ],
        reasons: ['Music masks dialogue', 'Fade the bed out'],
        expected: { buses: { music: { duckDb: -10 } } },
        touchesUserEdits: [],
      }
    },
  }
  const captions = {
    captionsClipFor: (context, language) => context.timeline.clips.find((clip) => clip.type === 'captions' && clip.metadata?.language === language) || null,
    compileCaptionsPlacement: (context, cues, params) => ({ steps: [{ tool: 'update_caption_cues', arguments: { clipId: 'clip-83', cues, studioMeta: { reason: 'brand style' } } }], reasons: [`Style ${cues.length} cues for ${params.language}`], expected: {} }),
  }
  assert.deepEqual(registerExternalIntents({ [AUDIO_MODULE]: audio, [CAPTIONS_MODULE]: captions }), ['audio:balance', 'audio:duck', 'audio:normalize', 'audio:fade', 'captions:add_captions'])

  const context = contextFor()
  assert.deepEqual(readsFor('audio:balance', context, { scene: 2 }, {}), [{ tool: 'get_audio_analysis', arguments: { clipId: 'x', intent: 'balance', scope: { scenes: [2] } } }])
  const plan = compileIntent({ intent: 'audio:duck', context, scope: {}, params: {}, writable: ['set_audio_buses', 'set_clip_audio'] })
  assert.deepEqual(calls[0], { intent: 'duck', scope: 'episode', hasSet: true, buses: true, duck: -8 })
  assert.deepEqual(plan.steps.map((step) => [step.tool, 'studioMeta' in step.arguments]), [['set_audio_buses', false], ['set_clip_audio', false]])
  assert.deepEqual(plan.reasons, ['Music masks dialogue', 'Fade the bed out'])
  assert.deepEqual(plan.scenes, [null, 5])
  assert.equal(plan.changes[0], 'Buses music duckDb -10')
  assert.match(plan.changes[1], /fade out 0\.50 s/)
  assert.equal(plan.expected.durationAfter, 99)
  assert.throws(() => compileIntent({ intent: 'audio:duck', context, scope: {}, params: {}, writable: ['set_clip_audio'] }), /set_audio_buses is not a plan-writable tool/)

  const styled = compileIntent({ intent: 'captions:add_captions', context, scope: {}, params: { language: 'en' }, writable: ['update_caption_cues'] })
  assert.equal(styled.reasons[0], 'Style 40 cues for en')
  assert.throws(() => compileIntent({ intent: 'captions:add_captions', context, scope: {}, params: { language: 'hi' }, writable: ['update_caption_cues'] }), /no hi cues to style\. Transcribe first/)
})

test('FILM-2014\'s repair compiler registers as the repair intent when the build has it', async () => {
  const { REPAIR_MODULE } = await import('../../src/studio/externalIntents.js')
  const repair = {
    INTENT: 'repair',
    reads: () => [],
    compile: (context, scope, params) => ({ intent: 'repair', steps: [{ tool: 'set_master_audio', arguments: { volume: 1.2 } }], reasons: [`Fix ${params.issues.length} issue`], scenes: [null], changes: ['Master +1.6 dB'], touchesUserEdits: [], notes: [], expected: { durationBefore: 99, durationAfter: 99, perScene: [] } }),
  }
  assert.deepEqual(registerExternalIntents({ [REPAIR_MODULE]: repair }), ['repair'])
  const plan = compileIntent({ intent: 'repair', context: contextFor(), scope: {}, params: { issues: [{ type: 'loudness' }] }, writable: ['set_master_audio'] })
  assert.deepEqual([plan.steps[0].tool, plan.reasons[0]], ['set_master_audio', 'Fix 1 issue'])
})
