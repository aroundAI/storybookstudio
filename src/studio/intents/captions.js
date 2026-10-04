// FILM-2016 AC6: studio_add_captions {language, style?}. Transcription is a
// job (contract E6), so the intent compiles in two phases that FILM-2013's
// runner sequences:
//
//   compileCaptionsIntent({ intent: 'add_captions', scope, params, context, policy, brand })
//     → { steps: [transcribe_captions], reasons, expected, continueWith: 'captions.afterTranscription' }
//   compileCaptionsAfterTranscription({ cues, params, context, policy, brand })
//     → { steps: [generate_captions?, update_caption_cues], reasons, expected,
//         qa: [{ check: 'caption_safe_area', language, clipId, aspect }] }
//
// The cues land styled (BrandSchema.captionStyle) and placed inside the
// aspect's safe rectangle; emphasis words are styled where a cue has them;
// the QA hook is captions/style.js checkCaptionSafeArea. Pure.
import { EditPolicySchema } from '../contracts/edit-policy.schema.mjs'
import { BrandSchema } from '../contracts/brand.schema.mjs'
import { aspectOf, checkCaptionSafeArea, emphasisWordsFrom, styleCaptionCues, STUDIO_CAPTION_PRESET_ID } from '../captions/style.js'

export const CAPTION_INTENTS = Object.freeze(['add_captions'])

// transcribe_captions takes an ASR language name; StoryBook speaks in tags.
const WHISPER_LANGUAGES = {
  en: 'English', hi: 'Hindi', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic', ru: 'Russian', bn: 'Bengali', ta: 'Tamil',
  te: 'Telugu', mr: 'Marathi', ur: 'Urdu', id: 'Indonesian', tr: 'Turkish', nl: 'Dutch', pl: 'Polish',
}
export const whisperLanguage = (tag) => WHISPER_LANGUAGES[String(tag || '').toLowerCase().split('-')[0]] || 'Auto'

const refuse = (reason) => ({ steps: [], reasons: [reason], expected: null, refused: { code: 'VALIDATION_FAILED', reason } })
const step = (tool, args, reason) => ({ tool, arguments: { ...args, studioMeta: { reason, scene: null } } })

const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/

const timelineAspect = (context) => {
  const timeline = context?.timeline || {}
  if (timeline.studio?.aspect) return timeline.studio.aspect
  if (context?.aspect) return context.aspect
  return aspectOf(timeline.width || context?.width || 1920, timeline.height || context?.height || 1080)
}

// The live captions clip for a language: on a role:'captions' track of that
// language (the rough-cut builder makes one per language).
export function captionsClipFor(context, language) {
  const tracks = context?.timeline?.tracks || []
  const clips = context?.timeline?.clips || []
  const trackIds = new Set(tracks.filter((track) => track.role === 'captions' && track.language === language).map((track) => track.id))
  return clips.find((clip) => clip.type === 'captions' && trackIds.has(clip.trackId)) || null
}

// A brand with the call's style on top: style may carry captionStyle fields
// (position, fontSize, maxCharsPerLine, background, emphasis) and emphasisWords.
const brandWithStyle = (brand, style) => {
  const raw = brand && typeof brand === 'object' ? brand : {}
  const { emphasisWords, ...captionStyle } = style && typeof style === 'object' ? style : {}
  return { ...raw, captionStyle: { ...(raw.captionStyle || {}), ...captionStyle } }
}

