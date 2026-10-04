// hit_duration's second tier (FILM-2013 follow-up): when cutting silence
// leaves the episode over its target, drop whole dialogue lines, the least
// important first (lineImportance), until the target is met. Each scene keeps
// its strongest line, and every shot piece the cut leaves stays at least the
// policy's minShotLength. Dropping dialogue changes what the episode says, so
// the policy decides who may do it: allowDialogueCuts 'never' (no drops),
// 'ask' (the default: proposed in a separate "Needs your OK" group, applied
// only when the caller asks again with params.approveDialogueDrops), or
// 'allow' (applied with the rest). Pure module.
import {
  EPS, clipEnd, clipStart, clipsCutBy, dialogueClips, mergeIntervals, pictureClips, round3, sceneOfClip, seconds, shotLabel,
  subtractIntervals, toFrame, voicedIntervals,
} from './shared.js'
import { lineImportance } from './common.js'

export const DIALOGUE_CUT_MODES = Object.freeze(['never', 'ask', 'allow'])
export const DEFAULT_DIALOGUE_CUT_MODE = 'ask'

export const dialogueCutMode = (context) => (DIALOGUE_CUT_MODES.includes(context?.policy?.allowDialogueCuts) ? context.policy.allowDialogueCuts : DEFAULT_DIALOGUE_CUT_MODE)

const quote = (text, length = 60) => {
  const value = String(text || '').trim()
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}

const overlapLength = (intervals, [a, b]) => intervals.reduce((sum, [x, y]) => sum + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0)

