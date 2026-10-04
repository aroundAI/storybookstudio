// FILM-2015: the Review screen's model (R-30, R-33). Before = the snapshot of
// the version the plan's apply created (the document before its first step,
// FILM-2012 versions); after = the document now. Clips changed in the plan are
// marked by origin (who last changed them in that version, from the op log);
// a ripple shift alone is not a change. Per-scene accept keeps the accepted
// scenes as the plan left them and restores the others from before, re-laying
// the scenes end to end so nothing overlaps or leaves a gap. Pure module.

const round = (value) => Math.round(value * 1000) / 1000
const PLACEMENT_KEYS = new Set(['startTime'])
const sceneOf = (clip) => {
  const scene = clip?.metadata?.semantic?.scene
  return Number.isInteger(scene) && scene >= 1 ? scene : null
}
const endOf = (clip) => (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)

const timelineOf = (document) => {
  if (Array.isArray(document?.timelines)) {
    return document.timelines.find((timeline) => timeline.id === document.currentTimelineId) || document.timelines[0] || { tracks: [], clips: [] }
  }
  return document || { tracks: [], clips: [] }
}

const touchedIdsOf = (entry) => {
  const ids = new Set()
  const visitClips = (collection) => {
    for (const id of collection?.remove || []) ids.add(id)
    for (const { item } of collection?.restore || []) if (item?.id) ids.add(item.id)
    for (const { id } of collection?.revert || []) ids.add(id)
  }
  const patch = entry?.inverse?.args?.patch
  visitClips(patch?.collections?.clips)
  for (const timeline of patch?.collections?.timelines?.revert || []) visitClips(timeline.patch?.collections?.clips)
  for (const id of entry?.args?.clipIds || []) ids.add(id)
  if (typeof entry?.args?.clipId === 'string') ids.add(entry.args.clipId)
  return ids
}

// Who last changed each clip within one version's ops.
function originsWithin(log, versionId) {
  const origins = new Map()
  for (const entry of log || []) {
    if (versionId && entry.versionId !== versionId) continue
    if (entry.by !== 'ai' && entry.by !== 'user') continue
    for (const id of touchedIdsOf(entry)) origins.set(id, entry.by)
  }
  return origins
}

const relativeOrder = (clips) => {
  const order = new Map()
  const byTrack = new Map()
  for (const clip of clips) {
    if (!byTrack.has(clip.trackId)) byTrack.set(clip.trackId, [])
    byTrack.get(clip.trackId).push(clip)
  }
  for (const list of byTrack.values()) list.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id)).forEach((clip, index) => order.set(clip.id, index))
  return order
}

const contentChanged = (was, now) => {
  const keys = new Set([...Object.keys(was), ...Object.keys(now)])
  for (const key of keys) {
    if (PLACEMENT_KEYS.has(key)) continue
    if (key === 'metadata') continue
    if (JSON.stringify(was[key]) !== JSON.stringify(now[key])) return true
  }
  return false
}

export function buildReviewModel({ before, after, log = [], versionId = null }) {
  const tBefore = timelineOf(before)
  const tAfter = timelineOf(after)
  const tracks = new Map([...(tBefore.tracks || []), ...(tAfter.tracks || [])].map((track) => [track.id, track]))
  const isPicture = (clip) => tracks.get(clip.trackId)?.type !== 'audio'
  const clipsBefore = new Map((tBefore.clips || []).map((clip) => [clip.id, clip]))
  const clipsAfter = new Map((tAfter.clips || []).map((clip) => [clip.id, clip]))
  const common = [...clipsBefore.keys()].filter((id) => clipsAfter.has(id))
  const orderBefore = relativeOrder(common.map((id) => clipsBefore.get(id)))
  const orderAfter = relativeOrder(common.map((id) => clipsAfter.get(id)))
  const origins = originsWithin(log, versionId)

  const statusOf = (id) => {
    const was = clipsBefore.get(id)
    const now = clipsAfter.get(id)
    if (!now) return 'removed'
    if (!was) return 'added'
    if (was.trackId !== now.trackId || orderBefore.get(id) !== orderAfter.get(id)) return 'moved'
    return contentChanged(was, now) ? 'changed' : 'same'
  }

  const row = (clip) => {
    const status = statusOf(clip.id)
    return {
      id: clip.id,
      name: clip.name || clip.id,
      trackId: clip.trackId,
      start: round(Number(clip.startTime) || 0),
      end: round(endOf(clip)),
      scene: sceneOf(clip),
      picture: isPicture(clip),
      status,
      origin: status === 'same' ? null : origins.get(clip.id) ?? 'ai',
    }
  }

  const beforeRows = [...clipsBefore.values()].map(row)
  const afterRows = [...clipsAfter.values()].map(row)
  const changedClipIds = [...new Set([...beforeRows, ...afterRows].filter((clip) => clip.status !== 'same').map((clip) => clip.id))]

  const pictureSpan = (rows, scene) => {
    const picture = rows.filter((clip) => clip.picture && clip.scene === scene)
    if (picture.length === 0) return 0
    return round(Math.max(...picture.map((clip) => clip.end)) - Math.min(...picture.map((clip) => clip.start)))
  }
  const sceneNumbers = [...new Set([...beforeRows, ...afterRows].map((clip) => clip.scene).filter((scene) => scene !== null))].sort((a, b) => a - b)
  const scenes = sceneNumbers.map((scene) => ({
    scene,
    changed: [...beforeRows, ...afterRows].some((clip) => clip.scene === scene && clip.status !== 'same'),
    durationBefore: pictureSpan(beforeRows, scene),
    durationAfter: pictureSpan(afterRows, scene),
  }))
  // Scene picture only: a captions clip spans the whole cut and is not picture.
  const pictureEnd = (rows) => round(rows.filter((clip) => clip.picture && clip.scene !== null).reduce((max, clip) => Math.max(max, clip.end), 0))

  return {
    tracks: [...tracks.values()].map((track) => ({ id: track.id, name: track.name || track.id, type: track.type })),
    before: { clips: beforeRows, duration: pictureEnd(beforeRows) },
    after: { clips: afterRows, duration: pictureEnd(afterRows) },
    durationBefore: pictureEnd(beforeRows),
    durationAfter: pictureEnd(afterRows),
    scenes,
    changedClipIds,
  }
}

