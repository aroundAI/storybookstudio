// The rough-cut builder (FILM-2012 AC3): a StoryBook edit package plus the
// probed local media becomes a upstream project document that opens as a rough
// cut, never an empty timeline. Pure module: no Electron, no stores, no
// clock. The same inputs always build the same project, so snapshots hold.
//
//   buildProject({ package, probedAssets, brand, policy, options })
//     → { project, files, warnings }
//
// `project` is project.storybookstudio (version 1.2, EditGraph v1 fields);
// `files` maps project-relative paths to the text written beside it
// (storybook/package.json, link.json, brand.json, policy.json); `warnings`
// lists what the rough cut could not place as planned (offline media first).
//
// Layout, in the upstream editor's own track and clip shapes (timelineStore.addClip,
// placeLiveCaptions, add_asset_to_timeline's linked audio):
//   video tracks: one captions track per language (role 'captions'; the
//   primary language visible), then video-1 with every shot
//   audio tracks: Dialogue per language (others muted), Shot audio (each
//   shot's own sound, linked to its picture), Music, SFX, Ambience; an
//   overlapping item opens a second lane of the same bus
import { EditPackageSchema, isMediaRef } from './contracts/edit-package.schema.mjs'
import { BrandSchema } from './contracts/brand.schema.mjs'
import { EditPolicySchema } from './contracts/edit-policy.schema.mjs'
import { EDITGRAPH_SCHEMA, roleForStoryBookSource } from './contracts/editgraph.schema.js'
import { PROJECT_VERSION_STUDIO } from './projectVersion.js'
import { quantizeTimeToFrame, roundDurationToFrame } from '../utils/timelineFrames.js'
import { MIN_AUDIO_CLIP_GAIN_DB, normalizeAudioClipGainDb } from '../utils/audioClipGain.js'
import { dubSlots, fitDubbedLine } from './localization/fit.js'
import { AUDIO_BUSES, DEFAULT_DUCK_DB, DUCK_ATTACK_MS, DUCK_RELEASE_MS, defaultAudioBuses } from './audio/buses.js'

export const MASTER_TIMELINE_ID = 'tl-master'
export const SHOT_TRACK_ID = 'video-1'
// The bus model lives in audio/buses.js (FILM-2016); re-exported for callers of the builder.
export { AUDIO_BUSES, DEFAULT_DUCK_DB, DUCK_ATTACK_MS, DUCK_RELEASE_MS }
// The upstream editor's subtitle style: the captions clip stores the preset id and the
// renderer fills in the rest (captionRenderer mergePresetWithOverrides).
export const ROUGH_CUT_CAPTION_PRESET_ID = 'kinetic-traditional'

export const STORYBOOK_FILES = Object.freeze({
  package: 'storybook/package.json',
  link: 'storybook/link.json',
  brand: 'storybook/brand.json',
  policy: 'storybook/policy.json',
})

// Language dependency per FILM-2019.
const AUDIO_TRACK_ORDER = ['dialogue', 'shotaudio', 'music', 'sfx', 'ambience']
const LANGUAGE_DEPENDENT_ROLES = new Set(['dialogue', 'caption'])
export const languageDependencyForRole = (role) => (LANGUAGE_DEPENDENT_ROLES.has(role) ? 'language' : 'none')

const BUS_TRACK_NAMES = { shotaudio: 'Shot audio', music: 'Music', sfx: 'SFX', ambience: 'Ambience' }
const AUDIO_CLIP_COLORS = { dialogue: '#565C6B', shotaudio: '#6B7280', music: '#4a8a6a', sfx: '#8a6a9a', ambience: '#4a7a8a' }
const VIDEO_CLIP_COLORS = ['#5a7a9e', '#7a6a9e', '#b06a8a', '#4a8a7a', '#6a7080', '#b06a6a']
const CAPTION_CLIP_COLOR = '#3E6B5C'
const MARKER_COLOR = '#f5c451'
const ORIGIN_AI = Object.freeze({ versionId: null, opId: null, by: 'ai' })

