// FILM-2015 renderer integration: a plan proposed over the bridge
// (studio:plan-proposed) appears as cards in the studio store; approving
// calls apply; rejecting leaves the document unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createStudioUiStore } from '../../../src/studio/ui/studioStore.js'
import { startStudioUiBridge } from '../../../src/studio/ui/studioBridge.js'
import { approvePlan, rejectPlan, proposeInstruction, repairIssues } from '../../../src/studio/ui/planActions.js'

const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/ui/plan-90s.json', import.meta.url), 'utf8'))

// window.electronAPI.studio as the preload exposes it: invoke calls and on* subscriptions.
function fakeApi(extra = {}) {
  const listeners = new Map()
  const calls = []
  const on = (channel) => (callback) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel).add(callback)
    return () => listeners.get(channel).delete(callback)
  }
  const call = (name, answer = {}) => async (args) => {
    calls.push([name, args])
    return { success: true, ...answer }
  }
  const studio = {
    authStatus: call('authStatus', { status: { signedIn: true, user: { email: 'maya@example.com' }, team: { name: 'Acme Studios' } }, apiOrigin: 'http://localhost:3309' }),
    rendererReady: call('rendererReady'),
    networkOnline: call('networkOnline'),
    projectOpened: call('projectOpened'),
    projectClosed: call('projectClosed'),
    onAuthChanged: on('studio:auth-changed'),
    onJobProgress: on('studio:job-progress'),
    onPullReady: on('studio:pull-ready'),
    onOpenRequest: on('studio:open-request'),
    onPlanProposed: on('studio:plan-proposed'),
    ...extra,
  }
  const emit = (channel, payload) => { for (const callback of listeners.get(channel) || []) callback(payload) }
  return { api: { studio }, emit, calls, listeners }
}

