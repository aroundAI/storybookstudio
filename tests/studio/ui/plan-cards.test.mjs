// FILM-2015: plan cards are the unit of approval. A card names the scene,
// the duration change and each change with its reason, from either source
// (the in-app agent, an external MCP client, or a StoryBook re-sync).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  formatSeconds,
  formatDurationChange,
  normalizePlan,
  planAnnouncement,
  stepsForScenes,
} from '../../../src/studio/ui/planCards.js'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/ui/plan-90s.json', import.meta.url), 'utf8'))

test('durations read as seconds with one decimal, before → after', () => {
  assert.equal(formatSeconds(17.44), '17.4 s')
  assert.equal(formatSeconds(null), '—')
  assert.equal(formatDurationChange(17.4, 12.8), '17.4 s → 12.8 s')
})

test('an agent plan becomes one card per scene with each change and its reason', () => {
  const plan = normalizePlan(fixture)
  assert.equal(plan.planId, 'plan-fixture-90s')
  assert.equal(plan.source, 'agent')
  assert.equal(plan.instruction, 'make it 90 seconds')
  assert.deepEqual(plan.cards.map((card) => card.scene), [1, 2])
  const [first] = plan.cards
  assert.equal(first.title, 'Scene 1 · INT. RESEARCH LAB - NIGHT (1)')
  assert.equal(first.durationLabel, '19.0 s → 15.0 s')
  assert.equal(first.deltaLabel, '−4.0 s')
  assert.deepEqual(first.changes[0], {
    text: 'Remove S1.4 ARJUN reacts to the alarm (4.0 s)',
    reason: "Second reaction to the same alarm; the scene already lands on Maya's look.",
    clipIds: ['clip-4', 'clip-64'],
  })
  assert.equal(plan.totalLabel, '99.0 s → 90.0 s')
})

test('touches-your-edits entries are kept and attached to their scene card', () => {
  const plan = normalizePlan(fixture)
  assert.equal(plan.touchesUserEdits.length, 1)
  assert.equal(plan.cards[1].touchesUserEdits, true)
  assert.equal(plan.cards[0].touchesUserEdits, false)
})

test('a StoryBook re-sync proposal (steps, no cards) renders as cards grouped by scene', () => {
  const resync = {
    source: 'resync',
    planId: 'resync-v8-abc',
    summary: '1 changed shot, 1 removed shot',
    steps: [
      { tool: 'import_asset_from_path', arguments: { path: '/p/a.mp4', studioMeta: { reason: 'StoryBook has a new video for S2.1.', scene: 2 } }, reason: 'StoryBook has a new video for S2.1.' },
      { tool: 'replace_clip_with_asset', arguments: { clipId: 'clip-5', studioMeta: { reason: 'StoryBook has a new video for S2.1.', scene: 2 } }, reason: 'StoryBook has a new video for S2.1.' },
      { tool: 'delete_clips', arguments: { clipIds: ['clip-20'], studioMeta: { reason: 'S5.4 was removed in StoryBook.', scene: 5 } }, reason: 'S5.4 was removed in StoryBook.' },
    ],
    unresolved: [{ kind: 'shot', id: 'x', reason: 'the new video is not available yet' }],
  }
  const plan = normalizePlan(resync, { sceneHeadings: new Map([[2, 'LAB'], [5, 'ROOF']]) })
  assert.equal(plan.source, 'resync')
  assert.equal(plan.instruction, 'StoryBook changed: 1 changed shot, 1 removed shot')
  assert.deepEqual(plan.cards.map((card) => card.scene), [2, 5])
  assert.equal(plan.cards[0].title, 'Scene 2 · LAB')
  assert.equal(plan.cards[0].durationLabel, null)
  // The import and the replace that share a reason read as one change.
  assert.equal(plan.cards[0].changes.length, 1)
  assert.deepEqual(plan.cards[0].changes[0].clipIds, ['clip-5'])
  assert.equal(plan.cards[1].changes[0].reason, 'S5.4 was removed in StoryBook.')
  assert.deepEqual(plan.unresolved, ['the new video is not available yet'])
})

test('a step outside any scene lands on a card titled "Whole episode"', () => {
  const plan = normalizePlan({ source: 'mcp', planId: 'p', steps: [{ tool: 'set_track_volume', arguments: { trackId: 'audio-3' }, reason: 'Music sits under dialogue.' }] })
  assert.equal(plan.cards.length, 1)
  assert.equal(plan.cards[0].scene, null)
  assert.equal(plan.cards[0].title, 'Whole episode')
})

test('a payload without a plan id is refused, not rendered', () => {
  assert.equal(normalizePlan({ cards: [] }), null)
  assert.equal(normalizePlan(null), null)
})

test('the arrival announcement names the number of scenes and the total change', () => {
  assert.equal(planAnnouncement(normalizePlan(fixture)), 'Plan ready for “make it 90 seconds”: 2 scenes, 99.0 s → 90.0 s. It touches 1 of your edits. Review the cards to approve.')
})