export function compileCaptionsIntent({ intent = 'add_captions', params = {}, context = {}, policy: policyInput = {}, brand = {} } = {}) {
  if (!CAPTION_INTENTS.includes(intent)) return refuse(`Unknown captions intent "${intent}".`)
  const language = params?.language
  if (!LANGUAGE_TAG.test(String(language || ''))) return refuse('studio_add_captions needs a language tag such as en or hi.')
  const policy = EditPolicySchema.parse(policyInput ?? {})
  const parsed = BrandSchema.safeParse(brandWithStyle(brand, params.style))
  if (!parsed.success) return refuse(`style: ${parsed.error.issues[0].path.join('.')} ${parsed.error.issues[0].message}`)
  const aspect = timelineAspect(context)
  const asr = whisperLanguage(language)
  const reasons = [`Transcribe the ${language} dialogue with the local whisper engine (language hint ${asr}); captions are timed to what is said.`]
  if (!policy.captions.enabled) reasons.push('The edit policy turns captions off; adding them because they were asked for.')
  return {
    steps: [step('transcribe_captions', { scope: 'timeline', language: asr }, reasons[0])],
    reasons,
    expected: { language, aspect, cuesStyled: policy.captions.style === 'brand' ? 'brand' : 'plain' },
    continueWith: 'captions.afterTranscription',
  }
}

export function compileCaptionsAfterTranscription({ cues, params = {}, context = {}, policy: policyInput = {}, brand = {} } = {}) {
  const language = params?.language
  if (!LANGUAGE_TAG.test(String(language || ''))) return refuse('studio_add_captions needs a language tag such as en or hi.')
  if (!Array.isArray(cues) || !cues.length) return refuse('The transcription returned no cues; nothing to place.')
  const policy = EditPolicySchema.parse(policyInput ?? {})
  const aspect = timelineAspect(context)
  const styledBrand = brandWithStyle(brand, params.style)
  const emphasisWords = emphasisWordsFrom({ brand, style: params.style })
  const { preset, cues: styled, emphasized } = styleCaptionCues({ cues, brand: styledBrand, policy, aspect, emphasisWords })
  const plain = policy.captions.style === 'plain'

  const steps = []
  const reasons = []
  let clip = captionsClipFor(context, language)
  if (!clip) {
    const others = (context?.timeline?.clips || []).filter((entry) => entry.type === 'captions')
    if (others.length) return refuse(`There is no captions clip for ${language}, and one for another language exists; add a ${language} captions track first (FILM-2019 language lanes).`)
    const reason = `Place a live captions clip for ${language} from the transcription draft.`
    steps.push(step('generate_captions', { scope: 'timeline', presetId: STUDIO_CAPTION_PRESET_ID }, reason))
    reasons.push(reason)
  }
  const width = context?.timeline?.width || context?.width
  const height = context?.timeline?.height || context?.height
  const reason = [
    `Style ${styled.length} cue(s) ${plain ? 'in the Studio default (policy captions.style plain)' : `with the brand caption style (${preset.fontFamily}, ${preset.subtitleTextStyle})`}`,
    `inside the ${aspect} safe area`,
    emphasized.length ? `${emphasized.reduce((sum, entry) => sum + entry.words.length, 0)} emphasis word(s) in ${emphasized.length} cue(s)` : null,
  ].filter(Boolean).join(', ') + '.'
  steps.push(step('update_caption_cues', { ...(clip ? { clipId: clip.id } : { target: 'clip' }), cues: styled, preset }, reason))
  reasons.push(reason)
  const issues = width && height ? checkCaptionSafeArea({ cues: styled, width, height, aspect }) : []
  return {
    steps,
    reasons,
    expected: { language, aspect, cueCount: styled.length, emphasized, safeAreaIssues: issues },
    qa: [{ check: 'caption_safe_area', language, clipId: clip?.id ?? null, aspect }],
  }
}

// FILM-2013's compile.js call form: compileCaptions(context, scope, params, policy)
// with context.brand (BrandSchema-parsed or raw) and context.timeline.
export const compileCaptions = (context = {}, scope = 'episode', params = {}, policy = context?.policy) => (
  compileCaptionsIntent({ intent: 'add_captions', scope, params, context, policy, brand: context?.brand })
)
export const compileCaptionsPlacement = (context = {}, cues = [], params = {}, policy = context?.policy) => (
  compileCaptionsAfterTranscription({ cues, params, context, policy, brand: context?.brand })
)