// The document after accepting only `acceptedScenes`: their clips as `after`
// has them, every other scene's clips as `before` had them, scenes laid end to
// end in scene order from where the first scene started. Clips outside any
// scene (music beds, captions) keep `after`'s version.
export function mergeAcceptedScenes(before, after, acceptedScenes) {
  const accepted = new Set(acceptedScenes || [])
  const result = JSON.parse(JSON.stringify(after))
  const target = timelineOf(result)
  const tBefore = timelineOf(before)
  const tracks = new Map([...(tBefore.tracks || []), ...(target.tracks || [])].map((track) => [track.id, track]))
  const isPicture = (clip) => tracks.get(clip.trackId)?.type !== 'audio'

  const scenes = new Map()
  const unscened = []
  const take = (clips, fromAfter) => {
    for (const clip of clips || []) {
      const scene = sceneOf(clip)
      if (scene === null) {
        if (fromAfter) unscened.push(clip)
        continue
      }
      if (accepted.has(scene) !== fromAfter) continue
      if (!scenes.has(scene)) scenes.set(scene, [])
      scenes.get(scene).push(JSON.parse(JSON.stringify(clip)))
    }
  }
  take(target.clips, true)
  take(tBefore.clips, false)

  const order = [...scenes.keys()].sort((a, b) => a - b)
  const pictureOf = (clips) => clips.filter(isPicture)
  const firstStart = (() => {
    const starts = order.map((scene) => {
      const picture = pictureOf(scenes.get(scene))
      return picture.length ? Math.min(...picture.map((clip) => clip.startTime)) : Infinity
    })
    const first = order.length ? starts[0] : 0
    return Number.isFinite(first) ? first : 0
  })()

  let cursor = firstStart
  const placed = []
  for (const scene of order) {
    const clips = scenes.get(scene)
    const picture = pictureOf(clips)
    const anchor = picture.length ? Math.min(...picture.map((clip) => clip.startTime)) : Math.min(...clips.map((clip) => clip.startTime))
    const span = picture.length ? Math.max(...picture.map(endOf)) - anchor : 0
    const shift = cursor - anchor
    for (const clip of clips) placed.push(shift === 0 ? clip : { ...clip, startTime: clip.startTime + shift })
    cursor += span
  }

  target.clips = [...placed, ...unscened].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
  return result
}

// "Why this?" for a clip: the report's change that names it, with its reason.
export function reasonForClip(report, clipId) {
  if (!report?.explain) return null
  const scenes = [...(report.explain.scenes || []), ...(report.explain.unassigned ? [report.explain.unassigned] : [])]
  for (const scene of scenes) {
    const change = (scene.changes || []).find((candidate) => candidate.clipId === clipId)
    if (change) return { scene: scene.scene ?? null, action: change.action, reason: change.reason, by: change.by, target: change.target }
  }
  const audio = (report.explain.audio || []).find((candidate) => candidate.clipId === clipId)
  if (audio) return { scene: null, action: audio.kind || 'changed', reason: audio.reason, by: audio.by, target: audio.target }
  return null
}
