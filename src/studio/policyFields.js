// The edit policy's dialogue-cut and silence limits and the brand's emphasis
// words, as the shared contract defines them (FILM-2004). Defaults come from
// the generated schema copies, never from constants here.
import { EDIT_POLICY_DEFAULTS, POLICY_DIALOGUE_CUTS } from './contracts/edit-policy.schema.mjs'
import { BRAND_DEFAULTS } from './contracts/brand.schema.mjs'

export const DIALOGUE_CUT_MODES = POLICY_DIALOGUE_CUTS
export const DEFAULT_DIALOGUE_CUT_MODE = EDIT_POLICY_DEFAULTS.allowDialogueCuts
export const DEFAULT_MAX_SILENCE_SECONDS = EDIT_POLICY_DEFAULTS.maxSilenceSeconds
export const DEFAULT_EMPHASIS_WORDS = BRAND_DEFAULTS.captionStyle.emphasisWords

export const dialogueCutModeOf = (policy) => (DIALOGUE_CUT_MODES.includes(policy?.allowDialogueCuts) ? policy.allowDialogueCuts : DEFAULT_DIALOGUE_CUT_MODE)
export const maxSilenceSecondsOf = (policy) => (Number.isFinite(policy?.maxSilenceSeconds) ? policy.maxSilenceSeconds : DEFAULT_MAX_SILENCE_SECONDS)
export const emphasisWordsOf = (brand) => (Array.isArray(brand?.captionStyle?.emphasisWords) ? brand.captionStyle.emphasisWords : DEFAULT_EMPHASIS_WORDS)
