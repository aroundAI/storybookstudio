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
import { DIRECTION_VECTORS } from './pointer.js'

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

// FILM-2019: the line height of text a refit wraps onto more than one line.
export const LINE_HEIGHT = 1.15

// The callout's bubble inside its footprint, clear of the side the tail
// leaves from.
export function calloutBubble(box, pointer) {
  const [dx, dy] = DIRECTION_VECTORS[pointer] || DIRECTION_VECTORS['down-left']
  const tail = Math.min(box.width, box.height) * 0.3
  const left = dx < 0 ? tail : 0
  const right = dx > 0 ? tail : 0
  const top = dy < 0 ? tail : 0
  const bottom = dy > 0 ? tail : 0
  return { dx, dy, tail, left, top, width: box.width - left - right, height: box.height - top - bottom }
}

export const lowerThirdNameHeight = (box, props) => Math.round(box.height * (props.title ? 0.58 : 1))

export function chartRows(box, props) {
  const pad = Math.round(box.height * 0.06)
  return { pad, titleHeight: props.title ? Math.round(box.height * 0.13) : 0, labelHeight: Math.round(box.height * 0.1), valueHeight: Math.round(box.height * 0.09), slot: (box.width - pad * 2) / props.items.length }
}

export function timelineRows(box, props) {
  const titleHeight = props.title ? Math.round(box.height * 0.2) : 0
  return { titleHeight, slot: Math.min(box.width / props.points.length, box.width / 3), rowHeight: (box.height - titleHeight) * 0.3 }
}

export const mapLabelHeight = (box, props) => Math.round(Math.min(box.width, box.height) * (props.caption ? 0.26 : 0.18))
export const progressLabelHeight = (box) => Math.round(box.height * 0.42)

const counterNumber = (props) => `${props.prefix ?? ''}${Number(props.to ?? 0).toLocaleString('en-US', { minimumFractionDigits: props.decimals ?? 0, maximumFractionDigits: props.decimals ?? 0 })}${props.suffix ?? ''}`

// FILM-2019: every piece of text a primitive draws, as a slot: its key, the
// text, the width a line may take, the largest font size the design draws it
// at (maxFont: the master draws it at that size or, when it would not fit on
// one line, smaller, fitFont), and the room its lines have (height, or
// maxLines). The components size their text from these slots and the
// localized refit (localization/refit.js) measures against the same ones, so
// what a language render measured is what it draws.
export function textSlots(compositionId, props, box) {
  const size = Math.min(box.width, box.height)
  const slot = (key, text, weight, width, maxFont, room) => ({ key, text: String(text ?? ''), weight, width, maxFont, ...room })
  switch (compositionId) {
    case 'text':
      return [
        slot('text', props.text, 800, box.width * 0.9, box.height * (props.subtitle ? 0.42 : 0.55), { height: box.height * (props.subtitle ? 0.62 : 0.9) }),
        ...(props.subtitle ? [slot('subtitle', props.subtitle, 500, box.width * 0.9, box.height * 0.2, { height: box.height * 0.28 })] : []),
      ]
    case 'counter':
      return [
        slot('number', counterNumber(props), 800, box.width * 0.86, box.height * (props.label ? 0.5 : 0.62), { maxLines: 1 }),
        ...(props.label ? [slot('label', props.label, 600, box.width * 0.86, box.height * 0.16, { height: box.height * 0.3 })] : []),
      ]
    case 'callout': {
      const bubble = calloutBubble(box, props.pointer)
      return [slot('text', props.text, 700, bubble.width * 0.88, bubble.height * 0.42, { height: bubble.height * 0.9 })]
    }
    case 'arrow':
      return props.label ? [slot('label', props.label, 700, box.width * 0.95, size * 0.14, { height: size * 0.3 })] : []
    case 'highlight': {
      const maxFont = Math.max(12, size * 0.12)
      return props.label ? [slot('label', props.label, 700, box.width * 0.8, maxFont, { height: maxFont * 1.7 })] : []
    }
    case 'lower-third': {
      const nameHeight = lowerThirdNameHeight(box, props)
      return [
        slot('name', props.name, 800, box.width * 0.85, nameHeight * 0.6, { height: nameHeight }),
        ...(props.title ? [slot('title', props.title, 500, box.width * 0.7, (box.height - nameHeight) * 0.62, { height: box.height - nameHeight })] : []),
      ]
    }
    case 'chart': {
      const rows = chartRows(box, props)
      return [
        ...(props.title ? [slot('title', props.title, 800, box.width - rows.pad * 2, rows.titleHeight * 0.8, { height: rows.titleHeight })] : []),
        ...props.items.map((item, index) => slot(`items.label.${index}`, item.label, 500, rows.slot * 0.92, rows.labelHeight * 0.75, { height: rows.labelHeight })),
      ]
    }
    case 'map': {
      const labelHeight = mapLabelHeight(box, props)
      return [
        slot('place', props.place, 800, box.width * 0.95, size * 0.13, { height: labelHeight * (props.caption ? 0.6 : 1) }),
        ...(props.caption ? [slot('caption', props.caption, 500, box.width * 0.95, size * 0.075, { height: labelHeight * 0.4 })] : []),
      ]
    }
    case 'timeline': {
      const rows = timelineRows(box, props)
      return [
        ...(props.title ? [slot('title', props.title, 800, box.width * 0.9, rows.titleHeight * 0.7, { height: rows.titleHeight })] : []),
        ...props.points.map((point, index) => (point.label ? slot(`points.label.${index}`, point.label, 500, rows.slot * 0.9, rows.rowHeight * 0.55, { height: rows.rowHeight }) : null)).filter(Boolean),
      ]
    }
    case 'progress-bar': {
      const labelHeight = progressLabelHeight(box)
      return [slot('label', `${props.label} 100%`, 700, box.width, labelHeight * 0.8, { maxLines: 1 })]
    }
    default:
      return []
  }
}

export const slotsByKey = (compositionId, props, box) => Object.fromEntries(textSlots(compositionId, props, box).map((entry) => [entry.key, entry]))

// The font size a slot is drawn at: the master's one-line fit, or a
// language render's refit (fit.slots[key].fontScale of the slot's maxFont).
export function slotFontSize(slot, fit) {
  const fitted = fit?.slots?.[slot?.key]
  return fitted ? slot.maxFont * fitted.fontScale : fitFont(slot?.text, slot?.width, slot?.maxFont)
}

// The lines a slot is drawn on: the refit's, else its text on one line.
export const slotLines = (slot, fit) => fit?.slots?.[slot?.key]?.lines || [slot?.text ?? '']
