import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { applyPatch, diffDocuments, touchedClipIds } from '../../src/studio/documentDiff.js'
import { createMemoryEditsSink } from '../../src/studio/editsSink.js'
import {
  OPLOG_PATH,
  OpLogEntrySchema,
  applyInverse,
  attachUserEditLogger,
  clipsTouchedByUserSince,
  createOpLog,
  lastOriginByClip,
  parseOpLog,
  wrapMcpActionRunner,
} from '../../src/studio/oplog.js'

const sample = () => JSON.parse(readFileSync(new URL('./fixtures/storybookstudio-sample-project.json', import.meta.url), 'utf8'))
const fixedClock = () => {
  let t = Date.parse('2026-10-03T10:41:12Z')
  return () => new Date((t += 1000))
}

// A document shaped like the renderer's: current timeline id, timelines, assets.
const makeDocumentHolder = () => {
  const project = sample()
  let document = { currentTimelineId: project.currentTimelineId, timelines: project.timelines, assets: project.assets }
  return {
    get: () => document,
    set: (next) => { document = next },
    timeline: () => document.timelines[0],
    updateTimeline(update) {
      document = { ...document, timelines: document.timelines.map((t, i) => (i === 0 ? update(t) : t)) }
    },
  }
}

const readLines = (sink) => (sink.files.get(OPLOG_PATH) || '').split('\n').filter(Boolean).map((line) => JSON.parse(line))

// A stand-in for handleMcpAction: each write tool mutates the document the
// way the upstream editor's handler would; previewOnly returns a plan and mutates nothing.
const makeFakeRunner = (holder) => {
  const writes = {
    trim_clips: ({ clipIds, trimEnd }) => holder.updateTimeline((t) => ({
      ...t,
      clips: t.clips.map((c) => (clipIds.includes(c.id) ? { ...c, duration: c.duration - trimEnd, trimEnd: c.trimEnd - trimEnd } : c)),
    })),
    delete_clips: ({ clipIds }) => holder.updateTimeline((t) => ({ ...t, clips: t.clips.filter((c) => !clipIds.includes(c.id)) })),
    move_clips: ({ clipIds, delta }) => holder.updateTimeline((t) => ({
      ...t,
      clips: t.clips.map((c) => (clipIds.includes(c.id) ? { ...c, startTime: c.startTime + delta } : c)),
    })),
    add_text_clip: ({ text }) => holder.updateTimeline((t) => ({
      ...t,
      clips: [...t.clips, { id: `clip-${t.clipCounter}`, trackId: 'video-1', type: 'text', name: text, startTime: 7.5, duration: 2 }],
      clipCounter: t.clipCounter + 1,
    })),
    add_timeline_markers: ({ markers }) => holder.updateTimeline((t) => ({ ...t, markers: [...t.markers, ...markers] })),
    update_track: ({ trackId, name }) => holder.updateTimeline((t) => ({
      ...t,
      tracks: t.tracks.map((track) => (track.id === trackId ? { ...track, name } : track)),
    })),
    switch_timeline: ({ timelineId }) => holder.set({ ...holder.get(), currentTimelineId: timelineId }),
    create_asset_folder: () => holder.set({ ...holder.get(), assets: [...holder.get().assets, { id: 'asset-9', name: 'x', type: 'image' }] }),
  }
  const calls = []
  const run = async (action, payload) => {
    calls.push({ action, payload })
    if (action === 'get_timeline') return { clips: holder.timeline().clips.length }
    if (action === 'explode') throw new Error('boom')
    if (payload.previewOnly !== false && writes[action]) return { previewOnly: true, action }
    writes[action]?.(payload)
    return { success: true, action }
  }
  return { run, calls, writeTools: Object.keys(writes) }
}

const writeArgs = {
  trim_clips: { clipIds: ['clip-1'], trimEnd: 1.5 },
  delete_clips: { clipIds: ['clip-3'] },
  move_clips: { clipIds: ['clip-1'], delta: 0.5 },
  add_text_clip: { text: 'Hook' },
  add_timeline_markers: { markers: [{ id: 'marker-2', time: 4, name: 'Scene 2' }] },
  update_track: { trackId: 'audio-1', name: 'Music' },
  switch_timeline: { timelineId: 'timeline-2' },
  create_asset_folder: {},
}

