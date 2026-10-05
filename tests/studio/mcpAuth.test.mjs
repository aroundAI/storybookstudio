// FILM-2010 AC4: the local MCP server needs a bearer and loopback Host/Origin.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { authorizeMcpRequest, isLoopbackHost, isLoopbackOrigin } = require('../../electron/studio/mcpAuth.js')
const { createStorybookStudioMcpServer } = require('../../electron/mcpServer.js')

const SECRET = 'a'.repeat(64)
const base = { host: '127.0.0.1:19790' }

test('a request without a bearer is refused 401', () => {
  assert.deepEqual(authorizeMcpRequest(base, SECRET), { ok: false, status: 401, reason: 'Missing bearer token.' })
})

test('a wrong bearer is refused 401, and the reason does not echo either secret', () => {
  const result = authorizeMcpRequest({ ...base, authorization: `Bearer ${'b'.repeat(64)}` }, SECRET)
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.ok(!result.reason.includes('b'.repeat(8)) && !result.reason.includes(SECRET))
})

test('a bearer that only shares a prefix with the secret is refused', () => {
  assert.equal(authorizeMcpRequest({ ...base, authorization: `Bearer ${SECRET.slice(0, 32)}` }, SECRET).status, 401)
})

test('the right bearer is accepted, scheme case-insensitive', () => {
  assert.deepEqual(authorizeMcpRequest({ ...base, authorization: `Bearer ${SECRET}` }, SECRET), { ok: true, status: 200 })
  assert.equal(authorizeMcpRequest({ ...base, authorization: `bearer ${SECRET}` }, SECRET).ok, true)
})

test('no configured secret fails closed', () => {
  assert.equal(authorizeMcpRequest({ ...base, authorization: 'Bearer ' }, null).status, 401)
  assert.equal(authorizeMcpRequest({ ...base, authorization: 'Bearer x' }, '').status, 401)
})

test('a non-loopback Origin is refused 403 even with the right bearer', () => {
  for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1.evil.example', 'file://', 'http://user@localhost']) {
    const result = authorizeMcpRequest({ ...base, origin, authorization: `Bearer ${SECRET}` }, SECRET)
    assert.equal(result.status, 403, origin)
  }
})

test('a non-loopback Host (DNS rebinding) is refused 403 even with the right bearer', () => {
  for (const host of ['evil.example:19790', 'evil.example', '127.0.0.1.evil.example', '', '192.168.1.10:19790']) {
    const result = authorizeMcpRequest({ host, authorization: `Bearer ${SECRET}` }, SECRET)
    assert.equal(result.status, 403, host)
  }
})

test('loopback Host and Origin forms are accepted on any port', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:19790', 'localhost:1', '[::1]:19790', 'LOCALHOST']) assert.ok(isLoopbackHost(host), host)
  for (const origin of ['http://127.0.0.1', 'http://localhost:5173', 'https://[::1]:8443']) assert.ok(isLoopbackOrigin(origin), origin)
})

function request(port, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method, headers }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

test('the running server answers 401 / 401 / 403 / 200 over HTTP', async (t) => {
  const server = createStorybookStudioMcpServer({ port: 0, version: 'test', authSecret: SECRET })
  await server.start()
  t.after(() => server.stop())
  const { port } = server.server.address()
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const json = { 'Content-Type': 'application/json' }

  const missing = await request(port, { headers: json, body })
  assert.equal(missing.status, 401)
  assert.match(missing.headers['www-authenticate'], /^Bearer/)

  const wrong = await request(port, { headers: { ...json, Authorization: `Bearer ${'0'.repeat(64)}` }, body })
  assert.equal(wrong.status, 401)

  const evil = await request(port, { headers: { ...json, Authorization: `Bearer ${SECRET}`, Origin: 'https://evil.example' }, body })
  assert.equal(evil.status, 403)
  assert.equal(evil.headers['access-control-allow-origin'], 'http://127.0.0.1')

  const preflight = await request(port, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })
  assert.equal(preflight.status, 403)

  const ok = await request(port, { headers: { ...json, Authorization: `Bearer ${SECRET}` }, body })
  assert.equal(ok.status, 200)
  // FILM-2013: the agent profile (19 capability tools) is the default; the upstream editor's are at ?profile=expert.
  assert.equal(JSON.parse(ok.body).result.tools.length, 19)

  const loopbackOrigin = await request(port, { headers: { ...json, Authorization: `Bearer ${SECRET}`, Origin: 'http://localhost:5173' }, body })
  assert.equal(loopbackOrigin.status, 200)
  assert.equal(loopbackOrigin.headers['access-control-allow-origin'], 'http://localhost:5173')
  assert.match(loopbackOrigin.headers['access-control-allow-headers'], /Authorization/)
})

test('a server constructed without a secret refuses every request', async (t) => {
  const server = createStorybookStudioMcpServer({ port: 0, version: 'test' })
  await server.start()
  t.after(() => server.stop())
  const { port } = server.server.address()
  const res = await request(port, { headers: { Authorization: 'Bearer anything' }, body: '{}' })
  assert.equal(res.status, 401)
})
