// FILM-2018: where a primitive sits in the frame. Every primitive draws
// inside one box, its footprint, and nothing outside it (the components clip
// to it). The footprint sits inside the aspect's safe rectangle
// (captions/layout.js SAFE_AREAS: 9:16 keeps clear of the bottom 25 % and the
// right-hand action rail), so a counter in a corner stays clear of the
// platform's controls on 16:9 and 9:16 alike. FILM-2014's graphic checks
// (review/qaChecks.js graphicIssues) measure the same footprint, so the
// render, the safe-area check and the caption-overlap check cannot disagree.
// Pure: the Remotion components and the QA in Node both import it.
import { aspectOf, safeAreaFor, safeRectPx } from '../../captions/layout.js'

// [width, height] in units of the safe rectangle's short side; a size over
// what the safe rectangle holds is cut to it. Highlight has no entry: its
// box is the region it outlines.
export const PRIMITIVE_BOXES = Object.freeze({
  text: [1.6, 0.3],
  counter: [0.6, 0.36],
  callout: [0.75, 0.34],
  arrow: [0.32, 0.32],
  'lower-third': [1.1, 0.24],
  chart: [1.2, 0.8],
  map: [0.7, 0.7],
  timeline: [1.6, 0.42],
  'progress-bar': [1.4, 0.16],
})

export const safeRectFor = ({ width, height, aspect = null }) => safeRectPx(safeAreaFor(aspect || aspectOf(width, height)), width, height)

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const fraction = (value, fallback) => (Number.isFinite(Number(value)) ? clamp(Number(value), 0, 1) : fallback)

export function anchorParts(anchor = 'center') {
  if (anchor === 'center') return ['center', 'center']
  if (anchor === 'top' || anchor === 'bottom') return [anchor, 'center']
  if (anchor === 'left' || anchor === 'right') return ['center', anchor]
  return String(anchor).split('-')
}

// A highlight's region, as fractions of the frame, cut to the safe rectangle;
// whole pixels, a pixel in, so no edge rounds out of it.
function regionBox(props, frame, safe) {
  const x = fraction(props.x, 0.3)
  const y = fraction(props.y, 0.3)
  const left = Math.max(safe.x, x * frame.width)
  const top = Math.max(safe.y, y * frame.height)
  const right = Math.min(safe.x + safe.width, Math.min(1, x + fraction(props.width, 0.4)) * frame.width)
  const bottom = Math.min(safe.y + safe.height, Math.min(1, y + fraction(props.height, 0.4)) * frame.height)
  const width = Math.max(2, right - left)
  const height = Math.max(2, bottom - top)
  return {
    x: Math.ceil(Math.min(left, safe.x + safe.width - Math.ceil(width))),
    y: Math.ceil(Math.min(top, safe.y + safe.height - Math.ceil(height))),
    width: Math.floor(width) - 1,
    height: Math.floor(height) - 1,
  }
}

// The box a primitive draws in, in pixels of `frame` ({width, height,
// aspect?}): {x, y, width, height}.
export function footprintFor(compositionId, props = {}, frame) {
  const exact = safeRectFor(frame)
  if (compositionId === 'highlight') return regionBox(props, frame, exact)
  // Whole pixels inside the safe rectangle, so no edge rounds out of it.
  const left = Math.ceil(exact.x)
  const top = Math.ceil(exact.y)
  const safe = { x: left, y: top, width: Math.floor(exact.x + exact.width) - left, height: Math.floor(exact.y + exact.height) - top }
  const [unitsWide, unitsHigh] = PRIMITIVE_BOXES[compositionId] || PRIMITIVE_BOXES.text
  const unit = Math.min(safe.width, safe.height)
  const width = Math.floor(Math.min(safe.width, unitsWide * unit))
  const height = Math.floor(Math.min(safe.height, unitsHigh * unit))
  const [vertical, horizontal] = anchorParts(props.anchor)
  const x = horizontal === 'left' ? safe.x : horizontal === 'right' ? safe.x + safe.width - width : safe.x + Math.floor((safe.width - width) / 2)
  const y = vertical === 'top' ? safe.y : vertical === 'bottom' ? safe.y + safe.height - height : safe.y + Math.floor((safe.height - height) / 2)
  return { x, y, width, height }
}

// The footprint as an absolutely placed box that clips what it holds.
export const boxStyle = (box) => ({ position: 'absolute', left: box.x, top: box.y, width: box.width, height: box.height, overflow: 'hidden', boxSizing: 'border-box' })

// A font size that fits `text` on one line in `width` (the wide average
// glyph of captions/layout.js approximateMeasure), at most `max`.
export const fitFont = (text, width, max) => Math.max(8, Math.floor(Math.min(max, width / Math.max(1, String(text || '').length * 0.6))))

// A brand font first, then fonts every platform has.
export const fontStack = (family) => `${family ? `"${String(family).replace(/"/g, '')}", ` : ''}system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`