test('every applied write tool appends exactly one op-log line with the AC5 fields', async () => {
  const holder = makeDocumentHolder()
  const sink = createMemoryEditsSink()
  const oplog = createOpLog({ sink, session: 'app-1', clock: fixedClock() })
  const fake = makeFakeRunner(holder)
  const runAction = wrapMcpActionRunner(fake.run, { oplog, getDocument: holder.get })

  for (const tool of fake.writeTools) {
    const before = readLines(sink).length
    await runAction(tool, { ...writeArgs[tool], previewOnly: false })
    const lines = readLines(sink)
    assert.equal(lines.length, before + 1, `${tool} appends one line`)
    const line = lines.at(-1)
    assert.deepEqual(Object.keys(line).sort(), ['args', 'by', 'inverse', 'op', 'reason', 'scene', 'session', 'tool', 'ts', 'versionId'])
    assert.equal(line.tool, tool)
    assert.equal(line.by, 'ai')
    assert.equal(line.session, 'app-1')
    assert.equal(line.op, before + 1)
    assert.equal(OpLogEntrySchema.safeParse(line).success, true)
  }
})

test('preview-only calls and reads append nothing', async () => {
  const holder = makeDocumentHolder()
  const sink = createMemoryEditsSink()
  const oplog = createOpLog({ sink, clock: fixedClock() })
  const fake = makeFakeRunner(holder)
  const runAction = wrapMcpActionRunner(fake.run, { oplog, getDocument: holder.get })

  for (const tool of fake.writeTools) {
    await runAction(tool, { ...writeArgs[tool], previewOnly: true })
    await runAction(tool, writeArgs[tool]) // previewOnly defaults to true in the upstream editor
  }
  await runAction('get_timeline', {})
  assert.equal(sink.files.get(OPLOG_PATH), undefined)
  assert.equal(oplog.entries().length, 0)
})

test('studioMeta carries reason, scene and session into the line and never reaches the handler', async () => {
  const holder = makeDocumentHolder()
  const sink = createMemoryEditsSink()
  const oplog = createOpLog({ sink, session: 'app-1', clock: fixedClock() })
  oplog.setVersionId('v2')
  const fake = makeFakeRunner(holder)
  const runAction = wrapMcpActionRunner(fake.run, { oplog, getDocument: holder.get })

  await runAction('trim_clips', {
    clipIds: ['clip-1'],
    trimEnd: 1.6,
    previewOnly: false,
    studioMeta: { reason: 'Information already given by dialogue', scene: 1, session: 'plan-7' },
  })
  assert.equal('studioMeta' in fake.calls[0].payload, false)
  const [line] = readLines(sink)
  assert.equal(line.reason, 'Information already given by dialogue')
  assert.equal(line.scene, 1)
  assert.equal(line.session, 'plan-7')
  assert.equal(line.versionId, 'v2')
  assert.equal(line.ts, '2026-10-03T10:41:13.000Z')
  assert.deepEqual(line.args, { clipIds: ['clip-1'], trimEnd: 1.6, previewOnly: false })
})

test('the scene of an op is read from the touched clips when the caller does not give one', async () => {
  const holder = makeDocumentHolder()
  holder.updateTimeline((t) => ({
    ...t,
    clips: t.clips.map((c) => ({ ...c, metadata: { semantic: { scene: c.id === 'clip-3' ? 2 : 1 } } })),
  }))
  const sink = createMemoryEditsSink()
  const oplog = createOpLog({ sink, clock: fixedClock() })
  const runAction = wrapMcpActionRunner(makeFakeRunner(holder).run, { oplog, getDocument: holder.get })
  await runAction('delete_clips', { clipIds: ['clip-3'], previewOnly: false })
  await runAction('move_clips', { clipIds: ['clip-1', 'clip-3'], delta: 1, previewOnly: false })
  const lines = readLines(sink)
  assert.equal(lines[0].scene, 2)
  assert.equal(lines[1].scene, 1) // clip-3 is gone, so only clip-1 moved
})

test('each line carries an inverse that turns the document back into what it was', async () => {
  const holder = makeDocumentHolder()
  const sink = createMemoryEditsSink()
  const oplog = createOpLog({ sink, clock: fixedClock() })
  const fake = makeFakeRunner(holder)
  const runAction = wrapMcpActionRunner(fake.run, { oplog, getDocument: holder.get })

  for (const tool of fake.writeTools) {
    const before = structuredClone(holder.get())
    await runAction(tool, { ...writeArgs[tool], previewOnly: false })
    const line = readLines(sink).at(-1)
    assert.deepEqual(applyInverse(holder.get(), line.inverse), before, `${tool} inverse`)
  }
})

test('a failed write that changed nothing logs nothing and still throws', async () => {
  const holder = makeDocumentHolder()
  const sink = createMemoryEditsSink()
  const oplog = createOpLog({ sink })
  const runAction = wrapMcpActionRunner(makeFakeRunner(holder).run, { oplog, getDocument: holder.get })
  await assert.rejects(() => runAction('explode', { previewOnly: false }), /boom/)
  assert.equal(oplog.entries().length, 0)
})

