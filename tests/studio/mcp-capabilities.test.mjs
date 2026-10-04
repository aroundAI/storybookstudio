// FILM-2013: electron/studio/mcpCapabilities.js on its own, with a fake
// renderer and fake primitives: the autoRepair loop (apply -> QA -> repair, at
// most 3 rounds, one version, only the final cards), a refused step preview,
// a failed step, and the cloud adapter FILM-2011 plugs in.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { createCapabilityTools, MAX_REPAIR_ROUNDS } = require('../../electron/studio/mcpCapabilities.js')

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const body = (result) => JSON.parse(result.content[0].text)

function fakes({ refusePreviewOf = null, failStep = null } = {}) {
  const calls = { renderer: [], primitives: [], plans: [] }
  const plan = { steps: [{ tool: 'extract_range', arguments: { startSeconds: 1, endSeconds: 2 } }], reasons: ['Dead air'], scenes: [1], changes: ['Cut'], notes: [], touchesUserEdits: [], expected: {} }
  const performAction = async (action, payload) => {
    calls.renderer.push(action)
    switch (action) {
      case 'studio_compile': return { plan, cards: [{ scene: 1, changes: [] }], report: {}, reportText: 'r', prompt: 'tighten', fingerprint: 'f1', reads: {} }
      case 'studio_create_version': return { version: { id: `v${calls.renderer.filter((name) => name === 'studio_create_version').length + 1}`, name: payload.name, parent: 'v1' } }
      case 'studio_finish_apply': return { version: {}, report: {}, reportText: 'final', reportPath: 'edits/reports/v2.json', ops: [] }
      default: throw new Error(action)
    }
  }
  const callPrimitive = async (name, args) => {
    calls.primitives.push(name)
    if (name === 'run_mcp_action_plan') {
      calls.plans.push(args)
      return text({ results: [{ index: -1, tool: 'create_project_checkpoint', success: true }, ...args.steps.map((step, index) => ({ index, tool: step.tool, success: failStep !== index }))] })
    }
    if (name === refusePreviewOf) return { isError: true, content: [{ type: 'text', text: 'Clip not found.' }] }
    return text({ previewOnly: true, message: 'ok' })
  }
  return { calls, performAction, callPrimitive }
}

const preview = async (tools) => body(await tools.call('studio_edit', { intent: 'tighten_pacing', scope: { scene: 1 } }))
const apply = async (tools, planId, extra = {}) => body(await tools.call('studio_edit', { intent: 'tighten_pacing', scope: { scene: 1 }, previewOnly: false, planId, ...extra }))

test('autoRepair: QA failing twice then passing runs three rounds inside the one version; studioMeta rides every step', async () => {
  const { calls, performAction, callPrimitive } = fakes()
  const qaResults = [{ pass: false, issues: [{ type: 'loudness' }] }, { pass: false, issues: [{ type: 'loudness' }] }, { pass: true, issues: [] }]
  const review = async () => qaResults.shift()
  const repair = async ({ issues }) => ({ plan: { steps: [{ tool: 'set_clip_audio', arguments: { clipId: 'c' } }], reasons: [`Fix ${issues[0].type}`], scenes: [null] } })
  const tools = createCapabilityTools({ performAction, callPrimitive, review, repair })
  const { planId } = await preview(tools)
  const result = await apply(tools, planId, { autoRepair: true })
  assert.deepEqual(result.autoRepair.rounds.map((round) => round.kind), ['plan', 'repair', 'repair'])
  assert.equal(result.autoRepair.stoppedBecause, 'QA passed')
  assert.equal(calls.renderer.filter((name) => name === 'studio_create_version').length, 1, 'one draft version')
  assert.equal(calls.plans.length, 3)
  assert.ok(calls.plans.every((planArgs) => planArgs.createCheckpointFirst === true && planArgs.stopOnError === true && planArgs.previewOnly === false))
  assert.deepEqual(calls.plans[1].steps[0].arguments.studioMeta, { reason: 'Fix loudness', scene: null, session: `studio-plan-${planId}` })
  assert.deepEqual(calls.plans[0].steps[0].arguments.studioMeta, { reason: 'Dead air', scene: 1, session: `studio-plan-${planId}` })
})

test(`autoRepair stops at ${MAX_REPAIR_ROUNDS} rounds and leaves what is left as cards`, async () => {
  const { calls, performAction, callPrimitive } = fakes()
  const review = async () => ({ pass: false, issues: [{ type: 'black_frames' }] })
  const repair = async () => ({ plan: { steps: [{ tool: 'trim_clips', arguments: {} }], reasons: ['Trim black'], scenes: [2] } })
  const tools = createCapabilityTools({ performAction, callPrimitive, review, repair })
  const result = await apply(tools, (await preview(tools)).planId, { autoRepair: true })
  assert.equal(result.autoRepair.rounds.length, MAX_REPAIR_ROUNDS)
  assert.match(result.autoRepair.stoppedBecause, /still has 1 issue after 3 rounds; they are left as cards/)
  assert.equal(calls.plans.length, MAX_REPAIR_ROUNDS)
})

