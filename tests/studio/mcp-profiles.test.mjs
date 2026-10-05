// FILM-2013 AC1: /mcp?profile=agent (the default) lists only the capability
// tools; ?profile=expert lists the upstream editor's tools plus the studio_* lifecycle
// tools; both need the FILM-2010 bearer. Tools other specs build answer
// VALIDATION_FAILED "not available yet". Raw HTTP against the real server.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'

import { extractTools, extractWritable } from '../../scripts/capability-matrix.mjs'
import { STUDIO_EDIT_INTENTS as COMPILER_INTENTS } from '../../src/studio/compile.js'
import { freePort } from './helpers/studio-harness.mjs'

const require = createRequire(import.meta.url)
const { createStorybookStudioMcpServer } = require('../../electron/mcpServer.js')
const capabilities = require('../../electron/studio/mcpCapabilities.js')

const SECRET = 'profile-test-secret'
const source = readFileSync(new URL('../../electron/mcpServer.js', import.meta.url), 'utf8')
let server
let base

const rpc = async (method, params = {}, { profile = null, header = null, bearer = SECRET } = {}) => {
  const url = new URL(base)
  if (profile) url.searchParams.set('profile', profile)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(header ? { 'X-MCP-Profile': header } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers }
}
const callText = (body) => JSON.parse(body.result.content[0].text)

before(async () => {
  const port = await freePort()
  server = createStorybookStudioMcpServer({ port, authSecret: SECRET, version: 'test' })
  await server.start()
  base = `http://127.0.0.1:${port}/mcp`
})
after(async () => {
  server.server?.closeAllConnections?.()
  await server.stop()
})

test('the agent profile is the default and lists only the 18 capability tools, each with annotations', async () => {
  const plain = await rpc('tools/list')
  const agent = await rpc('tools/list', {}, { profile: 'agent' })
  assert.equal(plain.status, 200)
  assert.deepEqual(plain.body.result.tools.map((tool) => tool.name), agent.body.result.tools.map((tool) => tool.name))
  const names = agent.body.result.tools.map((tool) => tool.name)
  assert.equal(names.length, 18)
  assert.ok(names.every((name) => name.startsWith('studio_')))
  assert.deepEqual([...names].sort(), [
    'studio_add_captions', 'studio_add_graphic', 'studio_apply_updates', 'studio_check_readiness', 'studio_check_updates',
    'studio_create_variant', 'studio_create_version', 'studio_deliver', 'studio_edit', 'studio_edit_audio', 'studio_get_context',
    'studio_get_job_status', 'studio_open_episode', 'studio_render_preview', 'studio_repair', 'studio_restore_version',
    'studio_review', 'studio_search_assets',
  ])
  for (const tool of agent.body.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name)
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', tool.name)
  }
  const edit = agent.body.result.tools.find((tool) => tool.name === 'studio_edit')
  assert.deepEqual(edit.inputSchema.properties.intent.enum, COMPILER_INTENTS)
  assert.equal(edit.inputSchema.properties.previewOnly.default, true)
})

test('the expert profile lists every upstream tool plus the 6 lifecycle tools, by query or by header', async () => {
  const upstream = extractTools(source).map((tool) => tool.name)
  assert.ok(upstream.length >= 130, `${upstream.length} upstream tools`)
  for (const options of [{ profile: 'expert' }, { header: 'expert' }]) {
    const names = (await rpc('tools/list', {}, options)).body.result.tools.map((tool) => tool.name)
    assert.equal(names.length, upstream.length + 6)
    assert.deepEqual(names.slice(0, upstream.length), upstream)
    assert.deepEqual(names.slice(upstream.length), ['studio_open_episode', 'studio_get_job_status', 'studio_check_readiness', 'studio_create_version', 'studio_restore_version', 'studio_deliver'])
  }
})

test('both profiles need the bearer: no bearer or a wrong one is 401 with WWW-Authenticate, before anything else', async () => {
  for (const profile of ['agent', 'expert', null]) {
    for (const bearer of [null, 'wrong-secret']) {
      const response = await rpc('tools/list', {}, { profile, bearer })
      assert.equal(response.status, 401, `${profile} ${bearer}`)
      assert.match(response.headers.get('www-authenticate'), /^Bearer /)
      assert.equal(response.body.result, undefined)
    }
  }
  const call = await rpc('tools/call', { name: 'studio_get_context', arguments: {} }, { bearer: null })
  assert.equal(call.status, 401)
})

