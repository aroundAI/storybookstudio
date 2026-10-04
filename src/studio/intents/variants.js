// FILM-2017: variant timelines (contract §5, variant short and variant hook).
// A variant is a copy of the master timeline the agent cut down for another
// platform: `timeline.studio = {kind: 'variant', variantOf, aspect}`. Pure
// module: it builds the timeline as data; electron/studio/deliver.js detects
// subjects, adds the reframe through set_clip_keyframes and inserts it.
//
// - short: the master trimmed to a range (a StoryBook shorts candidate, the
//   strongest sound bite, or a range the caller gives), at 9:16, with the
//   captions re-placed for the vertical safe area and the expected duration
//   checked against the preset's maxDuration.
// - hook: N alternative first-five-second openings, one per strong sound
//   bite (the dialogue's text and emotion from FILM-2012's asset semantics;
//   when no line carries them, the loudest dialogue), each its own timeline
//   and its own exported file, for StoryBook's hook tests.
import { presetFor, resolvePreset, VERTICAL_PRESET_NAMES } from '../delivery/presets.js'

export const HOOK_SECONDS = 5
export const MAX_HOOK_VARIANTS = 5
// A short built from a hook keeps going to this length (or the preset's
// maxDuration, if shorter), ending on a cut.
export const HOOK_SHORT_TARGET_SECONDS = 45
// FILM-2016's 9:16 safe rectangle (src/studio/captions/layout.js SAFE_AREAS):
// clear of the bottom 25% and the right 15%. Used until FILM-2016's
// styleCaptionCues is passed in as `styleCues`.
export const VERTICAL_CAPTION_SAFE_AREA = Object.freeze({ left: 0.05, right: 0.15, top: 0.08, bottom: 0.25 })

const EPS = 1e-6
const PICTURE_TYPES = new Set(['video', 'image'])
const round = (value) => Math.round(value * 1000) / 1000
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
const clipStart = (clip) => num(clip.startTime)
const clipEnd = (clip) => clipStart(clip) + num(clip.duration)
const clone = (value) => JSON.parse(JSON.stringify(value))
const invalid = (message) => Object.assign(new Error(message), { code: 'VALIDATION_FAILED' })

export function masterTimeline(project, timelineId = null) {
  const timelines = project?.timelines || []
  const wanted = timelineId
    ? timelines.find((timeline) => timeline.id === timelineId)
    : timelines.find((timeline) => timeline.studio?.kind === 'master') || timelines.find((timeline) => timeline.id === project?.currentTimelineId) || timelines[0]
  if (!wanted) throw invalid(timelineId ? `Timeline ${timelineId} was not found.` : 'The project has no timeline.')
  return wanted
}

export const timelineEnd = (timeline) => Math.max(0, ...(timeline?.clips || []).map(clipEnd))

// Same weights as FILM-2013's lineImportance (intents/common.js): emotion, a
// question or exclamation, brevity. Kept identical so the hook a variant
// opens on is the one open_with_strongest_line would pick.
const EMOTION_WEIGHT = { urgent: 0.3, angry: 0.3, afraid: 0.3, excited: 0.3, shocked: 0.3, determined: 0.2, sad: 0.2, tense: 0.2, hopeful: 0.15 }
export function lineImportance({ text = '', emotion = '' } = {}) {
  const words = String(text).split(/\s+/).filter(Boolean).length
  const score = (EMOTION_WEIGHT[String(emotion).toLowerCase()] ?? 0) + (text.includes('?') ? 0.25 : 0) + (text.includes('!') ? 0.2 : 0) + (words > 0 && words <= 12 ? 0.1 : 0)
  return round(score)
}

const isDialogue = (clip, tracks, assets) => {
  if (clip.type !== 'audio' || clip.enabled === false) return false
  const role = clip.metadata?.semantic?.role || assets.get(clip.assetId)?.role
  return role === 'dialogue' || /dialogue/i.test(tracks.get(clip.trackId)?.name || '')
}

