// FILM-2011 re-sync: what changed between two edit packages, and the plan
// that would bring the open project up to date. Pure (no Electron, no fs) so
// it runs under `node --test`; sync.js and pull.js use it in main.
//
// Media are compared by `key` (FILM-2001: `<bucket>/<path>`, stable while the
// file is the same, new when it is replaced); a re-signed URL is not a
// change. Rows are matched by id. The plan is a proposal for the AI panel:
// every step is previewOnly, carries its reason as arguments.studioMeta
// (FILM-2012 op log), and uses upstream primitives that run_mcp_action_plan
// accepts (import_asset_from_path, replace_clip_with_asset, delete_clips,
// add_asset_to_timeline).
const crypto = require('crypto')

const SHOT_MEDIA = ['video', 'firstFrame', 'lastFrame']
const SHOT_FIELDS = ['durationSeconds', 'timelineStartSeconds', 'trimInSeconds', 'trimOutSeconds', 'transitionType', 'sequenceNumber']
const LINE_FIELDS = ['text', 'timelineStartSeconds', 'language', 'characterName']

// A media slot's identity: its key (a slot with no file has none). The url
// is not part of it: it is re-signed on every call and unsigned on disk.
const keyOf = (entry) => (entry && typeof entry.key === 'string' && entry.key ? entry.key : null)

const EXTENSIONS = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

function extensionFor({ key, mime }) {
  if (EXTENSIONS[mime]) return EXTENSIONS[mime]
  const match = /\.([a-z0-9]{2,5})$/i.exec(key || '')
  return match ? match[1].toLowerCase() : 'bin'
}

const ROLE_PREFIX = {
  shot_video: 'shot',
  first_frame: 'shot-first',
  last_frame: 'shot-last',
  dialogue_audio: 'line',
  dubbed_audio: 'dub',
  music: 'music',
  sfx: 'sfx',
  ambience: 'ambience',
  character_image: 'character',
}

// The local file name for one media object: readable, ordered, and derived
// from the key, so a replaced file (new key) lands under a new name and the
// old clip keeps playing until the user approves the swap.
function localMediaName({ role, sequenceNumber = null, label = null, key, mime }) {
  const prefix = ROLE_PREFIX[role] || 'media'
  const order = Number.isInteger(sequenceNumber) ? `-${String(sequenceNumber).padStart(3, '0')}` : ''
  const slug = label ? `-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)}` : ''
  const hash = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 8)
  return `${prefix}${order}${slug}-${hash}.${extensionFor({ key, mime })}`
}

function diffRows(before, after, { fields, media }) {
  const old = new Map((before || []).map((row) => [row.id, row]))
  const now = new Map((after || []).map((row) => [row.id, row]))
  const changed = []
  const added = []
  const removed = []
  for (const [id, row] of now) {
    const prev = old.get(id)
    if (!prev) {
      added.push(row)
      continue
    }
    const changedMedia = media.filter((slot) => keyOf(prev[slot]) !== keyOf(row[slot]))
    const changedFields = fields.filter((field) => JSON.stringify(prev[field] ?? null) !== JSON.stringify(row[field] ?? null))
    if (changedMedia.length || changedFields.length) {
      const keys = Object.fromEntries(changedMedia.map((slot) => [slot, { from: keyOf(prev[slot]), to: keyOf(row[slot]) }]))
      changed.push({ id, sequenceNumber: row.sequenceNumber ?? null, sceneNumber: row.sceneNumber ?? null, media: changedMedia, fields: changedFields, keys, row })
    }
  }
  for (const [id, row] of old) if (!now.has(id)) removed.push(row)
  const bySequence = (a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0)
  return { changed: changed.sort(bySequence), added: added.sort(bySequence), removed: removed.sort(bySequence) }
}

function diffEditPackages(before, after) {
  return {
    etag: { from: before?.etag ?? null, to: after?.etag ?? null },
    shots: diffRows(before?.shots, after?.shots, { fields: SHOT_FIELDS, media: SHOT_MEDIA }),
    dialogue: diffRows(before?.dialogue, after?.dialogue, { fields: LINE_FIELDS, media: ['audio'] }),
  }
}