test('an unknown profile is a 400; each profile refuses the other\'s tools', async () => {
  assert.equal((await rpc('tools/list', {}, { profile: 'admin' })).status, 400)
  const primitive = await rpc('tools/call', { name: 'trim_clips', arguments: { clipId: 'clip-1', durationSeconds: 1 } })
  assert.equal(primitive.body.result.isError, true)
  assert.match(primitive.body.result.content[0].text, /not in the agent profile/)
  const edit = await rpc('tools/call', { name: 'studio_edit', arguments: { intent: 'tighten_pacing' } }, { profile: 'expert' })
  assert.equal(edit.body.result.isError, true)
  assert.match(edit.body.result.content[0].text, /agent profile only/)
  const instructions = await rpc('initialize', { protocolVersion: '2024-11-05' })
  assert.match(instructions.body.result.instructions, /Call studio_get_context first/)
  const expertInstructions = await rpc('initialize', { protocolVersion: '2024-11-05' }, { profile: 'expert' })
  assert.match(expertInstructions.body.result.instructions, /guide_comfyui_setup/)
})

test('tools another spec builds answer VALIDATION_FAILED "not available yet", naming the spec; the cloud tools wait for FILM-2011', async () => {
  const stubs = {
    studio_render_preview: ['FILM-2014', {}],
    studio_review: ['FILM-2014', {}],
    studio_create_variant: ['FILM-2017', { kind: 'short' }],
    studio_add_graphic: ['FILM-2018', { kind: 'lower_third', text: 'x', at: 1, duration: 2 }],
    studio_open_episode: ['FILM-2011', { episodeId: 'e' }],
    studio_get_job_status: ['FILM-2011', { jobId: 'j' }],
    studio_check_updates: ['FILM-2011', {}],
  }
  for (const [name, [owner, args]] of Object.entries(stubs)) {
    const { body } = await rpc('tools/call', { name, arguments: args })
    assert.equal(body.result.isError, true, name)
    const { error } = callText(body)
    assert.equal(error.code, 'VALIDATION_FAILED', name)
    assert.match(error.message, new RegExp(`not available yet: ${owner}`), name)
  }
  // These compile in the window (the re-sync plan, FILM-2016's compilers), so a bare server says so.
  for (const [name, args] of [['studio_apply_updates', {}], ['studio_edit_audio', { intent: 'duck' }], ['studio_add_captions', { language: 'en' }], ['studio_repair', { issues: [] }]]) {
    assert.match(callText((await rpc('tools/call', { name, arguments: args })).body).error.message, /window is not connected/, name)
  }
  const deliver = callText((await rpc('tools/call', { name: 'studio_deliver', arguments: { presets: ['youtube_16x9'], confirm: true } })).body)
  assert.match(deliver.error.message, /not available yet: FILM-2017.*cannot upload on its own/)
})

test('arguments are checked against the schema before anything runs', async () => {
  const missing = callText((await rpc('tools/call', { name: 'studio_edit', arguments: {} })).body)
  assert.deepEqual([missing.error.code, missing.error.details.problems], ['VALIDATION_FAILED', ['intent is required']])
  const wrong = callText((await rpc('tools/call', { name: 'studio_edit', arguments: { intent: 'make_it_pop', colour: 'red' } })).body)
  assert.deepEqual(wrong.error.details.problems.sort(), ['intent must be one of hit_duration, tighten_pacing, remove_dead_air, open_with_strongest_line, keep_music_under_dialogue, add_broll, emphasize, add_cta, match_brand, reorder_scenes, recut_around_drops', 'unknown argument colour'].sort())
})

test('the plan-writable set has every studio_* write tool but studio_deliver, and the five G3 primitives', () => {
  const writable = extractWritable(source)
  assert.deepEqual(capabilities.PLAN_WRITABLE_CAPABILITY_TOOLS.filter((name) => !writable.has(name)), [])
  assert.ok(!writable.has('studio_deliver'))
  for (const name of ['split_clip', 'extract_range', 'set_clip_speed', 'set_clip_audio', 'update_caption_cues']) assert.ok(writable.has(name), name)
  assert.ok(!writable.has('generate_captions'), 'caption generation stays a sequenced job (G3)')
  assert.deepEqual([...capabilities.STUDIO_EDIT_INTENTS], COMPILER_INTENTS)
})
