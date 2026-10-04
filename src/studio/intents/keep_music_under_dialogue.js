// keep_music_under_dialogue (contract §5): music-bus ducking at
// policy.music.duckDb, never ducking the dialogue bus. Ducking is a bus
// parameter (project.studio.audioBuses.music) that FILM-2016 renders; no
// Velorn primitive writes it (G4). Until FILM-2016's compiler is registered
// (compile.js registerIntentCompiler), this compiler returns no steps and
// says what the bus is set to.
import { finishPlan, sceneNote } from './shared.js'

export const INTENT = 'keep_music_under_dialogue'
export const reads = () => []

export function compile(context, _scope, _params, policy = context.policy) {
  const music = context.project?.audioBuses?.music || null
  const notes = []
  if (!policy.music.enabled) notes.push(sceneNote(null, 'Music is off in the edit policy (music.enabled false); nothing to duck'))
  else if (music?.duckUnder === 'dialogue') {
    notes.push(sceneNote(null, `The music bus is set to duck ${music.duckDb ?? policy.music.duckDb} dB under dialogue (attack ${music.attackMs ?? '-'} ms, release ${music.releaseMs ?? '-'} ms); the dialogue bus is never ducked. Playback and render apply it once FILM-2016's bus mixer lands.`))
  } else {
    notes.push(sceneNote(null, `The music bus does not duck under dialogue yet; setting it to ${policy.music.duckDb} dB needs FILM-2016's bus ducking (not available yet)`))
  }
  return finishPlan(context, { intent: INTENT, notes })
}
