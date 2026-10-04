// FILM-2011: signing in to StoryBook. Main process only; no IPC handler,
// event or log line ever carries a token (FILM-2010 S2).
//
// Two ways in:
// - a pasted personal access token (`sbk_pat_…`, FILM-1904), kept only after
//   `whoami` accepts it;
// - OAuth 2.1 with PKCE S256 as the pre-registered public client
//   `storybookstudio` (FILM-1907, FILM-2005): the system browser opens
//   /oauth/authorize, the code comes back to a loopback listener on
//   127.0.0.1:<random port>/callback or to velorn://auth/callback, and is
//   exchanged at /oauth/token with `client_name=<device name>` so the
//   connection is named after this computer. Access tokens last an hour; a
//   refresh runs five minutes before expiry and saves the rotated refresh
//   token (FILM-1907 rotates on every use).
//
// Tokens are stored through the FILM-2010 secrets module (safeStorage,
// userData/studio-secrets.json) under one key per StoryBook origin, so a
// staging and a production host can both be signed in.
const crypto = require('crypto')
const http = require('http')

const CLIENT_ID = 'storybookstudio'
const OAUTH_SCOPE = 'studio:read studio:write studio:render'
const REFRESH_LEAD_MS = 5 * 60 * 1000
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000
const VELORN_REDIRECT = 'velorn://auth/callback'
const PAT_PATTERN = /^sbk_pat_[A-Za-z0-9_-]{20,}$/
const SIGN_IN_AGAIN = 'Sign in again'

// One secrets key per origin; the store allows [A-Za-z0-9._:-].
function secretKeyForOrigin(origin) {
  return `storybook-auth:${String(origin).replace('://', '-').replace(/[^A-Za-z0-9.-]/g, '-')}`.slice(0, 128)
}

function refreshDelayMs({ expiresAt, now }) {
  if (!Number.isFinite(expiresAt)) return null
  return Math.max(0, expiresAt - REFRESH_LEAD_MS - now)
}

const mcpUrlFor = (origin) => new URL('/api/mcp', origin).toString()

const CALLBACK_PAGE = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;background:#0a0a0b;color:#e5e5e5;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:20px">${title}</h1><p>${body}</p></div></body>`

