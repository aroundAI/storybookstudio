import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createElectronEditsSink } from '../../src/studio/editsSink.js'
import { createOpLog } from '../../src/studio/oplog.js'
import { createVersionStore } from '../../src/studio/versions.js'

const require = createRequire(import.meta.url)
const editsFiles = require('../../electron/studio/editsFiles.js')

// The preload bridge, minus Electron: ipcMain.handle registrations called directly.
const makeBridge = () => {
  const handlers = new Map()
  editsFiles.registerStudioEditsHandlers({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } })
  const call = (channel) => (...args) => handlers.get(channel)({}, ...args)
  return {
    channels: [...handlers.keys()].sort(),
    api: { append: call('studioEdits:append'), read: call('studioEdits:read'), write: call('studioEdits:write'), sync: call('studioEdits:sync') },
  }
}

test('the main process registers append, read, write and sync channels', () => {
  assert.deepEqual(makeBridge().channels, ['studioEdits:append', 'studioEdits:read', 'studioEdits:sync', 'studioEdits:write'])
})

test('paths outside <project>/edits/ are refused', async () => {
  const { api } = makeBridge()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-edits-'))
  try {
    for (const bad of ['project.comfystudio', 'edits/../project.comfystudio', 'edits', 'edits//x', '../edits/x', 'edits/a\\..\\b', 'edits/./x']) {
      const result = await api.write(dir, bad, 'x')
      assert.equal(result.success, false, bad)
    }
    assert.equal((await api.write('relative/dir', 'edits/x.json', 'x')).success, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a real project folder: the op log appends, versions and snapshots land under edits/, a restart reads them back', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-edits-'))
  try {
    await mkdir(path.join(dir, 'edits'))
    await writeFile(path.join(dir, 'edits', 'oplog.jsonl'), '')
    const { api } = makeBridge()
    let document = { currentTimelineId: 't1', timelines: [{ id: 't1', clips: [{ id: 'c1', startTime: 0, duration: 2 }] }] }
    const open = async () => {
      const sink = createElectronEditsSink(api, dir)
      const oplog = createOpLog({ sink })
      await oplog.load()
      const versions = createVersionStore({ sink, oplog, getDocument: () => document, setDocument: (d) => { document = d } })
      await versions.load()
      return { oplog, versions }
    }

    const first = await open()
    await first.versions.createVersion('Rough cut', { by: 'ai' })
    await first.oplog.append({ by: 'user', tool: 'moveClip', args: {}, inverse: null })
    await first.oplog.sync()
    document = { ...document, timelines: [{ id: 't1', clips: [] }] }

    const second = await open()
    assert.equal(second.oplog.lastOpId(), 2)
    assert.equal(second.versions.current().id, 'v1')
    await second.versions.restoreVersion('v1')
    assert.deepEqual(document.timelines[0].clips, [{ id: 'c1', startTime: 0, duration: 2 }])

    const log = (await readFile(path.join(dir, 'edits', 'oplog.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(log.map((e) => e.tool), ['studio_create_version', 'moveClip', 'studio_restore_version'])
    assert.ok(JSON.parse(await readFile(path.join(dir, 'edits', 'snapshots', 'v1.json'), 'utf8')))
    assert.equal(JSON.parse(await readFile(path.join(dir, 'edits', 'versions.json'), 'utf8')).versions.length, 1)
    assert.equal(await editsFiles.readText(dir, 'edits/missing.json'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
