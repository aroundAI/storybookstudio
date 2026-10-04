// match_brand (contract §5): the brand's transition style at every scene
// change on the shot track. 'dissolve' adds a dissolve (at the policy's
// maxDuration), 'dip' a dip to black, 'cut' removes transitions there. Each
// change names the brand field it came from. Caption style is FILM-2016's,
// logos and intros FILM-2018's; the card says so.
import { EPS, clipEnd, clipStart, finishPlan, pictureClips, sceneNote, sceneOfClip, shotLabel, timecode } from './shared.js'
import { scopeScenes } from './common.js'

export const INTENT = 'match_brand'
export const reads = () => []

export function compile(context, scope, _params = {}, policy = context.policy) {
  const scenes = scopeScenes(context, scope)
  const style = context.brand.transitionStyle
  const shots = pictureClips(context.timeline).sort((a, b) => clipStart(a) - clipStart(b))
  const transitions = context.timeline?.transitions || []
  const notes = [sceneNote(null, 'Brand caption style is applied by studio_add_captions (FILM-2016); logo and intro graphics by FILM-2018')]
  const entries = []
  const userEdited = new Set(context.userEditedClipIds || [])
  for (let index = 1; index < shots.length; index += 1) {
    const out = shots[index - 1]
    const into = shots[index]
    if (out.trackId !== into.trackId || Math.abs(clipEnd(out) - clipStart(into)) > EPS * 1000) continue
    const scene = sceneOfClip(into)
    if (scene === sceneOfClip(out) || !scenes.includes(scene)) continue
    const existing = transitions.filter((transition) => transition.clipAId === out.id && transition.clipBId === into.id)
    if ([out, into].some((clip) => userEdited.has(clip.id))) {
      notes.push(sceneNote(scene, `Left the scene change ${shotLabel(out)} / ${shotLabel(into)} alone: you edited it by hand`))
      continue
    }
    const at = `${shotLabel(out)} / ${shotLabel(into)} (${timecode(clipStart(into))})`
    if (style === 'cut') {
      if (existing.length) {
        entries.push({
          step: { tool: 'remove_transitions', arguments: { transitionIds: existing.map((transition) => transition.id) } },
          reason: 'brand.transitionStyle is "cut"',
          scene,
          text: `Removed the transition at ${at}`,
        })
      }
      continue
    }
    if (!policy.transitions.preferred.includes(style)) {
      notes.push(sceneNote(scene, `brand.transitionStyle "${style}" is not among the policy's transitions (${policy.transitions.preferred.join(', ')}); left the cut at ${at}`))
      continue
    }
    if (existing.length) continue
    if (style === 'dissolve') {
      entries.push({
        step: { tool: 'add_transition', arguments: { clipAId: out.id, clipBId: into.id, transitionType: 'dissolve', durationSeconds: policy.transitions.maxDuration } },
        reason: `brand.transitionStyle is "dissolve"; ${policy.transitions.maxDuration} s is the policy's transitions.maxDuration`,
        scene,
        text: `Dissolve at ${at}`,
      })
    } else if (style === 'dip') {
      entries.push({
        step: { tool: 'add_dip_to_black', arguments: { clipPairs: [{ outClipId: out.id, inClipId: into.id }], durationSeconds: policy.transitions.maxDuration / 2 } },
        reason: `brand.transitionStyle is "dip"; each side ${policy.transitions.maxDuration / 2} s so the dip stays within the policy's ${policy.transitions.maxDuration} s`,
        scene,
        text: `Dip to black at ${at}`,
      })
    }
  }
  if (entries.length === 0) notes.push(sceneNote(null, `Every scene change in scope already matches brand.transitionStyle "${style}"`))
  return finishPlan(context, { intent: INTENT, entries, notes })
}