// Every dialogue line on the timeline, scored. `source` says which signal
// ranked it: 'analysis' (text and emotion) or 'energy' (loudness, when no
// line in the timeline carries text).
export function soundBites(project, { timelineId = null, language = null, energyOf = null } = {}) {
  const timeline = masterTimeline(project, timelineId)
  const tracks = new Map((timeline.tracks || []).map((track) => [track.id, track]))
  const assets = new Map((project.assets || []).map((asset) => [asset.id, asset]))
  const lines = (timeline.clips || [])
    .filter((clip) => isDialogue(clip, tracks, assets))
    .filter((clip) => !language || !(clip.metadata?.language || tracks.get(clip.trackId)?.language) || (clip.metadata?.language || tracks.get(clip.trackId)?.language) === language)
    .map((clip) => {
      const asset = assets.get(clip.assetId) || {}
      return {
        clipId: clip.id,
        start: round(clipStart(clip)),
        end: round(clipEnd(clip)),
        scene: clip.metadata?.semantic?.scene ?? asset.semantic?.scene ?? null,
        text: asset.semantic?.text ?? null,
        emotion: asset.semantic?.emotion ?? null,
        loudnessLufs: num(energyOf ? energyOf(clip, asset) : asset.analysis?.loudnessLufs, NaN),
      }
    })
  const analysed = lines.some((line) => line.text)
  const energetic = lines.some((line) => Number.isFinite(line.loudnessLufs))
  if (!analysed && !energetic) return { source: null, bites: [] }
  const source = analysed ? 'analysis' : 'energy'
  const bites = lines
    .filter((line) => (source === 'analysis' ? line.text : Number.isFinite(line.loudnessLufs)))
    .map((line) => ({ ...line, importance: source === 'analysis' ? lineImportance(line) : round(line.loudnessLufs) }))
    // Highest first; ties to the earlier line, so the pick is stable.
    .sort((a, b) => b.importance - a.importance || a.start - b.start)
  return { source, bites }
}

const pictureClipsOf = (timeline) => (timeline.clips || []).filter((clip) => PICTURE_TYPES.has(clip.type) && clip.enabled !== false).sort((a, b) => clipStart(a) - clipStart(b))

// The shot under time t, and the range grown to whole shots.
function shotRangeAround(timeline, start, end) {
  const shots = pictureClipsOf(timeline)
  let from = start
  let to = end
  for (const shot of shots) {
    if (clipStart(shot) <= from + EPS && clipEnd(shot) > from + EPS) from = clipStart(shot)
    if (clipStart(shot) < to - EPS && clipEnd(shot) >= to - EPS) to = clipEnd(shot)
  }
  return [round(from), round(to)]
}

// Extend [start, end] by whole shots until it reaches `target` seconds (or
// the next cut would pass `limit`).
function extendToShots(timeline, start, end, target, limit) {
  let to = end
  for (const shot of pictureClipsOf(timeline)) {
    if (clipStart(shot) < to - EPS) continue
    if (to - start >= target - EPS) break
    if (clipEnd(shot) - start > limit + EPS) break
    to = clipEnd(shot)
  }
  return round(to)
}