test('a step whose own preview refuses blocks the plan: VALIDATION_FAILED with every step\'s preview, nothing stored', async () => {
  const { calls, performAction, callPrimitive } = fakes({ refusePreviewOf: 'extract_range' })
  const tools = createCapabilityTools({ performAction, callPrimitive })
  const result = await tools.call('studio_edit', { intent: 'tighten_pacing', scope: { scene: 1 } })
  assert.equal(result.isError, true)
  const { error } = body(result)
  assert.equal(error.code, 'VALIDATION_FAILED')
  assert.deepEqual(error.details.stepPreviews.map((step) => [step.tool, step.ok]), [['extract_range', false]])
  assert.equal(tools.pendingPlanCount(), 0)
  assert.ok(!calls.primitives.includes('run_mcp_action_plan'))
})

test('a failed step stops the plan; the version and checkpoint stay for restore', async () => {
  const { performAction, callPrimitive } = fakes({ failStep: 0 })
  const tools = createCapabilityTools({ performAction, callPrimitive })
  const result = await apply(tools, (await preview(tools)).planId)
  assert.equal(result.applied, 'partial')
  assert.deepEqual(result.failedStep, { step: 1, tool: 'extract_range', success: false })
  assert.deepEqual(result.restoreWith, { tool: 'studio_restore_version', arguments: { versionId: 'v2' } })
})

test('a plan id applies once; a different scope or params needs a new preview', async () => {
  const { performAction, callPrimitive } = fakes()
  const tools = createCapabilityTools({ performAction, callPrimitive })
  const { planId } = await preview(tools)
  const other = body(await tools.call('studio_edit', { intent: 'tighten_pacing', scope: { scene: 2 }, previewOnly: false, planId }))
  assert.match(other.error.message, /differ from the previewed plan/)
  assert.equal((await apply(tools, planId)).applied, true)
  assert.match((await apply(tools, planId)).error.message, /Preview first/)
})

test('the cloud tools run over FILM-2011\'s client when one is passed in, with its error codes', async () => {
  const cloud = {
    openEpisode: async ({ episodeId }) => ({ jobId: `pull-${episodeId}` }),
    getJobStatus: (jobId) => ({ jobId, kind: 'pull', phase: 'media', done: 3, total: 9, bytes: 1024 }),
    checkUpdates: async () => { throw Object.assign(new Error('Sign in again'), { code: 'UNAUTHORIZED' }) },
  }
  const tools = createCapabilityTools({ performAction: async () => ({}), callPrimitive: async () => text({}), getCloud: () => cloud })
  assert.deepEqual(body(await tools.call('studio_open_episode', { episodeId: 'e1' })), { jobId: 'pull-e1' })
  assert.equal(body(await tools.call('studio_get_job_status', { jobId: 'pull-e1' })).done, 3)
  const refused = await tools.call('studio_check_updates', {})
  assert.deepEqual([refused.isError, body(refused).error.code], [true, 'UNAUTHORIZED'])
  const none = createCapabilityTools({ performAction: async () => ({}), callPrimitive: async () => text({}) })
  assert.match(body(await none.call('studio_open_episode', { episodeId: 'e1' })).error.message, /not available yet: FILM-2011 builds it\. \(the FILM-2011 cloud client is not in this build\)/)
  const missing = createCapabilityTools({ performAction: async () => ({}), callPrimitive: async () => text({}), getCloud: () => ({ getJobStatus: () => null }) })
  assert.equal(body(await missing.call('studio_get_job_status', { jobId: 'nope' })).error.code, 'NOT_FOUND')
})

test('studio_apply_updates previews the re-sync plan; a replace that needs its import is previewed when the import has run', async () => {
  const previews = []
  const plan = {
    steps: [{ tool: 'import_asset_from_path', arguments: { path: '/p/assets/video/shot-2b.mp4' } }, { tool: 'replace_clip_with_asset', arguments: { clipId: 'clip-2', assetName: 'shot-2b.mp4' } }],
    reasons: ['StoryBook has a new video for S1.2.', 'StoryBook has a new video for S1.2.'],
    scenes: [1, 1],
    previewAfter: [undefined, 0],
    notes: [],
    touchesUserEdits: [],
    expected: {},
  }
  const performAction = async (action) => (action === 'studio_resync_plan' ? { plan, cards: [{ scene: 1 }], report: {}, reportText: '', prompt: 'Sync from StoryBook', fingerprint: 'f', planKey: 'resync-v8' } : {})
  const tools = createCapabilityTools({ performAction, callPrimitive: async (name) => { previews.push(name); return text({ previewOnly: true }) } })
  const result = body(await tools.call('studio_apply_updates', {}))
  assert.deepEqual(previews, ['import_asset_from_path'])
  assert.deepEqual(result.stepPreviews.map((step) => [step.tool, step.ok]), [['import_asset_from_path', true], ['replace_clip_with_asset', true]])
  assert.match(result.stepPreviews[1].message, /when step 1 has run/)
  assert.deepEqual(result.applyWith, { tool: 'studio_apply_updates', arguments: { previewOnly: false, planId: result.planId } })
})
