// FILM-2015 main process: the app-quit prompt when work is in flight.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStudioUiMain } = require('../../../electron/studio/studioUi.js')

function harness() {
  const handlers = new Map()
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
  const sent = []
  const window = new EventEmitter()
  window.webContents = { send: (channel, payload) => sent.push([channel, payload]) }
  window.isDestroyed = () => false
  window.closeCalls = 0
  window.close = () => { window.closeCalls += 1; window.emit('close', { preventDefault() {} }) }
  const app = new EventEmitter()
  const ui = createStudioUiMain({ app, ipcMain, getMainWindow: () => window, isMainWindowSender: (event) => event?.sender === 'main' })
  const invoke = (channel, args, sender = 'main') => handlers.get(channel)({ sender }, args)
  return { ui, invoke, sent, window, app, handlers }
}

test('quitting with work in flight is held and the renderer asked; confirming lets it close', async () => {
  const { invoke, window, sent, app } = harness()
  app.emit('browser-window-created', {}, window)
  let prevented = 0
  window.emit('close', { preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 0, 'nothing pending: the window closes')

  await invoke('studio:setPendingWork', { pending: true })
  window.emit('close', { preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1)
  assert.deepEqual(sent.filter(([channel]) => channel === 'studio:close-requested').map(([, p]) => p), [{ intent: 'quit' }])

  await invoke('studio:confirmQuit', {})
  assert.equal(window.closeCalls, 1)
  window.emit('close', { preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1, 'once confirmed the close goes through')
})
