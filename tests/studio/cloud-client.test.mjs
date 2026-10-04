// FILM-2011 AC2: the main-process MCP client. Run against a real Streamable
// HTTP MCP server (the SDK's own, stateless like StoryBook's /api/mcp) that
// answers with StoryBook's error contract.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { z } = require('zod')
const { createStoryBookClient, StudioClientError, TOOL_NAMES, PENDING_TOOLS } = require('../../electron/studio/client.js')

const toolError = (code, message, details) => ({
  isError: true,
  content: [{ type: 'text', text: `${code}: ${message}` }],
  structuredContent: { code, message, retryable: code === 'RATE_LIMITED', ...(details ? { details } : {}) },
})

async function storyBook(t, { tokens, handlers = {} }) {
  const calls = []
  const authHeaders = []
  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization ?? ''
    authHeaders.push(auth)
    if (!tokens.has(auth.replace(/^Bearer /, ''))) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' })
      res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'The bearer token has expired.' }))
      return
    }
    const mcp = new McpServer({ name: 'storybook-test', version: '0' })
    const register = (name, shape, fn) =>
      mcp.registerTool(name, { inputSchema: shape }, async (args) => {
        calls.push({ name, args })
        return fn(args)
      })
    register('whoami', {}, () => ({ content: [{ type: 'text', text: 'you' }], structuredContent: { user: { id: 'u1' }, team: { slug: 'team' } } }))
    register('list_episodes', { projectId: z.string() }, (args) => ({ content: [{ type: 'text', text: 'eps' }], structuredContent: { items: [{ id: 'e1', projectId: args.projectId }] } }))
    register('get_edit_package', { episodeId: z.string(), ifNoneMatch: z.string().optional() }, handlers.get_edit_package ?? (() => ({ content: [{ type: 'text', text: 'pkg' }], structuredContent: { etag: 'v1' } })))
    register('open_edit_session', { episodeId: z.string(), packageEtag: z.string() }, handlers.open_edit_session ?? (() => toolError('FORBIDDEN', 'Needs the project role member or above; you are viewer.', { role: 'viewer', required: 'member' })))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { transport.close(); mcp.close() })
    await mcp.connect(transport)
    let body = ''
    for await (const chunk of req) body += chunk
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }))
  return { origin: `http://127.0.0.1:${server.address().port}`, calls, authHeaders }
}

function auth(initial, { refreshTo = null } = {}) {
  let token = initial
  const log = { refreshes: 0, signInRequired: 0 }
  return {
    log,
    getAccessToken: async () => token,
    refresh: async () => {
      log.refreshes += 1
      if (!refreshTo) return { ok: false }
      token = refreshTo
      return { ok: true }
    },
    onSignInRequired: () => { log.signInRequired += 1 },
  }
}

test('typed callers for every tool the spec names; the last five are marked pending', () => {
  assert.deepEqual(TOOL_NAMES, [
    'whoami', 'list_projects', 'list_episodes', 'get_edit_package', 'open_edit_session', 'record_edit_events', 'close_edit_session',
    'request_render_upload', 'finalize_render', 'deliver_edit', 'regenerate_shots', 'localize_episode',
  ])
  assert.deepEqual([...PENDING_TOOLS], ['request_render_upload', 'finalize_render', 'deliver_edit', 'regenerate_shots', 'localize_episode'])
})

test('calls go to <api>/api/mcp with the bearer and return structured content', async (t) => {
  const sb = await storyBook(t, { tokens: new Set(['sbk_pat_ok']) })
  const a = auth('sbk_pat_ok')
  const client = createStoryBookClient({ apiOrigin: sb.origin, auth: a })
  t.after(() => client.close())
  assert.deepEqual(await client.whoami(), { user: { id: 'u1' }, team: { slug: 'team' } })
  assert.deepEqual(await client.listEpisodes({ projectId: 'p1' }), { items: [{ id: 'e1', projectId: 'p1' }] })
  assert.deepEqual(sb.calls.map((c) => c.name), ['whoami', 'list_episodes'])
  assert.ok(sb.authHeaders.every((h) => h === 'Bearer sbk_pat_ok'))
})

test('UNAUTHORIZED refreshes once and retries with the new token', async (t) => {
  const sb = await storyBook(t, { tokens: new Set(['sbk_at_new']) })
  const a = auth('sbk_at_old', { refreshTo: 'sbk_at_new' })
  const client = createStoryBookClient({ apiOrigin: sb.origin, auth: a })
  t.after(() => client.close())
  assert.deepEqual(await client.getEditPackage({ episodeId: 'e1' }), { etag: 'v1' })
  assert.equal(a.log.refreshes, 1)
  assert.equal(a.log.signInRequired, 0)
})

test('UNAUTHORIZED after the refresh surfaces "Sign in again"', async (t) => {
  const sb = await storyBook(t, { tokens: new Set(['nobody']) })
  const a = auth('sbk_at_old', { refreshTo: 'sbk_at_still_bad' })
  const client = createStoryBookClient({ apiOrigin: sb.origin, auth: a })
  t.after(() => client.close())
  const error = await client.whoami().catch((e) => e)
  assert.ok(error instanceof StudioClientError)
  assert.equal(error.code, 'UNAUTHORIZED')
  assert.equal(error.message, 'Sign in again')
  assert.equal(a.log.refreshes, 1, 'refreshed once, not in a loop')
  assert.equal(a.log.signInRequired, 1)
})

test('FORBIDDEN surfaces the role', async (t) => {
  const sb = await storyBook(t, { tokens: new Set(['sbk_pat_ok']) })
  const client = createStoryBookClient({ apiOrigin: sb.origin, auth: auth('sbk_pat_ok') })
  t.after(() => client.close())
  const error = await client.openEditSession({ episodeId: 'e1', packageEtag: 'v1' }).catch((e) => e)
  assert.equal(error.code, 'FORBIDDEN')
  assert.equal(error.role, 'viewer')
  assert.match(error.message, /viewer/)
})

test('RATE_LIMITED waits retry_after_s and retries', async (t) => {
  let n = 0
  const sb = await storyBook(t, {
    tokens: new Set(['sbk_pat_ok']),
    handlers: {
      get_edit_package: () => (++n === 1 ? toolError('RATE_LIMITED', 'Too many calls; retry in 7s.', { retry_after_s: 7 }) : { content: [{ type: 'text', text: 'ok' }], structuredContent: { etag: 'v2' } }),
    },
  })
  const slept = []
  const client = createStoryBookClient({ apiOrigin: sb.origin, auth: auth('sbk_pat_ok'), sleep: async (ms) => slept.push(ms) })
  t.after(() => client.close())
  assert.deepEqual(await client.getEditPackage({ episodeId: 'e1' }), { etag: 'v2' })
  assert.deepEqual(slept, [7000])
})

test('a tool the server does not have yet is VALIDATION_FAILED "not available yet"', async (t) => {
  const sb = await storyBook(t, { tokens: new Set(['sbk_pat_ok']) })
  const client = createStoryBookClient({ apiOrigin: sb.origin, auth: auth('sbk_pat_ok') })
  t.after(() => client.close())
  const error = await client.deliverEdit({ sessionId: 's', episodeVersion: 3, renders: [], report: {}, qa: {} }).catch((e) => e)
  assert.equal(error.code, 'VALIDATION_FAILED')
  assert.match(error.message, /not available yet/)
})