function isEmptyDiff(diff) {
  return ['shots', 'dialogue'].every((kind) => ['changed', 'added', 'removed'].every((part) => diff[kind][part].length === 0))
}

// Which clips the open project has for each StoryBook row. The builder
// (FILM-2012) tags every clip with metadata.semantic.shotId (IN5) and each
// dialogue clip with metadata.storybook.dialogueId and metadata.language;
// shot audio clips carry the shot id too but are audio, so they are skipped.
function clipIndex(project) {
  const timelines = Array.isArray(project?.timelines) ? project.timelines : []
  const timeline = timelines.find((t) => t.id === project?.currentTimelineId) || timelines.find((t) => t?.studio?.kind === 'master') || timelines[0] || null
  const shots = new Map()
  const shotAudio = new Map()
  const lines = new Map()
  const dialogueTracks = new Map()
  const shotTracks = new Set()
  for (const clip of timeline?.clips || []) {
    const metadata = clip?.metadata || {}
    const semantic = metadata.semantic || {}
    const dialogueId = metadata.storybook?.dialogueId ?? semantic.dialogueId ?? null
    const language = metadata.language ?? semantic.language ?? null
    if (dialogueId) {
      if (!lines.has(dialogueId)) lines.set(dialogueId, [])
      lines.get(dialogueId).push(clip)
      if (language && !dialogueTracks.has(language)) dialogueTracks.set(language, clip.trackId)
    } else if (semantic.shotId && clip.type !== 'audio') {
      if (!shots.has(semantic.shotId)) shots.set(semantic.shotId, [])
      shots.get(semantic.shotId).push(clip)
      shotTracks.add(clip.trackId)
    } else if (semantic.shotId) {
      if (!shotAudio.has(semantic.shotId)) shotAudio.set(semantic.shotId, [])
      shotAudio.get(semantic.shotId).push(clip)
    }
  }
  return { timelineId: timeline?.id ?? null, shots, shotAudio, lines, dialogueTracks, shotTrack: [...shotTracks][0] ?? null }
}

const shotLabel = (row) => `shot ${row.sequenceNumber ?? '?'}${row.sceneNumber != null ? ` (scene ${row.sceneNumber})` : ''}`
const lineLabel = (row) => `line ${row.sequenceNumber ?? '?'}${row.characterName ? ` (${row.characterName})` : ''}`
const basename = (file) => String(file).split(/[\\/]/).pop()