// Where a short comes from: {candidateId}, {hook: true}, {range: [s, e]}.
export function resolveShortRange(project, { source = {}, timelineId = null, shortsCandidates = [], presetName = 'shorts_9x16', language = null, energyOf = null } = {}) {
  const timeline = masterTimeline(project, timelineId)
  const end = timelineEnd(timeline)
  const limit = presetFor(presetName).maxDuration ?? Infinity
  if (Array.isArray(source.range)) {
    const [s, e] = source.range.map(Number)
    if (!(Number.isFinite(s) && Number.isFinite(e) && e > s && s >= 0)) throw invalid('range is [start, end] in seconds, end after start.')
    if (s >= end - EPS) throw invalid(`range starts after the timeline ends (${round(end)} s).`)
    return { start: round(s), end: round(Math.min(e, end)), from: { kind: 'range' } }
  }
  if (source.candidateId) {
    const candidate = shortsCandidates.find((entry) => entry.id === source.candidateId)
    if (!candidate) throw invalid(`Shorts candidate ${source.candidateId} is not in the episode's package.`)
    // StoryBook gives the candidate in episode seconds; where its source shot
    // is on the timeline, follow the shot (the edit may have moved it).
    const shotClip = (timeline.clips || []).find((clip) => PICTURE_TYPES.has(clip.type) && candidate.sourceShotId && (clip.metadata?.storybook?.shotId === candidate.sourceShotId || clip.metadata?.semantic?.shotId === candidate.sourceShotId))
    const shift = shotClip && Number.isFinite(Number(shotClip.metadata?.storybook?.timelineStartSeconds)) ? clipStart(shotClip) - Number(shotClip.metadata.storybook.timelineStartSeconds) : 0
    const s = Math.max(0, num(candidate.startSeconds) + shift)
    const e = Math.min(end, num(candidate.endSeconds) + shift)
    if (!(e > s)) throw invalid(`Shorts candidate ${candidate.id} is not on the timeline any more.`)
    return { start: round(s), end: round(e), from: { kind: 'candidate', candidateId: candidate.id, title: candidate.title ?? null, hookType: candidate.hookType ?? null } }
  }
  if (source.hook) {
    const { source: signal, bites } = soundBites(project, { timelineId: timeline.id, language, energyOf })
    if (!bites.length) throw invalid('No dialogue line on the timeline to build a hook from.')
    const bite = bites[0]
    const [s, e] = shotRangeAround(timeline, bite.start, bite.end)
    const to = extendToShots(timeline, s, e, Math.min(HOOK_SHORT_TARGET_SECONDS, limit), limit)
    return { start: s, end: to, from: { kind: 'hook', clipId: bite.clipId, text: bite.text, importance: bite.importance, signal } }
  }
  throw invalid('source is {candidateId}, {hook: true} or {range: [start, end]}.')
}

// Cut a timeline down to [start, end) and move that range to 0.
export function trimTimelineToRange(timeline, start, end) {
  const out = clone(timeline)
  const kept = []
  for (const clip of out.clips || []) {
    const s = clipStart(clip)
    const e = clipEnd(clip)
    if (e <= start + EPS || s >= end - EPS) continue
    const newStart = Math.max(s, start)
    const newEnd = Math.min(e, end)
    const cutHead = newStart - s
    const speed = num(clip.speed, 1) || 1
    clip.startTime = round(newStart - start)
    clip.duration = round(newEnd - newStart)
    if (cutHead > EPS && clip.trimStart != null) clip.trimStart = round(num(clip.trimStart) + cutHead * speed)
    if (clip.trimEnd != null && clip.trimStart != null) clip.trimEnd = round(num(clip.trimStart) + clip.duration * speed)
    if (clip.captions?.cues) {
      // Captions cues are clip-relative.
      clip.captions.cues = clip.captions.cues
        .map((cue) => ({ ...cue, start: round(num(cue.start) - cutHead), end: round(num(cue.end) - cutHead) }))
        .filter((cue) => cue.end > EPS && cue.start < clip.duration - EPS)
        .map((cue) => ({ ...cue, start: Math.max(0, cue.start), end: Math.min(clip.duration, cue.end) }))
    }
    if (clip.keyframes && cutHead > EPS) {
      clip.keyframes = Object.fromEntries(Object.entries(clip.keyframes).map(([property, frames]) => [
        property,
        (frames || []).map((frame) => ({ ...frame, time: round(num(frame.time) - cutHead) })).filter((frame) => frame.time >= -EPS && frame.time <= clip.duration + EPS),
      ]))
    }
    kept.push(clip)
  }
  const keptIds = new Set(kept.map((clip) => clip.id))
  out.clips = kept
  out.transitions = (out.transitions || [])
    .filter((transition) => [transition.clipAId, transition.clipBId, transition.clipId].filter(Boolean).every((id) => keptIds.has(id)))
    .map((transition) => (transition.startTime != null ? { ...transition, startTime: round(num(transition.startTime) - start) } : transition))
  out.markers = (out.markers || []).filter((marker) => num(marker.time) >= start - EPS && num(marker.time) < end).map((marker) => ({ ...marker, time: round(num(marker.time) - start) }))
  out.duration = round(end - start)
  return out
}

