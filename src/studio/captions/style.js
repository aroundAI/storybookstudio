// FILM-2016 AC5, AC6: brand captions. BrandSchema.captionStyle (FILM-2004)
// becomes the style of Velorn's live captions clip (clip.captions.preset)
// plus per-cue globalOverrides, which kineticCaptionRenderer's subtitle path
// reads: colours, box or outline, size, the safe rectangle for the aspect,
// max characters per line, and emphasis words. checkCaptionSafeArea is the
// QA caption check (FILM-2014's qa.js calls it): the same layout the
// renderer draws, against the same rectangle. Pure: no stores, no DOM.
import { BrandSchema } from '../contracts/brand.schema.mjs'
import { EditPolicySchema } from '../contracts/edit-policy.schema.mjs'
import { approximateMeasure, aspectOf, blockInsideSafeRect, layoutCue, normalizeWord, safeAreaFor } from './layout.js'

export { SAFE_AREAS, safeAreaFor, safeRectPx, aspectOf, layoutSubtitleBlock, layoutCue, blockInsideSafeRect } from './layout.js'

export const STUDIO_CAPTION_PRESET_ID = 'kinetic-traditional'
// The subtitle renderer sizes text at 4.5 % of the short side; BrandSchema
// gives pixels at 1080p, so 48 px at 1080 is a scale of 48 / 48.6.
export const RENDERER_BASE_SIZE_AT_1080 = 1080 * 0.045
const DEFAULT_OPACITY = 65

const BACKGROUND_TO_TEXT_STYLE = { box: 'background', outline: 'outline', none: 'none' }

