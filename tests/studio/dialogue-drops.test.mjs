// FILM-2013 follow-up: hit_duration's second tier. When cutting silence
// cannot reach the target (the dialogue fills the scenes, as on t2015's
// seeded episode), it drops whole lines, the least important first, and the
// edit policy decides who may: allowDialogueCuts never | ask (default) | allow.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildProject } from '../../src/studio/projectBuilder.js'
import { buildStudioContext } from '../../src/studio/context.js'
import { compileIntent } from '../../src/studio/compile.js'
import { simulatePlan } from '../../src/studio/simulate.js'
import { clipEnd, clipStart, pictureClips, sceneOfClip, voicedIntervals } from '../../src/studio/intents/shared.js'
import { lineImportance } from '../../src/studio/intents/common.js'
import { normalizePlan } from '../../src/studio/ui/planCards.js'
import { loadFixture, probesFor } from './helpers/rough-cut.mjs'
import { denseDialogue } from './helpers/dense-dialogue.mjs'

const pkg = denseDialogue(loadFixture(20))
const { project, files } = buildProject({ package: pkg, probedAssets: probesFor(pkg) })
const contextWith = (policy = {}, brand = {}) => buildStudioContext({
  project,
  document: { currentTimelineId: project.currentTimelineId, timelines: project.timelines, assets: project.assets },
  storybook: { package: JSON.parse(files['storybook/package.json']), policy: { ...JSON.parse(files['storybook/policy.json']), ...policy }, brand: { ...JSON.parse(files['storybook/brand.json']), ...brand } },
})
const hit = (context, params = {}) => compileIntent({ intent: 'hit_duration', context, scope: {}, params: { targetSeconds: 90, ...params } })
const after = (context, plan) => simulatePlan(context.timeline, plan.steps, { fps: context.fps }).timeline
const cutsOf = (plan) => plan.steps.filter((step) => step.tool === 'extract_range').map((step) => [step.arguments.startSeconds, step.arguments.endSeconds])

test('the policy flag defaults to ask and is read from the policy, else the brand payload', () => {
  assert.equal(contextWith().policy.allowDialogueCuts, 'ask')
  assert.equal(contextWith({ allowDialogueCuts: 'never' }).policy.allowDialogueCuts, 'never')
  assert.equal(contextWith({}, { allowDialogueCuts: 'allow' }).policy.allowDialogueCuts, 'allow')
  assert.equal(contextWith({ allowDialogueCuts: 'sometimes' }).policy.allowDialogueCuts, 'ask')
})

test('ask (the default): silence cannot reach 90 s, so the plan applies nothing to dialogue and proposes the drops apart', () => {
  const context = contextWith()
  const plan = hit(context)
  assert.equal(plan.dialogueCuts, 'ask')
  assert.deepEqual(plan.droppedLines, [])
  assert.equal(plan.expected.durationAfter, 99, 'no pause in this episode is over the 0.6 s limit')
  assert.equal(plan.proposals.length, 1)
  const [proposal] = plan.proposals
  assert.equal(proposal.kind, 'dialogue_drops')
  assert.equal(proposal.title, 'Needs your OK: drops 3 lines')
  assert.equal(proposal.durationAfter, 90)
  assert.match(proposal.why, /needs 9\.0 s more, which only dialogue can give.*allowDialogueCuts: ask/)
  assert.deepEqual(proposal.approveWith.params, { targetSeconds: 90, approveDialogueDrops: true })
  for (const line of proposal.lines) {
    assert.ok(line.text.startsWith(`Line ${line.sequenceNumber}:`))
    assert.match(line.reason, /^Importance 0\.1, the lowest left in scene \d; the scene keeps line \d+ \(0\.4\)/)
  }
  // A shot that only carried a dropped line goes with it, and the proposal says so.
  const withShot = proposal.lines.find((line) => line.alsoRemovesShots.length)
  assert.deepEqual(withShot?.alsoRemovesShots, ['S5.2'])
  assert.match(withShot.reason, /S5\.2 goes too, since only this line plays over the rest of it \(a shorter piece would be under the 1\.2 s minimum\)$/)
})

