// FILM-2010: a second StorybookStudio on the same machine (a dev build beside
// the packaged app) gets its own MCP port, keeps it across restarts, and the
// connect command and the Host check follow the port it actually got.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStorybookStudioMcpServer } = require('../../electron/mcpServer.js')
const { authorizeMcpRequest } = require('../../electron/studio/mcpAuth.js')
const { createStudioMain } = require('../../electron/studio/studioMain.js')

const SECRET_A = 'a'.repeat(64)
const SECRET_B = 'b'.repeat(64)
const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

function request(port, { host = `127.0.0.1:${port}`, secret, body = TOOLS_LIST } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', Host: host }
    if (secret) headers.Authorization = `Bearer ${secret}`
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

// A run of `count` consecutive free ports, so the test never depends on what
// else is listening on this machine.
async function freePortRun(count) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const base = 30000 + Math.floor(Math.random() * 20000)
    const holders = []
    try {
      for (let port = base; port < base + count; port += 1) {
        const s = http.createServer()
        await new Promise((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', resolve) })
        holders.push(s)
      }
      return Array.from({ length: count }, (_, i) => base + i)
    } catch {
      // taken; try another base
    } finally {
      await Promise.all(holders.map((s) => new Promise((resolve) => s.close(resolve))))
    }
  }
  throw new Error('no free port run')
}

test('two servers started from the same port list get different ports, and both answer an authenticated tools/list', async (t) => {
  const ports = await freePortRun(4)
  const a = createStorybookStudioMcpServer({ port: ports[0], version: 'test', authSecret: SECRET_A })
  const b = createStorybookStudioMcpServer({ port: ports[0], version: 'test', authSecret: SECRET_B })
  t.after(() => Promise.all([a.stop(), b.stop()]))

  const statusA = await a.start({ ports })
  const statusB = await b.start({ ports })
  assert.equal(statusA.port, ports[0])
  assert.equal(statusB.port, ports[1], 'the second falls back to the next port')
  assert.equal(statusB.url, `http://127.0.0.1:${ports[1]}/mcp`)
  assert.equal(statusB.running, true)

  for (const [status, secret] of [[statusA, SECRET_A], [statusB, SECRET_B]]) {
    const res = await request(status.port, { secret })
    assert.equal(res.status, 200, `tools/list on ${status.port}`)
    assert.equal(JSON.parse(res.body).result.tools.length, 19)
  }
  // Each answers only its own secret.
  assert.equal((await request(statusB.port, { secret: SECRET_A })).status, 401)
})

test('the Host check accepts the port the server got and refuses any other', async (t) => {
  const ports = await freePortRun(3)
  const a = createStorybookStudioMcpServer({ port: ports[0], version: 'test', authSecret: SECRET_A })
  const b = createStorybookStudioMcpServer({ port: ports[0], version: 'test', authSecret: SECRET_B })
  t.after(() => Promise.all([a.stop(), b.stop()]))
  await a.start({ ports })
  const { port } = await b.start({ ports })

  assert.equal((await request(port, { secret: SECRET_B })).status, 200)
  assert.equal((await request(port, { secret: SECRET_B, host: `localhost:${port}` })).status, 200)
  assert.equal((await request(port, { secret: SECRET_B, host: `127.0.0.1:${ports[0]}` })).status, 403, 'the first instance\'s port')
  assert.equal((await request(port, { secret: SECRET_B, host: '127.0.0.1' })).status, 403, 'no port means 80')

  const headers = (host) => ({ host, authorization: `Bearer ${SECRET_A}` })
  assert.deepEqual(authorizeMcpRequest(headers('127.0.0.1:19791'), SECRET_A, { port: 19791 }), { ok: true, status: 200 })
  assert.deepEqual(authorizeMcpRequest(headers('[::1]:19791'), SECRET_A, { port: 19791 }), { ok: true, status: 200 })
  for (const host of ['127.0.0.1:19790', '127.0.0.1:19792', 'localhost', '127.0.0.1:019791x']) {
    assert.equal(authorizeMcpRequest(headers(host), SECRET_A, { port: 19791 }).status, 403, host)
  }
})

test('a server whose every port is taken says so instead of failing silently', async (t) => {
  const ports = await freePortRun(2)
  const holders = []
  for (const port of ports) {
    const s = http.createServer()
    await new Promise((resolve) => s.listen(port, '127.0.0.1', resolve))
    holders.push(s)
  }
  t.after(() => Promise.all(holders.map((s) => new Promise((resolve) => s.close(resolve)))))
  const server = createStorybookStudioMcpServer({ port: ports[0], version: 'test', authSecret: SECRET_A })
  await assert.rejects(server.start({ ports }), (error) => error.code === 'EADDRINUSE' && error.message.includes(`${ports[0]}–${ports[1]}`))
  const status = server.getStatus()
  assert.equal(status.running, false)
  assert.match(status.error, new RegExp(`${ports[0]}–${ports[1]} are all in use`))
})

// studioMain is what main.js calls: it picks the ports from userData, writes
// userData/mcp-endpoint.json, and builds the Settings connect command.
function fakeStudio(userDataDir, mcpServer, dialogCalls = []) {
  const handlers = new Map()
  const webContents = { send() {} }
  const mainWindow = { isDestroyed: () => false, webContents }
  const app = Object.assign(new EventEmitter(), {
    getPath: () => userDataDir,
    getVersion: () => '9.9.9',
    setAsDefaultProtocolClient: () => true,
    requestSingleInstanceLock: () => true,
    quit: () => {},
  })
  const studio = createStudioMain({
    app,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: {},
    getMainWindow: () => mainWindow,
    getMcpServer: () => mcpServer,
    dialog: { showMessageBox: async (_win, options) => { dialogCalls.push(options); return { response: 0 } } },
  })
  const connectCommand = () => handlers.get('studio:getMcpConnectCommand')({ sender: webContents })
  return { studio, connectCommand }
}

const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `sbs-mcp-port-${name}-`))

