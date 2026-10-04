// FILM-2011: velorn:// deep links. Main process only.
//
//   velorn://open?api=<StoryBook origin>&episode=<uuid>
//     opens the episode picker with that episode selected (never a pull by
//     itself: the user still clicks). `api` must be on the allowlist: the
//     configured StoryBook hosts plus the host the user is signed in to.
//   velorn://auth/callback?code=&state=
//     the OAuth redirect, handed to auth.js (which checks `state`).
//   anything else is ignored and logged, without its query string.
//
// The scheme is one constant (lead decision 8, FILM-2010: it may change).
const VELORN_SCHEME = 'velorn'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// An http(s) origin, or null. Credentials in the URL are refused outright.
function normalizeApiOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  return url.origin
}

function ignored(reason) {
  return { kind: 'ignored', reason }
}

function parseVelornUrl(raw, { allowedOrigins = [] } = {}) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return ignored('not a URL')
  }
  if (url.protocol !== `${VELORN_SCHEME}:`) return ignored('not a velorn:// link')

  // velorn://open?… parses with host "open"; velorn:open?… with pathname "open".
  const route = `${url.host}${url.pathname}`.replace(/^\/+|\/+$/g, '')

  if (route === 'auth/callback') {
    return { kind: 'auth-callback', params: Object.fromEntries(url.searchParams) }
  }

  if (route === 'open') {
    const api = normalizeApiOrigin(url.searchParams.get('api'))
    const allowed = new Set(allowedOrigins.map(normalizeApiOrigin).filter(Boolean))
    if (!api || !allowed.has(api)) return ignored('api host is not an allowed StoryBook host')
    const episodeId = url.searchParams.get('episode') ?? ''
    if (!UUID_PATTERN.test(episodeId)) return ignored('episode is not an episode id')
    return { kind: 'open', api, episodeId: episodeId.toLowerCase() }
  }

  return ignored(`unknown path "${route.slice(0, 40)}"`)
}

// The link inside a launch command line (Windows/Linux pass it as an argument).
function linkInArgv(argv) {
  return (argv || []).find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(`${VELORN_SCHEME}:`)) || null
}

// Claims the scheme and the single-instance lock and routes links. Handlers
// run only after ready(): links that arrive while the app starts (open-url
// fires before `ready` on macOS; a cold start carries the link in argv) are
// held until the window can show the picker.
function registerVelornProtocol({
  app,
  platform = process.platform,
  argv = process.argv,
  defaultApp = Boolean(process.defaultApp),
  execPath = process.execPath,
  getAllowedOrigins,
  onOpen,
  onAuthCallback,
  log = (line) => console.warn(line),
}) {
  // In development the scheme must launch `electron <app path>`.
  if (defaultApp && argv.length >= 2) {
    app.setAsDefaultProtocolClient(VELORN_SCHEME, execPath, [require('path').resolve(argv[1])])
  } else {
    app.setAsDefaultProtocolClient(VELORN_SCHEME)
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return { primary: false, ready() {}, handle() {} }
  }

  let isReady = false
  const held = []

  const route = (raw) => {
    const link = parseVelornUrl(raw, { allowedOrigins: getAllowedOrigins() })
    if (link.kind === 'open') return onOpen(link)
    if (link.kind === 'auth-callback') return onAuthCallback(link.params)
    log(`[studio] velorn:// link ignored: ${link.reason}`)
    return undefined
  }

  const handle = (raw) => {
    if (!isReady) {
      held.push(raw)
      return
    }
    try {
      route(raw)
    } catch (error) {
      log(`[studio] velorn:// link failed: ${error?.message || error}`)
    }
  }

  app.on('open-url', (event, url) => {
    event?.preventDefault?.()
    handle(url)
  })
  app.on('second-instance', (_event, commandLine) => {
    const link = linkInArgv(commandLine)
    if (link) handle(link)
  })
  if (platform !== 'darwin') {
    const link = linkInArgv(argv)
    if (link) handle(link)
  }

  return {
    primary: true,
    handle,
    ready() {
      if (isReady) return
      isReady = true
      for (const raw of held.splice(0)) handle(raw)
    },
  }
}

module.exports = {
  VELORN_SCHEME,
  UUID_PATTERN,
  normalizeApiOrigin,
  parseVelornUrl,
  linkInArgv,
  registerVelornProtocol,
}
