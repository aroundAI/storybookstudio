import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createMemoryEditsSink } from '../../src/studio/editsSink.js'
import { OPLOG_PATH, applyInverse, createOpLog, wrapMcpActionRunner } from '../../src/studio/oplog.js'
import { VERSIONS_PATH, createVersionStore } from '../../src/studio/versions.js'

const sample = () => JSON.parse(readFileSync(new URL('./fixtures/storybookstudio-sample-project.json', import.meta.url), 'utf8'))

const makeEditor = () => {
  const project = sample()
  let document = { currentTimelineId: project.currentTimelineId, timelines: project.timelines }
  const setCalls = []
  return {
    get: () => document,
    set: (next) => { setCalls.push(next); document = next },
    setCalls,
    trim: (clipId, by) => {
      document = {
        ...document,
        timelines: document.timelines.map((t) => ({
          ...t,
          clips: t.clips.map((c) => (c.id === clipId ? { ...c, duration: c.duration - by } : c)),
        })),
      }
    },
  }
}

const clock = () => {
  let t = Date.parse('2026-10-03T10:00:00Z')
  return () => new Date((t += 60_000))
}

const open = async (sink, editor, module = { createVersionStore }) => {
  const oplog = createOpLog({ sink, session: 'app', clock: clock() })
  await oplog.load()
  const versions = module.createVersionStore({ sink, oplog, getDocument: editor.get, setDocument: editor.set, clock: clock() })
  await versions.load()
  const runAction = wrapMcpActionRunner(async (action, payload) => {
    if (action === 'trim_clips' && payload.previewOnly === false) editor.trim(payload.clipId, payload.by)
    return { success: true }
  }, { oplog, getDocument: editor.get })
  return { oplog, versions, runAction }
}

const lines = (sink) => sink.files.get(OPLOG_PATH).split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('createVersion snapshots the document and records the AC6 fields', async () => {
  const sink = createMemoryEditsSink()
  const editor = makeEditor()
  const { versions } = await open(sink, editor)
  const v1 = await versions.createVersion('Rough cut', { by: 'ai' })
  assert.deepEqual(Object.keys(v1).sort(), ['createdAt', 'createdBy', 'id', 'name', 'opRange', 'parent', 'prompt', 'snapshotPath'])
  assert.equal(v1.id, 'v1')
  assert.equal(v1.parent, null)
  assert.equal(v1.createdBy, 'ai')
  assert.equal(v1.prompt, null)
  assert.equal(v1.snapshotPath, 'edits/snapshots/v1.json')
  assert.deepEqual(JSON.parse(sink.files.get('edits/snapshots/v1.json')), editor.get())
  assert.deepEqual(JSON.parse(sink.files.get(VERSIONS_PATH)).versions[0], v1)
})

test('a version owns the ops made while it is current, and the next version closes its range', async () => {
  const sink = createMemoryEditsSink()
  const editor = makeEditor()
  const { versions, runAction } = await open(sink, editor)
  await versions.createVersion('Rough cut', { by: 'ai' })
  await runAction('trim_clips', { clipId: 'clip-1', by: 0.5, previewOnly: false })
  await runAction('trim_clips', { clipId: 'clip-1', by: 0.5, previewOnly: false })
  const v2 = await versions.createVersion('AI cut v2', { prompt: 'Make it 90 seconds', by: 'ai' })
  const [v1] = versions.list()
  assert.deepEqual(v1.opRange, [1, 3])
  assert.deepEqual(v2.opRange, [4, null])
  assert.equal(v2.parent, 'v1')
  assert.equal(v2.prompt, 'Make it 90 seconds')
  assert.deepEqual(lines(sink).map((l) => [l.op, l.tool, l.versionId]), [
    [1, 'studio_create_version', 'v1'],
    [2, 'trim_clips', 'v1'],
    [3, 'trim_clips', 'v1'],
    [4, 'studio_create_version', 'v2'],
  ])
})

test('a version boundary fsyncs the log after the snapshot and versions.json are written', async () => {
  const sink = createMemoryEditsSink()
  const editor = makeEditor()
  const { versions } = await open(sink, editor)
  await versions.createVersion('Rough cut')
  assert.deepEqual(sink.writes.map((w) => `${w.kind} ${w.path}`), [
    'write edits/snapshots/v1.json',
    'append edits/oplog.jsonl',
    'write edits/versions.json',
    'sync edits/oplog.jsonl',
  ])
})

