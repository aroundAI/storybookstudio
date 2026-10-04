// FILM-2015: the Review screen. Before and after stacked, clips changed in the
// plan highlighted by origin, per-scene accept (the other scenes come back
// from the version before the plan), and "Why this?" from the report.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildReviewModel, mergeAcceptedScenes, reasonForClip } from '../../../src/studio/ui/review.js'
import { buildExplainWhyReport } from '../../../src/studio/report.js'

const snapshot = JSON.parse(readFileSync(new URL('../fixtures/rough-cut/20-shots.snapshot.json', import.meta.url), 'utf8'))
const documentOf = (timeline) => ({ currentTimelineId: timeline.id, timelines: [timeline] })
const before = () => documentOf(JSON.parse(JSON.stringify(snapshot.project.timelines[0])))

// The fixture plan applied: S1.4 and S2.4 (with their shot audio) removed,
// with the dialogue under them, everything after rippled left; clip-30 trimmed by hand.
function applied() {
  const doc = before()
  const t = doc.timelines[0]
  // The dialogue under each removed shot goes with it (clip-27/28, clip-35/36).
  const gone = new Set(['clip-4', 'clip-64', 'clip-27', 'clip-28', 'clip-8', 'clip-68', 'clip-35', 'clip-36'])
  t.clips = t.clips.filter((clip) => !gone.has(clip.id))
  for (const clip of t.clips) {
    if (clip.startTime >= 39) clip.startTime -= 9
    else if (clip.startTime >= 19) clip.startTime -= 4
  }
  t.clips.find((clip) => clip.id === 'clip-30').duration = 1
  return doc
}

// An op-log line whose inverse patch names the clips it touched (FILM-2012 shape).
const op = (n, by, tool, clipIds, reason, scene) => ({
  op: n, by, tool, args: { clipIds }, reason, scene, versionId: 'v2',
  inverse: { tool: 'studio_apply_patch', args: { patch: { fields: {}, collections: { timelines: { revert: [{ id: 'timeline-master', patch: { fields: {}, collections: { clips: { restore: clipIds.map((id, index) => ({ index, item: { id } })) } } } }] } } } } },
})
const log = [
  { op: 1, by: 'internal', tool: 'studio_create_version', args: { versionId: 'v1', name: 'Rough cut' }, versionId: 'v1' },
  { op: 2, by: 'ai', tool: 'studio_create_version', args: { versionId: 'v2', name: 'make it 90 seconds' }, versionId: 'v2' },
  op(3, 'ai', 'delete_clips', ['clip-4', 'clip-64', 'clip-27', 'clip-28'], 'Second reaction to the same alarm.', 1),
  op(4, 'ai', 'delete_clips', ['clip-8', 'clip-68', 'clip-35', 'clip-36'], 'Repeats the beat of S2.2.', 2),
  op(5, 'user', 'updateClipTrim', ['clip-30'], null, 2),
]
const versions = [
  { id: 'v1', name: 'Rough cut', parent: null, opRange: [1, 1], createdBy: 'internal', createdAt: '2026-10-04T20:00:00.000Z', prompt: null },
  { id: 'v2', name: 'make it 90 seconds', parent: 'v1', opRange: [2, null], createdBy: 'ai', createdAt: '2026-10-04T20:05:00.000Z', prompt: 'make it 90 seconds' },
]

test('both timelines are laid out; removed, moved and hand-edited clips are marked by origin', () => {
  const model = buildReviewModel({ before: before(), after: applied(), log, versionId: 'v2' })
  assert.equal(model.durationBefore, 99)
  assert.equal(model.durationAfter, 90)
  const beforeRow = new Map(model.before.clips.map((clip) => [clip.id, clip]))
  const afterRow = new Map(model.after.clips.map((clip) => [clip.id, clip]))
  assert.equal(beforeRow.get('clip-4').status, 'removed')
  assert.equal(beforeRow.get('clip-4').origin, 'ai')
  assert.equal(afterRow.has('clip-4'), false)
  assert.equal(afterRow.get('clip-30').status, 'changed')
  assert.equal(afterRow.get('clip-30').origin, 'user')
  // A ripple shift is not a change the user has to review.
  assert.equal(afterRow.get('clip-9').status, 'same')
  assert.equal(afterRow.get('clip-1').status, 'same')
  assert.deepEqual(model.scenes.map((scene) => [scene.scene, scene.changed, scene.durationBefore, scene.durationAfter]), [
    [1, true, 19, 15],
    [2, true, 20, 15],
    [3, false, 21, 21],
    [4, false, 19, 19],
    [5, false, 20, 20],
  ])
  assert.deepEqual(model.changedClipIds.sort(), ['clip-27', 'clip-28', 'clip-30', 'clip-35', 'clip-36', 'clip-4', 'clip-64', 'clip-68', 'clip-8'])
})

test('accepting scene 2 only keeps scene 2 as the plan left it and restores scene 1 from the version before', () => {
  const merged = mergeAcceptedScenes(before(), applied(), [2])
  const clips = new Map(merged.timelines[0].clips.map((clip) => [clip.id, clip]))
  // Scene 1 is back: its removed shot and shot audio return.
  assert.ok(clips.has('clip-4') && clips.has('clip-64') && clips.has('clip-27'))
  // Scene 2's removal stays.
  assert.ok(!clips.has('clip-8') && !clips.has('clip-68'))
  // Scene 1 runs 0..19 again, so scene 2 starts at 19 and is 15 s; later scenes follow without a gap or overlap.
  assert.equal(clips.get('clip-5').startTime, 19)
  assert.equal(clips.get('clip-9').startTime, 34)
  const picture = merged.timelines[0].clips.filter((clip) => clip.trackId === 'video-1').sort((a, b) => a.startTime - b.startTime)
  for (let i = 1; i < picture.length; i += 1) {
    assert.equal(Math.round((picture[i - 1].startTime + picture[i - 1].duration) * 1000) / 1000, picture[i].startTime, `${picture[i].id} follows ${picture[i - 1].id}`)
  }
  // Clips outside any scene (the music bed) keep the plan's version.
  assert.ok(clips.has('clip-80'))
})

test('accepting every scene is the plan as applied; accepting none is the version before', () => {
  const after = applied()
  assert.deepEqual(mergeAcceptedScenes(before(), after, [1, 2, 3, 4, 5]).timelines[0].clips.map((c) => c.id).sort(), after.timelines[0].clips.map((c) => c.id).sort())
  const none = mergeAcceptedScenes(before(), applied(), [])
  const original = before()
  assert.deepEqual(
    none.timelines[0].clips.filter((c) => c.metadata?.semantic?.scene).map((c) => [c.id, c.startTime, c.duration]).sort(),
    original.timelines[0].clips.filter((c) => c.metadata?.semantic?.scene).map((c) => [c.id, c.startTime, c.duration]).sort(),
  )
})

test('"Why this?" reads the report’s reason for a clip, and says so when there is none', () => {
  const report = buildExplainWhyReport({ log, versions, versionId: 'v2', before: before(), after: applied() })
  assert.deepEqual(reasonForClip(report, 'clip-4'), { scene: 1, action: 'removed', reason: 'Second reaction to the same alarm.', by: 'ai', target: 'S1.4 ARJUN reacts to the alarm (shot 4).' })
  assert.equal(reasonForClip(report, 'clip-30').by, 'user')
  assert.equal(reasonForClip(report, 'clip-1'), null)
  assert.equal(reasonForClip(null, 'clip-4'), null)
})
