// FILM-2011 fallback: a stock upstream project with the shots placed one after
// another on video-1, each dialogue line at its own start on one audio
// track, and the music under them. Used only when FILM-2012's builder
// (editLogRuntime.openStudioProjectFromPackage) is not in this build. Pure.
const isRef = (entry) => Boolean(entry && typeof entry.url === 'string' && entry.key)

export function buildSequentialRoughCut({ package: pkg, probedAssets = {}, createdAt = new Date().toISOString() }) {
  const fps = pkg.episode?.fps || 24
  const [aw, ah] = String(pkg.episode?.aspect || '16:9').split(':').map(Number)
  const width = aw >= ah ? Math.round((1080 * aw) / ah / 2) * 2 : 1080
  const height = aw >= ah ? 1080 : Math.round((1080 * ah) / aw / 2) * 2
  const assets = []
  const clips = []
  const assetFor = (entry, name, type) => {
    const probed = isRef(entry) ? probedAssets[entry.key] : null
    if (!probed?.path) return null
    const asset = {
      id: `asset-${assets.length + 1}`,
      name,
      type,
      path: probed.path,
      isImported: true,
      url: null,
      duration: probed.duration ?? null,
      width: probed.width ?? null,
      height: probed.height ?? null,
      folderId: null,
      storybook: { key: entry.key },
    }
    assets.push(asset)
    return asset
  }
  let clipCounter = 0
  const clip = (fields) => clips.push({ id: `clip-${++clipCounter}`, enabled: true, trimStart: 0, ...fields })

  let cursor = 0
  for (const shot of [...(pkg.shots || [])].sort((a, b) => a.sequenceNumber - b.sequenceNumber)) {
    const asset = assetFor(shot.video, `Shot ${shot.sequenceNumber}`, 'video')
    const duration = shot.durationSeconds || asset?.duration || 4
    if (asset) {
      clip({ trackId: 'video-1', assetId: asset.id, name: asset.name, type: 'video', startTime: cursor, duration, sourceDuration: asset.duration ?? duration, trimEnd: duration, metadata: { semantic: { scene: shot.sceneNumber ?? null, shotId: shot.id, role: 'generated_video' } } })
    }
    cursor += duration
  }
  for (const line of pkg.dialogue || []) {
    const asset = assetFor(line.audio, `Line ${line.sequenceNumber}`, 'audio')
    if (!asset) continue
    const duration = asset.duration || line.estimatedDurationSeconds || 2
    clip({ trackId: 'audio-1', assetId: asset.id, name: asset.name, type: 'audio', startTime: line.timelineStartSeconds ?? 0, duration, sourceDuration: duration, trimEnd: duration, metadata: { semantic: { scene: line.sceneNumber ?? null, shotId: line.shotId ?? null, role: 'dialogue' }, language: line.language, storybook: { dialogueId: line.id } } })
  }
  for (const track of pkg.audioTracks || []) {
    const asset = assetFor(track.media, track.name || track.type, 'audio')
    if (!asset) continue
    const duration = Math.min(asset.duration || cursor, Math.max(cursor - track.timelineStartSeconds, 1))
    clip({ trackId: 'audio-2', assetId: asset.id, name: asset.name, type: 'audio', startTime: track.timelineStartSeconds || 0, duration, sourceDuration: asset.duration ?? duration, trimEnd: duration, metadata: { semantic: { role: track.type } } })
  }
  const markers = (pkg.scenes || []).map((scene, index) => {
    const first = clips.find((c) => c.trackId === 'video-1' && c.metadata.semantic.scene === scene.number)
    return { id: `marker-${index + 1}`, time: first?.startTime ?? 0, name: `Scene ${scene.number} - ${scene.heading}`, color: '#f5c451' }
  })
  const timeline = {
    id: 'tl-master',
    name: 'Rough cut',
    created: createdAt,
    modified: createdAt,
    width,
    height,
    fps,
    duration: Math.max(cursor, 1),
    zoom: 100,
    tracks: [
      { id: 'video-1', name: 'Shots', type: 'video', muted: false, locked: false, visible: true },
      { id: 'audio-1', name: `Dialogue (${pkg.episode?.language || 'en'})`, type: 'audio', muted: false, locked: false, visible: true },
      { id: 'audio-2', name: 'Music', type: 'audio', muted: false, locked: false, visible: true },
    ],
    clips,
    transitions: [],
    markers,
    clipCounter,
    transitionCounter: 0,
    markerCounter: markers.length,
  }
  return {
    name: `${pkg.project?.name || 'StoryBook'} - Episode ${pkg.episode?.number ?? ''} ${pkg.episode?.title || ''}`.trim(),
    version: '1.1',
    created: createdAt,
    modified: createdAt,
    settings: { width, height, fps, aspectRatio: `${width}:${height}` },
    timelines: [timeline],
    currentTimelineId: timeline.id,
    assets,
    folders: [],
    folderCounter: 0,
  }
}
