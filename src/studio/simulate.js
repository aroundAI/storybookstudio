// Runs an action plan on a copy of a timeline (FILM-2013), so a preview can
// show per-scene durations and a draft explain-why report without touching
// the project. Each step mirrors the timing rules of the upstream editor's own handler in
// src/services/mcpActions.js (extract_range splits at the edges, removes the
// inside and ripples later clips left; removing a clip removes its linked
// partner). It is a model for cards, not a second editor: the applied result
// is whatever the upstream editor's handlers do, and the report after apply is built from
// the real document. Pure module: no Electron, no stores.
import { POP_DURATION_SECONDS } from './compositions/sfx.js'

const EPS = 1e-6
const clone = (value) => JSON.parse(JSON.stringify(value))
const toFrame = (seconds, fps) => Math.round(seconds * fps) / fps
const start = (clip) => Number(clip.startTime) || 0
const end = (clip) => start(clip) + (Number(clip.duration) || 0)
const ids = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]).map(String).filter(Boolean)

const withLinked = (clips, clipIds) => {
  const wanted = new Set(clipIds)
  const groups = new Set(clips.filter((clip) => wanted.has(clip.id) && clip.linkGroupId).map((clip) => clip.linkGroupId))
  for (const clip of clips) if (clip.linkGroupId && groups.has(clip.linkGroupId)) wanted.add(clip.id)
  return wanted
}

const entriesOf = (args) => (Array.isArray(args.clips) ? args.clips : [args]).map((entry) => ({ ...entry, clipId: String(entry.clipId || entry.id || '') }))

function extractRange(timeline, args, fps, counter) {
  const from = toFrame(Math.max(0, Number(args.startSeconds ?? args.start)), fps)
  const to = toFrame(Math.max(0, Number(args.endSeconds ?? args.end)), fps)
  if (!(to - from >= 1 / fps - EPS)) throw new Error('extract_range needs at least one frame')
  const half = 0.5 / fps
  const delta = to - from
  const requested = Array.isArray(args.trackIds) && args.trackIds.length ? new Set(args.trackIds.map(String)) : null
  const active = new Set(timeline.tracks.filter((track) => (!requested || requested.has(track.id)) && !track.locked).map((track) => track.id))
  const ripple = args.ripple !== false
  const next = []
  for (const clip of timeline.clips) {
    if (!active.has(clip.trackId) || end(clip) <= from + half) {
      next.push(clip)
      continue
    }
    const s = start(clip)
    const e = end(clip)
    const scale = Number(clip.speed) > 0 ? Number(clip.speed) : 1
    const left = s < from - half && e > from + half
    const right = s < to - half && e > to + half
    if (left) next.push({ ...clip, duration: from - s, trimEnd: (Number(clip.trimStart) || 0) + (from - s) * scale })
    if (right) {
      counter.n += 1
      next.push({
        ...clip,
        id: `${clip.id}~${counter.n}`,
        startTime: ripple ? from : to,
        duration: e - to,
        trimStart: (Number(clip.trimStart) || 0) + (to - s) * scale,
      })
    }
    if (left || right) continue
    if (s >= from - half && e <= to + half) continue // inside: removed
    if (ripple && s >= to - half) next.push({ ...clip, startTime: Math.max(0, s - delta) })
    else next.push(clip)
  }
  timeline.clips = next
}

function deleteClips(timeline, args) {
  const removed = withLinked(timeline.clips, ids(args.clipIds ?? args.clipId))
  const gone = timeline.clips.filter((clip) => removed.has(clip.id))
  timeline.clips = timeline.clips.filter((clip) => !removed.has(clip.id))
  if (args.ripple !== true) return
  for (const clip of [...gone].sort((a, b) => start(b) - start(a))) {
    timeline.clips = timeline.clips.map((other) => (other.trackId === clip.trackId && start(other) >= end(clip) - EPS
      ? { ...other, startTime: Math.max(0, start(other) - clip.duration) }
      : other))
  }
}

function predictedTrackId(timeline, type) {
  const highest = timeline.tracks.filter((track) => track.type === type)
    .reduce((max, track) => Math.max(max, Number(new RegExp(`^${type}-(\\d+)$`).exec(track.id)?.[1]) || 0), 0)
  return `${type}-${highest + 1}`
}

