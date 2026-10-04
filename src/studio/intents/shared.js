// Shared by the intent compilers (FILM-2013): timeline reads, the silence-cut
// engine and the steps that keep captions and scene markers in sync after a
// ripple cut. Pure module: no Electron, no stores. Every number a compiler
// uses as a bound comes from the policy or the caller's params; the defaults
// below apply only to params the caller left out and are named in reasons.
import { simulatePlan } from '../simulate.js'

export const EPS = 1e-6
export const DEFAULT_MIN_SILENCE_SECONDS = 0.6
export const DEFAULT_KEEP_PAUSE_SECONDS = 0.25
export const MAX_PLAN_STEPS = 50
export const BED_ROLES = new Set(['music', 'ambience', 'sfx'])

export const round3 = (value) => Math.round(value * 1000) / 1000
export const toFrame = (seconds, fps) => Math.round(seconds * fps) / fps
export const clipStart = (clip) => Number(clip?.startTime) || 0
export const clipEnd = (clip) => clipStart(clip) + (Number(clip?.duration) || 0)
export const sceneOfClip = (clip) => {
  const scene = clip?.metadata?.semantic?.scene
  return Number.isInteger(scene) && scene >= 1 ? scene : null
}
export const roleOfClip = (clip) => clip?.metadata?.semantic?.role ?? null
export const seconds = (value) => `${Number(value).toFixed(1)} s`
export const timecode = (value) => {
  const minutes = Math.floor(value / 60)
  return `${minutes}:${(value - minutes * 60).toFixed(1).padStart(4, '0')}`
}

export const trackMap = (timeline) => new Map((timeline?.tracks || []).map((track) => [track.id, track]))
export const isCaptionTrack = (track) => track?.role === 'captions'
export const isPictureClip = (clip, track) => track?.type === 'video' && !isCaptionTrack(track) && (clip.type === 'video' || clip.type === 'image')
export const isVoicedDialogueClip = (clip, track) => track?.type === 'audio' && !track.muted && clip.enabled !== false
  && (track.bus === 'dialogue' || roleOfClip(clip) === 'dialogue')

export function pictureClips(timeline) {
  const tracks = trackMap(timeline)
  return (timeline?.clips || []).filter((clip) => isPictureClip(clip, tracks.get(clip.trackId)))
}

export function dialogueClips(timeline) {
  const tracks = trackMap(timeline)
  return (timeline?.clips || []).filter((clip) => isVoicedDialogueClip(clip, tracks.get(clip.trackId)))
    .sort((a, b) => clipStart(a) - clipStart(b))
}

export const pictureEnd = (timeline) => round3(pictureClips(timeline).reduce((max, clip) => Math.max(max, clipEnd(clip)), 0))

export function sceneSpan(timeline, scene) {
  const clips = pictureClips(timeline).filter((clip) => sceneOfClip(clip) === scene)
  if (clips.length === 0) return null
  return { start: Math.min(...clips.map(clipStart)), end: Math.max(...clips.map(clipEnd)), clips: clips.sort((a, b) => clipStart(a) - clipStart(b)) }
}

export const sceneDuration = (timeline, scene) => {
  const span = sceneSpan(timeline, scene)
  return span ? round3(span.end - span.start) : 0
}

// "S3.2" from the builder's clip names, else the clip name.
export const shotLabel = (clip) => /^S\d+\.\d+/.exec(String(clip?.name || ''))?.[0] || clip?.name || clip?.id || 'clip'
export const lineLabel = (clip) => {
  const number = clip?.metadata?.storybook?.sequenceNumber
  return Number.isInteger(number) ? `line ${number}` : (clip?.name || clip?.id || 'a line')
}

// Music and ambience beds are not cut at every pause (a cut mid-phrase is
// audible); they are shortened at their end by what the cuts removed.
export const BED_BUSES = new Set(['music', 'ambience'])
export const isBedTrack = (track) => track?.type === 'audio' && BED_BUSES.has(track.bus)

