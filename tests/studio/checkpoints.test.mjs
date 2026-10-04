// FILM-2010 AC6: checkpoints persist under <project>/edits/checkpoints/ and survive a restart.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STORE_URL = new URL('../../src/studio/checkpointStore.js', import.meta.url)

// The same calls and return shapes as window.electronAPI (electron/preload.js -> main.js fs: handlers).
const nodeFsBridge = {
  pathJoin: (...parts) => path.join(...parts),
  createDirectory: async (dir, options = {}) => {
    fs.mkdirSync(dir, { recursive: options.recursive !== false })
    return { success: true }
  },
  writeFile: async (filePath, data) => {
    fs.writeFileSync(filePath, data)
    return { success: true }
  },
  readFile: async (filePath, options = {}) => {
    try {
      return { success: true, data: fs.readFileSync(filePath, options.encoding || 'utf8') }
    } catch (error) {
      return { success: false, error: error.message }
    }
  },
  listDirectory: async (dir) => {
    try {
      return { success: true, items: fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isFile: e.isFile() })) }
    } catch (error) {
      return { success: false, error: error.message, items: [] }
    }
  },
  deleteFile: async (filePath) => {
    fs.rmSync(filePath, { force: true })
    return { success: true }
  },
}

// A fresh module instance per call: nothing survives in memory between "processes".
async function freshProcess() {
  const mod = await import(`${STORE_URL.href}?process=${Math.random()}`)
  return mod.createCheckpointStore({ io: nodeFsBridge, cache: new Map(), limit: 3 })
}

function projectDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-checkpoints-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function snapshot(projectPath, n) {
  return {
    id: `checkpoint-${1700000000000 + n}-abc${n}`,
    label: `Before pass ${n}`,
    createdAt: new Date(1700000000000 + n).toISOString(),
    projectHandle: projectPath,
    currentTimelineId: 'tl-1',
    project: { name: 'Pilot', timelines: [{ id: 'tl-1', clips: [{ id: `clip-${n}`, startTime: n }] }] },
    assetsState: { assets: [{ id: 'a1', name: 'take.mp4' }], folders: [], assetCounter: 2, folderCounter: 1, currentPreviewId: null },
    timelineUi: { playheadPosition: n, inPoint: null, outPoint: null, selectedClipIds: [] },
  }
}

test('create, restart (new process), restore equals the snapshot', async (t) => {
  const project = projectDir(t)
  const original = snapshot(project, 1)

  const first = await freshProcess()
  const saved = await first.save(project, original)
  assert.equal(saved.persisted, true)
  assert.equal(saved.filePath, path.join(project, 'edits', 'checkpoints', `${original.id}.json`))
  assert.ok(fs.existsSync(saved.filePath))

  const second = await freshProcess()
  assert.deepEqual(await second.load(project, original.id), original)
  assert.deepEqual(await second.latest(project), original)
})

test('after a restart the latest checkpoint is the newest on disk', async (t) => {
  const project = projectDir(t)
  const first = await freshProcess()
  await first.save(project, snapshot(project, 2))
  await first.save(project, snapshot(project, 5))
  await first.save(project, snapshot(project, 3))
  const second = await freshProcess()
  assert.equal((await second.latest(project)).id, snapshot(project, 5).id)
  assert.equal(await second.count(project), 3)
})

test('the oldest files are pruned past the limit', async (t) => {
  const project = projectDir(t)
  const store = await freshProcess()
  for (const n of [1, 2, 3, 4, 5]) await store.save(project, snapshot(project, n))
  const files = fs.readdirSync(path.join(project, 'edits', 'checkpoints')).sort()
  assert.deepEqual(files, [3, 4, 5].map((n) => `${snapshot(project, n).id}.json`))
})

test('an id that is not a checkpoint id never reaches the filesystem', async (t) => {
  const project = projectDir(t)
  fs.writeFileSync(path.join(project, 'project.comfystudio'), '{"id":"../../project.comfystudio"}')
  const store = await freshProcess()
  assert.equal(await store.load(project, '../../project.comfystudio'), null)
  assert.equal(await store.load(project, 'checkpoint-1-a/../../x'), null)
  await assert.rejects(store.save(project, { ...snapshot(project, 1), id: '../escape' }), /malformed/)
})

test('a project without a folder path keeps the checkpoint in memory only', async () => {
  const store = await freshProcess()
  const result = await store.save(null, snapshot(null, 1))
  assert.deepEqual(result, { filePath: null, persisted: false })
  assert.equal((await store.load(null, snapshot(null, 1).id)).label, 'Before pass 1')
})
