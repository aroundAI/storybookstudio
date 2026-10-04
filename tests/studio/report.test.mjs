import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'

import { ExplainWhyReportSchema } from '../../src/studio/contracts/explain-why-report.schema.mjs'
import { createMemoryEditsSink } from '../../src/studio/editsSink.js'
import { OPLOG_PATH, attachUserEditLogger, createOpLog, parseOpLog, wrapMcpActionRunner } from '../../src/studio/oplog.js'
import { buildExplainWhyReport, formatExplainWhyText } from '../../src/studio/report.js'
import { createVersionStore } from '../../src/studio/versions.js'

const fixtureUrl = (name) => new URL(`./fixtures/${name}`, import.meta.url)
const readText = (name) => readFileSync(fixtureUrl(name), 'utf8')
// UPDATE_FIXTURES=1 rewrites the golden files; review the diff before committing.
const golden = (name, actual) => {
  if (process.env.UPDATE_FIXTURES === '1') writeFileSync(fixtureUrl(name), actual)
  return readText(name)
}

// Twenty seconds of a three-scene episode: shots on video-1, a dialogue line,
// music under everything. Times are what the rough-cut builder would place.
const shot = (id, name, scene, startTime, duration) => ({
  id, name, trackId: 'video-1', type: 'video', assetId: `asset-${id}`, startTime, duration,
  trimStart: 0, trimEnd: duration, sourceDuration: 8,
  metadata: { semantic: { scene, shotId: `shot-${id}`, role: 'generated_video' } },
})
const roughCut = () => ({
  currentTimelineId: 'tl-master',
  timelines: [{
    id: 'tl-master',
    name: 'Master',
    studio: { kind: 'master', aspect: '16:9', language: 'en' },
    tracks: [
      { id: 'video-1', name: 'Video 1', type: 'video' },
      { id: 'dialogue-en', name: 'Dialogue', type: 'audio' },
      { id: 'music', name: 'Music', type: 'audio', volume: 1 },
    ],
    clips: [
      shot('c11', 'Shot 1.1', 1, 0, 5),
      shot('c12', 'Shot 1.2', 1, 5, 4.8),
      shot('c13', 'Shot 1.3', 1, 9.8, 3),
      shot('c14', 'Shot 1.4', 1, 12.8, 2.1),
      shot('c21', 'Shot 2.1', 2, 14.9, 6),
      shot('c22', 'Shot 2.2', 2, 20.9, 5),
      shot('c31', 'Shot 3.1', 3, 25.9, 4),
      shot('c35', 'Shot 3.5', 3, 29.9, 3),
      { id: 'd1', name: 'MAYA line 1', trackId: 'dialogue-en', type: 'audio', startTime: 1, duration: 3, gainDb: 0, metadata: { semantic: { scene: 1, role: 'dialogue' } } },
      { id: 'm1', name: 'Music', trackId: 'music', type: 'audio', startTime: 0, duration: 32.9, gainDb: 0 },
    ],
  }],
})

const round = (value) => Math.round(value * 1000) / 1000
// Ripple edits on the picture: later clips on every track except music close the gap.
const ripple = (clips, fromTime, delta) => clips.map((c) => (
  c.trackId !== 'music' && c.startTime >= fromTime - 1e-9 ? { ...c, startTime: round(c.startTime - delta) } : c
))

