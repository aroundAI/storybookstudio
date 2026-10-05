// FILM-2019 AC3/AC4: a language variant's graphics. Composition clips whose
// languageDependency is 'language' get their words in the language and are
// rendered once per language, refit to the master's room (refit.js).
//
// Where the words come from. StoryBook's package carries no graphic text:
// its dubbed block is dialogue only (dubbed[].lines[].translatedText per
// dialogue line, contracts/edit-package.schema.mjs DubbedLineSchema). So,
// per text prop, first source wins:
//
//   'agent'  studio_create_variant's `graphics` argument:
//            {<clipId>: {<text prop>: text}}, an array of texts for a list
//            prop ('items.label': one per item); the agent translates
//   'kept'   what an earlier variant in this language stored on the clip
//   'dub'    the package's dub of a dialogue line the master's text quotes
//            word for word
//
// and a filled text prop with none stays in the master's words, reported
// per clip (refit.js untranslatedIssue), never silently. The words are kept
// on the master clip, composition.localized[<lang>] = {text, sources}, and
// a render selects them (selection.js compositionPropsForLanguage). Pure.
import { getComposition, resolveCompositionProps } from '../compositions/catalogue.js'
import { compositionPropsForLanguage } from './selection.js'
import { exceedsContainerIssue, refitGraphic, untranslatedIssue } from './refit.js'

const fail = (message, details) => Object.assign(new Error(message), { code: 'VALIDATION_FAILED', ...(details ? { details } : {}) })
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
const round3 = (value) => Math.round(value * 1000) / 1000

export const isLanguageGraphic = (clip) => clip?.type === 'composition' && clip.enabled !== false && clip.composition?.languageDependency === 'language'

function checkStrings(graphics, clipsById) {
  if (graphics == null) return {}
  if (typeof graphics !== 'object' || Array.isArray(graphics)) throw fail('graphics is {<clipId>: {<text prop>: text}}.')
  for (const [clipId, props] of Object.entries(graphics)) {
    const clip = clipsById.get(clipId)
    if (!clip) throw fail(`graphics names ${clipId}, which is not a graphic on the master.`, { clipId })
    if (!isLanguageGraphic(clip)) throw fail(`Graphic ${clipId} shows no words (languageDependency ${clip.composition?.languageDependency}); it renders the same in every language.`, { clipId })
    const primitive = getComposition(clip.composition.compositionId)
    if (!props || typeof props !== 'object' || Array.isArray(props)) throw fail(`graphics.${clipId} is {<text prop>: text}; its text props are ${primitive.textProps.join(', ')}.`, { clipId })
    for (const [path, value] of Object.entries(props)) {
      if (!primitive.textProps.includes(path)) throw fail(`${path} is not a text prop of the ${primitive.title} ${clipId}; its text props are ${primitive.textProps.join(', ')}.`, { clipId, prop: path })
      const [head, tail] = path.split('.')
      if (tail) {
        const items = clip.composition.props?.[head] || []
        if (!Array.isArray(value) || value.length !== items.length || !value.every((entry) => typeof entry === 'string')) throw fail(`graphics.${clipId}.${path} is a list of ${items.length} texts, one per ${head.replace(/s$/, '')}.`, { clipId, prop: path })
      } else if (typeof value !== 'string') throw fail(`graphics.${clipId}.${path} is a text.`, { clipId, prop: path })
    }
  }
  return graphics
}

// The words of each language graphic on `timeline` in `language`:
// [{clipId, compositionId, localized: {text, sources}, untranslated}].
// Throws VALIDATION_FAILED on a `graphics` argument that names no such clip
// or prop, before anything changes.
export function graphicStrings({ timeline, pkg = null, language, graphics = null }) {
  const clips = (timeline?.clips || []).filter((clip) => clip.type === 'composition')
  const given = checkStrings(graphics, new Map(clips.map((clip) => [clip.id, clip])))
  const dub = (pkg?.dubbed || []).find((entry) => entry.language === language)
  const dubOf = new Map((dub?.lines || []).map((line) => [line.dialogueId, line.translatedText]))
  const quoted = new Map((pkg?.dialogue || []).filter((line) => dubOf.has(line.id) && squash(line.text)).map((line) => [squash(line.text), dubOf.get(line.id)]))
  return clips.filter(isLanguageGraphic).map((clip) => {
    const primitive = getComposition(clip.composition.compositionId)
    const kept = clip.composition.localized?.[language] || {}
    const text = {}
    const sources = {}
    const untranslated = []
    for (const path of primitive.textProps) {
      const [head, tail] = path.split('.')
      const master = clip.composition.props?.[head]
      const masterTexts = tail ? (Array.isArray(master) ? master.map((item) => item?.[tail] ?? '') : []) : [master ?? '']
      if (!masterTexts.some((entry) => String(entry).trim())) continue
      const fromDub = masterTexts.map((entry) => (String(entry).trim() ? quoted.get(squash(entry)) : entry))
      const keptValue = kept.text?.[path]
      if (given[clip.id]?.[path] !== undefined) [text[path], sources[path]] = [given[clip.id][path], 'agent']
      else if (keptValue !== undefined && (!tail || (Array.isArray(keptValue) && keptValue.length === masterTexts.length))) [text[path], sources[path]] = [keptValue, kept.sources?.[path] || 'kept']
      else if (fromDub.every((entry) => entry !== undefined)) [text[path], sources[path]] = [tail ? fromDub : fromDub[0], 'dub']
      else untranslated.push(path)
    }
    return { clipId: clip.id, compositionId: clip.composition.compositionId, localized: Object.keys(text).length ? { text, sources } : null, untranslated }
  })
}