// Tracks a ripple cut runs over: every unlocked track but captions (its one
// live clip has no source to split; its cues are re-timed instead) and beds.
export const cutTrackIds = (timeline) => (timeline?.tracks || [])
  .filter((track) => !track.locked && !isCaptionTrack(track) && !isBedTrack(track)).map((track) => track.id)

export function mergeIntervals(intervals) {
  const sorted = intervals.filter(([a, b]) => b - a > EPS).sort((x, y) => x[0] - y[0])
  const merged = []
  for (const [a, b] of sorted) {
    const last = merged.at(-1)
    if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  return merged
}

export function subtractIntervals([start, end], remove) {
  const out = []
  let cursor = start
  for (const [a, b] of mergeIntervals(remove)) {
    if (b <= cursor + EPS) continue
    if (a >= end - EPS) break
    if (a > cursor + EPS) out.push([cursor, Math.min(a, end)])
    cursor = Math.max(cursor, b)
  }
  if (end - cursor > EPS) out.push([cursor, end])
  return out
}

// Voiced spans: dialogue clips minus the silences get_audio_analysis found
// inside them (silencesTimeline, absolute timeline seconds).
export function voicedIntervals(timeline, analysis = new Map()) {
  const voiced = []
  for (const clip of dialogueClips(timeline)) {
    const silences = (analysis.get(clip.id)?.clip?.silencesTimeline || []).map((span) => [span.start, span.end])
    voiced.push(...subtractIntervals([clipStart(clip), clipEnd(clip)], silences))
  }
  return mergeIntervals(voiced)
}

// Every clip a ripple cut over [start, end] cuts into (not the ones it only shifts).
export function clipsCutBy(timeline, start, end, trackIds) {
  const tracks = new Set(trackIds)
  return (timeline?.clips || []).filter((clip) => tracks.has(clip.trackId) && clipEnd(clip) > start + EPS && clipStart(clip) < end - EPS)
}

// Maps a time before the cuts to the time after them (cuts do not overlap).
export function mapThroughCuts(time, cuts) {
  let removed = 0
  for (const cut of cuts) {
    if (cut.end <= time + EPS) removed += cut.end - cut.start
    else if (cut.start < time) removed += time - cut.start
  }
  return time - removed
}

// One update_caption_cues per captions clip whose cues move, and one marker
// move per scene marker after a cut, so a ripple cut keeps both in sync.
export function retimeSteps(timeline, mapTime, { reason, fps }) {
  const steps = []
  const tracks = trackMap(timeline)
  for (const clip of timeline?.clips || []) {
    if (!isCaptionTrack(tracks.get(clip.trackId)) || !Array.isArray(clip.captions?.cues)) continue
    const offset = clipStart(clip)
    let changed = false
    const cues = []
    for (const cue of clip.captions.cues) {
      const start = round3(mapTime(offset + cue.start) - offset)
      const end = round3(mapTime(offset + cue.end) - offset)
      if (start !== round3(cue.start) || end !== round3(cue.end)) changed = true
      if (end - start < 1 / fps) {
        changed = true
        continue
      }
      cues.push({ ...cue, start, end })
    }
    if (changed) {
      steps.push({
        step: { tool: 'update_caption_cues', arguments: { clipId: clip.id, target: 'clip', cues } },
        reason,
        scene: null,
        text: `Re-timed ${clip.name || 'captions'} (${cues.length} cues) to the cut`,
      })
    }
    const length = round3(toFrame(mapTime(clipEnd(clip)) - mapTime(clipStart(clip)), fps))
    if (Math.abs(length - clip.duration) > EPS && length >= 1 / fps) {
      steps.push({
        step: { tool: 'trim_clips', arguments: { clips: [{ clipId: clip.id, durationSeconds: length }] } },
        reason: 'The captions clip ends where the picture now ends',
        scene: null,
        text: `${clip.name || 'Captions'} ${seconds(clip.duration)} -> ${seconds(length)}`,
      })
    }
  }
  for (const clip of timeline?.clips || []) {
    if (!isBedTrack(tracks.get(clip.trackId))) continue
    const start = round3(toFrame(mapTime(clipStart(clip)), fps))
    const length = round3(toFrame(mapTime(clipEnd(clip)), fps) - start)
    const moved = Math.abs(start - clipStart(clip)) > EPS
    const shortened = Math.abs(length - clip.duration) > EPS
    if ((!moved && !shortened) || length < 1 / fps) continue
    steps.push({
      step: { tool: 'trim_clips', arguments: { clips: [{ clipId: clip.id, ...(moved ? { startSeconds: start } : {}), durationSeconds: length }] } },
      reason: `${clip.name || 'The bed'} keeps playing through the cuts and ${moved ? 'follows its picture' : 'ends with the picture'}, rather than being cut mid-phrase`,
      scene: null,
      text: `${clip.name || clip.id} ${moved ? `moved to ${timecode(start)}, ` : ''}${seconds(clip.duration)} -> ${seconds(length)}`,
    })
  }
  for (const marker of timeline?.markers || []) {
    const next = round3(toFrame(mapTime(marker.time), fps))
    if (Math.abs(next - marker.time) < EPS) continue
    steps.push({
      step: { tool: 'set_timeline_marker_properties', arguments: { markerIds: [marker.id], timeSeconds: next } },
      reason: `Keeps the marker "${marker.label || marker.name || marker.id}" on its scene`,
      scene: Number.isInteger(marker.scene) ? marker.scene : null,
      text: `Moved marker "${marker.label || marker.name || marker.id}" ${timecode(marker.time)} -> ${timecode(next)}`,
    })
  }
  return steps
}

// The silence-cut engine behind tighten_pacing, remove_dead_air,
// hit_duration and recut_around_drops. Spans are the parts of each scene
// where no dialogue is voiced, at least `minSilence` long. Cuts are ripple
// extracts in the timeline's own coordinates; the steps are emitted latest
// first so each one's times are still valid when it runs.
//   stage 1: silences at a shot boundary or a scene edge, cut to `keepPause`
//   stage 2: silences inside a shot (a jump cut), cut to `keepPause`
//   stage 3: with a budget still left, the kept pauses too
// No picture clip ends shorter than policy.minShotLength; a span over a clip
// the user edited since the last plan is skipped unless includeUserEdits.
export function planSilenceCuts(context, {
  scenes,
  range = null,
  minSilence = DEFAULT_MIN_SILENCE_SECONDS,
  keepPause = DEFAULT_KEEP_PAUSE_SECONDS,
  budget = Infinity,
  allowJumpCuts = true,
  includeUserEdits = false,
  exclude = [],
  why = null,
}) {
  const { timeline, policy, fps } = context
  const userEdited = new Set(context.userEditedClipIds || [])
  const trackIds = cutTrackIds(timeline)
  const voiced = voicedIntervals(timeline, context.reads?.audioAnalysis)
  const dialogue = dialogueClips(timeline)
  const pictures = pictureClips(timeline)
  const notes = []
  const spans = []

  for (const scene of scenes) {
    const span = sceneSpan(timeline, scene)
    if (!span) continue
    const window = range ? [Math.max(span.start, range[0]), Math.min(span.end, range[1])] : [span.start, span.end]
    if (window[1] - window[0] <= EPS) continue
    const boundaries = span.clips.map(clipStart).filter((time) => time > span.start + EPS && time < span.end - EPS)
    for (const [start, end] of subtractIntervals(window, [...voiced, ...exclude])) {
      const length = end - start
      if (length < minSilence - EPS) continue
      const atBoundary = boundaries.some((time) => time >= start - EPS && time <= end + EPS)
      const atEdge = Math.abs(start - span.start) < EPS || Math.abs(end - span.end) < EPS
      const before = dialogue.filter((clip) => clipEnd(clip) <= start + EPS).at(-1) || null
      const after = dialogue.find((clip) => clipStart(clip) >= end - EPS) || null
      const shots = pictures.filter((clip) => clipEnd(clip) > start + EPS && clipStart(clip) < end - EPS)
      spans.push({ scene, start, end, length, kind: atBoundary ? 'boundary' : atEdge ? 'edge' : 'inside', before, after, shots, amount: 0 })
    }
  }

  const cutInterval = (span, amount) => {
    if (amount >= span.length - EPS) return [toFrame(span.start, fps), toFrame(span.end, fps)]
    const start = toFrame(span.start + (span.length - amount) / 2, fps)
    return [start, toFrame(start + amount, fps)]
  }
  // Every piece a shot is left in (a jump cut splits it) stays at least
  // policy.minShotLength long.
  const overlapOf = (clip, [a, b]) => Math.max(0, Math.min(clipEnd(clip), b) - Math.max(clipStart(clip), a))
  const fits = (span, amount) => {
    const intervals = spans.filter((other) => other !== span && other.amount > 0).map((other) => cutInterval(other, other.amount))
    intervals.push(cutInterval(span, amount))
    return span.shots.every((clip) => {
      const pieces = subtractIntervals([clipStart(clip), clipEnd(clip)], intervals.filter((interval) => overlapOf(clip, interval) > 0))
      return pieces.length > 0 && pieces.every(([a, b]) => b - a >= policy.minShotLength - EPS)
    })
  }
  const commit = (span, amount) => {
    span.amount = amount
  }

  let remaining = budget
  const frame = 1 / fps
  const grow = (span, upTo) => {
    if (remaining <= EPS) return
    let amount = Math.min(upTo, span.amount + remaining)
    amount = Math.floor(amount * fps + EPS) / fps
    while (amount > span.amount + EPS && !fits(span, amount)) amount = round3(amount - frame)
    if (amount <= span.amount + EPS) {
      if (span.amount === 0) span.blocked = 'shot'
      return
    }
    const touched = clipsCutBy(context.timeline, ...cutInterval(span, amount), trackIds).filter((clip) => userEdited.has(clip.id))
    if (touched.length > 0 && !includeUserEdits) {
      span.blocked = 'user'
      span.blockedBy = touched
      return
    }
    span.touches = touched
    remaining -= amount - span.amount
    commit(span, amount)
  }

  const byLength = (list) => [...list].sort((a, b) => b.length - a.length || a.start - b.start)
  const keepTo = (span) => Math.max(0, span.length - keepPause)
  for (const span of byLength(spans.filter((candidate) => candidate.kind !== 'inside'))) grow(span, keepTo(span))
  if (allowJumpCuts) for (const span of byLength(spans.filter((candidate) => candidate.kind === 'inside'))) grow(span, keepTo(span))
  if (Number.isFinite(budget)) {
    for (const span of byLength(spans.filter((candidate) => allowJumpCuts || candidate.kind !== 'inside'))) grow(span, span.length)
  }

  for (const span of spans) {
    if (span.blocked === 'user' && span.amount === 0) {
      notes.push({ scene: span.scene, text: `Left ${seconds(span.length)} of silence at ${timecode(span.start)}: cutting it would change ${span.blockedBy.map(shotLabel).join(', ')}, which you edited by hand since the last plan` })
    } else if (span.blocked === 'shot' && span.amount === 0) {
      notes.push({ scene: span.scene, text: `Left ${seconds(span.length)} of silence at ${timecode(span.start)}: cutting it would leave a shot under the policy minimum of ${policy.minShotLength} s` })
    }
  }

  const where = (span) => {
    if (span.kind === 'inside') return `inside ${shotLabel(span.shots[0])}, a jump cut`
    if (span.kind === 'boundary') return span.shots.map(shotLabel).join(' / ')
    return `${Math.abs(span.end - (sceneSpan(timeline, span.scene)?.end ?? -1)) < EPS ? 'end' : 'start'} of scene ${span.scene}`
  }
  const between = (span) => (span.before && span.after ? `between ${lineLabel(span.before)} and ${lineLabel(span.after)}`
    : span.before ? `after ${lineLabel(span.before)}` : span.after ? `before ${lineLabel(span.after)}` : 'with no dialogue')

  const cuts = spans.filter((span) => span.amount > EPS).map((span) => {
    const [start, end] = cutInterval(span, span.amount)
    const kept = round3(span.length - (end - start))
    return {
      scene: span.scene,
      start,
      end,
      kind: span.kind,
      touches: (span.touches || []).map((clip) => clip.id),
      text: `Cut ${seconds(end - start)} of silence at ${timecode(start)} (${where(span)})`,
      reason: `Dead air of ${seconds(span.length)} ${between(span)}; pauses over ${minSilence} s are cut${kept > EPS ? `, ${seconds(kept)} kept` : ''}${why ? `; ${why}` : ''}`,
    }
  })
  return { cuts, notes, removed: round3(cuts.reduce((sum, cut) => sum + (cut.end - cut.start), 0)), trackIds }
}

// Cuts (in original coordinates) to ripple extract steps, latest first, then
// the caption and marker re-time steps.
export function cutSteps(context, cuts, { trackIds, retimeReason = 'Keeps captions on the dialogue after the cut' } = {}) {
  const ordered = [...cuts].sort((a, b) => b.start - a.start)
  const entries = ordered.map((cut) => ({
    step: { tool: 'extract_range', arguments: { startSeconds: cut.start, endSeconds: cut.end, trackIds: trackIds ?? cutTrackIds(context.timeline), ripple: true } },
    reason: cut.reason,
    scene: cut.scene,
    text: cut.text,
    touches: cut.touches || [],
  }))
  if (entries.length === 0) return entries
  const sortedCuts = [...cuts].sort((a, b) => a.start - b.start)
  return [...entries, ...retimeSteps(context.timeline, (time) => mapThroughCuts(time, sortedCuts), { reason: retimeReason, fps: context.fps })]
}

// A compiler's draft → the plan shape every caller sees (contract A1):
// steps, reasons, scenes and change texts aligned by index, and `expected`
// from simulating the steps on the current timeline.
export function finishPlan(context, { intent, entries = [], notes = [], hookType = undefined }) {
  let list = entries
  const extraNotes = []
  if (list.length > MAX_PLAN_STEPS) {
    extraNotes.push({ scene: null, text: `The plan was cut to the first ${MAX_PLAN_STEPS} steps (run_mcp_action_plan's limit); run the intent again for the rest` })
    list = list.slice(0, MAX_PLAN_STEPS)
  }
  const plan = {
    intent,
    steps: list.map((entry) => entry.step),
    reasons: list.map((entry) => entry.reason),
    scenes: list.map((entry) => (Number.isInteger(entry.scene) ? entry.scene : null)),
    changes: list.map((entry) => entry.text),
    touchesUserEdits: [...new Set(list.flatMap((entry) => entry.touches || []))].sort(),
    notes: [...notes, ...extraNotes],
  }
  if (hookType !== undefined) plan.hookType = hookType
  const after = simulatePlan(context.timeline, plan.steps, { fps: context.fps }).timeline
  const sceneNumbers = (context.sceneMap || []).map((entry) => entry.scene)
  plan.expected = {
    durationBefore: pictureEnd(context.timeline),
    durationAfter: pictureEnd(after),
    perScene: sceneNumbers.map((scene) => ({ scene, before: sceneDuration(context.timeline, scene), after: sceneDuration(after, scene) })),
  }
  return plan
}

export const sceneNote = (scene, text) => ({ scene, text })