test('restoreVersion loads the snapshot (no replay), appends a restore op, and the document equals the snapshot', async () => {
  const sink = createMemoryEditsSink()
  const editor = makeEditor()
  const { versions, runAction } = await open(sink, editor)
  await versions.createVersion('Rough cut')
  const snapshot = JSON.parse(sink.files.get('edits/snapshots/v1.json'))
  await versions.createVersion('AI cut v2', { by: 'ai' })
  await runAction('trim_clips', { clipId: 'clip-1', by: 2, previewOnly: false })
  const editedDocument = structuredClone(editor.get())
  const readsBefore = sink.reads.length

  const result = await versions.restoreVersion('v1', { reason: 'Back to the rough cut' })

  assert.deepEqual(editor.get(), snapshot)
  assert.equal(editor.setCalls.length, 1)
  assert.deepEqual(sink.reads.slice(readsBefore), ['edits/snapshots/v1.json'])
  const restore = lines(sink).at(-1)
  assert.equal(restore.tool, 'studio_restore_version')
  assert.deepEqual(restore.args, { versionId: 'v1' })
  assert.equal(restore.reason, 'Back to the rough cut')
  assert.equal(restore.by, 'user')
  assert.equal(result.op.op, restore.op)
  // The restore is itself reversible: its inverse names a snapshot of what it replaced.
  assert.equal(restore.inverse.tool, 'studio_restore_snapshot')
  assert.deepEqual(JSON.parse(sink.files.get(restore.inverse.args.snapshotPath)), editedDocument)
  assert.equal(sink.writes.at(-1).kind, 'sync')
})

test('the store mutation a restore makes is not logged a second time as a hand edit', async () => {
  const sink = createMemoryEditsSink()
  const editor = makeEditor()
  const { versions, oplog } = await open(sink, editor)
  await versions.createVersion('Rough cut')
  let activityDuringSet = 'unset'
  const versions2 = createVersionStore({
    sink,
    oplog,
    getDocument: editor.get,
    setDocument: (doc) => { activityDuringSet = oplog.activity; editor.set(doc) },
  })
  await versions2.load()
  await versions2.restoreVersion('v1')
  assert.equal(activityDuringSet, 'internal')
})

test('versions and the op log survive a restart (fresh module instances over the same files)', async () => {
  const sink = createMemoryEditsSink()
  const editor = makeEditor()
  const first = await open(sink, editor)
  await first.versions.createVersion('Rough cut', { by: 'ai' })
  await first.runAction('trim_clips', { clipId: 'clip-1', by: 1, previewOnly: false })
  await first.versions.createVersion('AI cut v2', { prompt: 'Make it 90 seconds', by: 'ai' })
  const listed = first.versions.list()

  const freshVersions = await import('../../src/studio/versions.js?restart=1')
  const freshOplogModule = await import('../../src/studio/oplog.js?restart=1')
  const oplog = freshOplogModule.createOpLog({ sink })
  await oplog.load()
  const versions = freshVersions.createVersionStore({ sink, oplog, getDocument: editor.get, setDocument: editor.set })
  await versions.load()

  assert.deepEqual(versions.list(), listed)
  assert.equal(versions.current().id, 'v2')
  assert.equal(oplog.versionId(), 'v2')
  assert.equal(oplog.lastOpId(), 3)
  await versions.restoreVersion('v1')
  assert.deepEqual(editor.get(), JSON.parse(sink.files.get('edits/snapshots/v1.json')))
  assert.equal(lines(sink).at(-1).op, 4)
})

test('undo after restart: the inverse of a logged op reverts it on the restored document', async () => {
  const sink = createMemoryEditsSink()
  const editor = makeEditor()
  const { versions, runAction } = await open(sink, editor)
  await versions.createVersion('Rough cut')
  const before = structuredClone(editor.get())
  await runAction('trim_clips', { clipId: 'clip-1', by: 1, previewOnly: false })
  const op = lines(sink).at(-1)
  assert.deepEqual(applyInverse(editor.get(), op.inverse), before)
})

test('restoring an unknown version refuses and changes nothing', async () => {
  const sink = createMemoryEditsSink()
  const editor = makeEditor()
  const { versions } = await open(sink, editor)
  const before = editor.get()
  await assert.rejects(() => versions.restoreVersion('v9'), /Unknown version v9/)
  assert.equal(editor.get(), before)
  assert.equal(sink.files.get(OPLOG_PATH), undefined)
})

test('versions.json from an older run with a gap in ids still yields a unique next id', async () => {
  const sink = createMemoryEditsSink()
  sink.files.set(VERSIONS_PATH, JSON.stringify({ schema: 'studio-versions/1', current: 'v3', versions: [
    { id: 'v1', name: 'a', parent: null, opRange: [1, 1], createdBy: 'ai', createdAt: '2026-10-03T10:00:00.000Z', prompt: null, snapshotPath: 'edits/snapshots/v1.json' },
    { id: 'v3', name: 'b', parent: 'v1', opRange: [2, null], createdBy: 'ai', createdAt: '2026-10-03T10:01:00.000Z', prompt: null, snapshotPath: 'edits/snapshots/v3.json' },
  ] }))
  const editor = makeEditor()
  const { versions } = await open(sink, editor)
  const next = await versions.createVersion('c')
  assert.equal(next.id, 'v4')
})
