// FILM-2015: the scene strip above the timeline. One segment per scene, from
// the clips' scene (clip.metadata.semantic.scene, FILM-2012), the timeline's
// scene markers and storybook/package.json: heading, actual duration (the span
// of the scene's picture clips, as the explain-why report measures it) against
// the screenplay's planned duration; red when over by more than the tolerance.
// The edit policy has no tolerance field yet: policy.sceneDurationTolerance is
// read when present, else 10% (lead default, owner may change). Pure module.

export const DEFAULT_SCENE_TOLERANCE = 0.1

const round = (value) => Math.round(value * 1000) / 1000
const sceneOf = (clip) => {
  const scene = clip?.metadata?.semantic?.scene
  return Number.isInteger(scene) && scene >= 1 ? scene : null
}
const endOf = (clip) => (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)
const seconds = (value) => `${Number(value).toFixed(1)} s`

export function buildSceneSegments({ timeline, pkg = null, policy = null } = {}) {
  const tracks = new Map((timeline?.tracks || []).map((track) => [track.id, track]))
  const clips = timeline?.clips || []
  const isPicture = (clip) => tracks.get(clip.trackId)?.type !== 'audio'
  const tolerance = Number.isFinite(policy?.sceneDurationTolerance) ? policy.sceneDurationTolerance : DEFAULT_SCENE_TOLERANCE
  const planned = new Map((pkg?.scenes || []).map((scene) => [scene.number, scene]))
  const markerHeadings = new Map((timeline?.markers || []).filter((marker) => Number.isInteger(marker.scene)).map((marker) => [marker.scene, marker.label]))

  const byScene = new Map()
  for (const clip of clips) {
    const scene = sceneOf(clip)
    if (scene === null) continue
    if (!byScene.has(scene)) byScene.set(scene, { picture: [], all: [] })
    const entry = byScene.get(scene)
    entry.all.push(clip)
    if (isPicture(clip)) entry.picture.push(clip)
  }

  const segments = [...byScene.entries()]
    .filter(([, entry]) => entry.picture.length > 0)
    .map(([scene, entry]) => {
      const start = round(Math.min(...entry.picture.map((clip) => Number(clip.startTime) || 0)))
      const end = round(Math.max(...entry.picture.map(endOf)))
      const actual = round(end - start)
      const estimate = planned.get(scene)?.estimatedDurationSeconds
      const target = Number.isFinite(estimate) && estimate > 0 ? estimate : null
      const over = target !== null && actual > target * (1 + tolerance) + 1e-9
      const overBy = target !== null ? round(Math.max(0, actual - target)) : 0
      const heading = planned.get(scene)?.heading || markerHeadings.get(scene) || null
      const name = heading ? `Scene ${scene} · ${heading}` : `Scene ${scene}`
      const label = target === null
        ? `Scene ${scene} · ${seconds(actual)}, no target`
        : `Scene ${scene} · ${seconds(actual)} of ${seconds(target)}${over ? `, ${seconds(overBy)} over` : ''}`
      return {
        scene,
        heading,
        name,
        start,
        end,
        actual,
        target,
        over,
        overBy,
        label,
        clipIds: entry.all.map((clip) => clip.id),
      }
    })
    .sort((a, b) => a.start - b.start || a.scene - b.scene)

  const episodeTarget = pkg?.editPolicy?.targetDurationSeconds ?? pkg?.episode?.targetDurationSeconds ?? null
  const actual = segments.length > 0 ? round(Math.max(...segments.map((segment) => segment.end)) - Math.min(...segments.map((segment) => segment.start))) : 0
  return {
    segments,
    tolerance,
    total: { actual, target: Number.isFinite(episodeTarget) ? episodeTarget : null },
  }
}

// What a click on a segment means: select the scene's clips, and scope the
// next instruction ("tighten this") to the scene.
export function scopeForSegment(segment) {
  return { scenes: [segment.scene], clipIds: [...segment.clipIds], label: segment.name }
}