test('approving one scene keeps only that scene’s steps and turns previews into applies', () => {
  const plan = normalizePlan(fixture)
  const steps = stepsForScenes(plan, [2])
  assert.equal(steps.length, 1)
  assert.deepEqual(steps[0].arguments.clipIds, ['clip-8', 'clip-68'])
  assert.equal(steps[0].arguments.previewOnly, false)
  assert.equal(steps[0].arguments.studioMeta.scene, 2)
  assert.equal(stepsForScenes(plan, null).length, 2)
  // The payload itself is not mutated.
  assert.equal(fixture.steps[0].arguments.previewOnly, true)
})

// FILM-2013's proposal event (electron/studio/mcpCapabilities.js previewPlan).
const capabilityProposal = {
  phase: 'proposed',
  planId: 'c0ffee00-0000-4000-8000-000000000001',
  source: 'in-app',
  intent: 'hit_duration',
  scope: {},
  params: { targetSeconds: 90 },
  instruction: 'Make the episode 90 seconds',
  expected: { durationBefore: 99, durationAfter: 90 },
  cards: [
    { scene: 1, heading: 'INT. LAB', durationBefore: 19, durationAfter: 15, targetDuration: 17, changes: [{ step: 1, tool: 'delete_clips', text: 'Remove S1.4', reason: 'Repeats the alarm beat.', scene: 1 }] },
  ],
  touchesUserEdits: ['clip-8'],
  reportText: 'Scene 1: 19.0 s -> 15.0 s',
}

test('a FILM-2013 proposal keeps what apply needs and maps its source', () => {
  const plan = normalizePlan(capabilityProposal)
  assert.equal(plan.source, 'agent')
  assert.equal(plan.instruction, 'Make the episode 90 seconds')
  assert.deepEqual(plan.capability, { tool: 'studio_edit', args: { intent: 'hit_duration', scope: {}, params: { targetSeconds: 90 } }, scoped: true })
  assert.equal(plan.phase, 'proposed')
  assert.equal(plan.totalLabel, '99.0 s → 90.0 s')
  assert.equal(plan.cards[0].changes[0].text, 'Remove S1.4')
  assert.deepEqual(plan.touchesUserEdits, [{ clipId: 'clip-8', scene: null, text: 'A clip you edited by hand (clip-8) is in this plan.' }])
  assert.equal(plan.reportText, 'Scene 1: 19.0 s -> 15.0 s')
  assert.equal(normalizePlan({ ...capabilityProposal, source: 'mcp' }).source, 'mcp')
  assert.equal(normalizePlan({ ...capabilityProposal, source: 'plan' }).source, 'mcp')
})

test('without an instruction the intent reads as words; an apply_updates plan is a StoryBook update', () => {
  const plan = normalizePlan({ ...capabilityProposal, instruction: undefined, params: { targetSeconds: 90 } })
  assert.equal(plan.instruction, 'Hit duration (target 90 s)')
  const resync = normalizePlan({ ...capabilityProposal, intent: 'apply_updates', instruction: undefined, params: {} })
  assert.equal(resync.source, 'resync')
  assert.deepEqual(resync.capability, { tool: 'studio_apply_updates', args: {}, scoped: false })
  assert.equal(resync.instruction, 'Apply the StoryBook update')
})

test('an applied event carries the version it created', () => {
  const plan = normalizePlan({ phase: 'applied', planId: capabilityProposal.planId, source: 'mcp', intent: 'hit_duration', versionId: 'v3', cards: capabilityProposal.cards })
  assert.equal(plan.phase, 'applied')
  assert.equal(plan.versionId, 'v3')
})

test('each capability tool gets back the arguments it previewed with', () => {
  const base = { phase: 'proposed', planId: 'p', source: 'in-app', cards: [] }
  assert.deepEqual(normalizePlan({ ...base, tool: 'studio_edit_audio', intent: 'audio:duck', scope: { scenes: [2] }, params: { duckDb: -12 } }).capability, { tool: 'studio_edit_audio', args: { intent: 'duck', scope: { scenes: [2] }, params: { duckDb: -12 } }, scoped: true })
  assert.deepEqual(normalizePlan({ ...base, tool: 'studio_add_captions', intent: 'captions:add_captions', scope: {}, params: { language: 'en', style: 'bold' } }).capability, { tool: 'studio_add_captions', args: { language: 'en', style: 'bold' }, scoped: false })
  const issues = [{ type: 'loudness', severity: 0.7 }]
  assert.deepEqual(normalizePlan({ ...base, tool: 'studio_repair', intent: 'repair', scope: {}, params: { issues } }).capability, { tool: 'studio_repair', args: { issues }, scoped: false })
  assert.equal(normalizePlan({ ...base, tool: 'studio_repair', intent: 'repair', params: { issues } }).instruction, 'Repair')
})
