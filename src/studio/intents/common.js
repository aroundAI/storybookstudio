// Pieces several intent compilers share: scope, targets, the compile-time
// audio reads, transition caps. Pure module.
import { resolveScope } from '../context.js'
import {
  EPS, clipStart, dialogueClips, pictureEnd, round3, sceneDuration, sceneNote, sceneOfClip, seconds, shotLabel, voicedIntervals,
} from './shared.js'

export const scopeScenes = (context, scope) => resolveScope(context, scope).scenes

// get_audio_analysis on every voiced dialogue clip of the scenes: the
// silence list the cut engine subtracts from "voiced".
export function dialogueAnalysisReads(context, scenes) {
  const spans = context.sceneMap.filter((entry) => scenes.includes(entry.scene) && entry.start != null)
  return dialogueClips(context.timeline)
    .filter((clip) => spans.some((span) => clipStart(clip) < span.end && clipStart(clip) + clip.duration > span.start))
    .map((clip) => ({ tool: 'get_audio_analysis', arguments: { clipId: clip.id, includeLoudnessCurve: false } }))
}

// The amount to remove for params.targetSeconds (the scoped scenes' total
// when a scene is scoped, else the timeline's length), or Infinity.
export function targetBudget(context, scenes, params, { wholeTimeline = false } = {}) {
  const raw = params.targetSeconds ?? params.target ?? null
  if (raw == null) return { budget: Infinity, current: null, target: null }
  const target = Number(raw)
  if (!(target > 0)) {
    const error = new Error('targetSeconds must be a positive number of seconds.')
    error.code = 'VALIDATION_FAILED'
    throw error
  }
  const current = wholeTimeline ? pictureEnd(context.timeline) : round3(scenes.reduce((sum, scene) => sum + sceneDuration(context.timeline, scene), 0))
  return { budget: Math.max(0, current - target), current, target }
}

export function targetNotes(context, scenes, { target, current, removed, params, wholeTimeline = false }) {
  if (target == null) return []
  const after = round3(current - removed)
  const where = wholeTimeline ? 'The timeline' : scenes.length === 1 ? `Scene ${scenes[0]}` : `Scenes ${scenes.join(', ')}`
  const scene = wholeTimeline || scenes.length !== 1 ? null : scenes[0]
  if (current <= target + EPS) return [sceneNote(scene, `${where} is ${seconds(current)}, already at or under the ${seconds(target)} target; nothing was cut for it`)]
  if (Math.abs(after - target) <= target * 0.05 + EPS) return [sceneNote(scene, `${where}: ${seconds(current)} -> ${seconds(after)}, within 5% of the ${seconds(target)} target`)]
  const voiced = voicedIntervals(context.timeline, context.reads?.audioAnalysis)
  const spans = scenes.map((number) => context.sceneMap.find((entry) => entry.scene === number)).filter((entry) => entry?.start != null)
  const speech = round3(voiced.reduce((sum, [a, b]) => sum + spans.reduce((inner, span) => inner + Math.max(0, Math.min(b, span.end) - Math.max(a, span.start)), 0), 0))
  const lines = dialogueClips(context.timeline).filter((clip) => scenes.includes(sceneOfClip(clip))).length
  return [sceneNote(scene, `${where}: ${seconds(current)} -> ${seconds(after)}; the ${seconds(target)} target is not reached without cutting dialogue: ${lines} line${lines === 1 ? '' : 's'} run ${seconds(speech)} and the pauses left are under the ${params.minSilenceSeconds ?? 0.6} s limit`)]
}

// Transitions in the scenes longer than policy.transitions.maxDuration.
export function transitionSteps(context, scenes, policy, userEdited, params = {}) {
  const clips = new Map((context.timeline?.clips || []).map((clip) => [clip.id, clip]))
  const entries = []
  for (const transition of context.timeline?.transitions || []) {
    const ends = [transition.clipAId, transition.clipBId, transition.clipId].filter(Boolean).map((id) => clips.get(id)).filter(Boolean)
    const scene = ends.map(sceneOfClip).find((value) => value !== null) ?? null
    if (scene === null || !scenes.includes(scene)) continue
    if (!(Number(transition.duration) > policy.transitions.maxDuration + EPS)) continue
    const touched = ends.filter((clip) => userEdited.has(clip.id))
    if (touched.length && !params.includeUserEdits) continue
    entries.push({
      step: { tool: 'update_transition', arguments: { transitionId: transition.id, durationSeconds: policy.transitions.maxDuration } },
      reason: `Transition was ${seconds(transition.duration)}; the policy caps transitions at ${policy.transitions.maxDuration} s`,
      scene,
      text: `Shortened the ${transition.type || 'transition'} at ${ends.map(shotLabel).join(' / ')} to ${policy.transitions.maxDuration} s`,
      touches: touched.map((clip) => clip.id),
    })
  }
  return entries
}