const hexAlphaPercent = (hex) => (/^#[0-9a-fA-F]{8}$/.test(hex) ? Math.round((parseInt(hex.slice(7, 9), 16) / 255) * 100) : null)
const hex6 = (hex) => String(hex).slice(0, 7)

// Emphasis words: BrandSchema has the emphasis *style* (none | color |
// scale) but no word list yet, so the words come from the call (the
// studio_add_captions style) or an unparsed brand's captionStyle.emphasisWords.
export function emphasisWordsFrom({ brand = null, style = null } = {}) {
  const fromStyle = Array.isArray(style?.emphasisWords) ? style.emphasisWords : []
  const fromBrand = Array.isArray(brand?.captionStyle?.emphasisWords) ? brand.captionStyle.emphasisWords : []
  return [...new Set([...fromStyle, ...fromBrand].map((word) => String(word).trim()).filter(Boolean))]
}

export const emphasisWordsIn = (text, words) => {
  const wanted = new Set((words || []).map(normalizeWord))
  return String(text || '').split(/\s+/).filter((word) => wanted.has(normalizeWord(word)))
}

// The clip-level preset: the renderer's subtitle style in the brand's font
// and colours. policy.captions.style 'plain' keeps the Studio default look.
export function captionPresetFromBrand(brandInput = {}, policyInput = {}) {
  const brand = BrandSchema.parse(brandInput ?? {})
  const policy = EditPolicySchema.parse(policyInput ?? {})
  if (policy.captions.style === 'plain') return { id: STUDIO_CAPTION_PRESET_ID }
  return {
    id: STUDIO_CAPTION_PRESET_ID,
    fontFamily: brand.fonts.body,
    textColor: hex6(brand.colors.captionText),
    subtitleColor: hex6(brand.colors.captionText),
    subtitleTextStyle: BACKGROUND_TO_TEXT_STYLE[brand.captionStyle.background],
  }
}

// Per-cue overrides: what the renderer reads off each cue (globalOverrides).
export function captionOverrides({ brand: brandInput = {}, policy: policyInput = {}, aspect = '16:9', emphasisWords = [] } = {}) {
  const brand = BrandSchema.parse(brandInput ?? {})
  const policy = EditPolicySchema.parse(policyInput ?? {})
  const safeArea = { ...safeAreaFor(aspect) }
  if (policy.captions.style === 'plain') {
    return { safeArea, aspect, subtitlePosition: 'bottom', sizeScale: 1, maxCharsPerLine: null, emphasisWords: [], emphasisStyle: 'none' }
  }
  const style = brand.captionStyle
  const background = hex6(brand.colors.captionBackground)
  return {
    aspect,
    safeArea,
    subtitlePosition: style.position,
    subtitleColor: hex6(brand.colors.captionText),
    textStyle: BACKGROUND_TO_TEXT_STYLE[style.background],
    backgroundColor: background,
    backgroundOpacity: hexAlphaPercent(brand.colors.captionBackground) ?? DEFAULT_OPACITY,
    outlineColor: background,
    fontFamily: brand.fonts.body,
    sizeScale: Math.round((style.fontSize / RENDERER_BASE_SIZE_AT_1080) * 1000) / 1000,
    maxCharsPerLine: style.maxCharsPerLine,
    emphasisWords: style.emphasis === 'none' ? [] : emphasisWords,
    emphasisStyle: style.emphasis,
    emphasisColor: hex6(brand.colors.primary),
  }
}

// cues: [{id, start, end, text}] (a transcription draft or a clip's cues).
// → { preset, cues (each with globalOverrides), emphasized: [{cueId, words}] }
export function styleCaptionCues({ cues, brand = {}, policy = {}, aspect = '16:9', emphasisWords = [] }) {
  const overrides = captionOverrides({ brand, policy, aspect, emphasisWords })
  const styled = (cues || []).map(({ globalOverrides, ...cue }) => ({ ...cue, globalOverrides: { ...overrides } }))
  const emphasized = styled
    .map((cue) => ({ cueId: cue.id, words: emphasisWordsIn(cue.text, overrides.emphasisWords) }))
    .filter((entry) => entry.words.length)
  return { preset: captionPresetFromBrand(brand, policy), cues: styled, emphasized }
}

const overlaps = (a, b) => a.start < b.end - 1e-6 && b.start < a.end - 1e-6

// The QA caption check (V1): every cue's block inside the safe rectangle of
// the render's aspect, and no two cues on screen at once. QaIssueSchema shape.
export function checkCaptionSafeArea({ cues, width, height, aspect = null, measure = approximateMeasure }) {
  const target = aspect || aspectOf(width, height)
  const issues = []
  const sorted = [...(cues || [])].sort((a, b) => a.start - b.start)
  for (const cue of sorted) {
    const placed = { ...cue, globalOverrides: { ...(cue.globalOverrides || {}), safeArea: safeAreaFor(target) } }
    const asDrawn = cue.globalOverrides?.safeArea ? cue : null
    const layout = layoutCue(asDrawn || placed, { width, height, measure })
    const required = layoutCue(placed, { width, height, measure })
    const inside = blockInsideSafeRect({ ...layout, safeRect: required.safeRect })
    if (!asDrawn || !inside) {
      issues.push({
        type: 'caption_safe_area',
        severity: 0.7,
        timeRange: { start: cue.start, end: cue.end },
        scene: null,
        detail: asDrawn
          ? `Cue "${String(cue.text).slice(0, 60)}" leaves the ${target} safe area`
          : `Cue "${String(cue.text).slice(0, 60)}" is not placed for the ${target} safe area`,
        repairIntent: 'move_caption',
      })
    }
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (overlaps(sorted[i - 1], sorted[i])) {
      issues.push({
        type: 'caption_overlap',
        severity: 0.5,
        timeRange: { start: sorted[i].start, end: Math.min(sorted[i - 1].end, sorted[i].end) },
        scene: null,
        detail: `Cues "${String(sorted[i - 1].text).slice(0, 30)}" and "${String(sorted[i].text).slice(0, 30)}" overlap`,
        repairIntent: 're-time',
      })
    }
  }
  return issues
}