test('approved (or allow): the drops apply, the episode lands on 90.0 s, each scene keeps its strongest line, no shot piece under the minimum', () => {
  for (const [label, plan, context] of [['approved', hit(contextWith(), { approveDialogueDrops: true }), contextWith()], ['allow', hit(contextWith({ allowDialogueCuts: 'allow' })), contextWith({ allowDialogueCuts: 'allow' })]]) {
    assert.equal(plan.expected.durationAfter, 90, label)
    assert.equal(plan.droppedLines.length, 3, label)
    assert.deepEqual(plan.proposals, [], label)
    const timeline = after(context, plan)
    for (const clip of pictureClips(timeline)) assert.ok(clip.duration >= context.policy.minShotLength - 1e-6, `${label}: ${clip.name} ${clip.duration}`)
    // Every scene keeps its strongest line, and only dropped lines' speech is cut.
    const dropped = new Set(plan.droppedLines)
    for (const scene of context.screenplay) {
      const strongest = scene.dialogue.reduce((best, line) => (lineImportance(line) > lineImportance(best) ? line : best))
      assert.ok(!dropped.has(strongest.lineId), `${label}: scene ${scene.scene} lost its strongest line`)
    }
    const keptSpeech = voicedIntervals({ ...context.timeline, clips: context.timeline.clips.filter((clip) => !dropped.has(clip.metadata?.storybook?.dialogueId)) })
    for (const [a, b] of cutsOf(plan)) {
      const overlap = keptSpeech.reduce((sum, [x, y]) => sum + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0)
      assert.ok(overlap < 1e-6, `${label}: cut ${a}-${b} touches a kept line`)
    }
    assert.ok(plan.reasons.some((reason) => /^Least important line left in scene \d \(importance 0\.1; the scene keeps line \d+ at 0\.4\); dropped toward the 90\.0 s target/.test(reason)), label)
  }
})

test('never: no drops and no proposal; the card says the policy forbids cutting dialogue', () => {
  const plan = hit(contextWith({ allowDialogueCuts: 'never' }), { approveDialogueDrops: true })
  assert.deepEqual([plan.droppedLines.length, plan.proposals.length, plan.expected.durationAfter], [0, 0, 99])
  assert.ok(plan.notes.some((note) => /does not allow cutting dialogue \(allowDialogueCuts: never\)/.test(note.text)))
})

test('when silence reaches the target, no line is proposed (the original fixture: 99 → 90 s from pauses alone)', () => {
  const original = loadFixture(20)
  const built = buildProject({ package: original, probedAssets: probesFor(original) })
  const context = buildStudioContext({ project: built.project, document: { currentTimelineId: built.project.currentTimelineId, timelines: built.project.timelines, assets: built.project.assets }, storybook: { package: original, policy: original.editPolicy, brand: original.brand } })
  const plan = hit(context)
  assert.deepEqual([plan.proposals.length, plan.droppedLines.length], [0, 0])
  assert.ok(Math.abs(plan.expected.durationAfter - 90) <= 4.5)
})

test('the panel shows the proposal apart, with each line and the call that asks for it', () => {
  const plan = hit(contextWith())
  const normalized = normalizePlan({ planId: 'p1', intent: 'hit_duration', tool: 'studio_edit', scope: {}, params: { targetSeconds: 90 }, cards: [], proposals: plan.proposals.map((entry) => ({ ...entry, approveWith: { tool: 'studio_edit', arguments: { intent: 'hit_duration', scope: {}, params: entry.approveWith.params, previewOnly: true } } })) })
  assert.equal(normalized.proposals.length, 1)
  assert.equal(normalized.proposals[0].title, 'Needs your OK: drops 3 lines')
  assert.match(normalized.proposals[0].lines[0].label, /^Scene \d · line \d+ · (MAYA|ARJUN)$/)
  assert.deepEqual(normalized.proposals[0].approveWith.arguments.params, { targetSeconds: 90, approveDialogueDrops: true })
  assert.deepEqual(normalizePlan({ planId: 'p2', intent: 'tighten_pacing', cards: [] }).proposals, [])
})