// The document as the edit log sees it, and a step runner over it.
function fakeRunner() {
  const document = { clips: ['clip-1', 'clip-4', 'clip-8', 'clip-64', 'clip-68'] }
  const ran = []
  const versions = []
  const journal = []
  return {
    document,
    ran,
    versions,
    journal,
    runner: {
      currentVersionId: () => versions.at(-1)?.id ?? 'v1',
      createVersion: async (name, options) => {
        const version = { id: `v${versions.length + 2}`, name, ...options }
        versions.push(version)
        return version
      },
      runStep: async (tool, args) => {
        ran.push([tool, args])
        if (tool === 'delete_clips' && args.previewOnly === false) {
          document.clips = document.clips.filter((id) => !args.clipIds.includes(id))
        }
        return {}
      },
      writeJournal: async (entry) => { journal.push(entry) },
    },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('the bridge reports ready once it listens, and a proposed plan appears as cards with an announcement', async () => {
  const { api, emit, calls } = fakeApi()
  const store = createStudioUiStore()
  const stop = startStudioUiBridge({ api, store })
  await settle()
  assert.ok(calls.some(([name]) => name === 'rendererReady'), 'rendererReady is called after subscribing')
  assert.equal(store.getState().auth.signedIn, true)
  assert.equal(store.getState().auth.team.name, 'Acme Studios')

  emit('studio:plan-proposed', fixture())
  const [plan] = store.getState().plans
  assert.equal(plan.planId, 'plan-fixture-90s')
  assert.equal(plan.status, 'proposed')
  assert.deepEqual(plan.cards.map((card) => card.title), ['Scene 1 · INT. RESEARCH LAB - NIGHT (1)', 'Scene 2 · INT. RESEARCH LAB - NIGHT (2)'])
  assert.match(store.getState().announcement, /^Plan ready for “make it 90 seconds”/)
  assert.equal(store.getState().aiPanelOpen, true)

  // The same plan id again (an external client re-proposing) replaces, never duplicates.
  emit('studio:plan-proposed', { ...fixture(), instruction: 'make it 90 seconds please' })
  assert.equal(store.getState().plans.length, 1)
  assert.equal(store.getState().plans[0].instruction, 'make it 90 seconds please')
  stop()
  emit('studio:plan-proposed', { ...fixture(), planId: 'later' })
  assert.equal(store.getState().plans.length, 1, 'no events after stop')
})

test('Approve all with no main-process apply runs every step as an apply inside a new version', async () => {
  const { api, emit } = fakeApi()
  const store = createStudioUiStore()
  startStudioUiBridge({ api, store })
  emit('studio:plan-proposed', fixture())
  const { runner, ran, versions, document, journal } = fakeRunner()

  const result = await approvePlan({ store, api, runner, planId: 'plan-fixture-90s' })
  assert.equal(result.ok, true)
  assert.deepEqual(versions.map((v) => v.name), ['make it 90 seconds'])
  assert.equal(versions[0].by, 'ai')
  assert.deepEqual(ran.map(([tool, args]) => [tool, args.previewOnly, args.studioMeta.scene]), [['delete_clips', false, 1], ['delete_clips', false, 2]])
  assert.deepEqual(document.clips, ['clip-1'])
  const plan = store.getState().plans[0]
  assert.equal(plan.status, 'applied')
  assert.equal(plan.versionId, 'v2')
  assert.deepEqual(journal.map((entry) => entry.status), ['applying', 'applying', 'done'])
  assert.equal(journal[1].versionId, 'v2')
})

test('Approve scene applies only that scene’s steps', async () => {
  const { api, emit } = fakeApi()
  const store = createStudioUiStore()
  startStudioUiBridge({ api, store })
  emit('studio:plan-proposed', fixture())
  const { runner, document } = fakeRunner()
  await approvePlan({ store, api, runner, planId: 'plan-fixture-90s', scenes: [2] })
  assert.deepEqual(document.clips, ['clip-1', 'clip-4', 'clip-64'])
  assert.deepEqual(store.getState().plans[0].approvedScenes, [2])
})

test('when main provides applyPlan (FILM-2013), approve calls it and runs nothing locally', async () => {
  const applyCalls = []
  const { api, emit } = fakeApi({
    applyPlan: async (args) => { applyCalls.push(args); return { success: true, versionId: 'v7' } },
  })
  const store = createStudioUiStore()
  startStudioUiBridge({ api, store })
  emit('studio:plan-proposed', fixture())
  const { runner, ran, document } = fakeRunner()
  await approvePlan({ store, api, runner, planId: 'plan-fixture-90s', scenes: [1] })
  assert.deepEqual(applyCalls, [{ planId: 'plan-fixture-90s', scenes: [1] }])
  assert.equal(ran.length, 0)
  assert.equal(document.clips.length, 5)
  assert.equal(store.getState().plans[0].versionId, 'v7')
})

test('a refused apply (TARGET_CHANGED) keeps the cards and says why', async () => {
  const { api, emit } = fakeApi({
    applyPlan: async () => ({ success: false, code: 'TARGET_CHANGED', error: 'The timeline changed since the plan was prepared.' }),
  })
  const store = createStudioUiStore()
  startStudioUiBridge({ api, store })
  emit('studio:plan-proposed', fixture())
  const result = await approvePlan({ store, api, runner: fakeRunner().runner, planId: 'plan-fixture-90s' })
  assert.equal(result.ok, false)
  const plan = store.getState().plans[0]
  assert.equal(plan.status, 'proposed')
  assert.equal(plan.error, 'The timeline changed since the plan was prepared. Ask again to re-plan on the current timeline.')
})

test('Reject leaves the document unchanged and runs nothing', async () => {
  const rejected = []
  const { api, emit } = fakeApi({ rejectPlan: async (args) => { rejected.push(args); return { success: true } } })
  const store = createStudioUiStore()
  startStudioUiBridge({ api, store })
  emit('studio:plan-proposed', fixture())
  const { runner, ran, document, versions } = fakeRunner()
  await rejectPlan({ store, api, planId: 'plan-fixture-90s' })
  assert.equal(ran.length, 0)
  assert.equal(versions.length, 0)
  assert.deepEqual(document.clips, ['clip-1', 'clip-4', 'clip-8', 'clip-64', 'clip-68'])
  assert.equal(store.getState().plans[0].status, 'rejected')
  assert.deepEqual(rejected, [{ planId: 'plan-fixture-90s' }])
  // Approving a rejected plan does nothing.
  const late = await approvePlan({ store, api, runner, planId: 'plan-fixture-90s' })
  assert.equal(late.ok, false)
  assert.equal(ran.length, 0)
})

test('an instruction goes to main with the strip’s scope; without FILM-2013 the panel says the agent is not available', async () => {
  const proposed = []
  const withAgent = fakeApi({ proposePlan: async (args) => { proposed.push(args); return { success: true, planId: 'p1' } } })
  const store = createStudioUiStore()
  store.getState().setScope({ scenes: [3], clipIds: ['clip-9'], label: 'Scene 3 · LAB' })
  const answer = await proposeInstruction({ store, api: withAgent.api, instruction: '  tighten this ' })
  assert.equal(answer.ok, true)
  assert.deepEqual(proposed, [{ instruction: 'tighten this', scope: { scenes: [3], clipIds: ['clip-9'] } }])
  assert.equal(store.getState().pending.instruction, 'tighten this')

  const without = fakeApi()
  const other = createStudioUiStore()
  const refused = await proposeInstruction({ store: other, api: without.api, instruction: 'tighten this' })
  assert.equal(refused.ok, false)
  assert.equal(other.getState().pending, null)
  assert.match(other.getState().panelError, /not available yet/)
})

test('main learns when quitting would lose work, and a quit request with work pending asks first', async () => {
  const pendingCalls = []
  let quits = 0
  const { api, emit } = fakeApi({
    setPendingWork: async (args) => { pendingCalls.push(args.pending); return { success: true } },
    confirmQuit: async () => { quits += 1; return { success: true } },
    onCloseRequested: (callback) => { closeRequested = callback; return () => {} },
  })
  let closeRequested = null
  const store = createStudioUiStore()
  startStudioUiBridge({ api, store })
  emit('studio:plan-proposed', fixture())
  assert.deepEqual(pendingCalls, [true])
  closeRequested({ intent: 'quit' })
  const { prompt } = store.getState()
  assert.equal(prompt.title, 'Quit with work in progress?')
  prompt.resolve(false)
  assert.equal(quits, 0)
  assert.equal(store.getState().prompt, null)
  await rejectPlan({ store, api, planId: 'plan-fixture-90s' })
  assert.deepEqual(pendingCalls, [true, false])
  closeRequested({ intent: 'quit' })
  assert.equal(quits, 1, 'nothing pending: quit goes straight through')
})

// FILM-2013: apply goes through the capability tool the preview named.
const capabilityPlan = () => ({
  phase: 'proposed', planId: 'cap-1', source: 'mcp', intent: 'hit_duration', scope: {}, params: { targetSeconds: 90 },
  instruction: 'make it 90 seconds',
  cards: [{ scene: 1, durationBefore: 19, durationAfter: 15, changes: [{ text: 'Remove S1.4', reason: 'r1' }] }, { scene: 2, durationBefore: 20, durationAfter: 15, changes: [{ text: 'Remove S2.4', reason: 'r2' }] }],
  touchesUserEdits: [],
})
const mcpResult = (body, isError = false) => ({ isError, content: [{ type: 'text', text: JSON.stringify(body) }] })

test('Approve all on a FILM-2013 plan calls studio_edit with the previewed intent, scope, params and planId', async () => {
  const calls = []
  const { api, emit } = fakeApi({ callCapability: async (name, args) => { calls.push([name, args]); return mcpResult({ success: true, version: { id: 'v4' }, report: { finalDuration: 90 } }) } })
  const store = createStudioUiStore()
  startStudioUiBridge({ api, store })
  emit('studio:plan-proposed', capabilityPlan())
  const { runner, ran } = fakeRunner()
  const result = await approvePlan({ store, api, runner, planId: 'cap-1' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [['studio_edit', { intent: 'hit_duration', scope: {}, params: { targetSeconds: 90 }, previewOnly: false, planId: 'cap-1' }]])
  assert.equal(ran.length, 0)
  assert.equal(store.getState().plans[0].status, 'applied')
  assert.equal(store.getState().plans[0].versionId, 'v4')
})

test('a FILM-2013 apply is journalled too, so a crash in the middle offers the version before it', async () => {
  let journalDuringApply = null
  const { runner, journal } = fakeRunner()
  const { api, emit } = fakeApi({ callCapability: async () => { journalDuringApply = journal.at(-1); return mcpResult({ success: true, version: { id: 'v4' } }) } })
  const store = createStudioUiStore()
  startStudioUiBridge({ api, store })
  emit('studio:plan-proposed', capabilityPlan())
  await approvePlan({ store, api, runner, planId: 'cap-1' })
  assert.equal(journalDuringApply.status, 'applying')
  assert.equal(journalDuringApply.planId, 'cap-1')
  assert.deepEqual(journal.at(-1), { ...journalDuringApply, versionId: 'v4', status: 'done' })
})

test('a refused capability apply (TARGET_CHANGED) keeps the cards and says to ask again', async () => {
  const { api, emit } = fakeApi({ callCapability: async () => mcpResult({ error: { code: 'TARGET_CHANGED', message: 'The timeline changed since the preview.' } }, true) })
  const store = createStudioUiStore()
  startStudioUiBridge({ api, store })
  emit('studio:plan-proposed', capabilityPlan())
  await approvePlan({ store, api, runner: fakeRunner().runner, planId: 'cap-1' })
  assert.equal(store.getState().plans[0].status, 'proposed')
  assert.match(store.getState().plans[0].error, /^The timeline changed since the preview\. Ask again/)
})

test('an applied event from an external client marks the panel’s card applied', () => {
  const { api, emit } = fakeApi()
  const store = createStudioUiStore()
  startStudioUiBridge({ api, store })
  emit('studio:plan-proposed', capabilityPlan())
  emit('studio:plan-proposed', { phase: 'applied', planId: 'cap-1', source: 'mcp', intent: 'hit_duration', versionId: 'v9', cards: capabilityPlan().cards })
  const [plan] = store.getState().plans
  assert.equal(plan.status, 'applied')
  assert.equal(plan.versionId, 'v9')
  assert.match(store.getState().announcement, /^Applied “make it 90 seconds”/)
})

test('with FILM-2013, the instruction box previews studio_edit and the arriving cards carry the user’s words', async () => {
  const calls = []
  const harness = fakeApi({
    callCapability: async (name, args) => {
      calls.push([name, args])
      // FILM-2013 emits the cards before it answers.
      harness.emit('studio:plan-proposed', { phase: 'proposed', planId: 'cap-7', source: 'in-app', intent: args.intent, scope: args.scope, params: args.params, cards: [] })
      return mcpResult({ previewOnly: true, planId: 'cap-7' })
    },
  })
  const store = createStudioUiStore()
  startStudioUiBridge({ api: harness.api, store })
  store.getState().setScope({ scenes: [3], clipIds: ['clip-9'], label: 'Scene 3' })
  const answer = await proposeInstruction({ store, api: harness.api, instruction: 'tighten this' })
  assert.equal(answer.ok, true)
  assert.deepEqual(calls, [['studio_edit', { intent: 'tighten_pacing', scope: { scenes: [3] }, params: { instruction: 'tighten this' }, previewOnly: true }]])
  assert.equal(store.getState().plans[0].instruction, 'tighten this')
  assert.equal(store.getState().pending, null)

  const unknown = await proposeInstruction({ store, api: harness.api, instruction: 'make it more emotional' })
  assert.equal(unknown.ok, false)
  assert.match(store.getState().panelError, /make it 90 seconds/)
  assert.equal(calls.length, 1)
})

test('a FILM-2017 deliver job drives the delivery state, the per-file QA and its announcement; a pull job does not', () => {
  const { api, emit } = fakeApi()
  const store = createStudioUiStore()
  startStudioUiBridge({ api, store })
  store.getState().patch({ delivery: { jobId: 'd1', status: 'sending' } })
  emit('studio:job-progress', { id: 'd1', kind: 'deliver', phase: 'render', status: 'running', done: 0, total: 2 })
  assert.equal(store.getState().delivery.status, 'rendering')
  emit('studio:job-progress', { id: 'd1', kind: 'deliver', phase: 'upload', status: 'running', done: 1, total: 2 })
  assert.equal(store.getState().delivery.status, 'uploading')
  const qa = { pass: false, issues: [{ type: 'loudness', severity: 0.7, timeRange: null, scene: null, detail: 'Too loud.', repairIntent: 'normalize_loudness' }] }
  emit('studio:job-progress', { id: 'd1', kind: 'deliver', phase: 'done', status: 'done', done: 2, total: 2, result: { destination: 'storybook', delivered: true, renders: [{ preset: 'youtube_16x9', language: 'en', qa }, { preset: 'shorts_9x16', language: 'en', qa: { pass: true, issues: [] } }] } })
  const { delivery, qaAnnouncement, job } = store.getState()
  assert.equal(delivery.status, 'sent')
  assert.deepEqual(delivery.qa, { 'youtube_16x9-en': qa, 'shorts_9x16-en': { pass: true, issues: [] } })
  assert.equal(qaAnnouncement, 'QA checked 2 files: 1 with issues.')
  assert.equal(job, null, 'a deliver job is not the pull progress')

  emit('studio:job-progress', { id: 'd2', kind: 'deliver', phase: 'upload', status: 'failed', error: 'StoryBook moved on.', failure: { code: 'TARGET_CHANGED' } })
  assert.equal(store.getState().delivery.status, 'sent', 'another job does not overwrite this delivery')
  store.getState().patch({ delivery: { jobId: 'd2', status: 'sending' } })
  emit('studio:job-progress', { id: 'd2', kind: 'deliver', phase: 'upload', status: 'failed', error: 'StoryBook moved on.', failure: { code: 'TARGET_CHANGED' } })
  assert.deepEqual([store.getState().delivery.status, store.getState().delivery.code, store.getState().delivery.error], ['failed', 'TARGET_CHANGED', 'StoryBook moved on.'])
})

test('Approve scene on a FILM-2013 plan previews that scene alone and applies it, folded into the card', async () => {
  const calls = []
  const harness = fakeApi({
    callCapability: async (name, args) => {
      calls.push([name, args])
      if (args.previewOnly) {
        harness.emit('studio:plan-proposed', { phase: 'proposed', planId: 'cap-scene-2', source: 'in-app', tool: 'studio_edit', intent: args.intent, scope: args.scope, params: args.params, cards: [capabilityPlan().cards[1]] })
        return mcpResult({ previewOnly: true, planId: 'cap-scene-2' })
      }
      harness.emit('studio:plan-proposed', { phase: 'applied', planId: args.planId, source: 'in-app', intent: args.intent, versionId: 'v5', cards: [] })
      return mcpResult({ success: true, version: { id: 'v5' } })
    },
  })
  const store = createStudioUiStore()
  startStudioUiBridge({ api: harness.api, store })
  harness.emit('studio:plan-proposed', capabilityPlan())
  const result = await approvePlan({ store, api: harness.api, runner: fakeRunner().runner, planId: 'cap-1', scenes: [2] })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [
    ['studio_edit', { intent: 'hit_duration', scope: { scenes: [2] }, params: { targetSeconds: 90 }, previewOnly: true }],
    ['studio_edit', { intent: 'hit_duration', scope: { scenes: [2] }, params: { targetSeconds: 90 }, previewOnly: false, planId: 'cap-scene-2' }],
  ])
  const { plans } = store.getState()
  assert.deepEqual(plans.map((plan) => plan.planId), ['cap-1'], 'the scoped preview is not shown as a second plan')
  assert.equal(plans[0].status, 'applied')
  assert.deepEqual(plans[0].approvedScenes, [2])
  assert.equal(plans[0].versionId, 'v5')
})

test('Fix with AI asks studio_repair for a plan, which arrives as cards', async () => {
  const calls = []
  const { api } = fakeApi({ callCapability: async (name, args) => { calls.push([name, args]); return mcpResult({ previewOnly: true, planId: 'r1' }) } })
  const store = createStudioUiStore()
  const issue = { type: 'loudness', severity: 0.7, timeRange: null, scene: null, detail: 'Too loud.', repairIntent: 'normalize_loudness' }
  const answer = await repairIssues({ store, api, issues: [issue] })
  assert.equal(answer.ok, true)
  assert.deepEqual(calls, [['studio_repair', { issues: [issue], previewOnly: true }]])
  assert.equal(store.getState().aiPanelOpen, true)
})
