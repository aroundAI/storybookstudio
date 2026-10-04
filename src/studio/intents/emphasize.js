// emphasize (contract §5): a slow punch-in (set_clip_keyframes, scale) on the
// shot under a line, from the line's start to its end; optionally the line's
// words as a text card (params.text) in the brand's heading font. The zoom is
// params.zoomPercent, capped at 110% when policy.visual.avoidExtremeZoom is
// on (120% otherwise).
import { EPS, clipEnd, clipStart, finishPlan, pictureClips, round3, sceneNote, shotLabel, timecode } from './shared.js'
import { overlayTrack, scopeScenes, strongestLine, unavailable } from './common.js'

export const INTENT = 'emphasize'
export const ZOOM_CAP_AVOID_EXTREME = 110
export const ZOOM_CAP = 120
export const reads = () => []

export function compile(context, scope, params = {}, policy = context.policy) {
  const scenes = scopeScenes(context, scope)
  const clips = new Map((context.timeline?.clips || []).map((clip) => [clip.id, clip]))
  let shot = params.clipId ? clips.get(String(params.clipId)) : null
  if (params.clipId && !shot) throw unavailable(`Clip ${params.clipId} is not on the active timeline.`)
  const line = shot ? null : strongestLine(context, scenes, params)
  let lineStart = null
  let lineEnd = null
  if (line) {
    const lineClips = line.clipIds.map((id) => clips.get(id)).filter(Boolean)
    lineStart = Math.min(...lineClips.map(clipStart))
    lineEnd = Math.max(...lineClips.map(clipEnd))
    shot = pictureClips(context.timeline).find((clip) => clipStart(clip) <= lineStart + EPS && clipEnd(clip) > lineStart + EPS)
  }
  if (!shot) return finishPlan(context, { intent: INTENT, notes: [sceneNote(scenes[0] ?? null, 'No shot to emphasize in scope')] })
  const from = round3(Math.max(0, (lineStart ?? clipStart(shot)) - clipStart(shot)))
  const to = round3(Math.min(shot.duration, (lineEnd ?? clipEnd(shot)) - clipStart(shot)))
  const cap = policy.visual.avoidExtremeZoom ? ZOOM_CAP_AVOID_EXTREME : ZOOM_CAP
  const zoom = Math.min(cap, Math.max(101, Number(params.zoomPercent) || cap))
  const userEdited = new Set(context.userEditedClipIds || [])
  const touches = userEdited.has(shot.id) ? [shot.id] : []
  if (touches.length && !params.includeUserEdits) {
    return finishPlan(context, { intent: INTENT, notes: [sceneNote(shot.metadata?.semantic?.scene ?? null, `${shotLabel(shot)} was edited by hand since the last plan; pass includeUserEdits to emphasize it anyway`)] })
  }
  const scene = shot.metadata?.semantic?.scene ?? null
  const why = line ? `line ${line.sequenceNumber} (importance ${line.importance})` : `${shotLabel(shot)} as asked`
  const entries = [{
    step: {
      tool: 'set_clip_keyframes',
      arguments: {
        clipId: shot.id,
        replaceKeyframes: true,
        keyframes: ['scaleX', 'scaleY'].flatMap((property) => [
          { property, timeSeconds: from, value: 100, easing: 'easeInOut' },
          { property, timeSeconds: to, value: zoom, easing: 'easeInOut' },
        ]),
      },
    },
    reason: `Punch-in to ${zoom}% over ${why}${zoom === cap && policy.visual.avoidExtremeZoom ? '; capped by the policy (avoid extreme zoom)' : ''}`,
    scene,
    text: `Punch-in on ${shotLabel(shot)} ${timecode(clipStart(shot) + from)}-${timecode(clipStart(shot) + to)} to ${zoom}%`,
    touches,
  }]
  if (params.text) {
    const track = overlayTrack(context, 'Graphics')
    entries.unshift(...track.entries)
    entries.push({
      step: {
        tool: 'add_text_clip',
        arguments: {
          text: String(params.text),
          trackId: track.trackId,
          startSeconds: round3(clipStart(shot) + from),
          durationSeconds: round3(Math.max(0.5, to - from)),
          style: { fontFamily: context.brand.fonts.heading, textColor: context.brand.colors.captionText, backgroundColor: context.brand.colors.primary },
        },
      },
      reason: `Puts the words of ${why} on screen in the brand heading font (${context.brand.fonts.heading})`,
      scene,
      text: `Added the text "${String(params.text).slice(0, 40)}"`,
    })
  }
  return finishPlan(context, { intent: INTENT, entries })
}