const defaultTransform = () => ({
  positionX: 0, positionY: 0, positionZ: 0, scaleX: 100, scaleY: 100, scaleLinked: true,
  rotation: 0, rotationX: 0, rotationY: 0, perspective: 1200, anchorX: 50, anchorY: 50, opacity: 100,
  flipH: false, flipV: false, cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
  motionBlurEnabled: false, motionBlurMode: 'auto', motionBlurSamples: 8, motionBlurShutter: 180,
  blendMode: 'normal', blur: 0,
})

// 16:9 → 1920×1080, 9:16 → 1080×1920: the short side is 1080, both even.
export const dimensionsForAspect = (aspect) => {
  const [w, h] = String(aspect).split(':').map(Number)
  if (!(w > 0 && h > 0)) return { width: 1920, height: 1080 }
  const even = (value) => Math.round(value / 2) * 2
  return w >= h ? { width: even((1080 * w) / h), height: 1080 } : { width: 1080, height: even((1080 * h) / w) }
}

// audio_tracks.volume (0..2, 1 = unchanged) as clip gain in dB, within
// the upstream editor's clip gain range. Silence is the range's floor.
export const volumeToGainDb = (volume) => {
  const linear = Number(volume)
  if (!(linear > 0)) return MIN_AUDIO_CLIP_GAIN_DB
  return normalizeAudioClipGainDb(Math.round(20 * Math.log10(linear) * 100) / 100)
}

const fileName = (key) => String(key || '').split('/').pop() || null

const stripQuery = (url) => {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url
  }
}

// The package as pulled, minus the signatures: a presigned URL is a short-
// lived read credential and has no use on disk (re-sync diffs by `key`).
export const packageForDisk = (pkg) => JSON.parse(JSON.stringify(pkg, (key, value) => (
  key === 'url' && typeof value === 'string' ? stripQuery(value) : value
)))

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

// Items that overlap on one bus go to the first lane they fit in.
const assignLanes = (items) => {
  const laneEnds = []
  return items.map((item) => {
    let lane = laneEnds.findIndex((end) => item.start >= end - 1e-6)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(0)
    }
    laneEnds[lane] = item.start + item.duration
    return lane
  })
}