function createStudioAuth({
  secrets,
  verifyToken,
  openExternal,
  deviceName = () => 'StorybookStudio',
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  sdkAuth = require('@modelcontextprotocol/sdk/client/auth.js').auth,
  fetchFn = undefined,
  emit = () => {},
  log = () => {},
  callbackTimeoutMs = CALLBACK_TIMEOUT_MS,
}) {
  const timers = new Map()
  const messages = new Map()
  const refreshing = new Map()
  let pending = null

  const read = (origin) => {
    const raw = secrets.getSecret(secretKeyForOrigin(origin))
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  const write = (origin, record) => secrets.setSecret(secretKeyForOrigin(origin), JSON.stringify(record))

  function status(origin) {
    const record = origin ? read(origin) : null
    if (!record) return { signedIn: false, apiOrigin: origin ?? null, message: messages.get(origin) ?? null }
    return {
      signedIn: true,
      apiOrigin: origin,
      kind: record.kind,
      user: record.whoami?.user ?? null,
      team: record.whoami?.team ?? null,
      connection: record.whoami?.connection ? { clientName: record.whoami.connection.clientName ?? null, scopes: record.whoami.connection.scopes ?? [] } : null,
      expiresAt: record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
      message: null,
    }
  }

  const changed = (origin) => emit(status(origin))

  function schedule(origin, record) {
    clearTimer(timers.get(origin))
    timers.delete(origin)
    if (record?.kind !== 'oauth') return
    const delay = refreshDelayMs({ expiresAt: record.expiresAt, now: now() })
    if (delay === null) return
    const timer = setTimer(() => {
      timers.delete(origin)
      return refresh(origin)
    }, delay)
    timer?.unref?.()
    timers.set(origin, timer)
  }

  function forget(origin, message) {
    clearTimer(timers.get(origin))
    timers.delete(origin)
    secrets.deleteSecret(secretKeyForOrigin(origin))
    if (message) messages.set(origin, message)
    else messages.delete(origin)
    changed(origin)
  }

  async function signInWithToken(apiOrigin, token) {
    const origin = new URL(apiOrigin).origin
    const value = String(token ?? '').trim()
    if (!PAT_PATTERN.test(value)) {
      throw Object.assign(new Error('Paste a StoryBook personal access token: it starts with sbk_pat_.'), { code: 'VALIDATION_FAILED' })
    }
    const whoami = await verifyToken(origin, value)
    write(origin, { kind: 'pat', apiOrigin: origin, accessToken: value, whoami, savedAt: now() })
    messages.delete(origin)
    schedule(origin, null)
    changed(origin)
    return status(origin)
  }

  // The provider the SDK's auth() drives. Everything it saves stays in this
  // closure until the caller writes it to the secrets store.
  function provider({ origin, redirectUrl, state = null, tokens = undefined }) {
    const box = { tokens, authorizationUrl: null, verifier: null }
    return {
      box,
      get redirectUrl() {
        return redirectUrl
      },
      get clientMetadata() {
        return {
          client_name: 'StorybookStudio',
          redirect_uris: [redirectUrl],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: OAUTH_SCOPE,
        }
      },
      // Pre-registered (FILM-2005): no dynamic registration.
      clientInformation: () => ({ client_id: CLIENT_ID }),
      state: () => state,
      // This hook replaces the SDK's own client authentication, so it sets
      // client_id itself (FILM-2005 item 3), and names the device on the
      // code exchange: StoryBook stores it as the connection's name.
      addClientAuthentication(_headers, params) {
        params.set('client_id', CLIENT_ID)
        if (params.get('grant_type') === 'authorization_code') params.set('client_name', deviceName())
      },
      tokens: () => box.tokens,
      saveTokens: (next) => {
        box.tokens = next
      },
      redirectToAuthorization: (url) => {
        box.authorizationUrl = url
      },
      saveCodeVerifier: (verifier) => {
        box.verifier = verifier
      },
      codeVerifier: () => {
        if (!box.verifier) throw new Error('No PKCE verifier for this sign-in.')
        return box.verifier
      },
      origin,
    }
  }

  function loopbackListener({ state, origin }) {
    return new Promise((resolve, reject) => {
      let deliver = null
      const code = new Promise((ok, fail) => {
        deliver = { ok, fail }
      })
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        if (url.pathname !== '/callback') {
          res.writeHead(404).end()
          return
        }
        const params = Object.fromEntries(url.searchParams)
        const outcome = checkCallback(params, { state, origin })
        if (outcome.refused) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(CALLBACK_PAGE('Sign-in not accepted', outcome.refused))
          return
        }
        const page = outcome.error
          ? CALLBACK_PAGE('Sign-in was not completed', 'Return to StorybookStudio to try again.')
          : CALLBACK_PAGE('Signed in to StoryBook', 'You can close this tab and return to StorybookStudio.')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' })
        res.end(page, () => {
          server.close()
          server.closeAllConnections?.()
        })
        if (outcome.error) deliver.fail(outcome.error)
        else deliver.ok(outcome.code)
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        resolve({
          redirectUri: `http://127.0.0.1:${port}/callback`,
          code,
          close: () => {
            server.close()
            server.closeAllConnections?.()
          },
        })
      })
    })
  }

  // A callback is accepted only with this sign-in's state and, when the
  // server says who issued it (RFC 9207), from the host we asked.
  function checkCallback(params, { state, origin }) {
    if (!params.state || params.state !== state) return { refused: 'This sign-in link does not belong to the sign-in StorybookStudio started.' }
    if (params.iss && params.iss.replace(/\/$/, '') !== origin) return { refused: 'This sign-in came from a different server.' }
    if (params.error) {
      const error = Object.assign(new Error(params.error === 'access_denied' ? 'Sign-in was cancelled in the browser.' : `StoryBook refused the sign-in (${params.error}).`), { code: 'UNAUTHORIZED' })
      return { error }
    }
    if (!params.code) return { refused: 'The sign-in link has no code.' }
    return { code: params.code }
  }

  async function signInWithBrowser(apiOrigin, { redirect = 'loopback' } = {}) {
    const origin = new URL(apiOrigin).origin
    if (pending) pending.cancel(new Error('A newer sign-in started.'))

    const state = crypto.randomBytes(32).toString('base64url')
    let listener = null
    let codePromise
    let redirectUrl
    let viaProtocol = null
    if (redirect === 'velorn') {
      redirectUrl = VELORN_REDIRECT
      codePromise = new Promise((ok, fail) => {
        viaProtocol = { ok, fail }
      })
    } else {
      listener = await loopbackListener({ state, origin })
      redirectUrl = listener.redirectUri
      codePromise = listener.code
    }

    let timeout = null
    const flow = {
      state,
      origin,
      viaProtocol,
      cancel: (error) => {
        listener?.close()
        viaProtocol?.fail(error)
        listener?.code && listener.code.catch(() => {})
      },
    }
    pending = flow
    const timedOut = new Promise((_, fail) => {
      timeout = setTimeout(() => fail(Object.assign(new Error('Sign-in timed out; start it again.'), { code: 'UNAUTHORIZED' })), callbackTimeoutMs)
      timeout.unref?.()
    })

    try {
      const p = provider({ origin, redirectUrl, state })
      const options = { serverUrl: mcpUrlFor(origin), scope: OAUTH_SCOPE, ...(fetchFn ? { fetchFn } : {}) }
      const first = await sdkAuth(p, options)
      if (first !== 'REDIRECT' || !p.box.authorizationUrl) throw new Error('StoryBook did not start a browser sign-in.')
      await openExternal(p.box.authorizationUrl.toString())
      const code = await Promise.race([codePromise, timedOut])
      const second = await sdkAuth(p, { ...options, authorizationCode: code })
      if (second !== 'AUTHORIZED' || !p.box.tokens?.access_token) throw new Error('StoryBook did not issue a token.')
      const tokens = p.box.tokens
      const whoami = await verifyToken(origin, tokens.access_token)
      const record = {
        kind: 'oauth',
        apiOrigin: origin,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: Number.isFinite(tokens.expires_in) ? now() + tokens.expires_in * 1000 : null,
        scope: tokens.scope ?? null,
        whoami,
        savedAt: now(),
      }
      write(origin, record)
      messages.delete(origin)
      schedule(origin, record)
      changed(origin)
      return status(origin)
    } finally {
      clearTimeout(timeout)
      listener?.close()
      if (pending === flow) pending = null
    }
  }

  // velorn://auth/callback, routed here by protocol.js.
  function handleCallback(params) {
    const flow = pending
    if (!flow?.viaProtocol) return false
    const outcome = checkCallback(params || {}, { state: flow.state, origin: flow.origin })
    if (outcome.refused) {
      log(`[studio] auth callback refused: ${outcome.refused}`)
      return false
    }
    if (outcome.error) flow.viaProtocol.fail(outcome.error)
    else flow.viaProtocol.ok(outcome.code)
    return true
  }

  async function refresh(apiOrigin) {
    const origin = new URL(apiOrigin).origin
    if (refreshing.has(origin)) return refreshing.get(origin)
    const run = (async () => {
      const record = read(origin)
      if (record?.kind !== 'oauth' || !record.refreshToken) return { ok: false, reason: 'not_refreshable' }
      const p = provider({
        origin,
        redirectUrl: VELORN_REDIRECT,
        tokens: { access_token: record.accessToken, refresh_token: record.refreshToken, token_type: 'Bearer' },
      })
      let result
      try {
        result = await sdkAuth(p, { serverUrl: mcpUrlFor(origin), scope: OAUTH_SCOPE, ...(fetchFn ? { fetchFn } : {}) })
      } catch (error) {
        // Offline or a server error: keep the tokens and try again later.
        log(`[studio] token refresh failed, will retry: ${error?.message || error}`)
        const retry = setTimer(() => refresh(origin), 60_000)
        retry?.unref?.()
        clearTimer(timers.get(origin))
        timers.set(origin, retry)
        return { ok: false, reason: 'transient' }
      }
      const tokens = p.box.tokens
      // REDIRECT means the refresh token was refused and the SDK wants a new
      // browser sign-in; that is the user's decision, so nothing opens.
      if (result !== 'AUTHORIZED' || !tokens?.access_token || tokens.access_token === record.accessToken) {
        forget(origin, SIGN_IN_AGAIN)
        return { ok: false, reason: 'refused' }
      }
      const next = {
        ...record,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? record.refreshToken,
        expiresAt: Number.isFinite(tokens.expires_in) ? now() + tokens.expires_in * 1000 : null,
        scope: tokens.scope ?? record.scope,
        savedAt: now(),
      }
      write(origin, next)
      schedule(origin, next)
      changed(origin)
      return { ok: true }
    })()
    refreshing.set(origin, run)
    try {
      return await run
    } finally {
      refreshing.delete(origin)
    }
  }

  async function getAccessToken(apiOrigin) {
    const origin = new URL(apiOrigin).origin
    const record = read(origin)
    if (!record) return null
    if (record.kind === 'oauth' && Number.isFinite(record.expiresAt) && record.expiresAt - now() <= REFRESH_LEAD_MS) {
      const result = await refresh(origin)
      if (!result.ok && result.reason !== 'transient') return null
      return read(origin)?.accessToken ?? null
    }
    return record.accessToken
  }

  // On start: re-arm the refresh timer for a stored sign-in.
  function resume(apiOrigin) {
    const origin = new URL(apiOrigin).origin
    const record = read(origin)
    if (record) schedule(origin, record)
    return status(origin)
  }

  async function signOut(apiOrigin, { revoke = null } = {}) {
    const origin = new URL(apiOrigin).origin
    const record = read(origin)
    forget(origin, null)
    if (revoke && record?.kind === 'oauth' && record.refreshToken) {
      try {
        await revoke(origin, record.refreshToken)
      } catch (error) {
        log(`[studio] token revoke failed: ${error?.message || error}`)
      }
    }
    return status(origin)
  }

  // The client calls this when StoryBook still says UNAUTHORIZED after a refresh.
  function requireSignIn(apiOrigin) {
    forget(new URL(apiOrigin).origin, SIGN_IN_AGAIN)
  }

  return { signInWithToken, signInWithBrowser, handleCallback, refresh, getAccessToken, status, resume, signOut, requireSignIn }
}

module.exports = {
  CLIENT_ID,
  OAUTH_SCOPE,
  REFRESH_LEAD_MS,
  SIGN_IN_AGAIN,
  VELORN_REDIRECT,
  createStudioAuth,
  refreshDelayMs,
  secretKeyForOrigin,
  mcpUrlFor,
}