const clipEnd = (clip) => (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)

// What each language graphic on `timeline` draws in a render of `language`
// at `frame` ({width, height, fps}): its localized props, the refit, the
// length it plays for, and the issues. A graphic with no words in the
// language (or words too long for its schema) is drawn in the master's, as
// the master draws it. Pure: the caller renders each entry's request and
// puts the file on the clip (withLanguageGraphics).
export function planLanguageGraphics({ timeline, language, frame }) {
  const graphics = []
  const issues = []
  const clips = timeline?.clips || []
  for (const clip of clips) {
    if (!isLanguageGraphic(clip)) continue
    const selected = compositionPropsForLanguage(clip, language)
    if (!selected) continue
    const { compositionId } = clip.composition
    const start = round3(Number(clip.startTime) || 0)
    const timeRange = { start, end: round3(clipEnd(clip)) }
    if (selected.untranslated.length) issues.push(untranslatedIssue({ clipId: clip.id, compositionId, language, paths: selected.untranslated, timeRange }))
    const sourceDuration = Number(clip.sourceDuration ?? clip.duration) || Number(clip.duration) || 0
    const entry = (props, fit, { fits = true, translated = true, slots = [], durationSeconds = Number(clip.duration) || 0, extendedSeconds = 0, durationCapped = false } = {}) => ({
      clipId: clip.id,
      compositionId,
      translated,
      props,
      fit,
      fits,
      slots: slots.map(({ key, text, fontScale, lines, fits: slotFits, maxLines, step }) => ({ key, text, fontScale, lines, fits: slotFits, maxLines, step })),
      durationSeconds,
      extendedSeconds,
      durationCapped,
      // The composition render's length: the clip's source length, lengthened alike.
      renderSeconds: round3(sourceDuration + extendedSeconds),
      request: { engine: clip.composition.engine, compositionId, props, ...(fit ? { fit } : {}), durationSeconds: round3(sourceDuration + extendedSeconds), width: frame.width, height: frame.height, fps: frame.fps },
    })
    // In the master's words, drawn as the master draws them; rendered here
    // too, so a language render never waits on the editor's render.
    const masterWords = (fits) => entry(resolveCompositionProps(compositionId, clip.composition.props), null, { fits, translated: false })
    if (!selected.translated.length) {
      graphics.push(masterWords(true))
      continue
    }
    let props
    try {
      props = resolveCompositionProps(compositionId, selected.props)
    } catch (error) {
      // Longer than the primitive's schema allows: it cannot be drawn, so the master's words play.
      const reasons = (error.details?.issues || []).map((detail) => `${detail.path} ${detail.message}`).join('; ') || error.message
      issues.push(exceedsContainerIssue({ clipId: clip.id, compositionId, language, reason: `longer than the ${getComposition(compositionId).title} allows (${reasons}); the master's words play`, timeRange }))
      graphics.push(masterWords(false))
      continue
    }
    // The program's end without this clip: a graphic is not lengthened past it.
    const programEnd = Math.max(0, ...clips.filter((other) => other.id !== clip.id && other.enabled !== false && !['captions', 'caption'].includes(other.type)).map(clipEnd))
    const result = refitGraphic({ compositionId, props, masterProps: clip.composition.props, frame, durationSeconds: Number(clip.duration) || 0, maxDurationSeconds: Math.max(Number(clip.duration) || 0, programEnd - start) })
    if (!result.fits) issues.push(exceedsContainerIssue({ clipId: clip.id, compositionId, language, result, timeRange: { start, end: round3(start + result.durationSeconds) } }))
    graphics.push(entry(props, result.fit, result))
  }
  return { graphics, issues }
}

// The timeline as a render of the language plays it: each planned graphic
// with its localized props and refit, its length, and the render that drew
// them ({clipId: {propsHash, renderPath}}). A copy; the master is untouched.
export function withLanguageGraphics(timeline, graphics, renders) {
  const byId = new Map(graphics.filter((entry) => renders[entry.clipId]).map((entry) => [entry.clipId, entry]))
  if (!byId.size) return timeline
  return {
    ...timeline,
    clips: timeline.clips.map((clip) => {
      const entry = byId.get(clip.id)
      if (!entry) return clip
      const { propsHash, renderPath } = renders[clip.id]
      return {
        ...clip,
        duration: entry.durationSeconds,
        sourceDuration: entry.renderSeconds,
        trimEnd: round3((Number(clip.trimEnd ?? clip.sourceDuration ?? clip.duration) || 0) + entry.extendedSeconds),
        composition: { ...clip.composition, props: entry.props, fit: entry.fit ?? undefined, propsHash, renderPath, renderUrl: null },
      }
    }),
  }
}

// The master with each graphic's words for `language` stored on it
// (composition.localized[language]); a graphic with none keeps what it had.
export function storeGraphicStrings(timeline, language, entries) {
  const byId = new Map(entries.filter((entry) => entry.localized).map((entry) => [entry.clipId, entry.localized]))
  if (!byId.size) return timeline
  return {
    ...timeline,
    clips: timeline.clips.map((clip) => (byId.has(clip.id) ? { ...clip, composition: { ...clip.composition, localized: { ...(clip.composition.localized || {}), [language]: byId.get(clip.id) } } } : clip)),
  }
}