export function simulateStep(timeline, step, { fps = 24, counter = { n: 0 }, assets = [] } = {}) {
  const args = step.arguments || {}
  const byId = (id) => timeline.clips.find((clip) => clip.id === id)
  switch (step.tool) {
    case 'extract_range':
      extractRange(timeline, args, fps, counter)
      return
    case 'trim_clips':
      for (const entry of entriesOf(args)) {
        const clip = byId(entry.clipId)
        if (!clip) continue
        if (entry.startSeconds !== undefined || entry.startTime !== undefined) clip.startTime = toFrame(Number(entry.startSeconds ?? entry.startTime), fps)
        if (entry.durationSeconds !== undefined || entry.duration !== undefined) clip.duration = toFrame(Number(entry.durationSeconds ?? entry.duration), fps)
        if (entry.trimStartSeconds !== undefined || entry.trimStart !== undefined) clip.trimStart = Number(entry.trimStartSeconds ?? entry.trimStart)
        if (entry.trimEndSeconds !== undefined || entry.trimEnd !== undefined) clip.trimEnd = Number(entry.trimEndSeconds ?? entry.trimEnd)
      }
      return
    case 'move_clips':
      for (const entry of entriesOf(args)) {
        const clip = byId(entry.clipId)
        if (!clip) continue
        clip.trackId = String(entry.trackId || args.trackId || clip.trackId)
        clip.startTime = toFrame(Math.max(0, Number(entry.startSeconds ?? entry.startTime ?? args.startSeconds ?? clip.startTime)), fps)
      }
      return
    case 'delete_clips':
      deleteClips(timeline, args)
      return
    case 'set_clip_speed':
      for (const id of ids(args.clipIds ?? args.clipId)) {
        const clip = byId(id)
        if (!clip || args.speed == null) continue
        const speed = Math.max(0.1, Math.min(8, Number(args.speed) || 1))
        clip.duration = toFrame((clip.duration * (Number(clip.speed) || 1)) / speed, fps)
        clip.speed = speed
      }
      return
    case 'set_clip_audio':
      for (const id of ids(args.clipIds ?? args.clipId)) {
        const clip = byId(id)
        if (!clip) continue
        if (args.gainDb != null) clip.gainDb = Number(args.gainDb)
        if (args.fadeInSeconds != null) clip.fadeIn = Number(args.fadeInSeconds)
        if (args.fadeOutSeconds != null) clip.fadeOut = Number(args.fadeOutSeconds)
      }
      return
    case 'update_transition': {
      const transition = (timeline.transitions || []).find((candidate) => candidate.id === args.transitionId)
      if (!transition) return
      if (args.durationSeconds != null) transition.duration = Number(args.durationSeconds)
      if (args.transitionType) transition.type = args.transitionType
      return
    }
    case 'add_transition':
      counter.n += 1
      timeline.transitions = [...(timeline.transitions || []), {
        id: `sim-transition-${counter.n}`,
        type: args.transitionType || args.type || 'dissolve',
        clipAId: args.clipAId ?? null,
        clipBId: args.clipBId ?? null,
        clipId: args.clipId ?? null,
        edge: args.edge ?? null,
        duration: Number(args.durationSeconds ?? 0.5),
      }]
      return
    case 'remove_transitions': {
      const gone = new Set(ids(args.transitionIds ?? args.transitionId))
      timeline.transitions = (timeline.transitions || []).filter((transition) => !gone.has(transition.id))
      return
    }
    case 'split_clip': {
      // The razor: the left piece keeps the id, its keyframes and effects;
      // the right one starts at the cut on the same source time.
      const time = toFrame(Number(args.timeSeconds), fps)
      for (const id of ids(args.clipIds ?? args.clipId)) {
        const clip = byId(id)
        if (!clip || time <= start(clip) + 0.5 / fps || time >= end(clip) - 0.5 / fps) continue
        const scale = (Number(clip.sourceTimeScale) || 1) * (Number(clip.speed) > 0 ? Number(clip.speed) : 1)
        const left = time - start(clip)
        const trimStart = (Number(clip.trimStart) || 0) + left * scale
        counter.n += 1
        const { keyframes, effects, ...rest } = clip
        timeline.clips.push({ ...clone(rest), id: `${clip.id}~${counter.n}`, startTime: time, duration: end(clip) - time, trimStart, trimEnd: trimStart + (end(clip) - time) * scale })
        clip.duration = left
        clip.trimEnd = trimStart
      }
      return
    }
    case 'add_glsl_effect': {
      const clip = byId(String(args.clipId))
      if (!clip) return
      counter.n += 1
      const kept = (clip.effects || []).filter((effect) => !(args.replaceExisting && effect.type === args.effectType))
      clip.effects = [...kept, { id: `sim-effect-${counter.n}`, type: args.effectType, enabled: args.enabled !== false, presetId: args.presetId ?? null, settings: { ...(args.settings || {}) } }]
      return
    }
    case 'set_clip_keyframes': {
      const clip = byId(String(args.clipId))
      if (!clip) return
      const keyframes = { ...(clip.keyframes || {}) }
      const replaced = new Set()
      for (const frame of args.keyframes || []) {
        if (args.replaceKeyframes && !replaced.has(frame.property)) {
          keyframes[frame.property] = []
          replaced.add(frame.property)
        }
        keyframes[frame.property] = [...(keyframes[frame.property] || []), { time: frame.timeSeconds, value: frame.value, easing: frame.easing }]
      }
      clip.keyframes = keyframes
      return
    }
    case 'update_caption_cues': {
      const clip = byId(String(args.clipId))
      if (clip?.captions && Array.isArray(args.cues)) clip.captions = { ...clip.captions, cues: clone(args.cues) }
      return
    }
    case 'set_timeline_marker_properties': {
      const targets = new Set(ids(args.markerIds))
      timeline.markers = (timeline.markers || []).map((marker) => {
        if (!targets.has(marker.id) && args.all !== true) return marker
        const moved = { ...marker }
        if (args.timeSeconds != null) moved.time = Number(args.timeSeconds)
        if (args.timeOffsetSeconds != null) moved.time = Math.max(0, moved.time + Number(args.timeOffsetSeconds))
        if (typeof args.label === 'string') moved.label = args.label
        return moved
      })
      return
    }
    case 'add_track':
      timeline.tracks = [...timeline.tracks, {
        id: predictedTrackId(timeline, args.type === 'audio' ? 'audio' : 'video'),
        name: args.name || 'Track',
        type: args.type === 'audio' ? 'audio' : 'video',
        muted: false,
        locked: false,
        visible: true,
      }]
      return
    case 'add_text_clip':
      counter.n += 1
      timeline.clips = [...timeline.clips, {
        id: `sim-text-${counter.n}`,
        type: 'text',
        name: String(args.text || 'Text').slice(0, 40),
        trackId: args.trackId,
        startTime: toFrame(Number(args.startSeconds) || 0, fps),
        duration: toFrame(Number(args.durationSeconds ?? 5), fps),
        textProperties: { text: args.text, ...(args.style || {}) },
        metadata: args.metadata ?? null,
      }]
      return
    case 'add_composition_clip':
      counter.n += 1
      timeline.clips = [...timeline.clips, {
        id: `sim-composition-${counter.n}`,
        type: 'composition',
        name: String(args.name || args.compositionId),
        trackId: args.trackId,
        startTime: toFrame(Number(args.startSeconds) || 0, fps),
        duration: toFrame(Number(args.durationSeconds ?? 4), fps),
        composition: { engine: args.engine, compositionId: args.compositionId, props: args.props ?? {} },
      }]
      return
    case 'add_sfx_clip':
      counter.n += 1
      timeline.clips = [...timeline.clips, {
        id: `sim-sfx-${counter.n}`,
        type: 'audio',
        name: String(args.sfx || 'SFX'),
        trackId: args.trackId,
        startTime: toFrame(Number(args.startSeconds) || 0, fps),
        duration: toFrame(POP_DURATION_SECONDS, fps),
        metadata: { semantic: { scene: null, shotId: null, role: 'sfx' } },
      }]
      return
    case 'add_asset_to_timeline': {
      const asset = assets.find((candidate) => candidate.id === args.assetId)
      counter.n += 1
      timeline.clips = [...timeline.clips, {
        id: `sim-clip-${counter.n}`,
        type: asset?.type || 'video',
        name: asset?.name || String(args.assetId),
        assetId: args.assetId,
        trackId: args.trackId,
        startTime: toFrame(Number(args.startSeconds) || 0, fps),
        duration: toFrame(Number(args.durationSeconds ?? asset?.duration ?? 5), fps),
        metadata: asset?.semantic ? { semantic: { scene: asset.semantic.scene ?? null, shotId: asset.semantic.shotId ?? null, role: asset.role ?? null } } : null,
      }]
      return
    }
    default:
      // add_dip_to_black and other look-only steps change no timing.
  }
}

// → { timeline, timelines: [after each step] }
export function simulatePlan(timeline, steps, { fps = timeline?.fps || 24, assets = [], keepEach = false } = {}) {
  const working = clone({ tracks: [], clips: [], transitions: [], markers: [], ...timeline })
  const counter = { n: 0 }
  const each = []
  for (const step of steps) {
    simulateStep(working, step, { fps, counter, assets })
    if (keepEach) each.push(clone(working))
  }
  return { timeline: working, timelines: each }
}
