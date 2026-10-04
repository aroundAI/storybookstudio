// FILM-2011: the cloud client's main-process wiring. studioMain.js creates
// it; it owns sign-in, the MCP client per StoryBook host, the job registry,
// the pull job, re-sync, edit events and the velorn:// handler, and exposes
// them to the renderer as studio:* IPC (never a token, never a signed URL).
//
// Renderer → main (invoke):
//   studio:authStatus, studio:signIn {apiOrigin, method: 'token'|'browser', token?, redirect?},
//   studio:signOut, studio:listProjects, studio:listEpisodes {projectId},
//   studio:pull {episodeId, apiOrigin?} → {jobId}, studio:jobStatus {jobId},
//   studio:checkUpdates, studio:pullBuilt {jobId, ok, projectPath?, warnings?, error?},
//   studio:projectOpened {projectPath}, studio:projectClosed, studio:recordEvent {type, data},
//   studio:rendererReady
// Main → renderer (send):
//   studio:auth-changed, studio:job-progress, studio:pull-ready, studio:open-request,
//   studio:plan-proposed
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createStudioAuth } = require('./auth')
const { createStoryBookClient, StudioClientError } = require('./client')
const { createJobRegistry } = require('./jobs')
const { runPullJob } = require('./pull')
const { createResync } = require('./sync')
const { createEditEventQueue } = require('./events')
const { registerVelornProtocol, normalizeApiOrigin, UUID_PATTERN } = require('./protocol')
const { createProbe } = require('./probe')

const CONFIG_FILE = 'studio-cloud.json'
const BUILD_TIMEOUT_MS = 5 * 60 * 1000

function deviceName() {
  const host = os.hostname().replace(/\.local$/i, '').replace(/[-_]+/g, ' ').trim()
  return host ? `StorybookStudio on ${host}`.slice(0, 100) : 'StorybookStudio'
}

const errorBody = (error) => ({
  success: false,
  code: error?.code || 'INTERNAL',
  error: error?.message || String(error),
  ...(error instanceof StudioClientError && error.role ? { role: error.role } : {}),
})