const runSession = async () => {
  let document = roughCut()
  const editTimeline = (update) => {
    document = { ...document, timelines: document.timelines.map((t) => ({ ...t, clips: update(t.clips) })) }
  }
  const handlers = {
    trim_clips: ({ clipIds: [id], duration }) => editTimeline((clips) => {
      const clip = clips.find((c) => c.id === id)
      const end = clip.startTime + clip.duration
      const trimmed = clips.map((c) => (c.id === id ? { ...c, duration, trimEnd: duration } : c))
      return ripple(trimmed, end, round(clip.duration - duration))
    }),
    delete_clips: ({ clipIds: [id] }) => editTimeline((clips) => {
      const clip = clips.find((c) => c.id === id)
      return ripple(clips.filter((c) => c.id !== id), clip.startTime + clip.duration, clip.duration)
    }),
    move_clips: ({ clipIds: [first, second] }) => editTimeline((clips) => {
      const a = clips.find((c) => c.id === first)
      const b = clips.find((c) => c.id === second)
      const start = Math.min(a.startTime, b.startTime)
      return clips.map((c) => (c.id === first ? { ...c, startTime: start } : c.id === second ? { ...c, startTime: round(start + a.duration) } : c))
    }),
    update_audio_clip: ({ clipId, gainDb }) => editTimeline((clips) => clips.map((c) => (c.id === clipId ? { ...c, gainDb } : c))),
  }

  let state
  const store = {
    getState: () => state,
    setState: (partial) => { state = { ...state, ...partial } },
  }
  state = { updateClipTrim: (id, duration) => handlers.trim_clips({ clipIds: [id], duration }) }

  const sink = createMemoryEditsSink()
  let t = Date.parse('2026-10-03T10:40:00Z')
  const clock = () => new Date((t += 1000))
  const oplog = createOpLog({ sink, session: 'app-1', clock })
  const versions = createVersionStore({ sink, oplog, getDocument: () => document, setDocument: (d) => { document = d }, clock })
  attachUserEditLogger({ stores: [{ store, mutators: ['updateClipTrim'], label: 'timeline' }], oplog, getDocument: () => document, timers: { setTimeout: () => 0, clearTimeout: () => {} } })
  const runAction = wrapMcpActionRunner(async (action, payload) => {
    if (payload.previewOnly === false) handlers[action](payload)
    return { success: true }
  }, { oplog, getDocument: () => document })

  await versions.createVersion('Rough cut', { by: 'ai' })
  const before = document
  await versions.createVersion('AI cut v2', { prompt: 'Tighten scene 1', by: 'ai' })
  const step = (tool, args, reason) => runAction(tool, { ...args, previewOnly: false, studioMeta: { reason, session: 'plan-7' } })
  await step('trim_clips', { clipIds: ['c12'], duration: 3.2 }, 'Information already given by dialogue')
  await step('delete_clips', { clipIds: ['c14'] }, 'Duplicate establishing shot')
  await step('move_clips', { clipIds: ['c35', 'c31'] }, 'Strongest sound bite, used as the hook')
  await step('update_audio_clip', { clipId: 'm1', gainDb: -8 }, 'Dialogue was masked at 0:42-0:47')
  store.getState().updateClipTrim('c21', 5) // the user's own trim
  await oplog.flushPending()
  return { sink, versions, before, after: document }
}

test('the scripted session reproduces the committed fixture log', async () => {
  const { sink } = await runSession()
  assert.equal(sink.files.get(OPLOG_PATH), golden('report-oplog.jsonl', sink.files.get(OPLOG_PATH)))
  // A trim's ripple moves clips in later scenes; the line still belongs to the trimmed shot's scene.
  assert.deepEqual(parseOpLog(sink.files.get(OPLOG_PATH)).map((e) => [e.tool, e.by, e.scene]), [
    ['studio_create_version', 'ai', null],
    ['studio_create_version', 'ai', null],
    ['trim_clips', 'ai', 1],
    ['delete_clips', 'ai', 1],
    ['move_clips', 'ai', 3],
    ['update_audio_clip', 'ai', null],
    ['updateClipTrim', 'user', null],
  ])
})

