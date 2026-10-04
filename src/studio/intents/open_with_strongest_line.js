// open_with_strongest_line (contract §5): the line with the highest
// importance (lineImportance: emotion, question or exclamation, brevity; or
// params.lineId / params.sequenceNumber) and the shot it plays over move to
// 0:00 as a cold open; everything before it moves after it. Music and
// ambience beds stay where they are, so the bed keeps playing under the new
// order. The card reports the line and its importance score; the report's
// style.hookType is 'strongest_line'.
import { EPS, clipEnd, clipStart, finishPlan, pictureClips, pictureEnd, retimeSteps, sceneNote, shotLabel, timecode } from './shared.js'
import { lineImportance, relayoutEntries, scopeScenes, strongestLine, unavailable } from './common.js'

export const INTENT = 'open_with_strongest_line'
export const HOOK_TYPE = 'strongest_line'
export const reads = () => []

export function compile(context, scope, params = {}) {
  const scenes = scopeScenes(context, scope)
  const line = strongestLine(context, scenes, params)
  if (!line) return finishPlan(context, { intent: INTENT, notes: [sceneNote(null, 'No dialogue line in scope is on the timeline')] })
  const clips = new Map((context.timeline?.clips || []).map((clip) => [clip.id, clip]))
  const lineClips = line.clipIds.map((id) => clips.get(id)).filter(Boolean)
  const lineStart = Math.min(...lineClips.map(clipStart))
  const lineEnd = Math.max(...lineClips.map(clipEnd))
  const shot = pictureClips(context.timeline).find((clip) => clipStart(clip) <= lineStart + EPS && clipEnd(clip) > lineStart + EPS)
  if (!shot) throw unavailable(`No shot plays under line ${line.sequenceNumber}.`)
  let start = clipStart(shot)
  let end = Math.max(clipEnd(shot), lineEnd)
  // Grow the hook to whole shots so no shot is split.
  for (const clip of pictureClips(context.timeline)) {
    if (clipStart(clip) < end - EPS && clipEnd(clip) > end + EPS) end = clipEnd(clip)
  }
  if (start <= EPS) {
    return finishPlan(context, { intent: INTENT, notes: [sceneNote(line.scene, `Line ${line.sequenceNumber} (importance ${line.importance}) already opens the episode`)] })
  }
  const total = Math.max(pictureEnd(context.timeline), ...((context.timeline?.clips || []).map(clipEnd)))
  const segments = [{ start: 0, end: start }, { start, end }, ...(end < total - EPS ? [{ start: end, end: total }] : [])]
  const order = [1, 0, ...(segments.length === 3 ? [2] : [])]
  const label = `line ${line.sequenceNumber} (${line.character}: "${line.text.slice(0, 48)}${line.text.length > 48 ? '...' : ''}")`
  const { entries, mapTime, straddlers } = relayoutEntries(context, segments, order, {
    reasonFor: (index) => (index === 1
      ? `Strongest line in scope, ${label}, importance ${line.importance}${line.chosenBy === 'params' ? ' (chosen by you)' : ''}: used as the hook`
      : `Moved after the hook so the episode opens on ${label}`),
    textFor: (index, moved) => (index === 1
      ? `Moved ${shotLabel(shot)} and ${label} to 0:00 (${moved.length} clips)`
      : `Moved ${timecode(segments[0].start)}-${timecode(segments[0].end)} after the hook (${moved.length} clips)`),
    sceneFor: (index) => (index === 1 ? line.scene : null),
  })
  const notes = []
  const blocking = straddlers.filter((clip) => !['music', 'ambience', 'sfx'].includes(clip.metadata?.semantic?.role) && !String(clip.metadata?.bus || '').match(/music|ambience|sfx/))
  if (blocking.length) throw unavailable(`Cannot move the hook cleanly: ${blocking.map((clip) => clip.name || clip.id).join(', ')} spans the hook's edge.`)
  if (straddlers.length) notes.push(sceneNote(null, `${straddlers.length} music or ambience bed${straddlers.length === 1 ? '' : 's'} stay in place and play under the new order`))
  notes.push(sceneNote(line.scene, `Hook: ${label}, importance ${line.importance} (emotion, question or exclamation, brevity)`))
  const retime = retimeSteps(context.timeline, mapTime, { reason: 'Keeps captions on their lines after the reorder', fps: context.fps })
  return finishPlan(context, { intent: INTENT, entries: [...entries, ...retime], notes, hookType: HOOK_TYPE })
}

export { lineImportance }
