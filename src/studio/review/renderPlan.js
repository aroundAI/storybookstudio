// FILM-2014: what a timeline renders, as data. The preview tiers, the
// deterministic QA and the critic all read the document through this one
// module, so they agree on which clip is on screen, which bus a clip feeds and
// when a caption cue shows. Pure; src/studio/package.json makes it an ES
// module for the main process (Electron 28, Node 18) as well as `node --test`.

import { inLanguage, selectLanguage } from '../localization/selection.js'

export const EPS = 1e-6
export const KEYFRAME_INTERVAL_SECONDS = 2
export const KEYFRAME_WIDTH = 640
// Two keyframes closer than this are one keyframe (a cut 0.1 s after a 2 s tick).
export const KEYFRAME_MERGE_SECONDS = 0.25
// A cut's keyframe sits one frame-ish after the cut so it shows the new shot.
export const CUT_KEYFRAME_OFFSET_SECONDS = 0.05

const AUDIO_BUSES = ['dialogue', 'music', 'sfx', 'ambience', 'shotaudio']
const ROLE_BUS = { dialogue: 'dialogue', music: 'music', sfx: 'sfx', ambience: 'ambience', generated_video: 'shotaudio' }
const PICTURE_TYPES = new Set(['video', 'image', 'solid'])

const num = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
export const round3 = (value) => Math.round(value * 1000) / 1000
export const clipStart = (clip) => num(clip?.startTime)
export const clipEnd = (clip) => clipStart(clip) + num(clip?.duration)
export const volumeToDb = (volume) => (num(volume, 100) <= 0 ? -Infinity : 20 * Math.log10(num(volume, 100) / 100))
export const dbToVolume = (db) => Math.max(0, Math.min(200, Math.round(100 * 10 ** (db / 20) * 10) / 10))

export function activeTimeline(project, timelineId = null) {
  const timelines = project?.timelines || []
  return timelines.find((timeline) => timeline.id === (timelineId || project?.currentTimelineId)) || timelines[0] || null
}

export const trackMap = (timeline) => new Map((timeline?.tracks || []).map((track) => [track.id, track]))
export const isCaptionTrack = (track) => track?.role === 'captions'
export const sceneOfClip = (clip) => {
  const scene = clip?.metadata?.semantic?.scene
  return Number.isInteger(scene) && scene >= 1 ? scene : null
}

export function assetIndex(project) {
  return new Map((project?.assets || []).map((asset) => [asset.id, asset]))
}

