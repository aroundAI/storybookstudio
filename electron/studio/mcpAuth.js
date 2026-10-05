// FILM-2010: request checks for the local MCP server (electron/mcpServer.js).
// Pure: no Electron import, so `node --test` covers it.
const crypto = require('crypto')

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function headerValue(headers, name) {
  if (!headers) return ''
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) return value.length === 1 ? String(value[0]) : ''
  return value == null ? '' : String(value)
}

// Host header: "127.0.0.1:19790", "localhost", "[::1]:19790".
function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase()
  if (!value) return false
  const hostname = value.startsWith('[')
    ? value.slice(0, value.indexOf(']') + 1)
    : value.split(':')[0]
  if (value.startsWith('[') && !/^\[[^\]]+\](:\d{1,5})?$/.test(value)) return false
  if (!value.startsWith('[') && !/^[^:]+(:\d{1,5})?$/.test(value)) return false
  return LOOPBACK_HOSTNAMES.has(hostname)
}

// FILM-2010: the port a Host header names, or null when it names none.
function hostPort(host) {
  const match = /:(\d{1,5})$/.exec(String(host || '').trim())
  return match ? Number(match[1]) : null
}

// Origin header: "http://127.0.0.1:5173". "null" and non-http schemes are not loopback.
function isLoopbackOrigin(origin) {
  const value = String(origin || '').trim()
  if (!value || value === 'null') return false
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  return LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())
}

function secretsMatch(presented, secret) {
  const a = crypto.createHash('sha256').update(String(presented)).digest()
  const b = crypto.createHash('sha256').update(String(secret)).digest()
  return crypto.timingSafeEqual(a, b)
}

// Returns { ok: true, status: 200 } or { ok: false, status: 401|403, reason }.
// The reason never contains the presented or the expected secret.
// With `port`, the Host must name that port: a second StorybookStudio on the
// machine listens on another one (electron/studio/mcpPort.js).
function authorizeMcpRequest(headers, secret, { requireBearer = true, port = null } = {}) {
  const host = headerValue(headers, 'host')
  if (!isLoopbackHost(host)) {
    return { ok: false, status: 403, reason: 'Host is not loopback.' }
  }
  if (port != null && hostPort(host) !== port) {
    return { ok: false, status: 403, reason: 'Host names another port.' }
  }
  const origin = headerValue(headers, 'origin')
  if (origin && !isLoopbackOrigin(origin)) {
    return { ok: false, status: 403, reason: 'Origin is not loopback.' }
  }
  if (!requireBearer) return { ok: true, status: 200 }

  if (typeof secret !== 'string' || secret.length === 0) {
    return { ok: false, status: 401, reason: 'MCP server has no secret configured.' }
  }
  const authorization = headerValue(headers, 'authorization').trim()
  const match = /^Bearer\s+(\S+)$/i.exec(authorization)
  if (!match) {
    return { ok: false, status: 401, reason: 'Missing bearer token.' }
  }
  if (!secretsMatch(match[1], secret)) {
    return { ok: false, status: 401, reason: 'Invalid bearer token.' }
  }
  return { ok: true, status: 200 }
}

module.exports = {
  authorizeMcpRequest,
  hostPort,
  isLoopbackHost,
  isLoopbackOrigin,
}