test('without an op log the wrapper only strips studioMeta', async () => {
  const holder = makeDocumentHolder()
  const fake = makeFakeRunner(holder)
  const runAction = wrapMcpActionRunner(fake.run, { oplog: null, getDocument: holder.get })
  await runAction('trim_clips', { clipIds: ['clip-1'], trimEnd: 1, previewOnly: false, studioMeta: { reason: 'x' } })
  assert.deepEqual(fake.calls[0].payload, { clipIds: ['clip-1'], trimEnd: 1, previewOnly: false })
})

// A minimal zustand-like store: getState/setState with merge semantics and
// actions that call set(), so wrapping behaves as on the upstream editor's stores.
const makeStore = (holder) => {
  let state
  const set = (partial) => { state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) } }
  state = {
    moveClip: (clipId, startTime) => holder.updateTimeline((t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === clipId ? { ...c, startTime } : c)),
    })),
    removeClip: (clipId) => holder.updateTimeline((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) })),
    nudgeTwice: (clipId) => { state.moveClip(clipId, 1); state.moveClip(clipId, 2) },
    setPlayheadPosition: () => {},
  }
  return { getState: () => state, setState: set }
}

const manualTimers = () => {
  let pending = null
  return {
    setTimeout: (fn) => { pending = fn; return 1 },
    clearTimeout: () => { pending = null },
    fire: () => { const fn = pending; pending = null; fn?.() },
  }
}

test('hand edits through store mutators are logged by: user, one line per edit', async () => {
  const holder = makeDocumentHolder()
  const sink = createMemoryEditsSink()
  const oplog = createOpLog({ sink, clock: fixedClock() })
  const store = makeStore(holder)
  const timers = manualTimers()
  const detach = attachUserEditLogger({
    stores: [{ store, mutators: ['moveClip', 'removeClip', 'nudgeTwice', 'notAFunction'], label: 'timeline' }],
    oplog,
    getDocument: holder.get,
    timers,
  })

  store.getState().moveClip('clip-1', 3)
  timers.fire()
  await oplog.idle()
  store.getState().nudgeTwice('clip-3') // nested mutators: one edit
  timers.fire()
  await oplog.idle()
  store.getState().setPlayheadPosition(4) // not a listed mutator
  store.getState().moveClip('clip-1', 3) // no change: nothing to log
  timers.fire()
  await oplog.idle()

  const lines = readLines(sink)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map((l) => [l.by, l.tool]), [['user', 'moveClip'], ['user', 'nudgeTwice']])
  assert.deepEqual(lines[1].args, { store: 'timeline', mutators: ['nudgeTwice'] })
  detach()
  assert.equal(store.getState().moveClip.name, 'moveClip')
})

test('rapid hand edits (a drag) coalesce into one line, flushed at a version boundary', async () => {
  const holder = makeDocumentHolder()
  const sink = createMemoryEditsSink()
  const oplog = createOpLog({ sink, clock: fixedClock() })
  const store = makeStore(holder)
  const timers = manualTimers()
  attachUserEditLogger({ stores: [{ store, mutators: ['moveClip'], label: 'timeline' }], oplog, getDocument: holder.get, timers })
  const before = structuredClone(holder.get())
  for (const t of [0.1, 0.2, 0.3, 0.4]) store.getState().moveClip('clip-1', t)
  assert.equal(readLines(sink).length, 0)
  await oplog.flushPending()
  const lines = readLines(sink)
  assert.equal(lines.length, 1)
  assert.deepEqual(applyInverse(holder.get(), lines[0].inverse), before)
})

test('store mutations made by an MCP action are logged once, as ai, not again as user', async () => {
  const holder = makeDocumentHolder()
  const sink = createMemoryEditsSink()
  const oplog = createOpLog({ sink, clock: fixedClock() })
  const store = makeStore(holder)
  const timers = manualTimers()
  attachUserEditLogger({ stores: [{ store, mutators: ['moveClip'], label: 'timeline' }], oplog, getDocument: holder.get, timers })
  const run = async (action, payload) => { store.getState().moveClip('clip-1', payload.to); return { success: true } }
  const runAction = wrapMcpActionRunner(run, { oplog, getDocument: holder.get })
  await runAction('move_clips', { to: 5, previewOnly: false })
  timers.fire()
  await oplog.idle()
  assert.deepEqual(readLines(sink).map((l) => l.by), ['ai'])
})

test('a pending hand edit is written before the next AI op, keeping the log in order', async () => {
  const holder = makeDocumentHolder()
  const sink = createMemoryEditsSink()
  const oplog = createOpLog({ sink, clock: fixedClock() })
  const store = makeStore(holder)
  attachUserEditLogger({ stores: [{ store, mutators: ['moveClip'], label: 'timeline' }], oplog, getDocument: holder.get, timers: manualTimers() })
  const runAction = wrapMcpActionRunner(makeFakeRunner(holder).run, { oplog, getDocument: holder.get })
  store.getState().moveClip('clip-3', 9)
  await runAction('trim_clips', { clipIds: ['clip-1'], trimEnd: 1, previewOnly: false })
  assert.deepEqual(readLines(sink).map((l) => [l.op, l.by]), [[1, 'user'], [2, 'ai']])
})

