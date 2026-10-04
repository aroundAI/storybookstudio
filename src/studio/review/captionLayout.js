// FILM-2014: where a caption cue lands on the frame, as a rectangle in
// fractions of the frame (x, y from the top-left), for the preview burn-in.
// A cue FILM-2016 placed is laid out by captions/layout.js layoutCue, the
// layout the renderer and the QA check use; an unplaced cue by the model of
// the upstream editor's own subtitle box below. The traditional subtitle box follows
// src/utils/kineticCaptionRenderer.js renderTraditionalSubtitle (font size,
// padding, 88% wrap width, action-safe/title-safe/center, verticalOffset,
// 4% clamp); kinetic presets are approximated by their anchor and two lines.
// Text width is estimated at AVERAGE_CHAR_EM of the font size per character,
// so the box is a model, not a measurement; the clip's transform position
// (timeline px, as set_clip_style writes it) moves the whole layer.

import { layoutCue } from '../captions/layout.js'

export const AVERAGE_CHAR_EM = 0.55
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const percent = (value, fallback, min = 0, max = 100) => clamp(num(Number(value), fallback), min, max)

const TRADITIONAL_PRESETS = new Set(['kinetic-traditional'])

export function wrapLines(text, maxChars) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (candidate.length <= maxChars || !line) line = candidate
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

// {x, y, width, height} in frame fractions, plus pixel values and the font
// size, for one cue of a captions clip on a width x height frame.
export function cueRect(cue, clip, { width, height }) {
  // A cue FILM-2016 placed (globalOverrides.safeArea) is drawn by its layout.
  if (cue?.globalOverrides?.safeArea) {
    const layout = layoutCue(cue, { width, height })
    const shiftX = num(Number(clip?.transform?.positionX), 0)
    const shiftY = num(Number(clip?.transform?.positionY), 0)
    const box = { x: layout.box.x + shiftX, y: layout.box.y + shiftY, width: layout.box.width, height: layout.box.height }
    return {
      x: box.x / width,
      y: box.y / height,
      width: box.width / width,
      height: box.height / height,
      px: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      fontSize: Math.round(layout.fontSize),
      lines: layout.lines.map((line) => line.words.map((word) => word.text).join(' ')),
      traditional: true,
    }
  }
  const style = clip?.captions?.preset || {}
  const g = cue?.globalOverrides && typeof cue.globalOverrides === 'object' ? cue.globalOverrides : {}
  const presetId = style.id || 'kinetic-pop'
  const traditional = TRADITIONAL_PRESETS.has(presetId) || style.traditional === true
  const sizeMultiplier = clamp(num(Number(g.sizeScale), 1), 0.3, 2)
  const transform = clip?.transform || {}
  const shiftX = num(Number(transform.positionX), 0)
  const shiftY = num(Number(transform.positionY), 0)

  let fontSize
  let lines
  let blockWidth
  let blockHeight
  let blockY
  if (traditional) {
    fontSize = clamp(Math.round(Math.min(width, height) * 0.045 * sizeMultiplier), 16, 96)
    const lineHeight = fontSize * 1.3
    const padding = (fontSize * percent(g.backgroundPadding, 60, 10, 90)) / 100
    const maxChars = Math.max(1, Math.floor((width * 0.88) / (fontSize * AVERAGE_CHAR_EM)))
    lines = wrapLines(cue?.text, maxChars)
    blockHeight = lines.length * lineHeight + padding * 2
    blockWidth = Math.max(...lines.map((l) => l.length), 1) * fontSize * AVERAGE_CHAR_EM + padding * 2
    const position = g.subtitlePosition || style.subtitlePosition || 'action-safe'
    if (position === 'title-safe') blockY = height - blockHeight - height * 0.15
    else if (position === 'center') blockY = (height - blockHeight) / 2
    else blockY = height - blockHeight - height * 0.06
    blockY += clamp(num(Number(g.verticalOffset), 0), -0.45, 0.45) * height
    const margin = height * 0.04
    blockY = clamp(blockY, margin, Math.max(margin, height - blockHeight - margin))
  } else {
    // Kinetic: a word block of up to two lines around an anchor.
    fontSize = clamp(Math.round(Math.min(width, height) * 0.075 * sizeMultiplier), 16, 160)
    const maxChars = Math.max(1, Math.floor((width * 0.8) / (fontSize * AVERAGE_CHAR_EM)))
    lines = wrapLines(cue?.text, maxChars).slice(0, 2)
    blockHeight = lines.length * fontSize * 1.15 + fontSize * 0.4
    blockWidth = Math.max(...lines.map((l) => l.length), 1) * fontSize * AVERAGE_CHAR_EM
    const placement = g.verticalPlacement || 'auto'
    let anchorY = height * 0.5
    if (placement === 'top') anchorY = height * 0.28
    if (placement === 'bottom') anchorY = height * 0.72
    anchorY += clamp(num(Number(g.verticalOffset), 0), -0.45, 0.45) * height
    blockY = anchorY - blockHeight / 2
  }
  const x = (width - blockWidth) / 2 + shiftX
  const y = blockY + shiftY
  return {
    x: x / width,
    y: y / height,
    width: blockWidth / width,
    height: blockHeight / height,
    px: { x: Math.round(x), y: Math.round(y), width: Math.round(blockWidth), height: Math.round(blockHeight) },
    fontSize,
    lines,
    traditional,
  }
}
