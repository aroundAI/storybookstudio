// The explain-why report (FILM-2012 AC7, PRD R-24): what a version removed,
// trimmed, moved, added or changed, per scene, with the reason each op-log
// line carries; scene and total durations before and after; audio changes;
// and a slot for the QA result (FILM-2014). JSON in the shape of
// ExplainWhyReportSchema (FILM-2003) and the text block the PRD shows.
// `before` is the version's snapshot, `after` the document at the version's
// end (the next version's snapshot, or the current document).
// Pure module: no Electron, no stores.
import { touchedClipIds } from './documentDiff.js'
import { CREATE_VERSION_TOOL } from './oplog.js'

export const reportPathFor = (versionId) => `edits/reports/${versionId}.json`

const EPSILON = 1e-6
const PLACEMENT_KEYS = new Set(['startTime', 'duration', 'trimStart', 'trimEnd', 'sourceDuration', 'metadata'])
const round = (value) => Math.round(value * 1000) / 1000

const timelineOf = (document, timelineId) => {
  if (Array.isArray(document?.timelines)) {
    return document.timelines.find((timeline) => timeline.id === timelineId) || document.timelines[0] || { tracks: [], clips: [] }
  }
  return document || { tracks: [], clips: [] }
}

const sceneOf = (clip) => (Number.isInteger(clip?.metadata?.semantic?.scene) ? clip.metadata.semantic.scene : null)
const endOf = (clip) => (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)
const placement = (clip) => (clip ? { trackId: clip.trackId ?? null, startTime: round(Number(clip.startTime) || 0), duration: round(Number(clip.duration) || 0) } : null)

const pictureSpan = (clips) => {
  if (clips.length === 0) return 0
  const start = Math.min(...clips.map((clip) => Number(clip.startTime) || 0))
  return round(Math.max(...clips.map(endOf)) - start)
}

// The order of the clips present on both sides, per track, by start time: a
// ripple shift keeps it, a real move changes it.
const relativeOrder = (clips, commonIds) => {
  const order = new Map()
  const byTrack = new Map()
  for (const clip of clips) {
    if (!commonIds.has(clip.id)) continue
    if (!byTrack.has(clip.trackId)) byTrack.set(clip.trackId, [])
    byTrack.get(clip.trackId).push(clip)
  }
  for (const trackClips of byTrack.values()) {
    trackClips.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id)).forEach((clip, index) => order.set(clip.id, index))
  }
  return order
}

const changedFields = (before, after) => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((key) => !PLACEMENT_KEYS.has(key) && key !== 'gainDb' && JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort()
}

