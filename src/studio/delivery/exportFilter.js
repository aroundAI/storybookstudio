// FILM-2017: what a delivery preset changes in the upstream editor's own export
// (src/services/exporter.js, reached by export_timeline and
// export_delivery_batch with a preset): captions clips are drawn only when
// the preset burns them, and only the render's language is heard and shown
// (FILM-2019's selection, localization/selection.js: a track or clip with
// another language is left out, the language's own lane plays even though
// the editor mutes it, one without a language always plays). An export
// without a preset is unchanged.
import { selectLanguage } from '../localization/selection.js'

const CAPTION_TYPES = new Set(['captions', 'caption'])

export function applyDeliveryPresetFilter(timelineState, { captionPolicy = null, language = null } = {}) {
  if (!captionPolicy && !language) return timelineState
  const selected = selectLanguage(timelineState, language)
  const clips = (selected.clips || []).filter((clip) => !(captionPolicy && captionPolicy !== 'burn' && CAPTION_TYPES.has(clip.type)))
  if (selected === timelineState && clips.length === (timelineState.clips || []).length) return timelineState
  return { ...selected, clips }
}
