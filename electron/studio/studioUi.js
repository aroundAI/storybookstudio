// FILM-2015: main-process support for the Studio UI, registered by
// studioMain.js. Renderer → main (invoke): studio:setPendingWork {pending},
// studio:confirmQuit. Main → renderer: studio:close-requested {intent:'quit'}.
// Delivery itself is FILM-2017's (electron/studio/deliver.js).
function createStudioUiMain({ app, ipcMain, getMainWindow, isMainWindowSender }) {
  let pendingWork = false
  let quitConfirmed = false

  const send = (channel, payload) => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }
  const guard = (handler) => async (event, args = {}) => {
    if (!isMainWindowSender(event)) return { success: false, code: 'FORBIDDEN', error: 'Not available to this window.' }
    try {
      return await handler(args || {})
    } catch (error) {
      return { success: false, code: error?.code || 'INTERNAL', error: error?.message || String(error) }
    }
  }

  ipcMain.handle('studio:setPendingWork', guard(async ({ pending }) => {
    pendingWork = Boolean(pending)
    return { success: true }
  }))
  ipcMain.handle('studio:confirmQuit', guard(async () => {
    quitConfirmed = true
    getMainWindow()?.close()
    return { success: true }
  }))

  // Quit with a plan waiting or a delivery in flight: hold the close and let
  // the renderer ask (its prompt names what would be lost).
  app.on('browser-window-created', (_event, window) => {
    window.on('close', (event) => {
      if (window !== getMainWindow() || quitConfirmed || !pendingWork) return
      event.preventDefault()
      send('studio:close-requested', { intent: 'quit' })
    })
  })

  return {}
}

module.exports = { createStudioUiMain }
