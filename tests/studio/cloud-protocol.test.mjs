// FILM-2011 AC7: storybookstudio:// links. An open link names a StoryBook host on the
// allowlist and a well-formed episode id, and only ever pre-selects the
// picker; the auth callback goes to auth.js; anything else is ignored.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseStorybookStudioUrl, normalizeApiOrigin, registerStorybookStudioProtocol } = require('../../electron/studio/protocol.js')

const EPISODE = '6f1c2a9e-4b7d-4e85-9a3b-1c2d3e4f5a6b'
const ALLOWED = ['https://app.storybook.example', 'http://localhost:3306']
const open = (api, episode = EPISODE) =>
  `storybookstudio://open?api=${encodeURIComponent(api)}&episode=${encodeURIComponent(episode)}`

test('an open link on the allowlist pre-selects the episode', () => {
  assert.deepEqual(parseStorybookStudioUrl(open('https://app.storybook.example'), { allowedOrigins: ALLOWED }), {
    kind: 'open',
    api: 'https://app.storybook.example',
    episodeId: EPISODE,
  })
  // The web app sends an origin; a trailing slash or path is normalised to it.
  assert.equal(parseStorybookStudioUrl(open('http://localhost:3306/'), { allowedOrigins: ALLOWED }).api, 'http://localhost:3306')
})

test('a hostile api host is refused', () => {
  for (const api of [
    'https://evil.example',
    'https://app.storybook.example.evil.example',
    'https://app.storybook.example@evil.example',
    'http://app.storybook.example', // scheme matters
    'https://app.storybook.example:8443', // port matters
    'javascript:alert(1)',
    'file:///etc/passwd',
    '',
  ]) {
    const result = parseStorybookStudioUrl(open(api), { allowedOrigins: ALLOWED })
    assert.equal(result.kind, 'ignored', `expected ${JSON.stringify(api)} to be refused`)
    assert.match(result.reason, /api/)
  }
})

test('a malformed episode id is refused', () => {
  for (const episode of ['', '42', 'not-a-uuid', `${EPISODE}x`, `${EPISODE}/../x`, '../../etc/passwd']) {
    const result = parseStorybookStudioUrl(open('https://app.storybook.example', episode), { allowedOrigins: ALLOWED })
    assert.equal(result.kind, 'ignored', `expected ${JSON.stringify(episode)} to be refused`)
    assert.match(result.reason, /episode/)
  }
})

test('the auth callback is routed with its parameters; other paths and schemes are ignored', () => {
  assert.deepEqual(parseStorybookStudioUrl('storybookstudio://auth/callback?code=abc&state=xyz', { allowedOrigins: [] }), {
    kind: 'auth-callback',
    params: { code: 'abc', state: 'xyz' },
  })
  assert.equal(parseStorybookStudioUrl('storybookstudio://settings?x=1', { allowedOrigins: ALLOWED }).kind, 'ignored')
  assert.equal(parseStorybookStudioUrl('storybookstudio-file://open?api=x', { allowedOrigins: ALLOWED }).kind, 'ignored')
  assert.equal(parseStorybookStudioUrl('not a url', { allowedOrigins: ALLOWED }).kind, 'ignored')
})

test('normalizeApiOrigin keeps http(s) origins only', () => {
  assert.equal(normalizeApiOrigin('https://App.Storybook.example/api/mcp'), 'https://app.storybook.example')
  assert.equal(normalizeApiOrigin('ftp://x.example'), null)
  assert.equal(normalizeApiOrigin('https://user:pw@x.example'), null)
  assert.equal(normalizeApiOrigin(42), null)
})

function fakeApp({ lock = true } = {}) {
  const app = new EventEmitter()
  app.calls = []
  app.setAsDefaultProtocolClient = (...args) => app.calls.push(['setAsDefaultProtocolClient', ...args])
  app.requestSingleInstanceLock = () => lock
  app.quit = () => app.calls.push(['quit'])
  return app
}

test('registration claims the scheme and the single-instance lock, and routes open-url and second-instance', () => {
  const app = fakeApp()
  const seen = []
  const logged = []
  const handle = registerStorybookStudioProtocol({
    app,
    platform: 'darwin',
    argv: ['/Applications/StorybookStudio.app/Contents/MacOS/StorybookStudio'],
    getAllowedOrigins: () => ALLOWED,
    onOpen: (link) => seen.push(['open', link]),
    onAuthCallback: (params) => seen.push(['auth', params]),
    log: (line) => logged.push(line),
  })
  assert.equal(handle.primary, true)
  assert.deepEqual(app.calls[0].slice(0, 2), ['setAsDefaultProtocolClient', 'storybookstudio'])
  handle.ready()

  let prevented = false
  app.emit('open-url', { preventDefault: () => { prevented = true } }, open('http://localhost:3306'))
  assert.equal(prevented, true)
  // Windows/Linux deliver the link in the second instance's argv.
  app.emit('second-instance', {}, ['StorybookStudio.exe', '--flag', 'storybookstudio://auth/callback?code=c1&state=s1'])
  app.emit('open-url', { preventDefault() {} }, open('https://evil.example'))
  assert.deepEqual(seen, [
    ['open', { kind: 'open', api: 'http://localhost:3306', episodeId: EPISODE }],
    ['auth', { code: 'c1', state: 's1' }],
  ])
  assert.equal(logged.length, 1)
  assert.match(logged[0], /ignored/)
  // A refused link is logged without its query, which could carry a code.
  assert.doesNotMatch(logged[0], /evil\.example|code=/)
})

test('a second instance that cannot take the lock quits and handles nothing', () => {
  const app = fakeApp({ lock: false })
  const handle = registerStorybookStudioProtocol({ app, platform: 'win32', argv: [], getAllowedOrigins: () => ALLOWED, onOpen() {}, onAuthCallback() {}, log() {} })
  assert.equal(handle.primary, false)
  assert.ok(app.calls.some(([name]) => name === 'quit'))
})

test('a link in the first instance argv (Windows cold start) is handled once the app is ready', () => {
  const app = fakeApp()
  const seen = []
  const handle = registerStorybookStudioProtocol({
    app,
    platform: 'win32',
    argv: ['StorybookStudio.exe', open('http://localhost:3306')],
    getAllowedOrigins: () => ALLOWED,
    onOpen: (link) => seen.push(link),
    onAuthCallback() {},
    log() {},
  })
  assert.deepEqual(seen, [])
  handle.ready()
  assert.deepEqual(seen, [{ kind: 'open', api: 'http://localhost:3306', episodeId: EPISODE }])
})
