// FILM-2015: per-scene accept writes the merged document through the version
// store as one logged op (by the user, with its reason) whose inverse names a
// snapshot of what it replaced, so the accept can itself be undone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createMemoryEditsSink } from '../../../src/studio/editsSink.js'
import { createOpLog, RESTORE_SNAPSHOT_TOOL } from '../../../src/studio/oplog.js'
import { createVersionStore } from '../../../src/studio/versions.js'

const sample = () => JSON.parse(readFileSync(new URL('../fixtures/velorn-sample-project.json', import.meta.url), 'utf8'))

test('replaceDocument sets the document, logs one op with its reason, and keeps the replaced one restorable', async () => {
  const sink = createMemoryEditsSink()
  const project = sample()
  let document = { currentTimelineId: project.currentTimelineId, timelines: project.timelines }
  const oplog = createOpLog({ sink, session: 'app' })
  await oplog.load()
  const versions = createVersionStore({ sink, oplog, getDocument: () => document, setDocument: (next) => { document = next } })
  await versions.load()
  await versions.createVersion('Rough cut', { by: 'ai' })
  const original = JSON.parse(JSON.stringify(document))

  const merged = JSON.parse(JSON.stringify(document))
  merged.timelines[0].clips = merged.timelines[0].clips.slice(1)
  const { op } = await versions.replaceDocument(merged, { by: 'user', reason: 'Accepted scene 2 of “make it 90 seconds”', tool: 'studio_accept_scenes', args: { versionId: 'v1', scenes: [2] } })

  assert.deepEqual(document, merged)
  assert.equal(op.by, 'user')
  assert.equal(op.tool, 'studio_accept_scenes')
  assert.equal(op.reason, 'Accepted scene 2 of “make it 90 seconds”')
  assert.deepEqual(op.args, { versionId: 'v1', scenes: [2] })
  assert.equal(op.inverse.tool, RESTORE_SNAPSHOT_TOOL)
  assert.deepEqual(JSON.parse(sink.files.get(op.inverse.args.snapshotPath)), original)
  assert.equal(oplog.entries().filter((entry) => entry.tool === 'studio_accept_scenes').length, 1)
})
