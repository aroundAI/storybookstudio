// FILM-2011 AC1: sign-in by pasted token (validated by whoami) and by PKCE
// through the system browser with a loopback or storybookstudio:// redirect; tokens
// only in the secrets store, keyed by API host; refresh 5 minutes before
// expiry with the rotated refresh token saved; studio:auth-changed carries
// no token.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStudioAuth, refreshDelayMs, secretKeyForOrigin, REFRESH_LEAD_MS } = require('../../electron/studio/auth.js')

const API = 'http://localhost:3306'
const PAT = (name) => `sbk_pat_${name.padEnd(43, 'x')}`
const WHOAMI = { user: { id: 'u1', name: 'Ada', email: 'ada@example.com' }, team: { id: 't1', slug: 'team', name: 'Team' }, connection: { id: 'c1', clientName: 'Ada’s Mac', scopes: ['studio:read', 'studio:write'] } }

function memorySecrets() {
  const map = new Map()
  return {
    map,
    setSecret: (k, v) => map.set(k, v),
    getSecret: (k) => (map.has(k) ? map.get(k) : null),
    deleteSecret: (k) => map.delete(k),
    hasSecret: (k) => map.has(k),
  }
}

// A clock and timer queue the test advances by hand.
function fakeClock(start = 1_000_000) {
  let now = start
  const timers = []
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now + ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { if (timer) timer.cleared = true },
    pending: () => timers.filter((t) => !t.cleared && !t.fired),
    async advance(ms) {
      now += ms
      for (const timer of timers) {
        if (!timer.cleared && !timer.fired && timer.at <= now) {
          timer.fired = true
          await timer.fn()
        }
      }
    },
  }
}

function harness({ verify = async () => WHOAMI, sdkAuth } = {}) {
  const secrets = memorySecrets()
  const clock = fakeClock()
  const events = []
  const opened = []
  const auth = createStudioAuth({
    secrets,
    verifyToken: verify,
    openExternal: async (url) => opened.push(url),
    deviceName: () => 'Ada’s Mac',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sdkAuth,
    emit: (status) => events.push(status),
  })
  return { auth, secrets, clock, events, opened }
}

test('the refresh is due five minutes before expiry, never in the past', () => {
  assert.equal(REFRESH_LEAD_MS, 5 * 60 * 1000)
  assert.equal(refreshDelayMs({ expiresAt: 10_000_000, now: 1_000_000 }), 10_000_000 - 1_000_000 - REFRESH_LEAD_MS)
  assert.equal(refreshDelayMs({ expiresAt: 1_100_000, now: 1_000_000 }), 0)
  assert.equal(refreshDelayMs({ expiresAt: null, now: 1 }), null)
})

test('secrets are keyed by API host', () => {
  assert.equal(secretKeyForOrigin('http://localhost:3306'), 'storybook-auth:http-localhost-3306')
  assert.equal(secretKeyForOrigin('https://app.storybook.example'), 'storybook-auth:https-app.storybook.example')
  assert.notEqual(secretKeyForOrigin('https://a.example'), secretKeyForOrigin('https://b.example'))
})

test('a pasted token is stored only after whoami accepts it', async () => {
  let accept = false
  const h = harness({ verify: async () => { if (!accept) throw Object.assign(new Error('The bearer token is not recognised.'), { code: 'UNAUTHORIZED' }); return WHOAMI } })
  await assert.rejects(h.auth.signInWithToken(API, PAT('bad')), /not recognised/)
  assert.equal(h.secrets.map.size, 0)

  accept = true
  const status = await h.auth.signInWithToken(API, PAT('good'))
  assert.equal(status.signedIn, true)
  assert.equal(status.kind, 'pat')
  assert.equal(status.user.email, 'ada@example.com')
  assert.equal(await h.auth.getAccessToken(API), PAT('good'))
  assert.ok(h.secrets.getSecret(secretKeyForOrigin(API)).includes(PAT('good')))
  assert.equal(h.events.length, 1)
  assert.doesNotMatch(JSON.stringify(h.events), /sbk_pat_/)
  assert.doesNotMatch(JSON.stringify(status), /sbk_pat_/)
})

