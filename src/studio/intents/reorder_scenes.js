// reorder_scenes (contract §5): params.order lists the scenes in their new
// order; each scene block moves as one, so clips keep their relative order
// inside a scene. Beds stay in place; captions and markers follow.
import { finishPlan, retimeSteps, sceneNote } from './shared.js'
import { relayoutEntries, unavailable } from './common.js'

export const INTENT = 'reorder_scenes'
export const reads = () => []

export function compile(context, _scope, params = {}) {
  const placed = context.sceneMap.filter((entry) => entry.start != null).sort((a, b) => a.start - b.start)
  const order = (Array.isArray(params.order) ? params.order : []).map(Number)
  const known = placed.map((entry) => entry.scene)
  if (order.length !== known.length || [...order].sort((a, b) => a - b).join() !== [...known].sort((a, b) => a - b).join()) {
    throw unavailable(`params.order must list every placed scene once: ${known.join(', ')}.`)
  }
  if (order.join() === known.join()) return finishPlan(context, { intent: INTENT, notes: [sceneNote(null, 'The scenes are already in that order')] })
  const segments = placed.map((entry) => ({ start: entry.start, end: entry.end, scene: entry.scene }))
  const indexOf = (scene) => segments.findIndex((segment) => segment.scene === scene)
  const { entries, mapTime, straddlers } = relayoutEntries(context, segments, order.map(indexOf), {
    reasonFor: (index) => `Scene order ${order.join(', ')} as asked; scene ${segments[index].scene} moves as one block`,
    textFor: (index, moved) => `Moved scene ${segments[index].scene} to position ${order.indexOf(segments[index].scene) + 1} (${moved.length} clips)`,
    sceneFor: (index) => segments[index].scene,
  })
  const notes = straddlers.length ? [sceneNote(null, `${straddlers.length} clip${straddlers.length === 1 ? '' : 's'} spanning scenes (music or ambience beds) stay in place`)] : []
  const retime = retimeSteps(context.timeline, mapTime, { reason: 'Keeps captions and scene markers with their scenes', fps: context.fps })
  return finishPlan(context, { intent: INTENT, entries: [...entries, ...retime], notes })
}