function createStudioCloud({ app, ipcMain, shell, secrets, getMainWindow, isMainWindowSender, getFfprobePath = () => null, env = process.env, log = (line) => console.warn(line) }) {
  const configPath = () => path.join(app.getPath('userData'), CONFIG_FILE)
  const readConfig = () => {
    try {
      return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    } catch {
      return {}
    }
  }
  const writeConfig = (patch) => {
    const next = { ...readConfig(), ...patch }
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2))
    return next
  }

  const envAllowlist = () => String(env.STUDIO_API_ALLOWLIST || '').split(',').map(normalizeApiOrigin).filter(Boolean)
  const activeOrigin = () => normalizeApiOrigin(readConfig().apiOrigin) || normalizeApiOrigin(env.STUDIO_API_URL) || null
  // The hosts a velorn://open link may name: configured ones plus the host
  // the user signed in to.
  const allowedOrigins = () => {
    const config = readConfig()
    const signedIn = (config.signedInOrigins || []).map(normalizeApiOrigin).filter(Boolean)
    return [...new Set([...envAllowlist(), normalizeApiOrigin(env.STUDIO_API_URL), ...(config.allowedOrigins || []).map(normalizeApiOrigin), ...signedIn].filter(Boolean))]
  }
  const projectsRoot = () => env.STUDIO_PROJECTS_DIR || readConfig().projectsRoot || path.join(app.getPath('documents'), 'StorybookStudio')

  const send = (channel, payload) => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  const verifyToken = async (origin, token) => {
    const probeClient = createStoryBookClient({
      apiOrigin: origin,
      auth: { getAccessToken: async () => token, refresh: async () => ({ ok: false }), onSignInRequired() {} },
    })
    try {
      return await probeClient.whoami()
    } catch (error) {
      if (error?.code === 'UNAUTHORIZED') throw Object.assign(new Error('StoryBook did not accept that token.'), { code: 'UNAUTHORIZED' })
      throw error
    } finally {
      await probeClient.close()
    }
  }

  const auth = createStudioAuth({
    secrets,
    verifyToken,
    openExternal: (url) => shell.openExternal(url),
    deviceName,
    emit: (status) => send('studio:auth-changed', status),
    log,
  })

  const clients = new Map()
  const clientFor = (origin) => {
    const key = normalizeApiOrigin(origin)
    if (!key) throw Object.assign(new Error('Choose a StoryBook address first.'), { code: 'VALIDATION_FAILED' })
    if (!clients.has(key)) {
      clients.set(
        key,
        createStoryBookClient({
          apiOrigin: key,
          auth: { getAccessToken: auth.getAccessToken, refresh: auth.refresh, onSignInRequired: auth.requireSignIn },
        }),
      )
    }
    return clients.get(key)
  }

  const jobs = createJobRegistry({ emit: (job) => send('studio:job-progress', job) })
  const probe = (file) => createProbe(getFfprobePath())(file)
  const builds = new Map()

  // The builder (FILM-2012) runs in the renderer, where the project stores
  // live; the pull job waits for its answer.
  const buildInRenderer = (input) =>
    new Promise((resolve, reject) => {
      const window = getMainWindow()
      if (!window || window.isDestroyed()) {
        reject(new Error('The editor window is not open to build the project.'))
        return
      }
      const timer = setTimeout(() => {
        builds.delete(input.jobId)
        reject(new Error('The editor did not build the project in time.'))
      }, BUILD_TIMEOUT_MS)
      builds.set(input.jobId, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      send('studio:pull-ready', input)
    })

  // The pulled project that is open: its session, events and re-sync.
  let open = null
  const resync = createResync({
    getClient: clientFor,
    getOpenProject: () => open,
    emitPlan: (plan) => send('studio:plan-proposed', plan),
    log,
  })

  async function attachProject(projectDir) {
    const session = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(projectDir, 'storybook', 'session.json'), 'utf8'))
      } catch {
        return null
      }
    })()
    if (open?.projectDir === projectDir) return open
    await detachProject()
    if (!session?.sessionId || !normalizeApiOrigin(session.apiOrigin)) return null
    open = {
      projectDir,
      apiOrigin: session.apiOrigin,
      episodeId: session.episodeId,
      sessionId: session.sessionId,
      events: createEditEventQueue({
        client: clientFor(session.apiOrigin),
        sessionId: session.sessionId,
        persistPath: path.join(projectDir, 'storybook', 'pending-events.json'),
        log,
      }),
    }
    resync.start()
    return open
  }

  async function detachProject() {
    const closing = open
    open = null
    resync.stop()
    if (!closing) return null
    try {
      return await closing.events.close()
    } catch (error) {
      log(`[studio] could not close the edit session: ${error?.code || ''} ${error?.message || error}`)
      return null
    }
  }

  // FILM-2013's studio_open_episode calls this; the picker's Pull button too.
  function openEpisode({ episodeId, apiOrigin = activeOrigin() }) {
    if (!UUID_PATTERN.test(String(episodeId || ''))) throw Object.assign(new Error('That is not an episode id.'), { code: 'VALIDATION_FAILED' })
    const origin = normalizeApiOrigin(apiOrigin)
    if (!origin || !auth.status(origin).signedIn) throw Object.assign(new Error('Sign in to StoryBook first.'), { code: 'UNAUTHORIZED' })
    const running = jobs.running('pull').find((job) => job.episodeId === episodeId)
    if (running) return { jobId: running.id, existing: true }
    const job = jobs.create('pull', { episodeId, apiOrigin: origin })
    runPullJob({
      job,
      episodeId,
      apiOrigin: origin,
      client: clientFor(origin),
      projectsRoot: projectsRoot(),
      probe,
      build: buildInRenderer,
      log,
    })
      .then((result) => attachProject(result.projectDir))
      .catch(() => {
        // job.fail recorded it; the renderer sees studio:job-progress.
      })
    return { jobId: job.id, existing: false }
  }

  const protocol = registerVelornProtocol({
    app,
    getAllowedOrigins: allowedOrigins,
    onOpen: (link) => {
      const window = getMainWindow()
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore()
        window.focus()
      }
      // Never a pull: the picker opens with the episode selected.
      send('studio:open-request', { ...link, signedIn: auth.status(link.api).signedIn })
    },
    onAuthCallback: (params) => auth.handleCallback(params),
    log,
  })

  const guard = (handler) => async (event, args = {}) => {
    if (!isMainWindowSender(event)) return { success: false, code: 'FORBIDDEN', error: 'Not available to this window.' }
    try {
      return { success: true, ...(await handler(args || {})) }
    } catch (error) {
      return errorBody(error)
    }
  }

  const rememberSignedIn = (origin) => {
    const config = readConfig()
    writeConfig({ apiOrigin: origin, signedInOrigins: [...new Set([...(config.signedInOrigins || []), origin])] })
  }

  ipcMain.handle('studio:authStatus', guard(async ({ apiOrigin } = {}) => {
    const origin = normalizeApiOrigin(apiOrigin) || activeOrigin()
    return { status: auth.status(origin), apiOrigin: origin, allowedOrigins: allowedOrigins(), projectsRoot: projectsRoot() }
  }))
  ipcMain.handle('studio:signIn', guard(async ({ apiOrigin, method = 'browser', token, redirect = 'loopback' }) => {
    const origin = normalizeApiOrigin(apiOrigin)
    if (!origin) throw Object.assign(new Error('Enter the StoryBook address, for example https://app.example.com.'), { code: 'VALIDATION_FAILED' })
    const status = method === 'token' ? await auth.signInWithToken(origin, token) : await auth.signInWithBrowser(origin, { redirect })
    rememberSignedIn(origin)
    return { status }
  }))
  ipcMain.handle('studio:signOut', guard(async ({ apiOrigin } = {}) => {
    const origin = normalizeApiOrigin(apiOrigin) || activeOrigin()
    if (!origin) return { status: { signedIn: false } }
    const config = readConfig()
    writeConfig({ signedInOrigins: (config.signedInOrigins || []).filter((o) => o !== origin) })
    await clients.get(origin)?.close()
    clients.delete(origin)
    return { status: await auth.signOut(origin) }
  }))
  ipcMain.handle('studio:listProjects', guard(async ({ apiOrigin } = {}) => ({ result: await clientFor(apiOrigin || activeOrigin()).listProjects({}) })))
  ipcMain.handle('studio:listEpisodes', guard(async ({ apiOrigin, projectId }) => ({ result: await clientFor(apiOrigin || activeOrigin()).listEpisodes({ projectId }) })))
  ipcMain.handle('studio:pull', guard(async ({ episodeId, apiOrigin }) => openEpisode({ episodeId, apiOrigin })))
  ipcMain.handle('studio:jobStatus', guard(async ({ jobId }) => {
    const job = jobs.get(jobId)
    if (!job) throw Object.assign(new Error('No such job.'), { code: 'NOT_FOUND' })
    return { job }
  }))
  ipcMain.handle('studio:checkUpdates', guard(async () => ({ result: await resync.check() })))
  ipcMain.handle('studio:pullBuilt', guard(async ({ jobId, ok, projectPath, warnings, error, builder }) => {
    const pending = builds.get(jobId)
    if (!pending) throw Object.assign(new Error('No build is waiting for that job.'), { code: 'NOT_FOUND' })
    builds.delete(jobId)
    if (ok) pending.resolve({ projectPath, warnings: Array.isArray(warnings) ? warnings.map(String) : [], builder: builder ?? null })
    else pending.reject(Object.assign(new Error(String(error || 'The project could not be built.')), { code: 'BUILD_FAILED' }))
    return {}
  }))
  ipcMain.handle('studio:projectOpened', guard(async ({ projectPath }) => {
    if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) return { attached: false }
    const attached = await attachProject(projectPath)
    return { attached: Boolean(attached), episodeId: attached?.episodeId ?? null }
  }))
  ipcMain.handle('studio:projectClosed', guard(async () => ({ closed: Boolean(await detachProject()) })))
  ipcMain.handle('studio:recordEvent', guard(async ({ type, data }) => {
    if (!open) return { queued: false }
    await open.events.push({ type, data })
    return { queued: true }
  }))
  ipcMain.handle('studio:networkOnline', guard(async () => ({ flushed: open ? await open.events.online() : null })))
  ipcMain.handle('studio:rendererReady', guard(async () => {
    protocol.ready()
    return {}
  }))

  return {
    protocol,
    auth,
    jobs,
    openEpisode,
    getJobStatus: (jobId) => jobs.get(jobId),
    checkUpdates: () => resync.check(),
    onReady() {
      const origin = activeOrigin()
      if (origin) auth.resume(origin)
    },
    async shutdown() {
      await detachProject()
    },
  }
}

module.exports = { createStudioCloud, deviceName }
