// FILM-2019 AC4: a graphic's text in another language, refit to the room the
// master's design gave it. Per text slot (remotion/layout.js textSlots: the
// line width, the largest font size, the lines' room):
//
//   1. the font size comes down, as far as the floor (REFIT_FONT_FLOOR of
//      the slot's largest size), to keep the text on one line;
//   2. at the floor, the text wraps onto as many lines as the slot holds;
//   3. the clip is lengthened, by as much as DURATION_EXTENSION_CAP, when
//      the localized text takes longer to read than the master's.
//
// Text that still does not fit (more lines than the slot holds, or a word
// wider than a line) is the QA issue localized_text_exceeds_container,
// naming the element (the clip). The result's `fit` goes to the render
// (compositionRenderer, the Remotion engine's inputProps.fit) and the
// components draw each slot at the measured size on the measured lines, so
// what was measured is what is drawn.
//
// Measurement is a model, the same in Node and in any renderer: advance
// widths in em per character class, the full-width scripts (Han, kana,
// Hangul, full-width forms) at 1 em, combining marks at none, Indic letters
// wider than Latin, and bold (600 and up: the slot's weight, which the
// component draws at) BOLD_WIDTH wider. It is set to measure a little wide
// of what Chrome draws in a wide fallback sans (measured on Linux in
// tests/studio/composition-remotion.test.mjs), so text measured to fit is
// not clipped. Pure.
import { LINE_HEIGHT, footprintFor, textSlots } from '../compositions/remotion/layout.js'
import { getComposition } from '../compositions/catalogue.js'

export const REFIT_FONT_FLOOR = 0.7
export const DURATION_EXTENSION_CAP = 0.2
export const LOCALIZED_TEXT_EXCEEDS_CONTAINER = 'localized_text_exceeds_container'
export const GRAPHIC_TEXT_UNTRANSLATED = 'graphic_text_untranslated'
// Reading speed in characters a second (subtitle practice): the full-width
// scripts carry a word in one or two characters and read slower per character.
export const READING_RATE = Object.freeze({ fullWidth: 8, other: 17 })
export const BOLD_WIDTH = 1.13

const EPS = 1e-9
const round3 = (value) => Math.round(value * 1000) / 1000

