// FILM-2019 AC3: a language lane on the master timeline, from the dubbed
// lines StoryBook produced (FILM-2007's dubbed block in the pulled
// package). No per-language timeline: the lane is a Dialogue (<lang>) bus
// track (more lanes when lines overlap) and a Captions (<lang>) track on the
// master, selected per render (selection.js).
//
//   buildLanguageLane({ document, pkg, language, probes, brand, policy })
//     → { language, timelineId, removeTrackIds, removeClipIds, tracks, clips,
//         assets, captions, lines, overruns, warnings }
//   applyLanguageLane(timeline, lane) → the timeline with the lane in place
//
// Placement is the rough-cut builder's (projectBuilder.js), so a lane added
// later sits exactly where it would have had the dubs been there at pull:
// each dub at its line's timelineStartSeconds, speed-fitted (fit.js). The
// captions are studio_add_captions' placement step (FILM-2016: brand style,
// the aspect's safe area) over cues taken from the dubbed text at the time
// each dub plays; the dub's text is known, so nothing is transcribed.
// Re-running replaces the language's lane. Pure.
import { buildProject } from '../projectBuilder.js'
import { styleCaptionCues, emphasisWordsFrom, STUDIO_CAPTION_PRESET_ID, aspectOf } from '../captions/style.js'
import { EditPolicySchema } from '../contracts/edit-policy.schema.mjs'

const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/
const CAPTION_CLIP_COLOR = '#3E6B5C'
const round3 = (value) => Math.round(value * 1000) / 1000

const fail = (code, message, details) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) })

export const masterTimeline = (document) => (document?.timelines || []).find((timeline) => timeline.studio?.kind === 'master') || (document?.timelines || [])[0] || null

const isDialogueTrackOf = (track, language) => track.type === 'audio' && track.bus === 'dialogue' && track.language === language
const isCaptionsTrackOf = (track, language) => track.role === 'captions' && track.language === language