test('a token that is not a StoryBook token is refused before any network call', async () => {
  let called = 0
  const h = harness({ verify: async () => { called += 1; return WHOAMI } })
  await assert.rejects(h.auth.signInWithToken(API, 'ghp_abc'), /sbk_pat_/)
  assert.equal(called, 0)
})

// The SDK's auth(): the first call redirects, the second exchanges the code
// and saves tokens, a call with a refresh token saves rotated ones.
function fakeSdkAuth(log) {
  let issued = 0
  return async (provider, options) => {
    log.push({ code: options.authorizationCode ?? null, hasTokens: Boolean(await provider.tokens?.()) })
    if (options.authorizationCode) {
      const params = new URLSearchParams({ grant_type: 'authorization_code', code: options.authorizationCode })
      provider.addClientAuthentication(new Headers(), params)
      log.push({ tokenParams: Object.fromEntries(params) })
      issued += 1
      await provider.saveTokens({ access_token: `sbk_at_${issued}`, refresh_token: `sbk_rt_${issued}`, expires_in: 3600, token_type: 'Bearer', scope: 'studio:read studio:write' })
      return 'AUTHORIZED'
    }
    const current = await provider.tokens()
    if (current?.refresh_token) {
      const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refresh_token })
      provider.addClientAuthentication(new Headers(), params)
      log.push({ tokenParams: Object.fromEntries(params) })
      if (current.refresh_token === 'sbk_rt_revoked') {
        await provider.redirectToAuthorization(new URL(`${options.serverUrl}/oauth/authorize?x=1`))
        return 'REDIRECT'
      }
      issued += 1
      await provider.saveTokens({ access_token: `sbk_at_${issued}`, refresh_token: `sbk_rt_${issued}`, expires_in: 3600, token_type: 'Bearer' })
      return 'AUTHORIZED'
    }
    const state = await provider.state()
    const url = new URL('/oauth/authorize', options.serverUrl)
    url.searchParams.set('client_id', provider.clientInformation().client_id)
    url.searchParams.set('redirect_uri', String(provider.redirectUrl))
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge_method', 'S256')
    provider.saveCodeVerifier('verifier')
    await provider.redirectToAuthorization(url)
    return 'REDIRECT'
  }
}

test('PKCE with a loopback redirect: browser opened, code caught on 127.0.0.1, exchanged with the device name, refresh scheduled', async () => {
  const log = []
  const h = harness({ sdkAuth: fakeSdkAuth(log) })
  const signingIn = h.auth.signInWithBrowser(API, { redirect: 'loopback' })

  while (h.opened.length === 0) await new Promise((r) => setImmediate(r))
  const authorizeUrl = new URL(h.opened[0])
  assert.equal(authorizeUrl.searchParams.get('client_id'), 'storybookstudio')
  const redirect = authorizeUrl.searchParams.get('redirect_uri')
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d{2,5}\/callback$/)

  // A callback with the wrong state is refused and does not end the flow.
  const forged = await fetch(`${redirect}?code=forged&state=wrong`)
  assert.equal(forged.status, 400)
  const ok = await fetch(`${redirect}?code=real-code&state=${authorizeUrl.searchParams.get('state')}&iss=${encodeURIComponent(API)}`)
  assert.equal(ok.status, 200)

  const status = await signingIn
  assert.equal(status.signedIn, true)
  assert.equal(status.kind, 'oauth')
  assert.deepEqual(log.find((e) => e.code)?.code, 'real-code')
  assert.deepEqual(log.find((e) => e.tokenParams)?.tokenParams, {
    grant_type: 'authorization_code',
    code: 'real-code',
    client_id: 'storybookstudio',
    client_name: 'Ada’s Mac',
  })
  assert.equal(await h.auth.getAccessToken(API), 'sbk_at_1')
  // The loopback listener is closed once the code arrived.
  await assert.rejects(fetch(`${redirect}?code=late&state=x`))
  // One refresh timer, five minutes before the hour is up.
  assert.equal(h.clock.pending().length, 1)
  assert.equal(h.clock.pending()[0].at - h.clock.now(), 3600 * 1000 - REFRESH_LEAD_MS)
})

