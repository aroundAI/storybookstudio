// FILM-2010: the studio layer's main-process registration. main.js calls
// createStudioMain() once; everything security-related lives here so the
// upstream file changes only at its registration points.
const path = require('path')
const { loadOrCreateMcpSecret, buildMcpConnectCommand } = require('./mcpSecret')
const { comfystudioUrlToPath, resolveAllowedPath, createGrantedFileSet } = require('./protocolAllowlist')
const secrets = require('./secrets')
const { createStudioCloud } = require('./cloud')
const { createStudioDeliver } = require('./deliver')
const { createDeliveryPath } = require('./deliveryPath')
const { createAudioReads } = require('./audioReads')
const { createStudioUiMain } = require('./studioUi')

// Velorn's own temp working directories; Electron has no "cache" path name.
const CACHE_DIR_NAMES = ['comfystudio-shot-audio', 'comfystudio-caption-audio']

function createStudioMain({ app, ipcMain, safeStorage, shell, getMainWindow, getMcpServer, getFfprobePath = () => null, getFfmpegPath = () => null, getMediaPreparation = () => null, dialog = null }) {
  // A separate profile (and so a separate single-instance lock) for a
  // development run beside an installed StorybookStudio.
  if (process.env.STUDIO_USER_DATA_DIR) app.setPath('userData', process.env.STUDIO_USER_DATA_DIR)
  let mcpSecret = null
  const grantedFiles = createGrantedFileSet()

  const getMcpSecret = () => {
    if (!mcpSecret) mcpSecret = loadOrCreateMcpSecret(app.getPath('userData'))
    return mcpSecret
  }

  const isMainWindowSender = (event) => {
    const mainWindow = getMainWindow()
    return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents)
  }

  // Settings > Agents (MCP) asks for this to show the ready-made command.
  ipcMain.handle('studio:getMcpConnectCommand', (event) => {
    if (!isMainWindowSender(event)) return { success: false, error: 'Not available to this window.' }
    const status = getMcpServer()?.getStatus?.()
    const url = status?.url || 'http://127.0.0.1:19790/mcp'
    return { success: true, ...buildMcpConnectCommand({ url, secret: getMcpSecret() }) }
  })

  // FILM-2011: sign-in, pull, re-sync, edit events and velorn:// links.
  // Created here, at load, so the scheme and the single-instance lock are
  // claimed before `ready` (macOS delivers open-url that early).
  const cloud = createStudioCloud({
    app,
    ipcMain,
    shell,
    secrets,
    getMainWindow,
    isMainWindowSender,
    getFfprobePath,
  })

  // FILM-2017: Deliver, variants and the reframe tools.
  const deliver = createStudioDeliver({
    jobs: cloud.jobs,
    getOpenProject: cloud.getOpenProject,
    getClient: cloud.clientFor,
    checkUpdates: cloud.checkUpdates,
    getMcpServer,
    getFfmpegPath,
    getFfprobePath,
    // FILM-2014: render through the media-preparation queue (hardware encode,
    // x264 fallback) and check with qa.js.
    ...(() => {
      const delivery = createDeliveryPath({ getFfmpegPath, getFfprobePath, getMediaPreparation })
      return { render: delivery.render, qa: delivery.check }
    })(),
    log: (line) => console.warn(line),
  })
  const deliverGuard = (handler) => async (event, args = {}) => {
    if (!isMainWindowSender(event)) return { success: false, code: 'FORBIDDEN', error: 'Not available to this window.' }
    try {
      return { success: true, ...(await handler(args || {})) }
    } catch (error) {
      return { success: false, code: error?.code || 'INTERNAL', error: error?.message || String(error), details: error?.details ?? null }
    }
  }
  // The Deliver screen (FILM-2015): summary, the user's confirmation (the
  // only place a confirmation token is issued), start, retry.
  ipcMain.handle('studio:deliverSummary', deliverGuard((args) => deliver.summary(args)))
  ipcMain.handle('studio:deliverConfirm', deliverGuard(({ summaryHash }) => deliver.issueConfirmationToken(summaryHash)))
  ipcMain.handle('studio:deliverStart', deliverGuard((args) => deliver.studioDeliver({ ...args, confirm: true })))
  ipcMain.handle('studio:deliverRetry', deliverGuard(({ jobId }) => deliver.retry(jobId)))
  ipcMain.handle('studio:createVariant', deliverGuard((args) => deliver.createVariant(args)))
  ipcMain.handle('studio:chooseExportFolder', deliverGuard(async () => {
    const picker = dialog || require('electron').dialog
    const result = await picker.showOpenDialog(getMainWindow(), { properties: ['openDirectory', 'createDirectory'], title: 'Export delivery files to' })
    return { folder: result.canceled ? null : result.filePaths[0] || null }
  }))

  const protocolRoots = () => {
    const temp = app.getPath('temp')
    const openProjectPath = getMcpServer()?.lastSnapshot?.project?.path
    return [
      typeof openProjectPath === 'string' ? openProjectPath : null,
      app.getPath('userData'),
      ...CACHE_DIR_NAMES.map((name) => path.join(temp, name)),
    ].filter(Boolean)
  }

  // FILM-2013: the in-app agent calls the capability tools through the same
  // handler an MCP client reaches over HTTP, so both produce the same cards.
  ipcMain.handle('studio:callCapability', async (event, name, args = {}) => {
    if (!isMainWindowSender(event)) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Not available to this window.' } }) }] }
    const server = getMcpServer()
    if (!server?.callCapabilityTool) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'VALIDATION_FAILED', message: 'The MCP server has not started.' } }) }] }
    return server.callCapabilityTool(String(name || ''), args, { source: 'in-app' })
  })

  // FILM-2013: the intent compilers' audio reads, with ffmpeg in this process.
  const audioReads = createAudioReads({ getFfmpegPath })

  // FILM-2015: the quit prompt when a plan or a delivery is in flight.
  createStudioUiMain({ app, ipcMain, getMainWindow, isMainWindowSender })

  return {
    audioReads,
    // Plan cards to the AI panel (FILM-2015), from any client.
    emitPlanProposed(proposal) {
      const mainWindow = getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return false
      mainWindow.webContents.send('studio:plan-proposed', proposal)
      return true
    },
    getMcpSecret,
    cloud,
    deliver,
    isPrimaryInstance: cloud.protocol.primary,
    onReady() {
      secrets.configureSecrets({ userDataDir: app.getPath('userData'), safeStorage })
      cloud.onReady()
    },
    // media:getFileUrl is reachable only from windows that load the preload,
    // which already read any file through fs IPC; this grants nothing new to
    // them and keeps comfystudio:// closed to every other page.
    grantFile(filePath) {
      grantedFiles.grant(filePath)
    },
    resolveProtocolUrl(url) {
      const requestPath = comfystudioUrlToPath(url)
      return resolveAllowedPath(requestPath, protocolRoots(), { files: grantedFiles.list() })
    },
  }
}

module.exports = { createStudioMain }