test('the file is append-only: a reopened log continues numbering and keeps earlier lines byte for byte', async () => {
  const holder = makeDocumentHolder()
  const sink = createMemoryEditsSink()
  const first = createOpLog({ sink, clock: fixedClock() })
  const runA = wrapMcpActionRunner(makeFakeRunner(holder).run, { oplog: first, getDocument: holder.get })
  await runA('trim_clips', { clipIds: ['clip-1'], trimEnd: 1, previewOnly: false })
  const bytesAfterFirst = sink.files.get(OPLOG_PATH)

  const second = createOpLog({ sink, clock: fixedClock() })
  await second.load()
  const runB = wrapMcpActionRunner(makeFakeRunner(holder).run, { oplog: second, getDocument: holder.get })
  await runB('delete_clips', { clipIds: ['clip-3'], previewOnly: false })
  const text = sink.files.get(OPLOG_PATH)
  assert.ok(text.startsWith(bytesAfterFirst))
  assert.deepEqual(readLines(sink).map((l) => l.op), [1, 2])
  assert.deepEqual(sink.writes.filter((w) => w.path === OPLOG_PATH).map((w) => w.kind), ['append', 'append'])
})

test('a torn last line from a crash is skipped on load and the next line starts clean', async () => {
  const sink = createMemoryEditsSink()
  sink.files.set(OPLOG_PATH, '{"op":1,"ts":"2026-10-03T10:00:00.000Z","by":"user","session":null,"tool":"moveClip","args":{},"inverse":null,"reason":null,"scene":null,"versionId":null}\n{"op":2,"ts":"20')
  const oplog = createOpLog({ sink })
  await oplog.load()
  assert.equal(oplog.lastOpId(), 1)
  await oplog.append({ by: 'user', tool: 'removeClip', args: {}, inverse: null })
  const lines = sink.files.get(OPLOG_PATH).split('\n')
  assert.equal(JSON.parse(lines.at(-2)).op, 2)
  assert.equal(parseOpLog(sink.files.get(OPLOG_PATH)).length, 2)
})

test('sync waits for queued appends and fsyncs the log', async () => {
  const sink = createMemoryEditsSink()
  const oplog = createOpLog({ sink })
  oplog.append({ by: 'ai', tool: 'trim_clips', args: {}, inverse: null })
  await oplog.sync()
  assert.deepEqual(sink.writes.map((w) => w.kind), ['append', 'sync'])
})

test('AC8: clipsTouchedByUserSince lists clips whose last edit since the version is by the user', () => {
  const patchTouching = (ids) => ({ tool: 'studio_apply_patch', args: { patch: { collections: { timelines: { revert: [{ id: 'timeline-1', patch: { collections: { clips: { revert: ids.map((id) => ({ id, item: { id } })) } } } }] } } } } })
  const log = [
    { op: 1, by: 'user', tool: 'moveClip', inverse: patchTouching(['clip-9']), versionId: 'v1' },
    { op: 2, by: 'ai', tool: 'studio_create_version', args: { versionId: 'v2' }, inverse: null, versionId: 'v2' },
    { op: 3, by: 'user', tool: 'moveClip', inverse: patchTouching(['clip-1', 'clip-2']), versionId: 'v2' },
    { op: 4, by: 'ai', tool: 'trim_clips', inverse: patchTouching(['clip-2']), versionId: 'v2' },
    { op: 5, by: 'user', tool: 'removeClip', inverse: patchTouching(['clip-3']), versionId: 'v2' },
  ]
  assert.deepEqual(clipsTouchedByUserSince(log, 'v2'), ['clip-1', 'clip-3'])
  assert.deepEqual(clipsTouchedByUserSince(log, null), ['clip-1', 'clip-3', 'clip-9'])
  assert.deepEqual(lastOriginByClip(log).get('clip-2'), { versionId: 'v2', opId: 4, by: 'ai' })
})

test('diff and patch: removed, added, changed and reordered items all invert exactly', () => {
  const a = sample().timelines[0]
  const b = {
    ...a,
    clips: [{ ...a.clips[2], startTime: 0 }, a.clips[0], { id: 'clip-9', trackId: 'video-1', startTime: 9, duration: 1 }],
    tracks: [a.tracks[1], a.tracks[0]],
    zoom: 150,
    rippleEditMode: undefined,
  }
  delete b.markerCounter
  const patch = diffDocuments(b, a)
  assert.deepEqual(applyPatch(b, patch), a)
  assert.deepEqual([...touchedClipIds(patch)].sort(), ['clip-2', 'clip-3', 'clip-9'])
  assert.equal(diffDocuments(a, structuredClone(a)), null)
})