export function buildProject({ package: input, probedAssets = new Map(), brand: brandInput, policy: policyInput, options = {} } = {}) {
  const parsed = EditPackageSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`Not a StoryBook edit package: ${issue.path.join('.') || '(root)'} ${issue.message}`)
  }
  const pkg = parsed.data
  const brand = BrandSchema.parse(brandInput ?? pkg.brand ?? {})
  const policy = EditPolicySchema.parse(policyInput ?? pkg.editPolicy ?? {})
  const probes = probedAssets instanceof Map ? probedAssets : new Map(Object.entries(probedAssets || {}))
  const stamp = options.createdAt || pkg.generatedAt
  const { episode } = pkg
  const fps = episode.fps
  const { width, height } = dimensionsForAspect(episode.aspect)
  const atFrame = (seconds) => quantizeTimeToFrame(seconds, fps)
  const frameDuration = (seconds) => roundDurationToFrame(seconds, fps)
  const floorDuration = (seconds) => Math.max(1 / fps, Math.floor(seconds * fps + 1e-7) / fps)

  const warnings = []
  const warn = (code, fields) => warnings.push({ code, ...fields })

  // ---------------------------------------------------------------- folders
  const folders = []
  const folder = (name) => {
    const created = { id: `folder-${folders.length + 1}`, name, parentId: null, color: null, createdAt: stamp }
    folders.push(created)
    return created.id
  }
  const scenesByNumber = new Map(pkg.scenes.map((scene) => [scene.number, scene]))
  const sceneFolderIds = new Map()
  const sceneNumbers = [...new Set([
    ...pkg.scenes.map((scene) => scene.number),
    ...pkg.shots.map((shot) => shot.sceneNumber),
    ...pkg.dialogue.map((line) => line.sceneNumber),
  ].filter((number) => Number.isInteger(number)))].sort((a, b) => a - b)
  for (const number of sceneNumbers) {
    const heading = scenesByNumber.get(number)?.heading
    sceneFolderIds.set(number, folder(heading ? `Scene ${number} - ${heading}` : `Scene ${number}`))
  }
  let unscenedFolderId = null
  const folderForScene = (number) => sceneFolderIds.get(number) ?? (unscenedFolderId ??= folder('No scene'))
  const soundFolderId = pkg.audioTracks.length ? folder('Music and sound') : null
  const characterFolderId = pkg.characters.length ? folder('Characters') : null

  // ----------------------------------------------------------------- assets
  const assets = []
  const assetFor = ({ id, name, type, media, source, ref, role, folderId, semantic, language = null }) => {
    const probe = isMediaRef(media) ? probes.get(media.key) : null
    const base = {
      id,
      name,
      type,
      url: null,
      isImported: true,
      imported: stamp,
      folderId,
      role,
      semantic,
      languageDependency: languageDependencyForRole(role),
      ...(language ? { language } : {}),
      storybook: { source, ref, key: media.url === null ? null : media.key, sha256: media.sha256 ?? null, bytes: media.bytes ?? null },
    }
    let asset
    if (probe && probe.path) {
      const absolute = /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(probe.path)
      asset = {
        ...base,
        path: probe.path,
        ...(absolute ? { absolutePath: probe.path } : {}),
        size: media.bytes,
        mimeType: media.mime,
        duration: type === 'image' ? null : (probe.duration ?? null),
        width: probe.width ?? null,
        height: probe.height ?? null,
        settings: {
          ...(probe.duration != null && type !== 'image' ? { duration: probe.duration } : {}),
          ...(probe.fps ? { fps: probe.fps } : {}),
          ...(probe.width ? { width: probe.width } : {}),
          ...(probe.height ? { height: probe.height } : {}),
          ...(probe.codecs ? { codecs: probe.codecs } : {}),
        },
        ...(type === 'video' ? { hasAudio: probe.hasAudio !== false, audioEnabled: probe.hasAudio !== false } : {}),
      }
    } else {
      // Offline: the upstream editor's media-health check lists it (no local path) and
      // relink_asset points it at a file later; the clip keeps its slot.
      const reason = media.url === null ? media.mediaReason : 'not_downloaded'
      asset = {
        ...base,
        path: null,
        size: media.url === null ? null : media.bytes,
        mimeType: media.url === null ? null : media.mime,
        duration: null,
        width: null,
        height: null,
        settings: {},
        offline: { reason },
        ...(type === 'video' ? { hasAudio: false, audioEnabled: false } : {}),
      }
      warn('media_offline', { source, ref, assetId: id, reason, key: base.storybook.key })
    }
    assets.push(asset)
    return { asset, probe: asset.offline ? null : probe }
  }

  // ------------------------------------------------------------ the timeline
  const clips = []
  const nextClipId = () => `clip-${clips.length + 1}`
  const semanticFor = (scene, shotId, role) => ({ scene: Number.isInteger(scene) ? scene : null, shotId: shotId ?? null, role })
  const metadataFor = (scene, shotId, role, extra = {}) => ({
    semantic: semanticFor(scene, shotId, role),
    origin: { ...ORIGIN_AI },
    languageDependency: languageDependencyForRole(role),
    ...extra,
  })

  // A media clip in the upstream editor's addClip shape. `sourceSeconds` is how much of
  // the file plays from `trimStart`; speed changes its timeline length.
  const mediaClip = ({ trackId, asset, startTime, sourceSeconds, sourceDuration, trimStart = 0, speed = 1, type, color, metadata, linkGroupId, gainDb }) => {
    // The upstream editor's clampFiniteMediaClipToSource, so loading changes nothing: the
    // nearest frame, unless that runs past the file, then the frame before.
    const available = sourceDuration != null ? Math.max(0, sourceDuration - trimStart) : sourceSeconds
    const playable = Math.min(sourceSeconds, available)
    let duration = frameDuration(playable / speed)
    if (duration > available / speed + 1e-6) duration = floorDuration(available / speed)
    const trimEnd = trimStart + duration * speed
    const clip = {
      id: nextClipId(),
      trackId,
      assetId: asset.id,
      name: asset.name,
      startTime: atFrame(startTime),
      duration,
      sourceDuration: sourceDuration ?? trimEnd,
      trimStart,
      trimEnd: sourceDuration != null ? Math.min(sourceDuration, trimEnd) : trimEnd,
      sourceFps: type === 'video' ? (asset.settings?.fps ?? null) : null,
      timelineFps: fps,
      sourceTimeScale: 1,
      speed,
      reverse: false,
      ...(type === 'audio' ? { gainDb: gainDb ?? 0, fadeIn: 0, fadeOut: 0 } : {}),
      color,
      type,
      enabled: true,
      ...(type === 'video' ? { compositeLowerLayers: 'auto' } : {}),
      url: null,
      thumbnail: null,
      metadata,
      ...(linkGroupId ? { linkGroupId } : {}),
      transform: defaultTransform(),
    }
    clips.push(clip)
    return { clip, shortened: sourceSeconds > available + 1e-6 }
  }

  // Shots on video-1, at their planned start, else packed after the previous
  // shot by sequence_number.
  const shots = [...pkg.shots].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
  const dialogueByShot = new Map()
  for (const line of pkg.dialogue) {
    if (!line.shotId) continue
    if (!dialogueByShot.has(line.shotId)) dialogueByShot.set(line.shotId, [])
    dialogueByShot.get(line.shotId).push(line)
  }
  const placedShots = new Map()
  const shotAudioItems = []
  let cursor = 0
  let previousEnd = 0
  shots.forEach((shot, index) => {
    const planned = shot.timelineStartSeconds
    const startTime = atFrame(planned ?? cursor)
    if (planned == null) warn('shot_packed', { source: 'shot.timelineStartSeconds', ref: shot.id, startTime })
    else if (startTime < previousEnd - 1e-6) warn('shot_overlap', { source: 'shot', ref: shot.id, startTime, previousEnd })
    const lines = dialogueByShot.get(shot.id) || []
    const characters = [...new Set([
      ...(shot.primarySubject?.type === 'character' ? [shot.primarySubject.name] : []),
      ...lines.map((line) => line.characterName).filter(Boolean),
    ])]
    const role = roleForStoryBookSource('shot')
    const trimStart = shot.trimInSeconds ?? 0
    const plannedLength = shot.durationSeconds > 0
      ? shot.durationSeconds
      : Math.max(0, (shot.trimOutSeconds ?? shot.sourceDurationSeconds ?? 0) - trimStart)
    const { asset, probe } = assetFor({
      id: `sb-shot-${shot.id}`,
      name: `S${shot.sceneNumber ?? 0}.${shot.shotNumber ?? shot.sequenceNumber} ${shot.actionDescription || 'Shot'}`.slice(0, 120),
      type: 'video',
      media: shot.video,
      source: 'shot.video',
      ref: shot.id,
      role,
      folderId: folderForScene(shot.sceneNumber),
      semantic: {
        scene: shot.sceneNumber,
        shotId: shot.id,
        characters,
        purpose: shot.actionDescription,
        emotion: lines.find((line) => line.emotion)?.emotion ?? null,
        prompt: shot.prompt,
        continuationFrom: shot.continuationFromShotId,
        cameraDirection: shot.cameraDirection,
        sequenceNumber: shot.sequenceNumber,
      },
    })
    const sourceDuration = probe?.duration ?? shot.sourceDurationSeconds ?? null
    const hasShotAudio = Boolean(probe && probe.hasAudio !== false)
    const linkGroupId = hasShotAudio ? `sb-link-${shot.id}` : undefined
    const { clip, shortened } = mediaClip({
      trackId: SHOT_TRACK_ID,
      asset,
      startTime,
      sourceSeconds: plannedLength,
      sourceDuration,
      trimStart,
      type: 'video',
      color: VIDEO_CLIP_COLORS[index % VIDEO_CLIP_COLORS.length],
      metadata: metadataFor(shot.sceneNumber, shot.id, role, {
        storybook: { shotId: shot.id, sequenceNumber: shot.sequenceNumber, transitionType: shot.transitionType ?? 'cut' },
      }),
      linkGroupId,
    })
    if (shortened) warn('clip_shortened', { source: 'shot.video', ref: shot.id, plannedSeconds: plannedLength, sourceDuration })
    placedShots.set(shot.id, clip)
    if (hasShotAudio) shotAudioItems.push({ shot, asset, clip, sourceDuration, trimStart, linkGroupId })
    previousEnd = clip.startTime + clip.duration
    cursor = Math.max(cursor, previousEnd)

    for (const [frame, label] of [['firstFrame', 'first frame'], ['lastFrame', 'last frame']]) {
      if (shot[frame].url === null && shot[frame].mediaReason === 'not_generated') continue
      assetFor({
        id: `sb-${frame === 'firstFrame' ? 'first' : 'last'}-${shot.id}`,
        name: `S${shot.sceneNumber ?? 0}.${shot.shotNumber ?? shot.sequenceNumber} ${label}`,
        type: 'image',
        media: shot[frame],
        source: `shot.${frame}`,
        ref: shot.id,
        role: 'image',
        folderId: folderForScene(shot.sceneNumber),
        semantic: { scene: shot.sceneNumber, shotId: shot.id, characters, purpose: frame === 'firstFrame' ? 'first_frame' : 'last_frame', emotion: null, prompt: null, continuationFrom: null },
      })
    }
  })

  // Audio items per bus, laned, become tracks after the video tracks.
  const audioTrackGroups = [] // { key, bus, language, name, muted, items: [{ start, duration, build(trackId) }] }
  const group = (key, fields) => {
    let found = audioTrackGroups.find((candidate) => candidate.key === key)
    if (!found) {
      found = { key, items: [], ...fields }
      audioTrackGroups.push(found)
    }
    return found
  }

  // Dialogue: one track per language, each line at its own start (else its
  // shot's start). Dubbed lines sit where the line they dub sits.
  const languages = [...new Set([episode.language, ...episode.languages])]
  const plannedStart = (line) => line.timelineStartSeconds ?? (line.shotId ? placedShots.get(line.shotId)?.startTime : null) ?? 0
  const dialogueStart = (line) => {
    if (line.timelineStartSeconds == null) warn('dialogue_start_from_shot', { source: 'dialogue.timelineStartSeconds', ref: line.id, shotId: line.shotId ?? null })
    return plannedStart(line)
  }
  const addDialogue = ({ id, line, language, text, media, source, ref, speed, sourceSeconds }) => {
    const role = roleForStoryBookSource('dialogue_line')
    const { asset, probe } = assetFor({
      id,
      name: `${line.characterName || 'Line'} ${line.sequenceNumber} (${language})`,
      type: 'audio',
      media,
      source,
      ref,
      role,
      folderId: folderForScene(line.sceneNumber),
      language,
      semantic: {
        scene: line.sceneNumber, shotId: line.shotId, characters: line.characterName ? [line.characterName] : [],
        purpose: 'dialogue', emotion: line.emotion, prompt: null, continuationFrom: null, text, language,
      },
    })
    const length = probe?.duration ?? sourceSeconds
    if (!(length > 0)) {
      warn('dialogue_without_duration', { source, ref, assetId: asset.id })
      return
    }
    const start = atFrame(dialogueStart(line))
    group(`dialogue:${language}`, {
      bus: 'dialogue',
      language,
      name: `Dialogue (${language})`,
      muted: language !== episode.language,
    }).items.push({
      start,
      duration: frameDuration(length / speed),
      build: (trackId) => mediaClip({
        trackId, asset, startTime: start, sourceSeconds: length, sourceDuration: probe?.duration ?? length, speed,
        type: 'audio', color: AUDIO_CLIP_COLORS.dialogue,
        metadata: metadataFor(line.sceneNumber, line.shotId, role, { language, storybook: { dialogueId: line.id, sequenceNumber: line.sequenceNumber } }),
      }),
    })
  }
  const dialogueLines = [...pkg.dialogue].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
  for (const line of dialogueLines) {
    addDialogue({
      id: `sb-dlg-${line.id}`, line, language: line.language, text: line.text, media: line.audio,
      source: 'dialogue.audio', ref: line.id, speed: 1, sourceSeconds: line.estimatedDurationSeconds,
    })
  }
  const linesById = new Map(pkg.dialogue.map((line) => [line.id, line]))
  // A dub plays in the slot of the line it dubs, speed-fitted (localization/fit.js).
  const slots = dubSlots(pkg.dialogue.map((line) => ({ id: line.id, start: atFrame(plannedStart(line)) })), cursor)
  for (const dub of pkg.dubbed) {
    for (const dubbed of dub.lines) {
      const line = linesById.get(dubbed.dialogueId)
      if (!line) {
        warn('dub_without_line', { source: 'dubbed.lines', ref: dubbed.id, dialogueId: dubbed.dialogueId })
        continue
      }
      const sourceSeconds = probes.get(dubbed.audio.key)?.duration ?? dubbed.durationSeconds ?? line.estimatedDurationSeconds
      const fit = sourceSeconds > 0 ? fitDubbedLine({ sourceSeconds, timingAdjustment: dubbed.timingAdjustment, slotSeconds: slots.get(line.id) }) : { speed: dubbed.timingAdjustment, overrunSeconds: 0 }
      if (fit.overrunSeconds > 0) warn('dub_overruns_slot', { source: 'dubbed.lines', ref: dubbed.id, dialogueId: line.id, language: dub.language, speed: fit.speed, overrunSeconds: fit.overrunSeconds })
      addDialogue({
        id: `sb-dub-${dub.language}-${dubbed.id}`, line, language: dub.language, text: dubbed.translatedText, media: dubbed.audio,
        source: 'dubbed.audio', ref: dubbed.id, speed: fit.speed,
        sourceSeconds: dubbed.durationSeconds ?? line.estimatedDurationSeconds,
      })
    }
  }

  // Shot audio: each shot's own sound, linked to its picture, ducked under
  // dialogue by the bus (project.studio.audioBuses.shotaudio).
  for (const { shot, asset, clip, sourceDuration, trimStart, linkGroupId } of shotAudioItems) {
    group('shotaudio', { bus: 'shotaudio', language: null, name: BUS_TRACK_NAMES.shotaudio, muted: false }).items.push({
      start: clip.startTime,
      duration: clip.duration,
      build: (trackId) => mediaClip({
        trackId, asset, startTime: clip.startTime, sourceSeconds: clip.trimEnd - clip.trimStart, sourceDuration, trimStart,
        type: 'audio', color: AUDIO_CLIP_COLORS.shotaudio, linkGroupId,
        metadata: metadataFor(shot.sceneNumber, shot.id, 'generated_video', {
          bus: 'shotaudio', linkedVideoClipId: clip.id, embeddedAudioFromVideoAsset: true,
        }),
      }),
    })
  }

  // Music, SFX, ambience: their own buses at their planned start and
  // volume. A loopable bed longer than its file repeats back to back.
  for (const bus of ['music', 'sfx', 'ambience']) {
    for (const track of pkg.audioTracks.filter((candidate) => candidate.type === bus)) {
      const role = roleForStoryBookSource('audio_track', track.type)
      const { asset, probe } = assetFor({
        id: `sb-audio-${track.id}`,
        name: track.name || BUS_TRACK_NAMES[bus],
        type: 'audio',
        media: track.media,
        source: 'audioTracks.media',
        ref: track.id,
        role,
        folderId: soundFolderId,
        semantic: { scene: null, shotId: null, characters: [], purpose: bus, emotion: null, prompt: null, continuationFrom: null, tags: track.tags },
      })
      const fileLength = probe?.duration ?? null
      const wanted = track.durationSeconds ?? fileLength
      if (!(wanted > 0)) {
        warn('audio_without_duration', { source: 'audioTracks', ref: track.id, assetId: asset.id })
        continue
      }
      const pieceLength = fileLength ?? wanted
      const pieces = []
      if (track.loopable && fileLength && wanted > fileLength + 1e-6) {
        for (let at = 0; at < wanted - 1e-6; at += fileLength) pieces.push([at, Math.min(fileLength, wanted - at)])
      } else {
        if (fileLength && wanted > fileLength + 1e-6) warn('clip_shortened', { source: 'audioTracks.media', ref: track.id, plannedSeconds: wanted, sourceDuration: fileLength })
        pieces.push([0, Math.min(wanted, pieceLength)])
      }
      const target = group(bus, { bus, language: null, name: BUS_TRACK_NAMES[bus], muted: bus === 'music' && !policy.music.enabled })
      pieces.forEach(([offset, length], piece) => {
        const start = atFrame(track.timelineStartSeconds + offset)
        target.items.push({
          start,
          duration: frameDuration(length),
          build: (trackId) => mediaClip({
            trackId, asset, startTime: start, sourceSeconds: length, sourceDuration: fileLength ?? length,
            type: 'audio', color: AUDIO_CLIP_COLORS[bus], gainDb: volumeToGainDb(track.volume),
            metadata: metadataFor(null, null, role, { bus, storybook: { audioTrackId: track.id, volume: track.volume, loopable: track.loopable, piece } }),
          }),
        })
      })
    }
  }

  // Character reference images: in the library for search, not on the timeline.
  for (const character of pkg.characters) {
    character.referenceImages.forEach((media, index) => {
      if (media.url === null && media.mediaReason === 'not_generated') return
      assetFor({
        id: `sb-char-${character.assetId}-${index + 1}`,
        name: index === 0 ? character.name : `${character.name} reference ${index}`,
        type: 'image',
        media,
        source: 'characters.referenceImages',
        ref: character.assetId,
        role: roleForStoryBookSource('character_reference'),
        folderId: characterFolderId,
        semantic: { scene: null, shotId: null, characters: [character.name], purpose: 'character_reference', emotion: null, prompt: null, continuationFrom: null },
      })
    })
  }

  // Tracks. Audio groups in a fixed bus order, the primary language first.
  const busOrder = (entry) => [AUDIO_TRACK_ORDER.indexOf(entry.bus), entry.language ? languages.indexOf(entry.language) : 0]
  audioTrackGroups.sort((a, b) => {
    const [ab, al] = busOrder(a)
    const [bb, bl] = busOrder(b)
    return ab - bb || al - bl
  })
  const audioTracks = []
  for (const entry of audioTrackGroups) {
    const ordered = [...entry.items].sort((a, b) => a.start - b.start)
    const lanes = assignLanes(ordered)
    const laneCount = Math.max(1, ...lanes.map((lane) => lane + 1))
    if (laneCount > 1) warn('overlap_lane', { source: entry.bus, ref: entry.key, lanes: laneCount })
    const laneTrackIds = []
    for (let lane = 0; lane < laneCount; lane += 1) {
      const track = {
        id: `audio-${audioTracks.length + 1}`,
        name: lane === 0 ? entry.name : `${entry.name} ${lane + 1}`,
        type: 'audio',
        channels: 'stereo',
        muted: entry.muted,
        locked: false,
        visible: true,
        bus: entry.bus,
        ...(entry.language ? { language: entry.language } : {}),
      }
      audioTracks.push(track)
      laneTrackIds.push(track.id)
    }
    ordered.forEach((item, index) => item.build(laneTrackIds[lanes[index]]))
  }

  // Captions: the upstream editor's live captions clip, one per language on its own
  // role:'captions' track; the primary language shows, the others wait for
  // a language render (FILM-2019).
  const captionTracks = []
  const captionLanguages = [...pkg.captions].sort((a, b) => languages.indexOf(a.language) - languages.indexOf(b.language))
  captionLanguages.forEach((captionTrack, index) => {
    const cues = [...captionTrack.segments]
      .sort((a, b) => a.startSeconds - b.startSeconds || a.sequenceNumber - b.sequenceNumber)
      .map((segment) => ({ id: `cue-${segment.id}`, start: segment.startSeconds, end: Math.max(segment.endSeconds, segment.startSeconds + 0.1), text: segment.text }))
    if (cues.length === 0) {
      warn('captions_empty', { source: 'captions', ref: captionTrack.captionId, language: captionTrack.language })
      return
    }
    const track = {
      id: `video-${index + 2}`,
      name: `Captions (${captionTrack.language})`,
      type: 'video',
      muted: false,
      locked: false,
      visible: index === 0 && captionTrack.language === episode.language && policy.captions.enabled,
      role: 'captions',
      language: captionTrack.language,
    }
    captionTracks.push(track)
    const duration = Math.max(0.4, ...cues.map((cue) => cue.end))
    clips.push({
      id: nextClipId(),
      trackId: track.id,
      assetId: null,
      name: `Captions (${captionTrack.language})`,
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
      captions: {
        preset: {
          id: ROUGH_CUT_CAPTION_PRESET_ID,
          fontFamily: brand.fonts.body,
          textColor: brand.colors.captionText,
          subtitleColor: brand.colors.captionText,
        },
        cues,
        workspace: { version: 1, presetId: ROUGH_CUT_CAPTION_PRESET_ID, storybook: { captionId: captionTrack.captionId, stylePreset: captionTrack.stylePreset } },
      },
      metadata: metadataFor(null, null, 'caption', { language: captionTrack.language, storybook: { captionId: captionTrack.captionId } }),
      transform: defaultTransform(),
    })
  })

  const tracks = [
    ...captionTracks,
    { id: SHOT_TRACK_ID, name: 'Shots', type: 'video', muted: false, locked: false, visible: true },
    ...audioTracks,
  ]

  // One marker per scene, named by its heading, at the scene's first shot.
  const markers = []
  for (const number of sceneNumbers) {
    const first = shots.find((shot) => shot.sceneNumber === number && placedShots.has(shot.id))
    if (!first) {
      warn('scene_without_shots', { source: 'scenes', ref: number })
      continue
    }
    markers.push({
      id: `marker-${markers.length + 1}`,
      time: placedShots.get(first.id).startTime,
      label: scenesByNumber.get(number)?.heading || `Scene ${number}`,
      color: MARKER_COLOR,
      scene: number,
    })
  }
  markers.sort((a, b) => a.time - b.time)

  const contentEnd = Math.max(0, ...clips.map((clip) => clip.startTime + clip.duration))
  const timeline = {
    id: MASTER_TIMELINE_ID,
    name: 'Master',
    color: null,
    folderId: null,
    created: stamp,
    modified: stamp,
    width,
    height,
    fps,
    duration: Math.max(60, Math.ceil(contentEnd) + 10),
    zoom: 100,
    tracks,
    clips,
    transitions: [],
    markers,
    clipCounter: clips.length + 1,
    transitionCounter: 1,
    markerCounter: markers.length + 1,
    snappingEnabled: true,
    snappingThreshold: 10,
    rippleEditMode: false,
    studio: { kind: 'master', variantOf: null, aspect: episode.aspect, language: episode.language },
  }

  const project = {
    name: `${pkg.project.name} - E${String(episode.number).padStart(2, '0')} ${episode.title}`,
    version: PROJECT_VERSION_STUDIO,
    created: stamp,
    modified: stamp,
    settings: { width, height, fps, aspectRatio: `${width}:${height}` },
    timelines: [timeline],
    currentTimelineId: MASTER_TIMELINE_ID,
    assets,
    folders,
    folderCounter: folders.length + 1,
    generateWorkspace: null,
    studio: {
      schema: EDITGRAPH_SCHEMA,
      episodeId: episode.id,
      currentVersion: null,
      audioBuses: defaultAudioBuses(policy),
      storybook: { projectId: pkg.project.id, episodeId: episode.id, episodeVersion: episode.version, etag: pkg.etag, languages },
    },
  }

  const link = {
    apiBase: options.apiBase ?? null,
    projectId: pkg.project.id,
    episodeId: episode.id,
    episodeVersion: episode.version,
    etag: pkg.etag,
    pulledAt: options.pulledAt || pkg.generatedAt,
  }
  const files = {
    [STORYBOOK_FILES.package]: json(packageForDisk(input)),
    [STORYBOOK_FILES.link]: json(link),
    [STORYBOOK_FILES.brand]: json(brand),
    [STORYBOOK_FILES.policy]: json(policy),
  }

  return { project, files, warnings }
}
