// FILM-2017: what a delivery preset changes in the upstream editor's own export
// (src/services/exporter.js, reached by export_timeline and
// export_delivery_batch with a preset): captions clips are drawn only when
// the preset burns them, and only the render's language is heard and shown
// (a track or clip with another language is left out; one without a
// language always plays). An export without a preset is unchanged.
const CAPTION_TYPES = new Set(['captions', 'caption'])

export function applyDeliveryPresetFilter(timelineState, { captionPolicy = null, language = null } = {}) {
  if (!captionPolicy && !language) return timelineState
  const tracks = new Map((timelineState.tracks || []).map((track) => [track.id, track]))
  const clips = (timelineState.clips || []).filter((clip) => {
    if (captionPolicy && captionPolicy !== 'burn' && CAPTION_TYPES.has(clip.type)) return false
    const clipLanguage = clip.metadata?.language ?? tracks.get(clip.trackId)?.language ?? null
    return !language || !clipLanguage || clipLanguage === language
  })
  return clips.length === (timelineState.clips || []).length ? timelineState : { ...timelineState, clips }
}
