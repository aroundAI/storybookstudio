// What a user already has under the app's earlier names carries over once
// (owner decision 2026-10-05): the project file, settings in localStorage,
// the theme, LUTs in IndexedDB, the userData folder, old file URLs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import LEGACY from '../../src/studio/legacyNames.json' with { type: 'json' }
import {
  FILE_URL_PREFIX,
  PROJECT_FILENAME,
  THEME_ID,
  THEME_STORAGE_KEY,
  migrateLegacyIndexedDb,
  migrateLegacyStorage,
  normalizeLegacyFileUrls,
} from '../../src/studio/legacyMigration.js'

const require = createRequire(import.meta.url)
const { projectFilePath, removeLegacyProjectFile } = require('../../electron/studio/projectFile.js')
const { carryOverUserData } = require('../../electron/studio/legacyUserData.js')

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    get length() { return values.size },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  }
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-legacy-'))

test('settings saved under either earlier prefix move to storybookstudio-* once, and the theme follows', () => {
  const [first, second] = LEGACY.storagePrefixes
  const storage = memoryStorage({
    [`${first}language`]: 'ja',
    [`${second}editor-layout`]: '{"left":320}',
    [`${second}theme`]: LEGACY.themeId,
    'storybookstudio-language': 'en',
    unrelated: 'kept',
  })

  const moved = migrateLegacyStorage(storage, LEGACY)

  assert.equal(moved.length, 3)
  assert.equal(storage.getItem('storybookstudio-editor-layout'), '{"left":320}')
  assert.equal(storage.getItem('storybookstudio-language'), 'en', 'a value already under the new key wins')
  assert.equal(storage.getItem(THEME_STORAGE_KEY), THEME_ID)
  assert.equal(storage.getItem('unrelated'), 'kept')
  assert.equal([...storage.values.keys()].some((key) => LEGACY.storagePrefixes.some((prefix) => key.startsWith(prefix))), false)
  assert.deepEqual(migrateLegacyStorage(storage, LEGACY), [], 'a second launch moves nothing')
})

test('file URLs a project saved under the earlier scheme are rewritten on open', () => {
  const project = { assets: [{ url: `${LEGACY.fileUrlPrefix}%2Fp%2Fa.png`, path: '/p/a.png' }], name: 'x' }
  const opened = normalizeLegacyFileUrls(project, LEGACY)
  assert.equal(opened.assets[0].url, `${FILE_URL_PREFIX}%2Fp%2Fa.png`)
  assert.equal(opened.assets[0].path, '/p/a.png')
})

test('a project pulled before the rename opens, and its first save writes the new name and removes the old file', async () => {
  const dir = tempDir()
  const legacyFile = path.join(dir, LEGACY.projectFile)
  const pulled = { version: '1.2', name: 'Pulled episode', timelines: [], assets: [{ url: `${LEGACY.fileUrlPrefix}%2Fx.png` }], studio: { schema: 'editgraph/1', episodeId: 'ep-1' } }
  fs.writeFileSync(legacyFile, JSON.stringify(pulled))

  // The renderer's loader and saver, over a real folder.
  globalThis.window = {
    electronAPI: {
      isElectron: true,
      pathJoin: async (...parts) => path.join(...parts),
      exists: async (target) => fs.existsSync(target),
      readFile: async (target) => ({ success: true, data: fs.readFileSync(target, 'utf8') }),
      writeFile: async (target, data) => { fs.writeFileSync(target, data); return { success: true } },
      deleteFile: async (target) => { fs.rmSync(target); return { success: true } },
      createDirectory: async (target) => { fs.mkdirSync(target, { recursive: true }); return { success: true } },
      listDirectory: async () => ({ success: true, items: [] }),
    },
  }
  const { loadProject, saveProject, isValidProject } = await import('../../src/services/fileSystem.js')

  assert.equal(await isValidProject(dir), true)
  const opened = await loadProject(dir)
  assert.equal(opened.studio.episodeId, 'ep-1')
  assert.equal(opened.assets[0].url, `${FILE_URL_PREFIX}%2Fx.png`)

  await saveProject(dir, opened)
  assert.equal(fs.existsSync(path.join(dir, PROJECT_FILENAME)), true)
  assert.equal(fs.existsSync(legacyFile), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, PROJECT_FILENAME), 'utf8')).studio.episodeId, 'ep-1')
})

