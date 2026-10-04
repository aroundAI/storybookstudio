// FILM-2010: the local MCP server's bearer secret, userData/mcp-secret.
// Pure: the caller passes app.getPath('userData'), so `node --test` covers it.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const MCP_SECRET_FILE_NAME = 'mcp-secret'
const MCP_SECRET_PATTERN = /^[0-9a-f]{64}$/
const MCP_CLIENT_NAME = 'storybookstudio'
const MCP_TOKEN_ENV_VAR = 'STORYBOOKSTUDIO_MCP_TOKEN'

function mcpSecretPath(userDataDir) {
  return path.join(userDataDir, MCP_SECRET_FILE_NAME)
}

// Reads the secret, or generates 32 random bytes (hex) on first run.
// A file that does not hold a well-formed secret is replaced.
function loadOrCreateMcpSecret(userDataDir, { fsImpl = fs } = {}) {
  if (!userDataDir || !path.isAbsolute(userDataDir)) {
    throw new Error('loadOrCreateMcpSecret needs an absolute userData directory.')
  }
  const filePath = mcpSecretPath(userDataDir)
  try {
    const existing = fsImpl.readFileSync(filePath, 'utf8').trim()
    if (MCP_SECRET_PATTERN.test(existing)) return existing
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const secret = crypto.randomBytes(32).toString('hex')
  fsImpl.mkdirSync(userDataDir, { recursive: true })
  const tempPath = `${filePath}.${process.pid}.tmp`
  fsImpl.writeFileSync(tempPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 })
  fsImpl.renameSync(tempPath, filePath)
  try { fsImpl.chmodSync(filePath, 0o600) } catch { /* not supported on every platform */ }
  return secret
}

function buildMcpConnectCommand({ url, secret, name = MCP_CLIENT_NAME }) {
  const header = `Authorization: Bearer ${secret}`
  return {
    url,
    header,
    claudeCommand: `claude mcp add --transport http ${name} ${url} --header "${header}"`,
    // Codex reads the bearer at run time from the environment variable it is told to use.
    tokenEnvVar: MCP_TOKEN_ENV_VAR,
    codexEnvLine: `export ${MCP_TOKEN_ENV_VAR}=${secret}`,
    codexCommand: `codex mcp add ${name} --url ${url} --bearer-token-env-var ${MCP_TOKEN_ENV_VAR}`,
  }
}

module.exports = {
  MCP_SECRET_FILE_NAME,
  MCP_CLIENT_NAME,
  MCP_TOKEN_ENV_VAR,
  mcpSecretPath,
  loadOrCreateMcpSecret,
  buildMcpConnectCommand,
}