test('the refresh fires on schedule, rotates the refresh token and re-arms; the old refresh token is gone', async () => {
  const log = []
  const h = harness({ sdkAuth: fakeSdkAuth(log) })
  const signingIn = h.auth.signInWithBrowser(API, { redirect: 'storybookstudio' })
  while (h.opened.length === 0) await new Promise((r) => setImmediate(r))
  const authorizeUrl = new URL(h.opened[0])
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'storybookstudio://auth/callback')
  // storybookstudio://auth/callback arrives through protocol.js.
  assert.equal(h.auth.handleCallback({ code: 'c', state: 'nope' }), false)
  assert.equal(h.auth.handleCallback({ code: 'c', state: authorizeUrl.searchParams.get('state') }), true)
  await signingIn

  await h.clock.advance(3600 * 1000 - REFRESH_LEAD_MS - 1)
  assert.equal(await h.auth.getAccessToken(API), 'sbk_at_1', 'not yet')
  await h.clock.advance(1)
  assert.equal(await h.auth.getAccessToken(API), 'sbk_at_2')
  const stored = h.secrets.getSecret(secretKeyForOrigin(API))
  assert.match(stored, /sbk_rt_2/)
  assert.doesNotMatch(stored, /sbk_rt_1/)
  assert.equal(log.filter((e) => e.tokenParams?.grant_type === 'refresh_token')[0].tokenParams.refresh_token, 'sbk_rt_1')
  assert.equal(h.clock.pending().length, 1, 're-armed for the new expiry')
})

test('a token asked for inside the last five minutes is refreshed first', async () => {
  const log = []
  const h = harness({ sdkAuth: fakeSdkAuth(log) })
  const signingIn = h.auth.signInWithBrowser(API, { redirect: 'storybookstudio' })
  while (h.opened.length === 0) await new Promise((r) => setImmediate(r))
  h.auth.handleCallback({ code: 'c', state: new URL(h.opened[0]).searchParams.get('state') })
  await signingIn
  h.clock.pending().forEach((t) => h.clock.clearTimer(t)) // the timer missed (machine asleep)
  await h.clock.advance(3600 * 1000 - 60 * 1000)
  assert.equal(await h.auth.getAccessToken(API), 'sbk_at_2')
})

test('a refused refresh signs out with "Sign in again" and never opens a browser by itself', async () => {
  const log = []
  const h = harness({ sdkAuth: fakeSdkAuth(log) })
  h.secrets.setSecret(secretKeyForOrigin(API), JSON.stringify({ kind: 'oauth', apiOrigin: API, accessToken: 'sbk_at_old', refreshToken: 'sbk_rt_revoked', expiresAt: h.clock.now() + 1000, whoami: WHOAMI }))
  const result = await h.auth.refresh(API)
  assert.equal(result.ok, false)
  assert.equal(h.opened.length, 0)
  const status = h.auth.status(API)
  assert.equal(status.signedIn, false)
  assert.equal(status.message, 'Sign in again')
  assert.equal(h.secrets.getSecret(secretKeyForOrigin(API)), null)
  assert.equal(h.events.at(-1).message, 'Sign in again')
})

test('sign-out deletes the host’s tokens and leaves another host’s alone', async () => {
  const h = harness()
  await h.auth.signInWithToken(API, PAT('one'))
  await h.auth.signInWithToken('https://staging.example', PAT('two'))
  await h.auth.signOut(API)
  assert.equal(h.auth.status(API).signedIn, false)
  assert.equal(await h.auth.getAccessToken('https://staging.example'), PAT('two'))
})