// Re-place every captions clip's cues for the aspect. `styleCues` is
// FILM-2016's styleCaptionCues({cues, brand, policy, aspect}) → {cues};
// without it each cue gets the 9:16 safe area from FILM-2016's layout.
export function placeCaptionsForAspect(timeline, aspect, { styleCues = null, brand = {}, policy = {} } = {}) {
  let placed = 0
  for (const clip of timeline.clips || []) {
    if (!['captions', 'caption'].includes(clip.type) || !clip.captions?.cues) continue
    if (styleCues) {
      clip.captions.cues = styleCues({ cues: clip.captions.cues, brand, policy, aspect }).cues
    } else {
      clip.captions.cues = clip.captions.cues.map((cue) => ({ ...cue, globalOverrides: { ...(cue.globalOverrides || {}), aspect, safeArea: { ...VERTICAL_CAPTION_SAFE_AREA } } }))
    }
    placed += clip.captions.cues.length
  }
  return placed
}

const nextVariantId = (project, prefix) => {
  const ids = new Set((project.timelines || []).map((timeline) => timeline.id))
  let n = 1
  while (ids.has(`${prefix}-${n}`)) n += 1
  return `${prefix}-${n}`
}

// studio_create_variant {kind: 'short'}. Returns the timeline (no reframe
// yet: deliver.js adds it per picture clip) and what the tool reports.
export function buildShortVariant(project, { source, timelineId = null, presetName = 'shorts_9x16', shortsCandidates = [], language = null, styleCues = null, brand = {}, policy = {}, energyOf = null, now = () => new Date() } = {}) {
  if (!VERTICAL_PRESET_NAMES.includes(presetName)) throw invalid(`A short renders for a 9:16 preset: ${VERTICAL_PRESET_NAMES.join(', ')}.`)
  const master = masterTimeline(project, timelineId)
  const preset = resolvePreset(presetName, { timeline: master, policy })
  const range = resolveShortRange(project, { source, timelineId: master.id, shortsCandidates, presetName, language, energyOf })
  const timeline = trimTimelineToRange(master, range.start, range.end)
  const id = nextVariantId(project, 'timeline-short')
  const stamp = now().toISOString()
  Object.assign(timeline, {
    id,
    name: `${master.name || 'Timeline'} · Short ${range.from.kind === 'candidate' && range.from.title ? `“${range.from.title}”` : `${Math.round(range.start)}-${Math.round(range.end)} s`}`,
    width: preset.width,
    height: preset.height,
    created: stamp,
    modified: stamp,
  })
  const captionsPlaced = placeCaptionsForAspect(timeline, preset.aspect, { styleCues, brand, policy })
  const expectedDuration = round(range.end - range.start)
  const overMaxDuration = preset.maxDuration != null && expectedDuration > preset.maxDuration + EPS
  timeline.studio = {
    ...(master.studio || {}),
    kind: 'variant',
    variantKind: 'short',
    variantOf: master.id,
    aspect: preset.aspect,
    preset: preset.name,
    language: language ?? master.studio?.language ?? null,
    range: [range.start, range.end],
    source: range.from,
    reframeWarnings: [],
  }
  return {
    timeline,
    expectedDuration,
    maxDuration: preset.maxDuration,
    overMaxDuration,
    durationNote: overMaxDuration
      ? `${expectedDuration} s is over ${preset.name}'s ${preset.maxDuration} s limit; trim it before delivering.`
      : preset.maxDuration != null
        ? `${expectedDuration} s, within ${preset.name}'s ${preset.maxDuration} s limit.`
        : `${expectedDuration} s.`,
    range,
    captionsPlaced,
    pictureClipIds: pictureClipsOf(timeline).map((clip) => clip.id),
  }
}

