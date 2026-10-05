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