export function buildExplainWhyReport({ log, versions, versionId, before, after, qa = null, target = null }) {
  const index = versions.findIndex((version) => version.id === versionId)
  if (index < 0) throw new Error(`Unknown version ${versionId}`)
  const record = versions[index]
  const parent = record.parent ? versions.find((version) => version.id === record.parent) : null
  const [from, to] = record.opRange
  const withinEnd = (entry) => to == null || entry.op <= to
  const rangeOps = log.filter((entry) => entry.op >= from && withinEnd(entry))
  const counted = log.filter((entry) => withinEnd(entry) && entry.tool !== CREATE_VERSION_TOOL)
  const touchedByOp = new Map(rangeOps.map((entry) => [entry.op, touchedClipIds(entry.inverse?.args?.patch)]))

  // Prefer the op that named the clip in its arguments (the trim, not the
  // ripple it caused); otherwise the last op that touched it.
  const attribute = (id) => {
    const touching = rangeOps.filter((entry) => touchedByOp.get(entry.op).has(id) || JSON.stringify(entry.args ?? {}).includes(`"${id}"`))
    const naming = touching.filter((entry) => JSON.stringify(entry.args ?? {}).includes(`"${id}"`))
    const chosen = (naming.length > 0 ? naming : touching).at(-1)
    return chosen ? { reason: chosen.reason ?? null, by: chosen.by, opId: chosen.op } : { reason: null, by: null, opId: null }
  }

  const timelineId = after?.currentTimelineId ?? before?.currentTimelineId ?? null
  const timelineBefore = timelineOf(before, timelineId)
  const timelineAfter = timelineOf(after, timelineId)
  const tracks = new Map([...(timelineBefore.tracks || []), ...(timelineAfter.tracks || [])].map((track) => [track.id, track]))
  const isAudio = (clip) => tracks.get(clip?.trackId)?.type === 'audio'
  const clipsBefore = new Map((timelineBefore.clips || []).map((clip) => [clip.id, clip]))
  const clipsAfter = new Map((timelineAfter.clips || []).map((clip) => [clip.id, clip]))
  const commonIds = new Set([...clipsBefore.keys()].filter((id) => clipsAfter.has(id)))
  const orderBefore = relativeOrder(clipsBefore.values(), commonIds)
  const orderAfter = relativeOrder(clipsAfter.values(), commonIds)

  const sceneChanges = new Map()
  const audio = []
  const allIds = [...new Set([...clipsBefore.keys(), ...clipsAfter.keys()])]
  const sortKey = (id) => (clipsAfter.get(id) ?? clipsBefore.get(id)).startTime
  for (const id of allIds.sort((a, b) => sortKey(a) - sortKey(b) || a.localeCompare(b))) {
    const was = clipsBefore.get(id)
    const now = clipsAfter.get(id)
    const kinds = []
    let fields = []
    if (!now) kinds.push('removed')
    else if (!was) kinds.push('added')
    else {
      if (Math.abs((Number(was.duration) || 0) - (Number(now.duration) || 0)) > EPSILON) kinds.push('trimmed')
      if (was.trackId !== now.trackId || orderBefore.get(id) !== orderAfter.get(id)) kinds.push('moved')
      fields = changedFields(was, now)
      if (fields.length > 0) kinds.push('changed')
    }
    const clip = now ?? was
    const label = clip.name || id
    const attribution = kinds.length > 0 || (was && now && (was.gainDb ?? 0) !== (now.gainDb ?? 0)) ? attribute(id) : null
    if (was && now && isAudio(clip) && (was.gainDb ?? 0) !== (now.gainDb ?? 0)) {
      audio.push({ kind: 'gain', target: id, label, before: was.gainDb ?? 0, after: now.gainDb ?? 0, ...attribution })
    }
    const scene = sceneOf(was) ?? sceneOf(now)
    for (const kind of kinds) {
      if (isAudio(clip) && scene === null) {
        audio.push({ kind, target: id, label, before: was ? round(was.duration) : null, after: now ? round(now.duration) : null, ...attribution })
        continue
      }
      if (!sceneChanges.has(scene)) sceneChanges.set(scene, [])
      sceneChanges.get(scene).push({
        kind,
        clipId: id,
        label,
        before: placement(was),
        after: placement(now),
        ...(kind === 'changed' ? { fields } : {}),
        ...attribution,
      })
    }
  }

  for (const [trackId, track] of tracks) {
    const was = (timelineBefore.tracks || []).find((candidate) => candidate.id === trackId)
    const now = (timelineAfter.tracks || []).find((candidate) => candidate.id === trackId)
    if (track.type !== 'audio' || !was || !now || (was.volume ?? 1) === (now.volume ?? 1)) continue
    audio.push({ kind: 'track_volume', target: trackId, label: now.name || trackId, before: was.volume ?? 1, after: now.volume ?? 1, ...attribute(trackId) })
  }

  const pictureBefore = (timelineBefore.clips || []).filter((clip) => !isAudio(clip))
  const pictureAfter = (timelineAfter.clips || []).filter((clip) => !isAudio(clip))
  const sceneNumbers = new Set([...pictureBefore, ...pictureAfter].map(sceneOf))
  for (const scene of sceneChanges.keys()) sceneNumbers.add(scene)
  const orderedScenes = [...sceneNumbers].sort((a, b) => (a === null) - (b === null) || a - b)
  const scenes = orderedScenes.map((scene) => ({
    scene,
    durationBefore: pictureSpan(pictureBefore.filter((clip) => sceneOf(clip) === scene)),
    durationAfter: pictureSpan(pictureAfter.filter((clip) => sceneOf(clip) === scene)),
    changes: sceneChanges.get(scene) || [],
  }))
  const scenesBefore = new Set(pictureBefore.map(sceneOf).filter((scene) => scene !== null))
  const scenesAfter = new Set(pictureAfter.map(sceneOf))
  const totalEnd = (clips) => round(clips.reduce((max, clip) => Math.max(max, endOf(clip)), 0))
  const durationAfter = totalEnd(pictureAfter)

  return {
    versions: versions.slice(0, index + 1).map(({ id, name, parent: parentId, opRange, createdBy, createdAt, prompt }) => ({
      id, name, parent: parentId, opRange: [...opRange], createdBy, createdAt, prompt,
    })),
    finalDuration: durationAfter,
    aiOps: counted.filter((entry) => entry.by === 'ai').length,
    userOps: counted.filter((entry) => entry.by === 'user').length,
    explain: {
      versionId: record.id,
      versionName: record.name,
      baseVersionName: parent?.name ?? null,
      plan: record.prompt ?? null,
      durationBefore: totalEnd(pictureBefore),
      durationAfter,
      target: target ?? null,
      scenesKept: [...scenesBefore].filter((scene) => scenesAfter.has(scene)).length,
      scenesTotal: scenesBefore.size,
      scenes,
      audio,
      qa: qa ?? null,
    },
  }
}