test('fixture log -> the explain-why report: the figures, by hand', async () => {
  const { versions, before, after } = await runSession()
  const log = parseOpLog(readText('report-oplog.jsonl'))
  const report = buildExplainWhyReport({
    log, versions: versions.list(), versionId: 'v2', before, after, target: 30, qa: { pass: true, issues: [] },
  })
  assert.equal(ExplainWhyReportSchema.safeParse(report).success, true, JSON.stringify(ExplainWhyReportSchema.safeParse(report).error?.issues))

  // Picture length 32.9 s; minus 1.6 (trim) and 2.1 (delete) by the AI, 1.0 by the user.
  assert.equal(report.explain.durationBefore, 32.9)
  assert.equal(report.explain.durationAfter, 28.2)
  assert.equal(report.finalDuration, 28.2)
  assert.equal(report.aiOps, 4)
  assert.equal(report.userOps, 1)
  assert.deepEqual(report.explain.scenes.map((s) => [s.scene, s.durationBefore, s.durationAfter]), [[1, 14.9, 11.2], [2, 11, 10], [3, 7, 7]])
  assert.deepEqual(report.explain.scenes[0].changes.map((c) => [c.action, c.target, c.reason]), [
    ['trimmed', 'Shot 1.2', 'Information already given by dialogue'],
    ['removed', 'Shot 1.4', 'Duplicate establishing shot'],
  ])
  // A ripple shift is not a move; a change of order is.
  assert.deepEqual(report.explain.scenes[2].changes.map((c) => [c.action, c.target, c.startAfter, c.detail]), [['moved', 'Shot 3.5', 21.2, 'to 0:21.2'], ['moved', 'Shot 3.1', 24.2, 'to 0:24.2']])
  // The user's trim carries no reason of its own; the schema needs one.
  assert.deepEqual(report.explain.scenes[1].changes.map((c) => [c.action, c.by, c.reason, c.before, c.after]), [['trimmed', 'user', 'Hand edit', 6, 5]])
  assert.deepEqual(report.explain.audio.map((a) => [a.target, a.change, a.reason, a.before, a.after]), [['Music', '-8.0 dB', 'Dialogue was masked at 0:42-0:47', 0, -8]])
  assert.deepEqual(report.versions.map((v) => [v.id, v.label, v.parentId, v.origin]), [['v1', 'Rough cut', null, 'rough_cut'], ['v2', 'AI cut v2', 'v1', 'ai']])
  // The cut's style for FILM-2006: seven shots remain; the hook is not classified yet.
  assert.deepEqual(report.style, { shotCount: 7, hookType: null })
  assert.equal(report.explain.scenesKept, 3)
  assert.equal(report.explain.scenesTotal, 3)

  assert.deepEqual(report, JSON.parse(golden('report-expected.json', `${JSON.stringify(report, null, 2)}\n`)))
})

test('fixture log -> the text block in the PRD format', async () => {
  const { versions, before, after } = await runSession()
  const log = parseOpLog(readText('report-oplog.jsonl'))
  const report = buildExplainWhyReport({ log, versions: versions.list(), versionId: 'v2', before, after, target: 30, qa: { pass: true, issues: [] } })
  const text = formatExplainWhyText(report)
  assert.equal(text, golden('report-expected.txt', text))
  assert.match(text, /^Plan: "Tighten scene 1" {2,}Version: AI cut v2 \(from Rough cut\)$/m)
  assert.match(text, /^ {2}Trimmed {2}Shot 1\.2 {2}4\.8 s -> 3\.2 s {3}Information already given by dialogue$/m)
})

test('the report of a version with no QA run says so', async () => {
  const { versions, before, after } = await runSession()
  const log = parseOpLog(readText('report-oplog.jsonl'))
  const report = buildExplainWhyReport({ log, versions: versions.list(), versionId: 'v2', before, after })
  assert.equal(report.explain.qa, null)
  assert.equal(report.explain.targetDuration, null)
  assert.match(formatExplainWhyText(report), /^QA {8}not run$/m)
})

test('an unknown version id refuses', async () => {
  const { versions, before, after } = await runSession()
  assert.throws(() => buildExplainWhyReport({ log: [], versions: versions.list(), versionId: 'v7', before, after }), /Unknown version v7/)
})

test('a version with no picture leaves style out (unmeasured, never zero), and changes outside a scene stay out of scenes', async () => {
  const { versions, before, after } = await runSession()
  const log = parseOpLog(readText('report-oplog.jsonl'))
  const audioOnly = (document) => ({ ...document, timelines: document.timelines.map((t) => ({ ...t, clips: t.clips.filter((c) => c.trackId !== 'video-1') })) })
  const report = buildExplainWhyReport({ log, versions: versions.list(), versionId: 'v2', before: audioOnly(before), after: audioOnly(after) })
  assert.equal('style' in report, false)
  assert.equal(ExplainWhyReportSchema.safeParse(report).success, true)

  const unscened = (document) => ({ ...document, timelines: document.timelines.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === 'c12' ? { ...c, metadata: {} } : c)) })) })
  const moved = buildExplainWhyReport({ log, versions: versions.list(), versionId: 'v2', before: unscened(before), after: unscened(after) })
  assert.equal(moved.explain.scenes.every((scene) => Number.isInteger(scene.scene) && scene.scene >= 1), true)
  assert.deepEqual(moved.explain.unassigned.changes.map((c) => [c.action, c.target]), [['trimmed', 'Shot 1.2']])
  assert.equal(ExplainWhyReportSchema.safeParse(moved).success, true)
  assert.match(formatExplainWhyText(moved), /^Unassigned /m)
})
