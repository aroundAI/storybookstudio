// hit_duration (contract §5): brings the timeline (or the scoped scenes) to
// params.targetSeconds, else the policy's or the episode's target. Silence
// goes first (as tighten_pacing), then whole shots with no dialogue, the
// least informative first (no dialogue, not a scene's only shot, longest
// first); every scene keeps at least one shot. The result lands within 5% of
// the target or the card says why not.
import {
  DEFAULT_KEEP_PAUSE_SECONDS, DEFAULT_MIN_SILENCE_SECONDS, EPS, clipEnd, clipStart, clipsCutBy, cutSteps, cutTrackIds, finishPlan,
  pictureClips, planSilenceCuts, round3, sceneNote, sceneOfClip, seconds, shotLabel, subtractIntervals, toFrame, voicedIntervals,
} from './shared.js'
import { dialogueAnalysisReads, scopeScenes, targetBudget, targetNotes, unavailable } from './common.js'
import { resolveScope } from '../context.js'
import { dialogueCutMode, planDialogueDrops } from './dialogueDrops.js'

export const INTENT = 'hit_duration'
export const reads = (context, scope) => dialogueAnalysisReads(context, scopeScenes(context, scope))

export function compile(context, scope, params = {}) {
  const resolved = resolveScope(context, scope)
  const scenes = resolved.scenes
  const wholeTimeline = resolved.whole
  const targetSeconds = params.targetSeconds ?? params.target ?? (wholeTimeline ? context.target.seconds : null)
  if (targetSeconds == null) throw unavailable('hit_duration needs params.targetSeconds: the policy and the episode carry no target duration.')
  const { budget, current, target } = targetBudget(context, scenes, { targetSeconds }, { wholeTimeline })
  const fps = context.fps
  const userEdited = new Set(context.userEditedClipIds || [])
  const trackIds = cutTrackIds(context.timeline)
  const notes = []

  const silence = planSilenceCuts(context, {
    scenes,
    minSilence: Number(params.minSilenceSeconds ?? DEFAULT_MIN_SILENCE_SECONDS),
    keepPause: Number(params.keepPauseSeconds ?? DEFAULT_KEEP_PAUSE_SECONDS),
    budget,
    includeUserEdits: params.includeUserEdits === true,
    why: `toward the ${seconds(target)} target`,
  })
  const cuts = [...silence.cuts]
  notes.push(...silence.notes)
  let left = budget - silence.removed

  if (left > EPS) {
    const voiced = voicedIntervals(context.timeline, context.reads?.audioAnalysis)
    const shots = pictureClips(context.timeline).filter((clip) => scenes.includes(sceneOfClip(clip)))
    const perScene = new Map()
    for (const clip of shots) perScene.set(sceneOfClip(clip), (perScene.get(sceneOfClip(clip)) || 0) + 1)
    const candidates = shots
      .filter((clip) => subtractIntervals([clipStart(clip), clipEnd(clip)], voiced).reduce((sum, [a, b]) => sum + b - a, 0) >= clip.duration - EPS)
      .sort((a, b) => b.duration - a.duration || clipStart(a) - clipStart(b))
    for (const clip of candidates) {
      if (left <= EPS) break
      const scene = sceneOfClip(clip)
      if ((perScene.get(scene) || 0) <= 1) continue
      const start = toFrame(clipStart(clip), fps)
      const end = toFrame(clipEnd(clip), fps)
      if (cuts.some((cut) => cut.start < end - EPS && cut.end > start + EPS)) continue
      const touched = clipsCutBy(context.timeline, start, end, trackIds).filter((other) => userEdited.has(other.id))
      if (touched.length && !params.includeUserEdits) continue
      cuts.push({
        scene,
        start,
        end,
        touches: touched.map((other) => other.id),
        text: `Removed ${shotLabel(clip)} ${seconds(clip.duration)}`,
        reason: `No dialogue in this shot (lowest information); removed toward the ${seconds(target)} target, scene ${scene} keeps ${perScene.get(scene) - 1} shot${perScene.get(scene) === 2 ? '' : 's'}`,
      })
      perScene.set(scene, perScene.get(scene) - 1)
      left -= clip.duration
    }
  }

  // Tier 2: whole dialogue lines, least important first, as the policy allows.
  const mode = dialogueCutMode(context)
  let proposal = null
  if (left > EPS && mode === 'never') {
    notes.push(sceneNote(null, `The edit policy does not allow cutting dialogue (allowDialogueCuts: never), so the ${seconds(target)} target is not reached`))
  } else if (left > EPS) {
    const drops = planDialogueDrops(context, { scenes, budget: left, existingCuts: cuts, trackIds, target, includeUserEdits: params.includeUserEdits === true })
    for (const skip of drops.skipped) notes.push(sceneNote(null, `Kept line ${skip.sequenceNumber}: ${skip.why}`))
    if (drops.lines.length && (mode === 'allow' || params.approveDialogueDrops === true)) {
      cuts.push(...drops.cuts)
      left -= drops.removed
    } else if (drops.lines.length) {
      const withDrops = finishPlan(context, { intent: INTENT, entries: cutSteps(context, [...cuts, ...drops.cuts], { trackIds }) })
      proposal = {
        kind: 'dialogue_drops',
        title: `Needs your OK: drops ${drops.lines.length} line${drops.lines.length === 1 ? '' : 's'}`,
        why: `Cutting silence reaches ${seconds(current - (budget - left))}; the ${seconds(target)} target needs ${seconds(left)} more, which only dialogue can give. The edit policy asks before dialogue is cut (allowDialogueCuts: ask).`,
        lines: drops.lines,
        removedSeconds: drops.removed,
        durationAfter: withDrops.expected.durationAfter,
        approveWith: { params: { ...params, approveDialogueDrops: true } },
      }
    }
  }

  notes.push(...targetNotes(context, scenes, { target, current, removed: round3(budget - Math.max(0, left)), params, wholeTimeline }))
  const plan = finishPlan(context, { intent: INTENT, entries: cutSteps(context, cuts, { trackIds }), notes: notes.length ? notes : [sceneNote(null, 'Nothing to cut')] })
  plan.dialogueCuts = mode
  plan.droppedLines = cuts.filter((cut) => cut.tier === 'dialogue_drop').map((cut) => cut.lineId).filter((id, index, all) => all.indexOf(id) === index)
  plan.proposals = proposal ? [proposal] : []
  return plan
}