const FULL_WIDTH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF01-\uFF60\uFFE0-\uFFE6]/u
const COMBINING = /[\p{Mn}\p{Me}\u200B-\u200D\uFE0F]/u
const SPACING_MARK = /\p{Mc}/u
const INDIC = /[\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u
const NARROW = /[iljtfrI.,;:'!|()[\]{}"`]/
const WIDE = /[mwMW@%&]/
const EMOJI = /\p{Extended_Pictographic}/u

// One character's advance in em, at a regular weight.
export function advanceEm(char) {
  if (char === ' ' || char === '\u00A0') return 0.32
  if (COMBINING.test(char)) return 0
  if (FULL_WIDTH.test(char) || EMOJI.test(char)) return 1
  if (SPACING_MARK.test(char)) return 0.32
  if (INDIC.test(char)) return 0.72
  if (NARROW.test(char)) return 0.34
  if (WIDE.test(char)) return 0.96
  if (/\p{Lu}/u.test(char)) return 0.76
  if (/\p{Nd}/u.test(char)) return 0.64
  return 0.62
}

const weightFactor = (weight) => (Number(weight) >= 600 ? BOLD_WIDTH : 1)

// A string's width in em on one line, at a font weight (400 when none).
export const measureEm = (text, { weight = 400 } = {}) => [...String(text ?? '')].reduce((sum, char) => sum + advanceEm(char), 0) * weightFactor(weight)

// Where a line may break: between words, and between full-width characters
// (Chinese and Japanese set no spaces). A run of other characters is one
// word and never breaks inside.
function segments(text) {
  const out = []
  let word = ''
  let spaceBefore = false
  const push = () => {
    if (word) out.push({ text: word, spaceBefore })
    word = ''
    spaceBefore = false
  }
  for (const char of String(text ?? '')) {
    if (/\s/u.test(char)) {
      push()
      spaceBefore = out.length > 0
    } else if (FULL_WIDTH.test(char)) {
      const space = spaceBefore
      push()
      out.push({ text: char, spaceBefore: space })
    } else {
      word += char
    }
  }
  push()
  return out
}

// Greedy lines of at most `widthEm`; `overlong` when a word alone is wider.
export function wrapLines(text, widthEm, { weight = 400 } = {}) {
  const factor = weightFactor(weight)
  const lines = []
  let line = ''
  let lineEm = 0
  let overlong = false
  for (const segment of segments(text)) {
    const em = measureEm(segment.text, { weight })
    if (em > widthEm + EPS) overlong = true
    const gap = line && segment.spaceBefore ? advanceEm(' ') * factor : 0
    if (line && lineEm + gap + em > widthEm + EPS) {
      lines.push(line)
      line = segment.text
      lineEm = em
    } else {
      line += gap ? ` ${segment.text}` : segment.text
      lineEm += gap + em
    }
  }
  if (line) lines.push(line)
  return { lines: lines.length ? lines : [''], overlong }
}

// The lines a slot holds at a font size.
export const slotMaxLines = (slot, fontSize) => slot.maxLines ?? Math.max(1, Math.floor(slot.height / (fontSize * LINE_HEIGHT) + EPS))

// One slot: {fontScale, lines, fits, maxLines, step}. step is what it took:
// 'none', 'shrink' or 'wrap'.
export function refitSlot(slot, { floor = REFIT_FONT_FLOOR } = {}) {
  const em = measureEm(slot.text, { weight: slot.weight })
  const oneLine = em > 0 ? slot.width / em : Infinity
  if (oneLine >= slot.maxFont - EPS) return { key: slot.key, text: slot.text, fontScale: 1, lines: [slot.text], fits: true, maxLines: slotMaxLines(slot, slot.maxFont), step: 'none' }
  if (oneLine >= slot.maxFont * floor - EPS) return { key: slot.key, text: slot.text, fontScale: round3(Math.floor((oneLine / slot.maxFont) * 1000) / 1000), lines: [slot.text], fits: true, maxLines: slotMaxLines(slot, oneLine), step: 'shrink' }
  const fontSize = slot.maxFont * floor
  const { lines, overlong } = wrapLines(slot.text, slot.width / fontSize, { weight: slot.weight })
  const maxLines = slotMaxLines(slot, fontSize)
  return { key: slot.key, text: slot.text, fontScale: floor, lines, fits: !overlong && lines.length <= maxLines, maxLines, overlong, step: 'wrap' }
}

// Seconds to read a text: characters over the script's reading rate
// (combining marks and spaces are not read).
export function readingSeconds(text) {
  let seconds = 0
  for (const char of String(text ?? '')) {
    if (/\s/u.test(char) || COMBINING.test(char)) continue
    seconds += 1 / (FULL_WIDTH.test(char) ? READING_RATE.fullWidth : READING_RATE.other)
  }
  return seconds
}

// The words of a primitive's text props, in order (catalogue textProps;
// 'items.label' is each item's label).
export function textOf(compositionId, props = {}) {
  const primitive = getComposition(compositionId)
  return (primitive?.textProps || []).flatMap((path) => {
    const [head, tail] = path.split('.')
    const value = props?.[head]
    if (tail) return Array.isArray(value) ? value.map((item) => String(item?.[tail] ?? '')) : []
    return typeof value === 'string' ? [value] : []
  }).filter((text) => text.trim())
}

// The whole graphic. `props` are the localized props (defaults filled),
// `masterProps` the master's, `frame` the render's {width, height},
// `durationSeconds` the clip's length and `maxDurationSeconds` the most it
// may run before it would lengthen the program.
export function refitGraphic({ compositionId, props, masterProps, frame, durationSeconds, maxDurationSeconds = Infinity, floor = REFIT_FONT_FLOOR, cap = DURATION_EXTENSION_CAP }) {
  const box = footprintFor(compositionId, props, frame)
  const slots = textSlots(compositionId, props, box).map((slot) => refitSlot(slot, { floor }))
  const master = textOf(compositionId, masterProps).join(' ')
  const localized = textOf(compositionId, props).join(' ')
  const masterSeconds = readingSeconds(master)
  const readingRatio = masterSeconds > 0 ? readingSeconds(localized) / masterSeconds : 1
  const duration = Number(durationSeconds)
  const wanted = duration * Math.max(1, readingRatio)
  const limit = Math.max(duration, Math.min(duration * (1 + cap), Number(maxDurationSeconds)))
  const fitted = round3(Math.min(wanted, limit))
  return {
    fits: slots.every((slot) => slot.fits),
    fit: { slots: Object.fromEntries(slots.map((slot) => [slot.key, { fontScale: slot.fontScale, lines: slot.lines }])) },
    slots,
    box,
    durationSeconds: fitted,
    extendedSeconds: round3(fitted - duration),
    readingRatio: round3(readingRatio),
    durationCapped: wanted > limit + 1e-6,
  }
}

const quote = (text) => `"${String(text).slice(0, 80)}${String(text).length > 80 ? '…' : ''}"`

// The QA issue for a graphic whose localized text does not fit.
export function exceedsContainerIssue({ clipId, compositionId, language, result = null, reason = null, timeRange = null, floor = REFIT_FONT_FLOOR }) {
  const parts = reason ? [reason] : result.slots.filter((slot) => !slot.fits).map((slot) => (slot.overlong
    ? `${slot.key} ${quote(slot.text)} has a word wider than its line at the ${Math.round(floor * 100)}% font floor`
    : `${slot.key} ${quote(slot.text)} needs ${slot.lines.length} lines at the ${Math.round(floor * 100)}% font floor and holds ${slot.maxLines}`))
  return {
    type: LOCALIZED_TEXT_EXCEEDS_CONTAINER,
    severity: 0.6,
    timeRange,
    scene: null,
    detail: `localized text exceeds container: graphic ${clipId} (${compositionId}) in ${language}: ${parts.join('; ')}. Shorten the ${language} text (studio_create_variant graphics) or give the graphic more room.`.slice(0, 2000),
  }
}

// The QA note for a graphic shown in the master's words.
export const untranslatedIssue = ({ clipId, compositionId, language, paths, timeRange = null }) => ({
  type: GRAPHIC_TEXT_UNTRANSLATED,
  severity: 0.3,
  timeRange,
  scene: null,
  detail: `The ${language} render shows graphic ${clipId} (${compositionId}) in the master's words (${paths.join(', ')}): no ${language} text was given for it. Pass graphics: {"${clipId}": {"${paths[0]}": "…"}} to studio_create_variant to translate it.`.slice(0, 2000),
})
