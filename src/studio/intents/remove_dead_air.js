// remove_dead_air (contract §5): ripple-cuts only spans where no dialogue is
// voiced (the dialogue clips minus get_audio_analysis' silences), so no
// dialogue word is cut. Pauses over params.minSilenceSeconds (0.6 s unless
// given) are cut down to params.keepPauseSeconds (0.25 s unless given).
import { DEFAULT_KEEP_PAUSE_SECONDS, DEFAULT_MIN_SILENCE_SECONDS, cutSteps, finishPlan, planSilenceCuts, sceneNote } from './shared.js'
import { dialogueAnalysisReads, scopeScenes } from './common.js'

export const INTENT = 'remove_dead_air'
export const reads = (context, scope) => dialogueAnalysisReads(context, scopeScenes(context, scope))

export function compile(context, scope, params = {}) {
  const scenes = scopeScenes(context, scope)
  const result = planSilenceCuts(context, {
    scenes,
    range: Array.isArray(scope?.range) ? scope.range.map(Number) : null,
    minSilence: Number(params.minSilenceSeconds ?? DEFAULT_MIN_SILENCE_SECONDS),
    keepPause: Number(params.keepPauseSeconds ?? DEFAULT_KEEP_PAUSE_SECONDS),
    allowJumpCuts: params.allowJumpCuts !== false,
    includeUserEdits: params.includeUserEdits === true,
  })
  const notes = [...result.notes]
  if (result.cuts.length === 0) notes.push(sceneNote(scenes.length === 1 ? scenes[0] : null, `No silence over ${params.minSilenceSeconds ?? DEFAULT_MIN_SILENCE_SECONDS} s in scope`))
  return finishPlan(context, { intent: INTENT, entries: cutSteps(context, result.cuts, { trackIds: result.trackIds }), notes })
}
