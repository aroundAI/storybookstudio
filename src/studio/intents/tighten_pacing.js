// tighten_pacing (contract §5): removes silence over the pause limit, drops
// duplicate shots with no dialogue, trims shots longer than the policy's
// maxShotLength, and shortens transitions to the policy's maxDuration. With
// params.targetSeconds it cuts only as much as the target needs, kept pauses
// last, and says why when the target cannot be reached without cutting
// dialogue. The design's `detect_silence` step is get_audio_analysis (G5),
// read before compiling; every cut is a ripple extract_range over all but the
// captions tracks, so a trim never leaves a gap or slips dialogue off its
// picture (Velorn's trim_clips does not ripple), and the captions and scene
// markers after the cut are re-timed in the same plan.
import {
  DEFAULT_KEEP_PAUSE_SECONDS, DEFAULT_MIN_SILENCE_SECONDS, EPS, clipEnd, clipStart, clipsCutBy, cutSteps, cutTrackIds, finishPlan,
  pictureClips, planSilenceCuts, round3, sceneDuration, sceneNote, sceneOfClip, seconds, shotLabel, subtractIntervals, timecode,
  toFrame, voicedIntervals,
} from './shared.js'
import { dialogueAnalysisReads, scopeScenes, targetBudget, targetNotes, transitionSteps } from './common.js'

export const INTENT = 'tighten_pacing'
export const reads = (context, scope) => dialogueAnalysisReads(context, scopeScenes(context, scope))

// Two shots of one scene with the same subject and camera, the later one with
// no voiced dialogue, is a repeat (policy.visual.avoidRepeatedShots). The
// visual check (inspect_visible_shots) is a vision read that belongs to the
// critic (FILM-2014); the compiler decides from the shots' semantic fields.
export function duplicateShots(context, scenes) {
  const voiced = voicedIntervals(context.timeline, context.reads?.audioAnalysis)
  const assets = new Map(context.assets.map((asset) => [asset.id, asset]))
  const found = []
  for (const scene of scenes) {
    const shots = pictureClips(context.timeline).filter((clip) => sceneOfClip(clip) === scene).sort((a, b) => clipStart(a) - clipStart(b))
    const seen = []
    for (const clip of shots) {
      const semantic = assets.get(clip.assetId)?.semantic || {}
      const key = `${(semantic.characters || []).join('+')}|${semantic.cameraDirection || ''}`
      const silent = subtractIntervals([clipStart(clip), clipEnd(clip)], voiced).reduce((sum, [a, b]) => sum + b - a, 0) >= (Number(clip.duration) || 0) - EPS
      const original = seen.find((entry) => entry.key === key)
      if (original && silent && key !== '|' && shots.length - found.filter((entry) => entry.scene === scene).length > 1) {
        found.push({ scene, clip, of: original.clip })
      } else seen.push({ key, clip })
    }
  }
  return found
}

export function compile(context, scope, params = {}, policy = context.policy) {
  const scenes = scopeScenes(context, scope)
  const fps = context.fps
  const userEdited = new Set(context.userEditedClipIds || [])
  const trackIds = cutTrackIds(context.timeline)
  const { budget, current, target } = targetBudget(context, scenes, params)
  const notes = []
  const cuts = []
  let left = budget

  if (policy.visual.avoidRepeatedShots) {
    for (const { scene, clip, of } of duplicateShots(context, scenes)) {
      if (left <= EPS) break
      const touched = clipsCutBy(context.timeline, clipStart(clip), clipEnd(clip), trackIds).filter((other) => userEdited.has(other.id))
      if (touched.length && !params.includeUserEdits) {
        notes.push(sceneNote(scene, `Kept ${shotLabel(clip)}, a repeat of ${shotLabel(of)}, because you edited ${touched.map(shotLabel).join(', ')} by hand`))
        continue
      }
      cuts.push({
        scene,
        start: toFrame(clipStart(clip), fps),
        end: toFrame(clipEnd(clip), fps),
        touches: touched.map((other) => other.id),
        text: `Removed ${shotLabel(clip)} ${seconds(clip.duration)}`,
        reason: `Duplicate of ${shotLabel(of)} (same subject and camera) with no dialogue; policy avoids repeated shots`,
      })
      left -= Number(clip.duration) || 0
    }
  }

  const silence = planSilenceCuts(context, {
    scenes,
    range: params.range ?? null,
    minSilence: Number(params.minSilenceSeconds ?? DEFAULT_MIN_SILENCE_SECONDS),
    keepPause: Number(params.keepPauseSeconds ?? DEFAULT_KEEP_PAUSE_SECONDS),
    budget: left,
    allowJumpCuts: params.allowJumpCuts !== false,
    includeUserEdits: params.includeUserEdits === true,
    exclude: cuts.map((cut) => [cut.start, cut.end]),
    why: Number.isFinite(budget) ? `toward the ${seconds(target)} target` : null,
  })
  cuts.push(...silence.cuts)
  notes.push(...silence.notes)
  left -= silence.removed

  // Shots still over maxShotLength: trim the unvoiced tail beyond it.
  const voiced = voicedIntervals(context.timeline, context.reads?.audioAnalysis)
  for (const clip of pictureClips(context.timeline).filter((candidate) => scenes.includes(sceneOfClip(candidate)))) {
    if (left <= EPS) break
    const lost = cuts.reduce((sum, cut) => sum + Math.max(0, Math.min(clipEnd(clip), cut.end) - Math.max(clipStart(clip), cut.start)), 0)
    const length = (Number(clip.duration) || 0) - lost
    if (length <= policy.maxShotLength + EPS) continue
    let need = Math.min(length - policy.maxShotLength, left)
    const free = subtractIntervals([clipStart(clip), clipEnd(clip)], [...voiced, ...cuts.map((cut) => [cut.start, cut.end])]).reverse()
    for (const [a, b] of free) {
      if (need <= EPS) break
      const amount = Math.floor(Math.min(need, b - a) * fps + EPS) / fps
      if (amount < 1 / fps) continue
      const touched = clipsCutBy(context.timeline, b - amount, b, trackIds).filter((other) => userEdited.has(other.id))
      if (touched.length && !params.includeUserEdits) continue
      cuts.push({
        scene: sceneOfClip(clip),
        start: toFrame(b - amount, fps),
        end: toFrame(b, fps),
        touches: touched.map((other) => other.id),
        text: `Trimmed ${shotLabel(clip)} by ${seconds(amount)} at ${timecode(b - amount)}`,
        reason: `Reaction held ${seconds(length)}, over the policy maximum of ${policy.maxShotLength} s; cut after the line lands`,
      })
      need -= amount
      left -= amount
    }
    if (need > EPS) notes.push(sceneNote(sceneOfClip(clip), `${shotLabel(clip)} stays ${seconds(length)}, over the ${policy.maxShotLength} s maximum: the rest is dialogue`))
  }

  const entries = [...cutSteps(context, cuts, { trackIds }), ...transitionSteps(context, scenes, policy, userEdited, params)]
  notes.push(...targetNotes(context, scenes, { target, current, removed: round3(budget === Infinity ? 0 : budget - left), cuts, params }))
  if (entries.length === 0 && notes.length === 0) {
    for (const scene of scenes) notes.push(sceneNote(scene, `Scene ${scene} (${seconds(sceneDuration(context.timeline, scene))}) has no silence over the pause limit, no repeated shot and no shot over ${policy.maxShotLength} s`))
  }
  return finishPlan(context, { intent: INTENT, entries, notes })
}
