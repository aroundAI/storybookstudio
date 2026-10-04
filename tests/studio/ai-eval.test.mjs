// FILM-2013: the nightly AI eval harness (scripts/ai-eval.mjs): its scoring,
// the release gate, the cost table, and one end-to-end run with the scripted
// oracle agent (no model, no cost). The model-driven run needs a configured
// model and is the owner's (phase 20 README, question 2).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { costOf, gate, oraclePlan, resolveInstruction, runEval, scoreRun, summarize } from '../../scripts/ai-eval.mjs'

const context = (scene3, duration, versions = 1) => ({
  sceneMap: [{ scene: 1, actualDuration: 10 }, { scene: 3, actualDuration: scene3 }],
  timeline: { duration },
  screenplay: [{ dialogue: [{ clipIds: ['a'] }, { clipIds: [] }] }],
  versions: Array.from({ length: versions }, (_, index) => ({ id: `v${index + 1}` })),
})

test('instructions resolve against the episode: scene 3 at 60%, the episode at 85%', () => {
  const resolved = resolveInstruction({ id: 'north-star', text: 'Tighten scene {scene} to {sceneTarget} s and fix the audio.', expect: { sceneTarget: true } }, context(21, 99))
  assert.deepEqual([resolved.text, resolved.scene, resolved.sceneTarget, resolved.target], ['Tighten scene 3 to 13 s and fix the audio.', 3, 13, 84])
  assert.deepEqual(oraclePlan(resolved).map((call) => [call.name, call.args.intent]), [['studio_edit', 'tighten_pacing'], ['studio_edit_audio', 'fade']])
})

test('a run is scored on the target within 5%, coverage, revisions and cost', () => {
  const resolved = { id: 'north-star', expect: { sceneTarget: true }, scene: 3, sceneTarget: 13 }
  const hit = scoreRun({ resolved, before: context(21, 99), after: context(13.4, 91, 2) })
  assert.deepEqual([hit.durationHit, hit.revisions, hit.scriptCoverage, hit.costUsd], [true, 1, 0.75, 0])
  assert.equal(scoreRun({ resolved, before: context(21, 99), after: context(13.917, 91, 2) }).durationHit, false)
  assert.equal(costOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), 6)
  assert.equal(costOf('some-other-model', { input_tokens: 1 }), null)
})

test('the gate fails a QA drop or a cost rise over 20%, and compares QA only when both runs measured it', () => {
  const base = { qaPassRate: 0.9, costUsd: 10 }
  assert.deepEqual(gate({ qaPassRate: 0.9, costUsd: 12 }, base), { ok: true, failures: [] })
  assert.match(gate({ qaPassRate: 0.8, costUsd: 10 }, base).failures[0], /QA pass rate fell: 0\.9 -> 0\.8/)
  assert.match(gate({ qaPassRate: 0.9, costUsd: 12.5 }, base).failures[0], /cost rose more than 20%/)
  assert.equal(gate({ qaPassRate: null, costUsd: 10 }, base).ok, true)
  assert.equal(summarize([{ score: { durationHit: true, qaPass: null, scriptCoverage: 1, revisions: 1, toolErrors: 0, costUsd: 0 } }]).qaReason, 'unmeasured: QA is FILM-2014 (studio_review not available yet)')
})

test('end to end with the oracle agent: one episode, two instructions, over MCP', async () => {
  const { runs, summary, verdict } = await runEval({ agent: 'oracle', episodes: ['e20-default'], instructions: ['hit-duration', 'hook'], maxTurns: 5 })
  assert.deepEqual(runs.map((run) => [run.instruction, run.text]), [['hit-duration', 'Make it 84 seconds.'], ['hook', 'Open with the strongest line.']])
  assert.equal(runs[0].score.durationHit, true)
  assert.equal(runs[0].score.durationAfter, 84)
  assert.equal(runs[0].score.revisions, 1)
  assert.equal(runs[0].score.scriptCoverage, 1)
  assert.deepEqual([summary.runs, summary.toolErrors, summary.costUsd], [2, 0, 0])
  assert.equal(verdict.ok, true)
})
