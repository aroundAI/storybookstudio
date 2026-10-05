// FILM-2010: which port the local MCP server listens on. Two StorybookStudios
// on one machine (a dev build beside the packaged app) each get their own,
// from a small range, and keep it across restarts through
// userData/mcp-endpoint.json. Pure: the caller passes app.getPath('userData').
const fs = require('fs')
const path = require('path')

const DEFAULT_MCP_PORT = 19790
const MCP_PORT_RANGE_SIZE = 10
const MCP_ENDPOINT_FILE_NAME = 'mcp-endpoint.json'

function mcpUrlForPort(port) {
  return `http://127.0.0.1:${port}/mcp`
}

function mcpEndpointPath(userDataDir) {
  return path.join(userDataDir, MCP_ENDPOINT_FILE_NAME)
}

function inRange(port, base = DEFAULT_MCP_PORT, size = MCP_PORT_RANGE_SIZE) {
  return Number.isInteger(port) && port >= base && port < base + size
}

// The port this userData last listened on, or null.
function readMcpEndpoint(userDataDir, { fsImpl = fs } = {}) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(mcpEndpointPath(userDataDir), 'utf8'))
    return inRange(parsed?.port) ? { port: parsed.port, url: mcpUrlForPort(parsed.port) } : null
  } catch {
    return null
  }
}

function writeMcpEndpoint(userDataDir, { port }, { fsImpl = fs } = {}) {
  const filePath = mcpEndpointPath(userDataDir)
  const tempPath = `${filePath}.${process.pid}.tmp`
  fsImpl.mkdirSync(userDataDir, { recursive: true })
  fsImpl.writeFileSync(tempPath, `${JSON.stringify({ port, url: mcpUrlForPort(port) }, null, 2)}\n`, 'utf8')
  fsImpl.renameSync(tempPath, filePath)
}

// The remembered port first, then 19790…19799 in order.
function mcpPortCandidates(preferredPort = null, { base = DEFAULT_MCP_PORT, size = MCP_PORT_RANGE_SIZE } = {}) {
  const range = Array.from({ length: size }, (_, i) => base + i)
  return inRange(preferredPort, base, size) ? [preferredPort, ...range.filter((port) => port !== preferredPort)] : range
}

module.exports = {
  DEFAULT_MCP_PORT,
  MCP_PORT_RANGE_SIZE,
  MCP_ENDPOINT_FILE_NAME,
  mcpUrlForPort,
  mcpEndpointPath,
  readMcpEndpoint,
  writeMcpEndpoint,
  mcpPortCandidates,
}
