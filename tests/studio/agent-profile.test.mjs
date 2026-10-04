// FILM-2013 AC: src/services/agentTools.js drives the agent profile. The
// matrix: every capability tool, called by the in-app agent
// (runAgentTool -> studio:callCapability) and by an MCP SDK client over HTTP,
// on the same fixture and instruction, gives the same result; for every
// studio_edit intent, the same plan cards.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'

import { connectSdkClient, loadRendererModules, parseToolResult, startStudioHarness } from './helpers/studio-harness.mjs'

const require = createRequire(import.meta.url)
const capabilities = require('../../electron/studio/mcpCapabilities.js')

let m
let harness
let client

before(async () => {
  m = await loadRendererModules()
  harness = await startStudioHarness(m)
  client = await connectSdkClient(harness)
})
after(async () => {
  await client?.close()
  await harness?.close()
  await m?.vite.close()
})

const viaSdk = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  const body = parseToolResult(result)
  return result.isError ? { isError: true, ...body } : body
}
const viaAgent = (name, args) => m.agentTools.runAgentTool(name, args)
const stable = (value) => JSON.parse(JSON.stringify(value, (key, inner) => (['planId', 'applyWith', 'generatedAt', 'createdAt', 'ts'].includes(key) ? undefined : inner)))

const EDITS = {
  hit_duration: { scope: {}, params: { targetSeconds: 80 } },
  tighten_pacing: { scope: { scene: 3 }, params: { targetSeconds: 12 } },
  remove_dead_air: { scope: { scene: 2 }, params: {} },
  open_with_strongest_line: { scope: { scene: 3 }, params: {} },
  keep_music_under_dialogue: { scope: {}, params: {} },
  add_broll: { scope: { scene: 2 }, params: {} },
  emphasize: { scope: { scene: 4 }, params: {} },
  add_cta: { scope: {}, params: { text: 'Watch episode 2' } },
  match_brand: { scope: {}, params: {} },
  reorder_scenes: { scope: {}, params: { order: [2, 1, 3, 4, 5] } },
  recut_around_drops: { scope: {}, params: {} },
}

test('the in-app agent sees the same 18 tools as the agent profile, and its instructions start from studio_get_context', () => {
  const agentNames = m.agentTools.CAPABILITY_AGENT_TOOLS.map((tool) => tool.name).sort()
  const profileNames = capabilities.definitionsFor('agent').map((tool) => tool.name).sort()
  assert.deepEqual(agentNames, profileNames)
  const instructions = m.agentTools.getAgentToolInstructions()
  assert.match(instructions, /"tool":"studio_get_context"/)
  assert.match(instructions, /apply with previewOnly false and the planId only after the user approves/)
  assert.ok(!/- trim_clips \(/.test(instructions), 'primitives stay in the expert list')
  assert.match(m.agentTools.getAgentToolInstructions({ profile: 'expert' }), /"tool":"get_project"/)
})

test('every studio_edit intent: the in-app agent and the SDK client get identical plan cards for the same fixture and instruction', async () => {
  assert.deepEqual(Object.keys(EDITS).sort(), [...capabilities.STUDIO_EDIT_INTENTS].sort())
  for (const [intent, { scope, params }] of Object.entries(EDITS)) {
    const args = { intent, scope, params }
    const sdk = await viaSdk('studio_edit', args)
    const agent = await viaAgent('studio_edit', args)
    assert.ok(!sdk.isError, `${intent}: ${JSON.stringify(sdk.error)}`)
    assert.ok(!agent.isError, `${intent}: ${JSON.stringify(agent.error)}`)
    assert.ok(sdk.cards.length > 0, `${intent} has cards`)
    assert.deepEqual(agent.cards, sdk.cards, intent)
    assert.deepEqual(stable(agent.notes), stable(sdk.notes), intent)
    assert.deepEqual(agent.expected, sdk.expected, intent)
    assert.deepEqual(agent.plan.stepCount, sdk.plan.steps.length, intent)
  }
  const sources = harness.proposals.map((proposal) => proposal.source)
  assert.equal(sources.filter((source) => source === 'mcp').length, Object.keys(EDITS).length)
  assert.equal(sources.filter((source) => source === 'in-app').length, Object.keys(EDITS).length)
})

test('every other capability tool: same result from both clients (the stubs refuse the same way)', async () => {
  const calls = {
    studio_get_context: { scope: { scene: 3 } },
    studio_search_assets: { query: 'Line 18', role: 'dialogue' },
    studio_check_readiness: {},
    studio_deliver: { presets: ['youtube_16x9'] },
    studio_add_graphic: { kind: 'lower_third', text: 'Maya', at: 1, duration: 2 },
    studio_create_variant: { kind: 'short' },
    studio_review: {},
    studio_repair: { issues: [] },
    studio_render_preview: {},
    studio_check_updates: {},
    studio_apply_updates: {},
    studio_open_episode: { episodeId: harness.pkg.episode.id },
    studio_get_job_status: { jobId: 'job-1' },
  }
  for (const [name, args] of Object.entries(calls)) {
    assert.deepEqual(stable(await viaAgent(name, args)), stable(await viaSdk(name, args)), name)
  }
  // FILM-2016's tools return plan cards when its compilers are in the build.
  for (const [name, args] of [['studio_edit_audio', { intent: 'fade' }], ['studio_add_captions', { language: 'en' }]]) {
    const sdk = await viaSdk(name, args)
    const agent = await viaAgent(name, args)
    if (sdk.isError) assert.deepEqual(stable(agent), stable(sdk), name)
    else assert.deepEqual([agent.cards, stable(agent.notes), agent.expected], [sdk.cards, stable(sdk.notes), sdk.expected], name)
  }
  const agentVersion = await viaAgent('studio_create_version', { name: 'From the panel' })
  const sdkVersion = await viaSdk('studio_create_version', { name: 'From Claude' })
  assert.deepEqual([agentVersion.version.createdBy, sdkVersion.version.createdBy], ['ai', 'ai'])
  assert.deepEqual(Object.keys(agentVersion.version).sort(), Object.keys(sdkVersion.version).sort())
  const restored = await viaAgent('studio_restore_version', { versionId: agentVersion.version.id })
  assert.equal(restored.version.id, agentVersion.version.id)
  assert.equal(Object.keys(calls).length + 5, capabilities.definitionsFor('agent').length)
})

test('the in-app agent applies a plan the same way: one logged line per step with the preview\'s reasons', async () => {
  const args = { intent: 'tighten_pacing', scope: { scene: 3 }, params: { targetSeconds: 12 } }
  const preview = await viaAgent('studio_edit', args)
  const sdkPreview = await viaSdk('studio_edit', args)
  const applied = await viaAgent('studio_edit', { ...args, previewOnly: false, planId: preview.planId })
  assert.equal(applied.applied, true, JSON.stringify(applied.error))
  assert.deepEqual(applied.opLog.map((entry) => entry.reason), sdkPreview.plan.reasons)
})