const nextNumber = (ids, prefix) => {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`)
  return Math.max(0, ...ids.map((id) => Number(pattern.exec(String(id))?.[1] || 0))) + 1
}

// Dubbed text, timed to the dub as it plays, as caption cues.
export function laneCaptionCues(placed) {
  return placed
    .filter((entry) => String(entry.text || '').trim())
    .sort((a, b) => a.start - b.start)
    .map((entry, index, all) => {
      const next = all[index + 1]
      // A cue ends when the next one starts: two never show at once.
      const end = next ? Math.min(entry.end, next.start) : entry.end
      return { id: `cue-dub-${entry.dubId}`, start: round3(entry.start), end: round3(Math.max(end, entry.start + 0.1)), text: String(entry.text).trim() }
    })
}

export function buildLanguageLane({ document, pkg, language, probes = new Map(), brand = null, policy = null } = {}) {
  if (!LANGUAGE_TAG.test(String(language || ''))) throw fail('VALIDATION_FAILED', 'A language variant needs a language tag such as hi or es.')
  const master = masterTimeline(document)
  if (!master) throw fail('VALIDATION_FAILED', 'The project has no master timeline.')
  const dub = (pkg?.dubbed || []).find((entry) => entry.language === language)
  if (!dub || !dub.lines.length) {
    throw fail('NOT_FOUND', `StoryBook has no ${language} dub of this episode in the pulled package. Localize it in StoryBook (localize_episode), then studio_check_updates and studio_apply_updates to pull the dubbed lines.`, { language, availableLanguages: (pkg?.dubbed || []).map((entry) => entry.language) })
  }
  const primary = master.studio?.language || pkg.episode?.language || null
  if (language === primary) throw fail('VALIDATION_FAILED', `${language} is the episode's own language; its dialogue is the master's.`)

  // The builder places the dubs; only this language's lane is taken from it.
  const built = buildProject({ package: { ...pkg, dubbed: [dub] }, probedAssets: probes, brand, policy })
  const builtTimeline = built.project.timelines[0]
  const builtTracks = builtTimeline.tracks.filter((track) => isDialogueTrackOf(track, language))
  const builtTrackIds = new Set(builtTracks.map((track) => track.id))
  const builtClips = builtTimeline.clips.filter((clip) => builtTrackIds.has(clip.trackId))
  const assetIds = new Set(builtClips.map((clip) => clip.assetId))
  const assets = built.project.assets.filter((asset) => assetIds.has(asset.id))
  const dubRefs = new Set(dub.lines.map((line) => line.id))
  const warnings = built.warnings.filter((warning) => dubRefs.has(warning.ref) || (warning.source === 'dubbed.audio'))

  // What the lane replaces on the master: this language's dialogue and captions.
  const removeTracks = master.tracks.filter((track) => isDialogueTrackOf(track, language) || isCaptionsTrackOf(track, language))
  const removeTrackIds = new Set(removeTracks.map((track) => track.id))
  const removeClipIds = master.clips
    .filter((clip) => removeTrackIds.has(clip.trackId) || (clip.metadata?.language === language && ['audio', 'captions'].includes(clip.type)))
    .map((clip) => clip.id)

  // Ids: the replaced tracks' own first, then the editor's next free ones.
  const reuseAudio = removeTracks.filter((track) => track.type === 'audio').map((track) => track.id)
  const reuseCaptions = removeTracks.filter((track) => track.role === 'captions').map((track) => track.id)
  let audioNumber = nextNumber(master.tracks.map((track) => track.id), 'audio')
  let videoNumber = nextNumber(master.tracks.map((track) => track.id), 'video')
  let clipNumber = Math.max(nextNumber(master.clips.map((clip) => clip.id), 'clip'), Number(master.clipCounter) || 1)
  // As the builder makes them: muted in the editor, which monitors the episode's language.
  const trackIdMap = new Map()
  const tracks = builtTracks.map((track) => {
    const id = reuseAudio.shift() || `audio-${audioNumber++}`
    trackIdMap.set(track.id, id)
    return { ...track, id }
  })
  const clips = builtClips.map((clip) => ({ ...clip, id: `clip-${clipNumber++}`, trackId: trackIdMap.get(clip.trackId) }))

  // Captions: the dubbed text where each dub plays, styled and placed for the master's aspect.
  const dubById = new Map(dub.lines.map((line) => [`sb-dub-${language}-${line.id}`, line]))
  const placed = clips.map((clip) => ({ dubId: dubById.get(clip.assetId)?.id, text: dubById.get(clip.assetId)?.translatedText, start: clip.startTime, end: clip.startTime + clip.duration }))
  const cues = laneCaptionCues(placed)
  const parsedPolicy = EditPolicySchema.parse(policy ?? pkg.editPolicy ?? {})
  const aspect = master.studio?.aspect || aspectOf(master.width || 1920, master.height || 1080)
  const brandInput = brand ?? pkg.brand ?? {}
  const styled = styleCaptionCues({ cues, brand: brandInput, policy: parsedPolicy, aspect, emphasisWords: emphasisWordsFrom({ brand: brandInput }) })
  let captionsTrack = null
  let captionsClip = null
  if (styled.cues.length) {
    captionsTrack = {
      id: reuseCaptions.shift() || `video-${videoNumber++}`,
      name: `Captions (${language})`,
      type: 'video',
      muted: false,
      locked: false,
      visible: false,
      role: 'captions',
      language,
    }
    const duration = Math.max(0.4, ...styled.cues.map((cue) => cue.end))
    captionsClip = {
      id: `clip-${clipNumber++}`,
      trackId: captionsTrack.id,
      assetId: null,
      name: `Captions (${language})`,
      startTime: 0,
      duration,
      sourceDuration: duration,
      trimStart: 0,
      trimEnd: duration,
      color: CAPTION_CLIP_COLOR,
      type: 'captions',
      enabled: true,
      compositeLowerLayers: 'auto',
      url: null,
      thumbnail: null,
      captions: { preset: styled.preset, cues: styled.cues, workspace: { version: 1, presetId: STUDIO_CAPTION_PRESET_ID, storybook: { dubbedVersionId: dub.dubbedVersionId, source: 'dubbed_lines' } } },
      metadata: {
        semantic: { scene: null, shotId: null, role: 'caption' },
        origin: { versionId: null, opId: null, by: 'ai' },
        languageDependency: 'language',
        language,
        storybook: { dubbedVersionId: dub.dubbedVersionId },
      },
      transform: { ...(builtClips[0]?.transform || {}) },
    }
  }

  const overruns = warnings.filter((warning) => warning.code === 'dub_overruns_slot')
  return {
    language,
    timelineId: master.id,
    aspect,
    dubbedVersionId: dub.dubbedVersionId,
    removeTrackIds: [...removeTrackIds],
    removeClipIds,
    tracks: [...tracks, ...(captionsTrack ? [captionsTrack] : [])],
    clips: [...clips, ...(captionsClip ? [captionsClip] : [])],
    assets,
    captions: captionsClip ? { clipId: captionsClip.id, cueCount: styled.cues.length, emphasized: styled.emphasized } : null,
    lines: { dubbed: dub.lines.length, placed: clips.length, offline: assets.filter((asset) => asset.offline).length, fitted: clips.filter((clip) => clip.speed !== 1).length },
    overruns,
    warnings,
    clipCounter: clipNumber,
  }
}

// The master with the lane: the language's old tracks and clips out, the
// lane's dialogue tracks after the other dialogue tracks, its captions track
// after the other captions tracks.
export function applyLanguageLane(timeline, lane) {
  const removeTracks = new Set(lane.removeTrackIds)
  const removeClips = new Set(lane.removeClipIds)
  const kept = (timeline.tracks || []).filter((track) => !removeTracks.has(track.id))
  const laneDialogue = lane.tracks.filter((track) => track.type === 'audio')
  const laneCaptions = lane.tracks.filter((track) => track.role === 'captions')
  const insertAfter = (list, items, predicate, fallbackIndex) => {
    if (!items.length) return list
    const last = list.reduce((found, track, index) => (predicate(track) ? index : found), -1)
    const at = last >= 0 ? last + 1 : fallbackIndex(list)
    return [...list.slice(0, at), ...items, ...list.slice(at)]
  }
  let tracks = insertAfter(kept, laneCaptions, (track) => track.role === 'captions', () => 0)
  tracks = insertAfter(tracks, laneDialogue, (track) => track.type === 'audio' && track.bus === 'dialogue', (list) => {
    const firstAudio = list.findIndex((track) => track.type === 'audio')
    return firstAudio >= 0 ? firstAudio : list.length
  })
  const clips = [...(timeline.clips || []).filter((clip) => !removeClips.has(clip.id)), ...lane.clips]
  const contentEnd = Math.max(0, ...clips.map((clip) => (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)))
  return {
    ...timeline,
    tracks,
    clips,
    clipCounter: Math.max(Number(timeline.clipCounter) || 1, lane.clipCounter),
    duration: Math.max(Number(timeline.duration) || 0, Math.ceil(contentEnd) + 10),
  }
}

// The project's assets with the lane's (an asset of the same id is replaced).
export function mergeLaneAssets(assets, laneAssets) {
  const incoming = new Map(laneAssets.map((asset) => [asset.id, asset]))
  return [...(assets || []).filter((asset) => !incoming.has(asset.id)), ...laneAssets]
}
