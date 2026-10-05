// FILM-2010 AC7: secrets are encrypted with safeStorage in the main process; a planted
// value never shows up in the file on disk, the MCP snapshot/responses, the logs or the
// renderer-facing bridge.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const secrets = require('../../electron/studio/secrets.js')
const { createStorybookStudioMcpServer } = require('../../electron/mcpServer.js')

const PLANTED = 'sk-planted-6b1f0c9e4a7d2e85'
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')

// Reversible, and never contains the plaintext or its base64.
function fakeSafeStorage({ available = true } = {}) {
  const key = 0x5a
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.concat([Buffer.from('v10'), Buffer.from(value, 'utf8').map((b) => b ^ key)]),
    decryptString: (buffer) => Buffer.from(buffer.subarray(3).map((b) => b ^ key)).toString('utf8'),
  }
}

function userDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-secrets-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Everything the process prints while fn runs: console.* and raw stdout/stderr writes.
async function captureOutput(fn) {
  const lines = []
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace']
  const originals = Object.fromEntries(methods.map((m) => [m, console[m]]))
  const writes = { out: process.stdout.write, err: process.stderr.write }
  for (const m of methods) console[m] = (...args) => lines.push(args.map(String).join(' '))
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return writes.out.call(process.stdout, chunk, ...rest) }
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return writes.err.call(process.stderr, chunk, ...rest) }
  try {
    await fn()
  } finally {
    Object.assign(console, originals)
    process.stdout.write = writes.out
    process.stderr.write = writes.err
  }
  return lines.join('\n')
}

function assertAbsent(haystack, where) {
  for (const form of [PLANTED, Buffer.from(PLANTED).toString('base64'), Buffer.from(PLANTED).toString('hex')]) {
    assert.ok(!haystack.includes(form), `${where} contains the planted secret (${form.slice(0, 6)}…)`)
  }
}

function post(port, secret, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('a stored secret round-trips and the file holds only ciphertext', async (t) => {
  const dir = userDataDir(t)
  const output = await captureOutput(async () => {
    secrets.configureSecrets({ userDataDir: dir, safeStorage: fakeSafeStorage() })
    secrets.setSecret('storybook.refreshToken', PLANTED)
    assert.equal(secrets.getSecret('storybook.refreshToken'), PLANTED)
    assert.equal(secrets.hasSecret('storybook.refreshToken'), true)
  })
  const file = fs.readFileSync(path.join(dir, secrets.SECRETS_FILE_NAME), 'utf8')
  assert.ok(JSON.parse(file).entries['storybook.refreshToken'])
  assertAbsent(file, 'studio-secrets.json')
  assertAbsent(output, 'log output')
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, secrets.SECRETS_FILE_NAME)).mode & 0o777, 0o600)
})

test('deleteSecret removes the entry', (t) => {
  const store = secrets.createSecretStore({ filePath: path.join(userDataDir(t), 's.json'), safeStorage: fakeSafeStorage() })
  store.setSecret('k', PLANTED)
  assert.equal(store.deleteSecret('k'), true)
  assert.equal(store.getSecret('k'), null)
  assert.equal(store.deleteSecret('k'), false)
})

test('without OS encryption the store refuses instead of writing plaintext', (t) => {
  const filePath = path.join(userDataDir(t), 's.json')
  const store = secrets.createSecretStore({ filePath, safeStorage: fakeSafeStorage({ available: false }) })
  assert.throws(() => store.setSecret('k', PLANTED), (error) => error.code === 'SECRETS_UNAVAILABLE' && !error.message.includes(PLANTED))
  assert.equal(fs.existsSync(filePath), false)
})

test('a stored entry cannot be read back once encryption becomes unavailable', (t) => {
  const filePath = path.join(userDataDir(t), 's.json')
  secrets.createSecretStore({ filePath, safeStorage: fakeSafeStorage() }).setSecret('k', PLANTED)
  const locked = secrets.createSecretStore({ filePath, safeStorage: fakeSafeStorage({ available: false }) })
  assert.throws(() => locked.getSecret('k'), { code: 'SECRETS_UNAVAILABLE' })
})

test('errors never echo a value', (t) => {
  const store = secrets.createSecretStore({ filePath: path.join(userDataDir(t), 's.json'), safeStorage: fakeSafeStorage() })
  assert.throws(() => store.setSecret('bad key with spaces', PLANTED), (error) => !error.message.includes(PLANTED))
})

test('the MCP snapshot, its responses and the server logs never carry a stored secret', async (t) => {
  const dir = userDataDir(t)
  secrets.configureSecrets({ userDataDir: dir, safeStorage: fakeSafeStorage() })
  secrets.setSecret('storybook.accessToken', PLANTED)

  const mcpSecret = 'c'.repeat(64)
  const server = createStorybookStudioMcpServer({ port: 0, version: 'test', authSecret: mcpSecret })
  let transcript = ''
  const output = await captureOutput(async () => {
    await server.start()
    server.updateSnapshot({
      schemaVersion: 1,
      app: { name: 'StorybookStudio' },
      project: { name: 'Pilot', path: dir, settings: { width: 1920, height: 1080, fps: 24 } },
      timelines: [], currentTimeline: null, assets: [], folders: [],
    })
    const { port } = server.server.address()
    for (const payload of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_project', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_timeline', arguments: {} } },
    ]) {
      transcript += await post(port, mcpSecret, payload)
    }
    transcript += JSON.stringify(server.getStatus()) + JSON.stringify(server.lastSnapshot)
  })
  await server.stop()
  assert.match(transcript, /Pilot/, 'the transcript is real: it names the open project')
  assertAbsent(transcript, 'MCP responses and snapshot')
  assertAbsent(output, 'server log output')
})

test('no renderer-facing code can reach the secrets module', () => {
  const preload = fs.readFileSync(path.join(REPO, 'electron', 'preload.js'), 'utf8')
  assert.doesNotMatch(preload, /getSecret|setSecret|studio-secrets|secrets\.js/)

  const main = fs.readFileSync(path.join(REPO, 'electron', 'main.js'), 'utf8')
  assert.doesNotMatch(main, /ipcMain\.(handle|on)\([^)]*[Ss]ecret/)
  assert.doesNotMatch(main, /getSecret\(/)

  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(m?js|jsx)$/.test(entry.name) && /studio\/secrets|studio-secrets/.test(fs.readFileSync(full, 'utf8'))) offenders.push(full)
    }
  }
  walk(path.join(REPO, 'src'))
  assert.deepEqual(offenders, [])
})