function buildResyncPlan({ diff, project, assetPaths = {}, session = null }) {
  const index = clipIndex(project)
  const steps = []
  const unresolved = []
  const imported = new Set()

  const step = (tool, args, reason, scene = null) => {
    steps.push({ tool, arguments: { ...args, previewOnly: true, studioMeta: { reason, scene, session } }, reason })
  }
  const importStep = (key, category, reason, scene) => {
    const file = assetPaths[key]
    if (!file) return null
    if (!imported.has(key)) {
      imported.add(key)
      step('import_asset_from_path', { path: file, category, folderPath: ['StoryBook', 'Re-sync'] }, reason, scene)
    }
    return basename(file)
  }

  for (const change of diff.shots.changed) {
    if (!change.media.includes('video')) continue
    const reason = `StoryBook has a new video for ${shotLabel(change.row)}.`
    const clips = index.shots.get(change.id) || []
    const newKey = change.keys.video.to
    if (!clips.length) {
      unresolved.push({ kind: 'shot', id: change.id, reason: 'no clip in the open project carries this shot' })
      continue
    }
    if (!newKey) {
      unresolved.push({ kind: 'shot', id: change.id, reason: 'the new video is not available yet' })
      continue
    }
    const assetName = importStep(newKey, 'video', reason, change.sceneNumber)
    if (!assetName) {
      unresolved.push({ kind: 'shot', id: change.id, reason: 'the new video was not downloaded' })
      continue
    }
    for (const clip of clips) step('replace_clip_with_asset', { clipId: clip.id, assetName }, reason, change.sceneNumber)
    // The upstream editor replaces an audio clip only with an audio asset, so the shot's
    // own sound (a separate clip of the old video) cannot be swapped here.
    const stale = index.shotAudio.get(change.id) || []
    if (stale.length) {
      unresolved.push({ kind: 'shot_audio', id: change.id, clipIds: stale.map((clip) => clip.id), reason: 'the shot audio clip still plays the old take' })
    }
  }

  for (const row of diff.shots.removed) {
    const reason = `${shotLabel(row)} was removed in StoryBook.`
    const clips = index.shots.get(row.id) || []
    if (!clips.length) {
      unresolved.push({ kind: 'shot', id: row.id, reason: 'no clip in the open project carries this shot' })
      continue
    }
    const linked = index.shotAudio.get(row.id) || []
    step('delete_clips', { clipIds: [...clips, ...linked].map((clip) => clip.id) }, reason, row.sceneNumber ?? null)
  }

  for (const row of diff.shots.added) {
    const key = keyOf(row.video)
    const reason = `${shotLabel(row)} is new in StoryBook.`
    const assetName = key ? importStep(key, 'video', reason, row.sceneNumber) : null
    if (!assetName) {
      unresolved.push({ kind: 'shot', id: row.id, reason: key ? 'the video was not downloaded' : 'the shot has no video yet' })
      continue
    }
    step('add_asset_to_timeline', { assetName, ...(index.shotTrack ? { trackId: index.shotTrack } : {}), ...(row.timelineStartSeconds != null ? { startSeconds: row.timelineStartSeconds } : { placement: 'track_end' }) }, reason, row.sceneNumber)
  }

  for (const change of diff.dialogue.changed) {
    if (!change.media.includes('audio')) continue
    const reason = `StoryBook has new audio for ${lineLabel(change.row)}.`
    const clips = index.lines.get(change.id) || []
    const key = change.keys.audio.to
    const assetName = clips.length && key ? importStep(key, 'audio', reason, change.sceneNumber) : null
    if (!assetName) {
      unresolved.push({ kind: 'dialogue', id: change.id, reason: clips.length ? 'the new audio is not available' : 'no clip in the open project carries this line' })
      continue
    }
    for (const clip of clips) step('replace_clip_with_asset', { clipId: clip.id, assetName }, reason, change.sceneNumber)
  }

  for (const row of diff.dialogue.removed) {
    const clips = index.lines.get(row.id) || []
    if (!clips.length) continue
    step('delete_clips', { clipIds: clips.map((clip) => clip.id) }, `${lineLabel(row)} was removed in StoryBook.`, row.sceneNumber ?? null)
  }

  for (const row of diff.dialogue.added) {
    const key = keyOf(row.audio)
    const reason = `${lineLabel(row)} is new in StoryBook.`
    const assetName = key ? importStep(key, 'audio', reason, row.sceneNumber) : null
    if (!assetName) {
      unresolved.push({ kind: 'dialogue', id: row.id, reason: key ? 'the audio was not downloaded' : 'the line has no audio yet' })
      continue
    }
    const trackId = index.dialogueTracks.get(row.language)
    step('add_asset_to_timeline', { assetName, ...(trackId ? { trackId } : { createTrack: true, trackName: `Dialogue (${row.language})` }), ...(row.timelineStartSeconds != null ? { startSeconds: row.timelineStartSeconds } : {}) }, reason, row.sceneNumber)
  }

  return { steps, unresolved }
}

function summarizeDiff(diff) {
  const part = (n, word) => (n ? `${n} ${word}${n === 1 ? '' : 's'}` : null)
  return [
    part(diff.shots.changed.length, 'changed shot'),
    part(diff.shots.added.length, 'new shot'),
    part(diff.shots.removed.length, 'removed shot'),
    part(diff.dialogue.changed.length, 'changed line'),
    part(diff.dialogue.added.length, 'new line'),
    part(diff.dialogue.removed.length, 'removed line'),
  ].filter(Boolean).join(', ') || 'no shot or dialogue changes'
}

module.exports = {
  diffEditPackages,
  isEmptyDiff,
  buildResyncPlan,
  clipIndex,
  localMediaName,
  extensionFor,
  summarizeDiff,
  keyOf,
}