const COLUMN = 38
const seconds = (value) => `${Number(value).toFixed(1)} s`
const plainNumber = (value) => (Number.isInteger(value) ? String(value) : Number(value).toFixed(1))
const signed = (value) => `${value > 0 ? '+' : ''}${Number(value).toFixed(1)}`
const columns = (left, right) => (left.length < COLUMN - 1 ? `${left.padEnd(COLUMN)}${right}` : `${left}  ${right}`)
const timecode = (value) => {
  const minutes = Math.floor(value / 60)
  const rest = value - minutes * 60
  const whole = Math.abs(rest - Math.round(rest)) < 0.05
  return `${minutes}:${whole ? String(Math.round(rest)).padStart(2, '0') : rest.toFixed(1).padStart(4, '0')}`
}
const why = (change) => change.reason ?? (change.by === 'user' ? 'Hand edit' : 'No reason recorded')

const changeLine = (change) => {
  const kind = `${change.kind[0].toUpperCase()}${change.kind.slice(1)}`.padEnd(9)
  switch (change.kind) {
    case 'trimmed': return `  ${kind}${change.label}  ${seconds(change.before.duration)} -> ${seconds(change.after.duration)}`
    case 'removed': return `  ${kind}${change.label}  ${seconds(change.before.duration)}`
    case 'added': return `  ${kind}${change.label}  ${seconds(change.after.duration)}`
    case 'moved': return `  ${kind}${change.label} -> ${timecode(change.after.startTime)}`
    default: return `  ${kind}${change.label}  ${(change.fields || []).join(', ')}`
  }
}

const audioDetail = (change) => {
  if (change.kind === 'gain') return `${signed(change.after - change.before)} dB`
  if (change.kind === 'track_volume') return `volume ${change.before} -> ${change.after}`
  return change.kind
}

export function formatExplainWhyText(report) {
  const { explain } = report
  const lines = [
    columns(
      explain.plan ? `Plan: "${explain.plan}"` : 'Plan: (no prompt)',
      `Version: ${explain.versionName}${explain.baseVersionName ? ` (from ${explain.baseVersionName})` : ''}`,
    ),
    columns(
      `Duration: ${seconds(explain.durationBefore)} -> ${seconds(explain.durationAfter)}`,
      `Target: ${explain.target == null ? 'none' : `${plainNumber(explain.target)} s`}   Scenes kept: ${explain.scenesKept} of ${explain.scenesTotal}`,
    ),
    '',
  ]
  for (const scene of explain.scenes) {
    if (scene.changes.length === 0) continue
    lines.push(`${scene.scene === null ? 'Unassigned' : `Scene ${scene.scene}`}  ${seconds(scene.durationBefore)} -> ${seconds(scene.durationAfter)}`)
    for (const change of scene.changes) lines.push(columns(changeLine(change), why(change)))
  }
  for (const change of explain.audio) lines.push(columns(`${'Audio'.padEnd(10)}${change.label} ${audioDetail(change)}`, why(change)))
  if (!explain.qa) lines.push(`${'QA'.padEnd(10)}not run`)
  else {
    const count = explain.qa.issues.length
    lines.push(`${'QA'.padEnd(10)}${explain.qa.pass ? 'pass' : 'fail'}, ${count} issue${count === 1 ? '' : 's'}`)
  }
  return `${lines.join('\n')}\n`
}