// studio_create_variant {kind: 'hook', variants: N}: one five-second opening
// per bite, strongest first, never two from the same shot.
export function buildHookVariants(project, { variants = 3, timelineId = null, language = null, energyOf = null, now = () => new Date() } = {}) {
  const count = Math.floor(Number(variants))
  if (!(count >= 1 && count <= MAX_HOOK_VARIANTS)) throw invalid(`variants is 1 to ${MAX_HOOK_VARIANTS}.`)
  const master = masterTimeline(project, timelineId)
  const { source: signal, bites } = soundBites(project, { timelineId: master.id, language, energyOf })
  if (!bites.length) throw invalid('No dialogue line on the timeline to build a hook from.')
  const end = timelineEnd(master)
  const chosen = []
  const usedShots = new Set()
  for (const bite of bites) {
    if (chosen.length >= count) break
    const [shotStart] = shotRangeAround(master, bite.start, bite.end)
    if (usedShots.has(shotStart)) continue
    usedShots.add(shotStart)
    // The opening starts on the cut before the line, so the line lands in
    // its first seconds, and runs five seconds (less at the very end).
    const start = Math.max(0, Math.min(shotStart, end - HOOK_SECONDS))
    chosen.push({ bite, start: round(start), end: round(Math.min(end, start + HOOK_SECONDS)) })
  }
  const stamp = now().toISOString()
  const taken = new Set((project.timelines || []).map((timeline) => timeline.id))
  return {
    signal,
    requested: count,
    variants: chosen.map(({ bite, start, end: stop }, index) => {
      const timeline = trimTimelineToRange(master, start, stop)
      let n = index + 1
      while (taken.has(`timeline-hook-${n}`)) n += 1
      taken.add(`timeline-hook-${n}`)
      Object.assign(timeline, { id: `timeline-hook-${n}`, name: `${master.name || 'Timeline'} · Hook ${index + 1}`, created: stamp, modified: stamp })
      timeline.studio = {
        ...(master.studio || {}),
        kind: 'variant',
        variantKind: 'hook',
        variantOf: master.id,
        aspect: master.studio?.aspect ?? '16:9',
        hookIndex: index + 1,
        range: [start, stop],
        source: { kind: 'hook', clipId: bite.clipId, text: bite.text, importance: bite.importance, signal },
      }
      return { timeline, rank: index + 1, bite: { clipId: bite.clipId, text: bite.text, emotion: bite.emotion, importance: bite.importance, start: bite.start }, range: [start, stop] }
    }),
  }
}

// Set keyframes on a timeline document the way Velorn's set_clip_keyframes
// (replaceKeyframes: true) stores them: clip.keyframes[property] =
// [{time, value, easing}] sorted by time. For a document that is not open in
// the editor (a headless delivery, tests); the open editor goes through the
// tool itself so the change is undoable and logged.
export function embedKeyframes(timeline, steps) {
  const byId = new Map((timeline.clips || []).map((clip) => [clip.id, clip]))
  for (const step of steps) {
    const clip = byId.get(step.clipId)
    if (!clip) continue
    const next = { ...(clip.keyframes || {}) }
    const properties = [...new Set(step.keyframes.map((frame) => frame.property))]
    for (const property of properties) {
      next[property] = step.keyframes
        .filter((frame) => frame.property === property)
        .map((frame) => ({ time: Math.min(num(clip.duration), Math.max(0, frame.timeSeconds)), value: frame.value, easing: frame.easing || 'easeInOut' }))
        .sort((a, b) => a.time - b.time)
    }
    clip.keyframes = next
  }
  return timeline
}
