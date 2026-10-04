// FILM-2016 AC5: where a caption block sits. One function lays a cue out
// inside the aspect's safe rectangle; the live-captions renderer draws what
// it returns (kineticCaptionRenderer, when a cue carries a safe area) and
// the QA caption check measures the same thing, so preview, export and QA
// cannot disagree. Pure: text is measured by the caller's `measure`.
//
// Safe rectangles, as fractions of the frame kept clear on each side:
//   16:9  bottom 10 %
//   9:16  bottom 25 % (platform caption, buttons) and right 15 % (action rail)
//   1:1   bottom 12 %
// Sides and top keep the 5 % title-safe margin (9:16 top 8 %, the status
// and search overlays), a lead default the owner may change.

export const SAFE_AREAS = Object.freeze({
  '16:9': Object.freeze({ left: 0.05, right: 0.05, top: 0.05, bottom: 0.1 }),
  '9:16': Object.freeze({ left: 0.05, right: 0.15, top: 0.08, bottom: 0.25 }),
  '1:1': Object.freeze({ left: 0.05, right: 0.05, top: 0.05, bottom: 0.12 }),
})

const ASPECT_RATIOS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 }

export function aspectOf(width, height) {
  const ratio = Number(width) / Number(height)
  if (!(ratio > 0)) return '16:9'
  return Object.entries(ASPECT_RATIOS).reduce((best, [name, value]) => (
    Math.abs(Math.log(value / ratio)) < Math.abs(Math.log(ASPECT_RATIOS[best] / ratio)) ? name : best
  ), '16:9')
}

export const safeAreaFor = (aspect) => SAFE_AREAS[aspect] || SAFE_AREAS[aspectOf(...String(aspect).split(':').map(Number))]

export function safeRectPx(safeArea, width, height) {
  return {
    x: safeArea.left * width,
    y: safeArea.top * height,
    width: (1 - safeArea.left - safeArea.right) * width,
    height: (1 - safeArea.top - safeArea.bottom) * height,
  }
}

// Without a canvas (QA in the main process, tests): a deliberately wide
// average glyph, so a block that fits here fits when drawn.
export const approximateMeasure = (text, size) => String(text).length * size * 0.6

export const normalizeWord = (word) => String(word).toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')

export const EMPHASIS_SCALE = 1.15
const MIN_FONT_SIZE = 12

function wrap(words, maxWidth, maxChars, widthOf) {
  const lines = []
  let current = []
  for (const word of words) {
    const candidate = [...current, word]
    const text = candidate.map((entry) => entry.text).join(' ')
    if (current.length && (widthOf(candidate) > maxWidth || (maxChars && text.length > maxChars))) {
      lines.push(current)
      current = [word]
    } else {
      current = candidate
    }
  }
  if (current.length) lines.push(current)
  return lines
}

// → { fontSize, padding, lineHeight, box: {x, y, width, height}, safeRect,
//     lines: [{ baseline, x, width, words: [{ text, x, width, size, emphasized }] }] }
export function layoutSubtitleBlock({
  width,
  height,
  text,
  fontSize,
  measure = approximateMeasure,
  safeArea = SAFE_AREAS['16:9'],
  position = 'bottom',
  maxCharsPerLine = null,
  emphasisWords = [],
  emphasisStyle = 'none',
  paddingRatio = 0.6,
  lineHeightRatio = 1.3,
  verticalOffset = 0,
}) {
  const safe = safeRectPx(safeArea, width, height)
  const emphasized = new Set((emphasisWords || []).map(normalizeWord).filter(Boolean))
  const raw = String(text || '').trim().split(/\s+/).filter(Boolean)

  let size = fontSize
  for (;;) {
    const padding = size * paddingRatio
    const lineHeight = size * lineHeightRatio
    const gap = measure(' ', size)
    const words = raw.map((word) => {
      const isEmphasized = emphasisStyle !== 'none' && emphasized.has(normalizeWord(word))
      const wordSize = isEmphasized && emphasisStyle === 'scale' ? size * EMPHASIS_SCALE : size
      return { text: word, size: wordSize, emphasized: isEmphasized, width: measure(word, wordSize) }
    })
    const widthOf = (line) => line.reduce((sum, word) => sum + word.width, 0) + gap * Math.max(0, line.length - 1)
    const maxTextWidth = safe.width - padding * 2
    const lines = wrap(words, maxTextWidth, maxCharsPerLine, widthOf)
    const widest = Math.max(0, ...lines.map(widthOf))
    const boxHeight = lines.length * lineHeight + padding * 2
    if ((widest > maxTextWidth || boxHeight > safe.height) && size > MIN_FONT_SIZE) {
      size = Math.max(MIN_FONT_SIZE, size * 0.9)
      continue
    }
    const boxWidth = Math.min(safe.width, widest + padding * 2)
    const centerX = safe.x + safe.width / 2
    let boxY
    if (position === 'top') boxY = safe.y
    else if (position === 'center') boxY = safe.y + (safe.height - boxHeight) / 2
    else boxY = safe.y + safe.height - boxHeight
    if (Number.isFinite(verticalOffset) && verticalOffset) boxY += verticalOffset * height
    boxY = Math.min(Math.max(boxY, safe.y), Math.max(safe.y, safe.y + safe.height - boxHeight))

    return {
      fontSize: size,
      padding,
      lineHeight,
      safeRect: safe,
      box: { x: centerX - boxWidth / 2, y: boxY, width: boxWidth, height: boxHeight },
      lines: lines.map((line, index) => {
        const lineWidth = widthOf(line)
        let x = centerX - lineWidth / 2
        const placed = line.map((word) => {
          const entry = { ...word, x }
          x += word.width + gap
          return entry
        })
        return { baseline: boxY + padding + (index + 0.75) * lineHeight, x: centerX - lineWidth / 2, width: lineWidth, words: placed }
      }),
    }
  }
}

// The layout the renderer draws for one cue at a frame size.
export function layoutCue(cue, { width, height, measure = approximateMeasure }) {
  const g = cue.globalOverrides || {}
  const sizeScale = Number.isFinite(Number(g.sizeScale)) ? Math.min(2, Math.max(0.3, Number(g.sizeScale))) : 1
  return layoutSubtitleBlock({
    width,
    height,
    text: cue.text,
    fontSize: Math.min(96, Math.max(16, Math.round(Math.min(width, height) * 0.045 * sizeScale))),
    measure,
    safeArea: g.safeArea || safeAreaFor(aspectOf(width, height)),
    position: g.subtitlePosition === 'top' || g.subtitlePosition === 'center' ? g.subtitlePosition : 'bottom',
    maxCharsPerLine: g.maxCharsPerLine || null,
    emphasisWords: g.emphasisWords || [],
    emphasisStyle: g.emphasisStyle || 'none',
    verticalOffset: Number(g.verticalOffset) || 0,
  })
}

// Is a laid-out block inside its safe rectangle (glyph top ≈ baseline − size)?
export function blockInsideSafeRect(layout, epsilon = 0.5) {
  const { box, safeRect: safe } = layout
  const inside = (left, top, right, bottom) => left >= safe.x - epsilon && top >= safe.y - epsilon
    && right <= safe.x + safe.width + epsilon && bottom <= safe.y + safe.height + epsilon
  if (!inside(box.x, box.y, box.x + box.width, box.y + box.height)) return false
  return layout.lines.every((line) => line.words.every((word) => inside(word.x, line.baseline - word.size, word.x + word.width, line.baseline + word.size * 0.3)))
}