test('the main process reads a pulled folder under either name and removes the old file after writing', async () => {
  const dir = tempDir()
  assert.equal(projectFilePath(dir), path.join(dir, PROJECT_FILENAME), 'an empty folder gets the new name')
  fs.writeFileSync(path.join(dir, LEGACY.projectFile), '{}')
  assert.equal(projectFilePath(dir), path.join(dir, LEGACY.projectFile))
  fs.writeFileSync(path.join(dir, PROJECT_FILENAME), '{}')
  assert.equal(projectFilePath(dir), path.join(dir, PROJECT_FILENAME), 'the new name wins')
  await removeLegacyProjectFile(dir)
  assert.equal(fs.existsSync(path.join(dir, LEGACY.projectFile)), false)
})

test('the userData folder under the earlier name moves once, and never over an existing one', () => {
  const appData = tempDir()
  const app = { getPath: (name) => (name === 'appData' ? appData : path.join(appData, 'StorybookStudio')) }
  fs.mkdirSync(path.join(appData, LEGACY.userDataDir))
  fs.writeFileSync(path.join(appData, LEGACY.userDataDir, 'settings.json'), '{"a":1}')

  assert.deepEqual(carryOverUserData({ app, env: {} }), { from: path.join(appData, LEGACY.userDataDir), to: path.join(appData, 'StorybookStudio') })
  assert.equal(fs.readFileSync(path.join(appData, 'StorybookStudio', 'settings.json'), 'utf8'), '{"a":1}')
  assert.equal(carryOverUserData({ app, env: {} }), null, 'nothing left to move')

  fs.mkdirSync(path.join(appData, LEGACY.userDataDir))
  assert.equal(carryOverUserData({ app, env: {} }), null, 'an existing folder is never replaced')
  assert.equal(carryOverUserData({ app, env: { STUDIO_USER_DATA_DIR: '/x' } }), null)
})

test('LUTs in the earlier IndexedDB database are copied to the current one and the old database is deleted', async () => {
  const databases = new Map([[LEGACY.lutDatabase, new Map([['lut-1', { id: 'lut-1', name: 'Warm' }]])], ['current', new Map()]])
  const request = (result) => {
    const req = {}
    queueMicrotask(() => { req.result = result; req.onsuccess?.() })
    return req
  }
  const dbFor = (name) => ({
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const tx = {
        objectStore: () => ({
          getAll: () => request([...databases.get(name).values()]),
          put: (record) => databases.get(name).set(record.id, record),
        }),
      }
      queueMicrotask(() => tx.oncomplete?.())
      return tx
    },
    close() {},
  })
  const indexedDB = {
    databases: async () => [...databases.keys()].map((name) => ({ name })),
    open: (name) => request(dbFor(name)),
    deleteDatabase: (name) => {
      databases.delete(name)
      return request(undefined)
    },
  }

  const copied = await migrateLegacyIndexedDb({ indexedDB, legacyName: LEGACY.lutDatabase, store: 'luts', openTarget: async () => dbFor('current') })
  assert.equal(copied, 1)
  assert.deepEqual(databases.get('current').get('lut-1'), { id: 'lut-1', name: 'Warm' })
  assert.equal(databases.has(LEGACY.lutDatabase), false)
  assert.equal(await migrateLegacyIndexedDb({ indexedDB, legacyName: LEGACY.lutDatabase, store: 'luts', openTarget: async () => dbFor('current') }), 0)
})
