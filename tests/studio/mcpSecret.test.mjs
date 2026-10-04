// FILM-2010 AC4: userData/mcp-secret is generated once and the connect command carries it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { loadOrCreateMcpSecret, buildMcpConnectCommand, mcpSecretPath } = require('../../electron/studio/mcpSecret.js')

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-mcp-secret-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('first run writes 32 random bytes as hex, readable only by the owner', (t) => {
  const dir = tempDir(t)
  const secret = loadOrCreateMcpSecret(dir)
  assert.match(secret, /^[0-9a-f]{64}$/)
  assert.equal(fs.readFileSync(mcpSecretPath(dir), 'utf8').trim(), secret)
  if (process.platform !== 'win32') assert.equal(fs.statSync(mcpSecretPath(dir)).mode & 0o777, 0o600)
})

test('later runs reuse the same secret', (t) => {
  const dir = tempDir(t)
  assert.equal(loadOrCreateMcpSecret(dir), loadOrCreateMcpSecret(dir))
})

test('two installs get different secrets', (t) => {
  assert.notEqual(loadOrCreateMcpSecret(tempDir(t)), loadOrCreateMcpSecret(tempDir(t)))
})

test('a malformed secret file is replaced', (t) => {
  const dir = tempDir(t)
  fs.writeFileSync(mcpSecretPath(dir), 'short\n')
  assert.match(loadOrCreateMcpSecret(dir), /^[0-9a-f]{64}$/)
})

test('the Claude Code command is the one the spec prescribes', () => {
  const secret = 'f'.repeat(64)
  const commands = buildMcpConnectCommand({ url: 'http://127.0.0.1:19790/mcp', secret })
  assert.equal(
    commands.claudeCommand,
    `claude mcp add --transport http storybookstudio http://127.0.0.1:19790/mcp --header "Authorization: Bearer ${secret}"`,
  )
  assert.equal(commands.codexCommand, 'codex mcp add storybookstudio --url http://127.0.0.1:19790/mcp --bearer-token-env-var STORYBOOKSTUDIO_MCP_TOKEN')
  assert.equal(commands.codexEnvLine, `export STORYBOOKSTUDIO_MCP_TOKEN=${secret}`)
})