test('studioMain: two instances get different ports, the connect command names each, and each keeps its port across restarts', async (t) => {
  const dirA = tempDir('a')
  const dirB = tempDir('b')
  t.after(() => { fs.rmSync(dirA, { recursive: true, force: true }); fs.rmSync(dirB, { recursive: true, force: true }) })

  const start = async (dir) => {
    const server = createStorybookStudioMcpServer({ version: 'test', authSecret: SECRET_A })
    const { studio, connectCommand } = fakeStudio(dir, server)
    const status = await studio.startMcpServer(server)
    return { server, status, connectCommand, studio }
  }

  const a = await start(dirA)
  const b = await start(dirB)
  t.after(() => Promise.all([a.server.stop(), b.server.stop()]))
  assert.equal(a.status.running, true)
  assert.equal(b.status.running, true)
  assert.notEqual(a.status.port, b.status.port)
  for (const port of [a.status.port, b.status.port]) assert.ok(port >= 19790 && port <= 19799, `${port} in 19790–19799`)

  for (const instance of [a, b]) {
    const command = await instance.connectCommand()
    assert.equal(command.success, true)
    assert.equal(command.url, `http://127.0.0.1:${instance.status.port}/mcp`)
    assert.ok(command.claudeCommand.includes(`http://127.0.0.1:${instance.status.port}/mcp`), command.claudeCommand)
  }

  const endpointB = JSON.parse(fs.readFileSync(path.join(dirB, 'mcp-endpoint.json'), 'utf8'))
  assert.equal(endpointB.port, b.status.port)
  assert.equal(endpointB.url, `http://127.0.0.1:${b.status.port}/mcp`)

  // Restart both, B first: each gets the port it had, not the first free one.
  await a.server.stop()
  await b.server.stop()
  const b2 = await start(dirB)
  const a2 = await start(dirA)
  t.after(() => Promise.all([a2.server.stop(), b2.server.stop()]))
  assert.equal(b2.status.port, b.status.port, 'B keeps its port')
  assert.equal(a2.status.port, a.status.port, 'A keeps its port')
})

test('studioMain shows the user a failure to start, not only a console line', async (t) => {
  const dir = tempDir('fail')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const server = createStorybookStudioMcpServer({ version: 'test', authSecret: SECRET_A })
  const dialogCalls = []
  const { studio } = fakeStudio(dir, server, dialogCalls)
  // Every candidate refuses with EADDRINUSE.
  server.start = async () => {
    server.error = 'Ports 19790–19799 are all in use.'
    throw Object.assign(new Error(server.error), { code: 'EADDRINUSE' })
  }
  const status = await studio.startMcpServer(server)
  assert.equal(status.running, false)
  assert.equal(dialogCalls.length, 1)
  assert.match(dialogCalls[0].message, /MCP server/)
  assert.match(dialogCalls[0].detail, /19790–19799 are all in use/)
  assert.equal(fs.existsSync(path.join(dir, 'mcp-endpoint.json')), false)
})
