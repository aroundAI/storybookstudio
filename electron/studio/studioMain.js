// FILM-2010: the studio layer's main-process registration. main.js calls
// createStudioMain() once; everything security-related lives here so the
// upstream file changes only at its registration points.
const path = require('path')
const { loadOrCreateMcpSecret, buildMcpConnectCommand } = require('./mcpSecret')
const { comfystudioUrlToPath, resolveAllowedPath, createGrantedFileSet } = require('./protocolAllowlist')
const { configureSecrets } = require('./secrets')

// Velorn's own temp working directories; Electron has no "cache" path name.
const CACHE_DIR_NAMES = ['comfystudio-shot-audio', 'comfystudio-caption-audio']

function createStudioMain({ app, ipcMain, safeStorage, getMainWindow, getMcpServer }) {
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

  const protocolRoots = () => {
    const temp = app.getPath('temp')
    const openProjectPath = getMcpServer()?.lastSnapshot?.project?.path
    return [
      typeof openProjectPath === 'string' ? openProjectPath : null,
      app.getPath('userData'),
      ...CACHE_DIR_NAMES.map((name) => path.join(temp, name)),
    ].filter(Boolean)
  }

  return {
    getMcpSecret,
    onReady() {
      configureSecrets({ userDataDir: app.getPath('userData'), safeStorage })
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
