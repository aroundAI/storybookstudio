// The preload's studio bridge is one object shared by FILM-2011 (cloud),
// FILM-2013 (callCapability) and FILM-2015. Two branches that each add a
// `studio:` key to the exposed object merge without a textual conflict, and
// the later key silently replaces the earlier bridge. This loads preload.js
// with a fake Electron and checks the merged bridge has every part.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

test('window.electronAPI.studio carries the cloud client, the plan event and callCapability, once', () => {
  const source = readFileSync(new URL('../../electron/preload.js', import.meta.url), 'utf8')
  const exposed = {}
  const invoked = []
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api } },
    ipcRenderer: { invoke: (...args) => { invoked.push(args); return Promise.resolve() }, on: () => {}, removeListener: () => {}, send: () => {} },
    webUtils: { getPathForFile: () => '' },
  }
  const sandbox = { require: (name) => (name === 'electron' ? electron : {}), process: { platform: 'darwin', versions: {}, env: {} }, console, module: {}, exports: {} }
  vm.runInNewContext(source, sandbox, { filename: 'preload.js' })
  const studio = exposed.electronAPI?.studio
  assert.ok(studio, 'electronAPI.studio exists')
  for (const name of ['pull', 'jobStatus', 'checkUpdates', 'onPlanProposed', 'callCapability']) assert.equal(typeof studio[name], 'function', name)
  studio.callCapability('studio_get_context', { scope: { scene: 3 } })
  assert.deepEqual(invoked.at(-1), ['studio:callCapability', 'studio_get_context', { scope: { scene: 3 } }])
  assert.equal((source.match(/^ {2}studio: /gm) || []).length, 1, 'one studio key in the exposed object')
})