export function unavailable(message) {
  const error = new Error(message)
  error.code = 'VALIDATION_FAILED'
  return error
}

// Moves whole segments of the timeline: `segments` are [start, end) spans
// covering the cut, `order` their new sequence. A clip inside one segment
// moves with it; a clip spanning segments (a music or ambience bed) stays
// where it is, so the bed keeps playing under the new order. Captions and
// markers are mapped the same way. One move_clips step per moved segment,
// at most 100 clips each (Velorn's move_clips limit).
export function relayoutEntries(context, segments, order, { reasonFor, textFor, sceneFor }) {
  const tracks = new Map((context.timeline?.tracks || []).map((track) => [track.id, track]))
  const starts = []
  let cursor = segments[0].start
  for (const index of order) {
    starts[index] = cursor
    cursor += segments[index].end - segments[index].start
  }
  const segmentOf = (time) => segments.findIndex((segment) => time >= segment.start - EPS && time < segment.end - EPS)
  const mapTime = (time) => {
    const index = segmentOf(time)
    if (index < 0) return time
    return time - segments[index].start + starts[index]
  }
  const moving = new Map()
  const straddlers = []
  for (const clip of context.timeline?.clips || []) {
    const track = tracks.get(clip.trackId)
    if (track?.role === 'captions') continue
    const from = segmentOf(clipStart(clip))
    const to = segmentOf(clipStart(clip) + clip.duration - EPS * 2)
    if (from < 0) continue
    if (from !== to) {
      straddlers.push(clip)
      continue
    }
    if (Math.abs(starts[from] - segments[from].start) < EPS) continue
    if (!moving.has(from)) moving.set(from, [])
    moving.get(from).push(clip)
  }
  const entries = []
  for (const index of order) {
    const clips = moving.get(index) || []
    for (let at = 0; at < clips.length; at += 100) {
      const chunk = clips.slice(at, at + 100)
      entries.push({
        step: { tool: 'move_clips', arguments: { clips: chunk.map((clip) => ({ clipId: clip.id, startSeconds: round3(mapTime(clipStart(clip))) })), resolveOverlaps: false } },
        reason: reasonFor(index),
        scene: sceneFor(index),
        text: textFor(index, chunk),
      })
    }
  }
  return { entries, mapTime, straddlers }
}

const EMOTION_WEIGHT = { urgent: 0.3, angry: 0.3, afraid: 0.3, excited: 0.3, shocked: 0.3, determined: 0.2, sad: 0.2, tense: 0.2, hopeful: 0.15 }

// A line's importance for a hook: emotion, a question or exclamation, and
// brevity. Deterministic, so the same script always picks the same line;
// the score is reported on the card.
export function lineImportance(line) {
  const text = String(line?.text || '')
  const words = text.split(/\s+/).filter(Boolean).length
  const emotion = EMOTION_WEIGHT[String(line?.emotion || '').toLowerCase()] ?? 0
  const score = emotion + (text.includes('?') ? 0.25 : 0) + (text.includes('!') ? 0.2 : 0) + (words > 0 && words <= 12 ? 0.1 : 0)
  return round3(score)
}

export function strongestLine(context, scenes, params = {}) {
  const lines = context.screenplay.filter((scene) => scenes.includes(scene.scene)).flatMap((scene) => scene.dialogue.map((line) => ({ ...line, scene: scene.scene })))
  const placed = lines.filter((line) => line.clipIds.length > 0)
  if (params.lineId || params.sequenceNumber != null) {
    const wanted = placed.find((line) => line.lineId === params.lineId || line.sequenceNumber === Number(params.sequenceNumber))
    if (!wanted) throw unavailable(`Line ${params.lineId ?? params.sequenceNumber} is not on the timeline in scope.`)
    return { ...wanted, importance: lineImportance(wanted), chosenBy: 'params' }
  }
  let best = null
  for (const line of placed) {
    const importance = lineImportance(line)
    if (!best || importance > best.importance) best = { ...line, importance, chosenBy: 'importance' }
  }
  return best
}

// A video track for overlays (b-roll, graphics): an existing track of that
// name, else an add_track step and the id Velorn will give it (video-N+1).
export function overlayTrack(context, name) {
  const existing = (context.timeline?.tracks || []).find((track) => track.type === 'video' && track.name === name && !track.locked)
  if (existing) return { trackId: existing.id, entries: [] }
  const highest = (context.timeline?.tracks || []).filter((track) => track.type === 'video')
    .reduce((max, track) => Math.max(max, Number(/^video-(\d+)$/.exec(track.id)?.[1]) || 0), 0)
  return {
    trackId: `video-${highest + 1}`,
    entries: [{
      step: { tool: 'add_track', arguments: { type: 'video', name, position: 'top' } },
      reason: `A ${name} track above the shots, so nothing on the edit is overwritten`,
      scene: null,
      text: `Added the ${name} track`,
    }],
  }
}
