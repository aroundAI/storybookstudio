// FILM-2018: where a graphic lands against the captions. studio_add_graphic
// picks an anchor that keeps the graphic clear of the captions on screen
// with it, and FILM-2014's QA (review/qaChecks.js graphicIssues) fails a
// graphic that covers a caption. Both measure here,
// on the same footprint the Remotion component draws in (remotion/layout.js)
// and the same caption block the caption QA measures (captions/layout.js
// layoutCue, placed for the aspect's safe area). Pure.
import { approximateMeasure, aspectOf, layoutCue, safeAreaFor } from '../captions/layout.js'
import { footprintFor, safeRectFor } from './remotion/layout.js'

const EPS = 1e-6
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

export const frameOf = ({ width, height, aspect = null }) => ({ width, height, aspect: aspect || aspectOf(width, height) })

export const rectsOverlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

// Is a pixel rectangle inside the frame's safe rectangle (the footprints are, by construction)?
export const insideSafeArea = (rect, frame, epsilon = 0.5) => {
  const safe = safeRectFor(frame)
  return rect.x >= safe.x - epsilon && rect.y >= safe.y - epsilon
    && rect.x + rect.width <= safe.x + safe.width + epsilon && rect.y + rect.height <= safe.y + safe.height + epsilon
}

export const graphicFootprint = (compositionId, props, frame) => footprintFor(compositionId, props, frame)

// The caption blocks on screen during [start, end): one per cue of every
// enabled captions clip on a visible track, laid out for the frame's safe
// area. → [{clipId, cueId, start, end, text, box}]
export function captionBlocks(timeline, { start = 0, end = Infinity, width, height, aspect = null, measure = approximateMeasure } = {}) {
  const frame = frameOf({ width, height, aspect })
  const hidden = new Set((timeline?.tracks || []).filter((track) => track.visible === false).map((track) => track.id))
  const blocks = []
  for (const clip of timeline?.clips || []) {
    if (clip.type !== 'captions' || clip.enabled === false || hidden.has(clip.trackId)) continue
    const clipStart = num(clip.startTime)
    const clipEnd = clipStart + num(clip.duration)
    const offset = clipStart - num(clip.trimStart)
    for (const cue of clip.captions?.cues || []) {
      const cueStart = Math.max(clipStart, offset + num(cue.start))
      const cueEnd = Math.min(clipEnd, offset + num(cue.end))
      if (cueEnd <= cueStart + EPS || cueEnd <= start + EPS || cueStart >= end - EPS) continue
      const placed = { ...cue, globalOverrides: { ...(cue.globalOverrides || {}), safeArea: safeAreaFor(frame.aspect) } }
      blocks.push({ clipId: clip.id, cueId: cue.id ?? null, start: cueStart, end: cueEnd, text: String(cue.text || ''), box: layoutCue(placed, { width, height, measure }).box })
    }
  }
  return blocks
}

// The caption blocks a graphic's footprint covers while both are on screen.
export function captionsCovered({ compositionId, props, start, end, timeline, frame }) {
  const box = graphicFootprint(compositionId, props, frame)
  return captionBlocks(timeline, { start, end, ...frame }).filter((block) => rectsOverlap(box, block.box))
}