// → { cuts: [{scene, start, end, text, reason, touches}], lines: [...], removed, skipped: [...] }
export function planDialogueDrops(context, { scenes, budget, existingCuts = [], trackIds, target, includeUserEdits = false }) {
  const fps = context.fps
  const policy = context.policy
  const userEdited = new Set(context.userEditedClipIds || [])
  const clips = new Map((context.timeline?.clips || []).map((clip) => [clip.id, clip]))
  const dialogue = new Set(dialogueClips(context.timeline).map((clip) => clip.id))
  const voiced = voicedIntervals(context.timeline, context.reads?.audioAnalysis)
  const pictures = pictureClips(context.timeline)

  const lines = []
  for (const scene of context.screenplay.filter((entry) => scenes.includes(entry.scene))) {
    for (const line of scene.dialogue) {
      const placed = line.clipIds.map((id) => clips.get(id)).filter((clip) => clip && dialogue.has(clip.id))
      if (!placed.length) continue
      lines.push({
        ...line,
        scene: scene.scene,
        importance: lineImportance(line),
        start: Math.min(...placed.map(clipStart)),
        end: Math.max(...placed.map(clipEnd)),
        clips: placed,
      })
    }
  }
  const byScene = new Map()
  for (const line of lines) {
    if (!byScene.has(line.scene)) byScene.set(line.scene, [])
    byScene.get(line.scene).push(line)
  }
  // Each scene keeps its strongest line (the earliest on a tie).
  const protectedIds = new Set([...byScene.values()].map((sceneLines) => sceneLines.reduce((best, line) => (line.importance > best.importance ? line : best)).lineId))
  const remaining = new Map([...byScene].map(([scene, sceneLines]) => [scene, sceneLines.length]))

  const candidates = lines
    .filter((line) => !protectedIds.has(line.lineId))
    .sort((a, b) => a.importance - b.importance || (b.end - b.start) - (a.end - a.start) || b.start - a.start)

  const chosen = []
  const cutIntervals = () => mergeIntervals([...existingCuts.map((cut) => [cut.start, cut.end]), ...chosen.flatMap((entry) => entry.intervals)])
  const skipped = []
  let left = budget

  for (const line of candidates) {
    if (left <= EPS) break
    if ((remaining.get(line.scene) || 0) <= 1) continue
    // The line and the pause after it, up to the next voiced audio or the
    // end of the scene's picture.
    const sceneEnd = Math.max(...pictures.filter((clip) => sceneOfClip(clip) === line.scene).map(clipEnd))
    const nextVoice = voiced.map(([a]) => a).filter((a) => a >= line.end - EPS).sort((a, b) => a - b)[0]
    const spanEnd = Math.min(nextVoice ?? sceneEnd, sceneEnd)
    let intervals = subtractIntervals([toFrame(line.start, fps), toFrame(Math.max(line.end, spanEnd), fps)], cutIntervals())
      .filter(([a, b]) => b - a >= 1 / fps - EPS)
    if (!intervals.length) continue

    // A shot left shorter than the policy minimum by this drop is dropped too
    // when nothing else is said over it; otherwise the line stays.
    const others = voicedIntervals({ ...context.timeline, clips: context.timeline.clips.filter((clip) => !line.clips.includes(clip)) }, context.reads?.audioAnalysis)
    let blocked = null
    const absorbed = new Set()
    for (let pass = 0; pass < 3 && !blocked; pass += 1) {
      const all = mergeIntervals([...cutIntervals(), ...intervals])
      let grew = false
      for (const shot of pictures.filter((clip) => intervals.some(([a, b]) => clipEnd(clip) > a + EPS && clipStart(clip) < b - EPS))) {
        for (const [a, b] of subtractIntervals([clipStart(shot), clipEnd(shot)], all)) {
          if (b - a >= policy.minShotLength - EPS) continue
          if (overlapLength(others, [a, b]) > EPS) {
            blocked = `it would leave ${shotLabel(shot)} under the policy minimum of ${policy.minShotLength} s with other dialogue on it`
            break
          }
          intervals = mergeIntervals([...intervals, [toFrame(a, fps), toFrame(b, fps)]])
          absorbed.add(shotLabel(shot))
          grew = true
        }
        if (blocked) break
      }
      if (!grew) break
    }
    if (blocked) {
      skipped.push({ lineId: line.lineId, sequenceNumber: line.sequenceNumber, why: blocked })
      continue
    }
    const touched = [...new Set(intervals.flatMap(([a, b]) => clipsCutBy(context.timeline, a, b, trackIds)).filter((clip) => userEdited.has(clip.id)).map((clip) => clip.id))]
    if (touched.length && !includeUserEdits) {
      skipped.push({ lineId: line.lineId, sequenceNumber: line.sequenceNumber, why: 'you edited a clip under it by hand since the last plan' })
      continue
    }
    const removed = round3(intervals.reduce((sum, [a, b]) => sum + b - a, 0))
    const strongest = byScene.get(line.scene).find((entry) => protectedIds.has(entry.lineId))
    chosen.push({ line, intervals, removed, touched, strongest, absorbed: [...absorbed] })
    remaining.set(line.scene, remaining.get(line.scene) - 1)
    left -= removed
  }

  // Whole lines overshoot; the last one gives back part of the pause after
  // it (never any of its speech), so the cut lands on the target.
  const last = chosen.at(-1)
  if (last && left < -EPS) {
    let giveBack = -left
    last.intervals = last.intervals.map(([a, b]) => {
      if (giveBack <= EPS || b <= last.line.end + EPS) return [a, b]
      const room = b - Math.max(a, last.line.end)
      const back = Math.floor(Math.min(giveBack, room) * fps + EPS) / fps
      giveBack -= back
      return [a, toFrame(b - back, fps)]
    }).filter(([a, b]) => b - a >= 1 / fps - EPS)
    last.removed = round3(last.intervals.reduce((sum, [a, b]) => sum + b - a, 0))
  }

  const alsoShots = (absorbed) => (absorbed.length ? `; ${absorbed.join(', ')} goes too, since only this line plays over the rest of it (a shorter piece would be under the ${policy.minShotLength} s minimum)` : '')
  const cuts = chosen.flatMap(({ line, intervals, touched, strongest, absorbed }) => intervals.map(([start, end]) => ({
    scene: line.scene,
    start,
    end,
    touches: touched,
    tier: 'dialogue_drop',
    lineId: line.lineId,
    text: `Dropped line ${line.sequenceNumber} (${line.character}): "${quote(line.text)}"`,
    reason: `Least important line left in scene ${line.scene} (importance ${line.importance}; the scene keeps line ${strongest.sequenceNumber} at ${strongest.importance}); dropped toward the ${seconds(target)} target${alsoShots(absorbed)}`,
  })))
  return {
    cuts,
    removed: round3(chosen.reduce((sum, entry) => sum + entry.removed, 0)),
    lines: chosen.map(({ line, removed, strongest, absorbed }) => ({
      lineId: line.lineId,
      sequenceNumber: line.sequenceNumber,
      scene: line.scene,
      character: line.character,
      text: line.text,
      importance: line.importance,
      seconds: removed,
      reason: `Importance ${line.importance}, the lowest left in scene ${line.scene}; the scene keeps line ${strongest.sequenceNumber} (${strongest.importance})${alsoShots(absorbed)}`,
      alsoRemovesShots: absorbed,
    })),
    skipped,
  }
}
