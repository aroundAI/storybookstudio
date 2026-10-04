// recut_around_drops (contract §5, PRD Learn): tightens the ±5 s around each
// measured audience drop in analyticsHints.retention. With no measured drops
// (reason 'unmeasured', 'no_published_video' or 'no_curve') it returns no
// steps and says so; it never guesses a drop.
import { DEFAULT_KEEP_PAUSE_SECONDS, DEFAULT_MIN_SILENCE_SECONDS, cutSteps, finishPlan, planSilenceCuts, sceneNote, timecode } from './shared.js'
import { dialogueAnalysisReads, scopeScenes } from './common.js'

export const INTENT = 'recut_around_drops'
export const WINDOW_SECONDS = 5

const dropTime = (drop) => Number(drop?.atSeconds ?? drop?.timeSeconds ?? drop?.startSeconds ?? drop?.t)

export const reads = (context, scope) => (context.analyticsHints?.retention?.length ? dialogueAnalysisReads(context, scopeScenes(context, scope)) : [])

export function compile(context, scope, params = {}) {
  const hints = context.analyticsHints || {}
  const drops = (hints.retention || []).filter((drop) => Number.isFinite(dropTime(drop)))
  if (drops.length === 0) {
    return finishPlan(context, {
      intent: INTENT,
      notes: [sceneNote(null, `No measured audience drops for this episode (${hints.reason || 'unmeasured'}); nothing to recut. Drops are never guessed.`)],
    })
  }
  const scenes = scopeScenes(context, scope)
  const cuts = []
  const notes = []
  for (const drop of drops) {
    const at = dropTime(drop)
    const result = planSilenceCuts(context, {
      scenes,
      range: [Math.max(0, at - WINDOW_SECONDS), at + WINDOW_SECONDS],
      minSilence: Number(params.minSilenceSeconds ?? DEFAULT_MIN_SILENCE_SECONDS),
      keepPause: Number(params.keepPauseSeconds ?? DEFAULT_KEEP_PAUSE_SECONDS),
      includeUserEdits: params.includeUserEdits === true,
      exclude: cuts.map((cut) => [cut.start, cut.end]),
      why: `viewers dropped at ${timecode(at)}${drop.dropPercent != null ? ` (-${drop.dropPercent}%)` : ''}`,
    })
    cuts.push(...result.cuts)
    notes.push(...result.notes)
    if (result.cuts.length === 0) notes.push(sceneNote(null, `No silence to cut within ${WINDOW_SECONDS} s of the drop at ${timecode(at)}`))
  }
  return finishPlan(context, { intent: INTENT, entries: cutSteps(context, cuts), notes })
}
