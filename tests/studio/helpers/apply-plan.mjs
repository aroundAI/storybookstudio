// A test stand-in for the upstream editor's primitives: applies the steps studio_repair
// emits to a project document the way the renderer's tools would, so the
// render → QA → repair loop can run under `node --test` without a window.
// Only the arguments repair.js uses are implemented; anything else throws, so
// a new step shape cannot pass silently.
import { clone } from './review-media.mjs'
import { applyBusPatch } from '../../../src/studio/audio/buses.js'

const EPS = 1e-6
const end = (clip) => clip.startTime + clip.duration

function extractRange(timeline, { startSeconds: a, endSeconds: b, trackIds, ripple = true }) {
  const tracks = new Set(trackIds || timeline.tracks.filter((t) => !t.locked).map((t) => t.id))
  const width = b - a
  const out = []
  let counter = timeline.clipCounter || timeline.clips.length + 1
  for (const clip of timeline.clips) {
    if (!tracks.has(clip.trackId)) { out.push(clip); continue }
    const speed = clip.speed || 1
    const s = clip.startTime
    const e = end(clip)
    if (e <= a + EPS) { out.push(clip); continue }
    if (s >= b - EPS) { out.push(ripple ? { ...clip, startTime: s - width } : clip); continue }
    if (clip.type === 'captions') {
      // Live captions keep one clip; cues inside the range go, later cues shift.
      const offset = s - (clip.trimStart || 0)
      const cues = (clip.captions?.cues || []).flatMap((cue) => {
        const cs = offset + cue.start
        const ce = offset + cue.end
        if (ce <= a + EPS) return [cue]
        if (cs >= b - EPS) return [{ ...cue, start: cue.start - width, end: cue.end - width }]
        return []
      })
      out.push({ ...clip, duration: clip.duration - Math.max(0, Math.min(e, b) - Math.max(s, a)), captions: { ...clip.captions, cues } })
      continue
    }
    if (s < a - EPS) out.push({ ...clip, duration: a - s, trimEnd: (clip.trimStart || 0) + (a - s) * speed, fadeOut: 0 })
    if (e > b + EPS) {
      counter += 1
      out.push({ ...clip, id: `${clip.id}-r${counter}`, startTime: ripple ? a : b, duration: e - b, trimStart: (clip.trimStart || 0) + (b - s) * speed, fadeIn: 0 })
    }
  }
  return { ...timeline, clips: out, clipCounter: counter }
}

export function applyStep(project, step) {
  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === next.currentTimelineId) || next.timelines[0]
  const clipById = (id) => {
    const clip = timeline.clips.find((c) => c.id === id)
    if (!clip) throw new Error(`${step.tool}: no clip ${id}`)
    return clip
  }
  const args = step.arguments
  switch (step.tool) {
    case 'set_master_audio':
      if (args.volume !== undefined) timeline.masterAudioVolume = Math.max(0, Math.min(200, args.volume))
      if (args.inserts) timeline.masterAudioInserts = args.inserts
      break
    case 'set_clip_audio':
      for (const id of args.clipIds || [args.clipId]) {
        const clip = clipById(id)
        if (args.gainDb !== undefined) clip.gainDb = args.gainDb
        if (args.fadeInSeconds !== undefined) clip.fadeIn = Math.min(args.fadeInSeconds, clip.duration)
        if (args.fadeOutSeconds !== undefined) clip.fadeOut = Math.min(args.fadeOutSeconds, clip.duration)
      }
      break
    case 'set_clip_style': {
      const clip = clipById(args.clipId)
      clip.transform = { ...(clip.transform || {}), ...(args.transform || {}) }
      break
    }
    case 'set_audio_buses':
      next.studio.audioBuses = applyBusPatch(next.studio.audioBuses, args.buses)
      break
    case 'update_caption_cues': {
      const clip = clipById(args.clipId)
      if (args.cues) clip.captions.cues = args.cues.map((cue, i) => ({ id: cue.id ?? `cue-${i}`, ...cue }))
      if (args.preset) clip.captions.preset = { ...clip.captions.preset, ...args.preset }
      for (const edit of args.edits || []) {
        const cue = clip.captions.cues.find((c) => c.id === edit.id)
        if (edit.startSeconds !== undefined) cue.start = edit.startSeconds
        if (edit.endSeconds !== undefined) cue.end = edit.endSeconds
        if (edit.text !== undefined) cue.text = edit.text
      }
      break
    }
    case 'replace_clip_with_asset': {
      const clip = clipById(args.clipId)
      const asset = next.assets.find((a) => a.id === args.assetId)
      if (!asset) throw new Error(`replace_clip_with_asset: no asset ${args.assetId}`)
      clip.assetId = asset.id
      if (asset.type === 'image') { clip.type = 'image'; clip.trimStart = 0 }
      break
    }
    case 'extract_range': {
      const index = next.timelines.indexOf(timeline)
      next.timelines[index] = extractRange(timeline, args)
      break
    }
    default:
      throw new Error(`apply-plan helper does not implement ${step.tool}`)
  }
  return next
}

export const applyPlan = (project, plan) => plan.steps.reduce((doc, step) => applyStep(doc, step), project)

// The inverse of a ripple extract: opens `seconds` of nothing at `at` on
// every track (clips across `at` are split), planting silence and black.
export function insertGap(project, at, seconds) {
  const next = clone(project)
  const timeline = next.timelines.find((t) => t.id === next.currentTimelineId) || next.timelines[0]
  const out = []
  let counter = timeline.clipCounter || timeline.clips.length + 1
  for (const clip of timeline.clips) {
    const s = clip.startTime
    const e = s + clip.duration
    if (clip.type === 'captions') {
      const offset = s - (clip.trimStart || 0)
      clip.captions.cues = clip.captions.cues.map((cue) => (offset + cue.start >= at ? { ...cue, start: cue.start + seconds, end: cue.end + seconds } : cue))
      out.push({ ...clip, duration: clip.duration + seconds })
    } else if (e <= at + 1e-6) out.push(clip)
    else if (s >= at - 1e-6) out.push({ ...clip, startTime: s + seconds })
    else {
      const speed = clip.speed || 1
      counter += 1
      out.push({ ...clip, duration: at - s, trimEnd: (clip.trimStart || 0) + (at - s) * speed })
      out.push({ ...clip, id: `${clip.id}-g${counter}`, startTime: at + seconds, duration: e - at, trimStart: (clip.trimStart || 0) + (at - s) * speed })
    }
  }
  timeline.clips = out
  timeline.clipCounter = counter
  return next
}
