// FILM-2010: the studio layer's main-process registration. main.js calls
// createStudioMain() once; everything security-related lives here so the
// upstream file changes only at its registration points.
const path = require('path')
const { loadOrCreateMcpSecret, buildMcpConnectCommand } = require('./mcpSecret')
const { comfystudioUrlToPath, resolveAllowedPath, createGrantedFileSet } = require('./protocolAllowlist')
const secrets = require('./secrets')
const { createStudioCloud } = require('./cloud')

// Velorn's own temp working directories; Electron has no "cache" path name.
const CACHE_DIR_NAMES = ['comfystudio-shot-audio', 'comfystudio-caption-audio']

function createStudioMain({ app, ipcMain, safeStorage, shell, getMainWindow, getMcpServer, getFfprobePath = () => null }) {
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

  // FILM-2011 sets this when its cloud client starts; until then the cloud
  // capability tools answer "not available yet".
  let cloud = null

  return {
    getCloud: () => cloud,
    setCloud(next) {
      cloud = next || null
    },
    // Plan cards to the AI panel (FILM-2015), from any client.
    emitPlanProposed(proposal) {
      const mainWindow = getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return false
      mainWindow.webContents.send('studio:plan-proposed', proposal)
      return true
    },
    getMcpSecret,
    cloud,
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
