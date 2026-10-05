// FILM-2019 AC2: what a render of one language hears and shows. One master
// timeline carries every language; a render selects one. Every render path
// reads this module (the editor's export, export_timeline and
// export_delivery_batch through delivery/exportFilter.js, the delivery and
// preview renders through review/renderPlan.js, the interim renderer), so
// they cannot disagree about which lane plays.
//
// - An element's language is its clip's metadata.language, else its track's.
//   None (null) is language-independent: video, music, SFX, ambience and shot
//   audio always play.
// - A track with a language is selected by it: in a render of that language
//   it is heard (and a captions track is shown when captions are on in the
//   timeline); in a render of another language it is muted and hidden. A
//   language track's own `muted`/`visible` is the editor's monitoring choice
//   (the builder mutes every language but the episode's), not the render's.
// - Without a language (an export with no preset) the tracks are as stored.
// Pure.
import { getComposition } from '../compositions/catalogue.js'

export const elementLanguage = (clip, track) => clip?.metadata?.language ?? track?.language ?? null

// A clip plays in a render of `language` when it has no language or that one.
export const inLanguage = (clip, track, language) => {
  if (!language) return true
  const own = elementLanguage(clip, track)
  return own === null || own === language
}

const isCaptionsTrack = (track) => track?.role === 'captions'

// Captions are on in a timeline when any captions track is shown: the
// policy's captions.enabled (or the editor's eye toggle) hides them all.
export const captionsShown = (tracks) => (tracks || []).some((track) => isCaptionsTrack(track) && track.visible !== false)

// A track as a render of `language` sees it.
export function trackForLanguage(track, language, { captionsOn = true } = {}) {
  if (!language || !track?.language) return track
  const match = track.language === language
  if (isCaptionsTrack(track)) return { ...track, visible: match && captionsOn }
  return { ...track, muted: !match }
}

// {tracks, clips, ...} (a timeline or the editor's timeline state) as a
// render of `language` sees it: other languages' clips left out, language
// tracks selected. Unchanged (the same object) without a language.
export function selectLanguage(timelineState, language) {
  if (!language || !timelineState) return timelineState
  const sourceTracks = timelineState.tracks || []
  const captionsOn = captionsShown(sourceTracks)
  const tracks = sourceTracks.map((track) => trackForLanguage(track, language, { captionsOn }))
  const byId = new Map(sourceTracks.map((track) => [track.id, track]))
  const clips = (timelineState.clips || []).filter((clip) => inLanguage(clip, byId.get(clip.trackId), language))
  return { ...timelineState, tracks, clips }
}

// FILM-2019 AC3: a composition clip's props as a render of `language` draws
// them. Like the lanes, every language sits on the one master clip and the
// render selects: its text props in that language where the clip carries
// them (composition.localized[language].text, by text prop path, written by
// studio_create_variant), the master's elsewhere. Only a clip whose
// languageDependency is 'language' changes; the master's props are never
// rewritten. Null for any other clip or without a language.
// -> {props, translated, untranslated}: the text prop paths in each state
//    (only filled ones count).
export function compositionPropsForLanguage(clip, language) {
  const composition = clip?.type === 'composition' ? clip.composition : null
  if (!language || composition?.languageDependency !== 'language') return null
  const primitive = getComposition(composition.compositionId)
  if (!primitive) return null
  const text = composition.localized?.[language]?.text || {}
  const props = { ...(composition.props || {}) }
  const translated = []
  const untranslated = []
  for (const path of primitive.textProps) {
    const [head, tail] = path.split('.')
    const value = props[head]
    const filled = tail ? Array.isArray(value) && value.some((item) => String(item?.[tail] ?? '').trim()) : typeof value === 'string' && value.trim() !== ''
    const given = text[path]
    const usable = tail ? Array.isArray(given) && Array.isArray(value) && given.length === value.length && given.every((entry) => typeof entry === 'string') : typeof given === 'string'
    if (usable) {
      props[head] = tail ? value.map((item, index) => ({ ...item, [tail]: given[index] })) : given
      translated.push(path)
    } else if (filled) untranslated.push(path)
  }
  return { props, translated, untranslated }
}