// No node:path: the renderer (FILM-2013's compilers, through repair.js)
// imports this module too.
export const isAbsolutePath = (file) => file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith('\\\\')
export const joinPath = (dir, file) => {
  const sep = /^[A-Za-z]:\\/.test(dir) && !dir.includes('/') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${file.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep)}`
}

// The file a tier reads for an asset: the proxy when one is ready and the
// caller asks for proxies, else the original. null when the asset has no
// file (offline, or never downloaded). Relative paths are project-relative.
export function assetFile(asset, projectDir, { preferProxy = false } = {}) {
  if (!asset) return null
  const resolve = (file) => (typeof file === 'string' && file ? (isAbsolutePath(file) ? file : projectDir ? joinPath(projectDir, file) : null) : null)
  if (preferProxy && asset.proxyStatus === 'ready') {
    const proxy = resolve(asset.proxyPath)
    if (proxy) return proxy
  }
  if (asset.offline) return null
  return resolve(asset.path)
}

// Picture tracks, top layer first: the upstream editor lists video tracks top to bottom.
function pictureTracks(timeline) {
  return (timeline?.tracks || []).filter((track) => track.type === 'video' && !isCaptionTrack(track) && track.visible !== false)
}

export function pictureClips(timeline) {
  const tracks = new Set(pictureTracks(timeline).map((track) => track.id))
  return (timeline?.clips || [])
    .filter((clip) => tracks.has(clip.trackId) && clip.enabled !== false && PICTURE_TYPES.has(clip.type) && num(clip.duration) > EPS)
    .sort((a, b) => clipStart(a) - clipStart(b))
}

// FILM-2018: the composition clips of a timeline as overlays on the picture,
// bottom layer first so the top track composites last. `file` is the render
// (null until one lands); a composition clip never takes a picture segment,
// so the shot below keeps playing under it.
export function compositionOverlays(project, { timelineId = null, projectDir = null } = {}) {
  const timeline = activeTimeline(project, timelineId)
  if (!timeline) return []
  const order = new Map(pictureTracks(timeline).map((track, index) => [track.id, index]))
  return (timeline.clips || [])
    .filter((clip) => clip.type === 'composition' && order.has(clip.trackId) && clip.enabled !== false && num(clip.duration) > EPS)
    .map((clip) => {
      const renderPath = typeof clip.composition?.renderPath === 'string' ? clip.composition.renderPath : null
      const opacity = num(clip.transform?.opacity, 100)
      return {
        clipId: clip.id,
        compositionId: clip.composition?.compositionId ?? null,
        start: clipStart(clip),
        end: clipEnd(clip),
        sourceStart: num(clip.trimStart),
        renderPath,
        file: renderPath && projectDir ? joinPath(projectDir, renderPath) : null,
        opacity: Math.max(0, Math.min(1, opacity / 100)),
        layer: order.get(clip.trackId),
        name: clip.name || clip.id,
      }
    })
    .sort((a, b) => b.layer - a.layer || a.start - b.start)
}

// The program end: the last picture or audio clip, captions excluded (a
// captions clip may outrun the picture and is checked on its own).
export function programDuration(timeline) {
  const tracks = trackMap(timeline)
  let end = 0
  for (const clip of timeline?.clips || []) {
    const track = tracks.get(clip.trackId)
    if (!track || isCaptionTrack(track) || clip.enabled === false) continue
    end = Math.max(end, clipEnd(clip))
  }
  return round3(end)
}

// Which clip is on screen when, as non-overlapping segments covering
// [0, duration]: the top visible picture clip wins; nothing on screen is a gap.
export function pictureSegments(project, { timelineId = null, projectDir = null, preferProxy = false } = {}) {
  const timeline = activeTimeline(project, timelineId)
  if (!timeline) return []
  const assets = assetIndex(project)
  const order = new Map(pictureTracks(timeline).map((track, index) => [track.id, index]))
  const clips = pictureClips(timeline)
  const duration = programDuration(timeline)
  const bounds = [...new Set([0, duration, ...clips.flatMap((clip) => [clipStart(clip), clipEnd(clip)])])]
    .filter((t) => t >= 0 && t <= duration + EPS)
    .sort((a, b) => a - b)
  const segments = []
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const [start, end] = [bounds[i], bounds[i + 1]]
    if (end - start <= EPS) continue
    const mid = (start + end) / 2
    const top = clips
      .filter((clip) => clipStart(clip) <= mid && clipEnd(clip) > mid)
      .sort((a, b) => order.get(a.trackId) - order.get(b.trackId))[0]
    const last = segments.at(-1)
    if (last && last.clipId === (top?.id ?? null) && Math.abs(last.end - start) < EPS) {
      last.end = end
      continue
    }
    if (!top) {
      segments.push({ start, end, clipId: null, kind: 'gap', file: null, scene: null })
      continue
    }
    const asset = assets.get(top.assetId)
    const speed = num(top.speed, 1) || 1
    segments.push({
      start,
      end,
      clipId: top.id,
      assetId: top.assetId ?? null,
      kind: top.type === 'solid' ? 'solid' : top.type,
      color: top.type === 'solid' ? top.color || '#000000' : null,
      file: top.type === 'solid' ? null : assetFile(asset, projectDir, { preferProxy }),
      offline: top.type !== 'solid' && !assetFile(asset, projectDir),
      // Source seconds at the segment start; the upstream editor's trimStart is in source time.
      sourceStart: num(top.trimStart) + (start - clipStart(top)) * speed,
      speed,
      scene: sceneOfClip(top),
      shotId: top.metadata?.semantic?.shotId ?? null,
    })
  }
  return segments.map((segment) => ({ ...segment, start: round3(segment.start), end: round3(segment.end) }))
}

// Cuts: every boundary between two segments showing different clips.
export const cutTimes = (segments) => segments.slice(1).filter((segment, i) => segment.clipId !== segments[i].clipId).map((segment) => segment.start)

// One keyframe per cut (just after it) and one every `every` seconds,
// merged when two fall within KEYFRAME_MERGE_SECONDS.
export function keyframeTimes(segments, { every = KEYFRAME_INTERVAL_SECONDS, range = null } = {}) {
  if (segments.length === 0) return []
  const duration = segments.at(-1).end
  const [from, to] = range ? [Math.max(0, range[0]), Math.min(duration, range[1])] : [0, duration]
  const candidates = [{ time: from + CUT_KEYFRAME_OFFSET_SECONDS, reason: 'start' }]
  for (const cut of cutTimes(segments)) candidates.push({ time: cut + CUT_KEYFRAME_OFFSET_SECONDS, reason: 'cut' })
  for (let t = Math.ceil(from / every) * every; t < to; t += every) if (t > from) candidates.push({ time: t, reason: 'interval' })
  candidates.sort((a, b) => a.time - b.time || (a.reason === 'cut' ? -1 : 1))
  const out = []
  for (const candidate of candidates) {
    if (candidate.time < from - EPS || candidate.time >= to - EPS) continue
    const last = out.at(-1)
    if (last && candidate.time - last.time < KEYFRAME_MERGE_SECONDS) {
      // A cut's frame wins: it shows the new shot.
      if (candidate.reason === 'cut') Object.assign(last, { time: round3(candidate.time), reason: 'cut' })
      continue
    }
    out.push({ ...candidate, time: round3(candidate.time) })
  }
  return out
}

export const segmentAt = (segments, time) => segments.find((segment) => segment.start <= time + EPS && segment.end > time + EPS) || segments.at(-1) || null

export function busOfClip(clip, track) {
  if (AUDIO_BUSES.includes(track?.bus)) return track.bus
  if (AUDIO_BUSES.includes(clip?.metadata?.bus)) return clip.metadata.bus
  return ROLE_BUS[clip?.metadata?.semantic?.role] || 'sfx'
}

// A clip sounds in a render of `language` when it, or its track, has no
// language or that one (a dubbed lane plays only in its own render); the
// language's own tracks are selected by it (FILM-2019, localization/selection.js).
export { inLanguage }
const languageTracks = (timeline, language) => trackMap(selectLanguage(timeline, language))

// Every audible audio clip with what the mix needs: file, timing, gains, fades, bus.
export function audioClips(project, { timelineId = null, projectDir = null, language = null } = {}) {
  const timeline = activeTimeline(project, timelineId)
  if (!timeline) return []
  const tracks = languageTracks(timeline, language)
  const assets = assetIndex(project)
  const soloed = (timeline.tracks || []).some((track) => track.type === 'audio' && track.solo)
  return (timeline.clips || [])
    .filter((clip) => {
      const track = tracks.get(clip.trackId)
      return track?.type === 'audio' && !track.muted && (!soloed || track.solo) && clip.enabled !== false && num(clip.duration) > EPS && inLanguage(clip, track, language)
    })
    .map((clip) => {
      const track = tracks.get(clip.trackId)
      const asset = assets.get(clip.assetId)
      return {
        clipId: clip.id,
        trackId: clip.trackId,
        bus: busOfClip(clip, track),
        role: clip.metadata?.semantic?.role ?? null,
        language: clip.metadata?.language ?? track.language ?? null,
        file: assetFile(asset, projectDir),
        offline: !assetFile(asset, projectDir),
        start: clipStart(clip),
        duration: num(clip.duration),
        sourceStart: num(clip.trimStart),
        speed: num(clip.speed, 1) || 1,
        gainDb: num(clip.gainDb),
        fadeIn: num(clip.fadeIn),
        fadeOut: num(clip.fadeOut),
        trackGainDb: volumeToDb(track.volume ?? 100),
        scene: sceneOfClip(clip),
        name: clip.name || clip.id,
      }
    })
    .sort((a, b) => a.start - b.start)
}

export const busGainDb = (project, bus) => num(project?.studio?.audioBuses?.[bus]?.gainDb)
export const masterGainDb = (timeline) => volumeToDb(timeline?.masterAudioVolume ?? 100)

// Caption cues in timeline seconds. A live captions clip stores cue times
// relative to its own source start (trimStart), like any clip.
export function captionCues(project, { timelineId = null, language = null } = {}) {
  const timeline = activeTimeline(project, timelineId)
  if (!timeline) return []
  const tracks = languageTracks(timeline, language)
  const out = []
  for (const clip of timeline.clips || []) {
    const track = tracks.get(clip.trackId)
    if (clip.type !== 'captions' || clip.enabled === false || track?.visible === false || !inLanguage(clip, track, language)) continue
    const offset = clipStart(clip) - num(clip.trimStart)
    for (const cue of clip.captions?.cues || []) {
      const start = offset + num(cue.start)
      const end = offset + num(cue.end)
      if (end <= clipStart(clip) + EPS || start >= clipEnd(clip) - EPS) continue
      out.push({
        clipId: clip.id,
        cueId: cue.id ?? null,
        language: clip.metadata?.language ?? track?.language ?? null,
        text: String(cue.text || ''),
        start: round3(Math.max(start, clipStart(clip))),
        end: round3(Math.min(end, clipEnd(clip))),
        cue,
        clip,
      })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

// The scene playing at `time`: the picture clip's semantic scene, else the
// last scene marker at or before it.
export function sceneAt(project, time, { timelineId = null } = {}) {
  const timeline = activeTimeline(project, timelineId)
  const clip = pictureClips(timeline).find((candidate) => clipStart(candidate) <= time + EPS && clipEnd(candidate) > time + EPS)
  if (sceneOfClip(clip)) return sceneOfClip(clip)
  const marker = (timeline?.markers || []).filter((m) => Number.isInteger(m.scene) && num(m.time) <= time + EPS).sort((a, b) => b.time - a.time)[0]
  return marker?.scene ?? null
}

// The scene that holds most of [start, end], for issues that span a range.
export function sceneOfRange(project, start, end, options = {}) {
  const mid = (start + end) / 2
  return sceneAt(project, mid, options)
}

export function timelineFrame(project, timelineId = null) {
  const timeline = activeTimeline(project, timelineId)
  return {
    width: num(timeline?.width, num(project?.settings?.width, 1920)),
    height: num(timeline?.height, num(project?.settings?.height, 1080)),
    fps: num(timeline?.fps, num(project?.settings?.fps, 24)),
    aspect: timeline?.studio?.aspect ?? null,
  }
}
