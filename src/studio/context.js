// What the agent reads first (FILM-2013, contract P1/P2): the screenplay with
// dialogue text, the scene map, the policy and brand, a timeline summary, the
// versions and the last QA result, assembled from the live project document
// and the storybook/ files beside it. The same object is what the intent
// compilers receive. Nothing here is cached across a document change: the
// runtime builds it on every call. Pure module: no Electron, no stores.
import { BrandSchema } from './contracts/brand.schema.mjs'
import { EditPolicySchema } from './contracts/edit-policy.schema.mjs'
import { CREATE_VERSION_TOOL, clipsTouchedByUserSince } from './oplog.js'
import {
  clipEnd, clipStart, dialogueClips, isCaptionTrack, pictureClips, pictureEnd, round3, roleOfClip, sceneOfClip, sceneSpan, trackMap,
} from './intents/shared.js'

const currentTimeline = (document) => {
  const timelines = document?.timelines || []
  return timelines.find((timeline) => timeline.id === document?.currentTimelineId) || timelines[0] || null
}

// The version the last AI plan created: "since the previous plan" in A5.
export function previousPlanVersionId(log) {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const entry = log[index]
    if (entry.tool === CREATE_VERSION_TOOL && entry.by === 'ai') return entry.args?.versionId ?? null
  }
  return null
}

const parseOr = (schema, value) => {
  const parsed = schema.safeParse(value ?? {})
  return parsed.success ? { value: parsed.data, valid: value != null } : { value: schema.parse({}), valid: false, error: parsed.error.issues[0]?.message }
}

// P2: every screenplay scene appears, including those with no clip, so a
// coverage gap shows as actualDuration 0.
export function buildSceneMap({ timeline, screenplay = [], targetSeconds = null }) {
  const numbers = new Set(screenplay.map((scene) => scene.scene))
  for (const clip of timeline?.clips || []) {
    const scene = sceneOfClip(clip)
    if (scene !== null) numbers.add(scene)
  }
  const byNumber = new Map(screenplay.map((scene) => [scene.scene, scene]))
  const plannedTotal = screenplay.reduce((sum, scene) => sum + (Number(scene.estimatedDurationSeconds) || 0), 0)
  return [...numbers].sort((a, b) => a - b).map((scene) => {
    const span = sceneSpan(timeline, scene)
    const planned = byNumber.get(scene)?.estimatedDurationSeconds ?? null
    return {
      scene,
      heading: byNumber.get(scene)?.heading ?? null,
      clipIds: (timeline?.clips || []).filter((clip) => sceneOfClip(clip) === scene).map((clip) => clip.id),
      shotClipIds: span ? span.clips.map((clip) => clip.id) : [],
      start: span ? round3(span.start) : null,
      end: span ? round3(span.end) : null,
      plannedDuration: planned,
      actualDuration: span ? round3(span.end - span.start) : 0,
      targetDuration: targetSeconds && plannedTotal > 0 && planned != null ? round3((planned * targetSeconds) / plannedTotal) : null,
    }
  })
}

// The screenplay from the pulled package, each line pointing at the clips
// that carry it (dialogue clips are tagged with metadata.storybook.dialogueId).
export function buildScreenplay(pkg, timeline) {
  if (!pkg) return []
  const clipsByLine = new Map()
  for (const clip of timeline?.clips || []) {
    const id = clip.metadata?.storybook?.dialogueId
    if (!id) continue
    if (!clipsByLine.has(id)) clipsByLine.set(id, [])
    clipsByLine.get(id).push(clip.id)
  }
  const lines = [...(pkg.dialogue || [])].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
  return (pkg.scenes || []).map((scene) => ({
    scene: scene.number,
    heading: scene.heading ?? null,
    description: scene.description ?? null,
    characters: scene.characters || [],
    estimatedDurationSeconds: scene.estimatedDurationSeconds ?? null,
    dialogue: lines.filter((line) => line.sceneNumber === scene.number).map((line) => ({
      lineId: line.id,
      sequenceNumber: line.sequenceNumber,
      character: line.characterName,
      text: line.text,
      emotion: line.emotion ?? null,
      language: line.language,
      clipIds: clipsByLine.get(line.id) || [],
    })),
  }))
}

function timelineSummary(timeline) {
  const tracks = trackMap(timeline)
  const counts = new Map()
  for (const clip of timeline?.clips || []) counts.set(clip.trackId, (counts.get(clip.trackId) || 0) + 1)
  return {
    id: timeline?.id ?? null,
    name: timeline?.name ?? null,
    fps: timeline?.fps ?? null,
    duration: pictureEnd(timeline),
    clipCount: (timeline?.clips || []).length,
    shotCount: pictureClips(timeline).length,
    dialogueClipCount: dialogueClips(timeline).length,
    transitionCount: (timeline?.transitions || []).length,
    markerCount: (timeline?.markers || []).length,
    tracks: [...tracks.values()].map((track) => ({
      id: track.id,
      name: track.name,
      type: track.type,
      role: track.role ?? null,
      bus: track.bus ?? null,
      language: track.language ?? null,
      muted: Boolean(track.muted),
      locked: Boolean(track.locked),
      clipCount: counts.get(track.id) || 0,
    })),
  }
}

export function buildStudioContext({
  project = null,
  document,
  storybook = {},
  versions = [],
  currentVersionId = null,
  log = [],
  lastQa = null,
  reads = {},
}) {
  const timeline = currentTimeline(document)
  const rawPolicy = storybook.policy ?? storybook.package?.editPolicy
  const policy = parseOr(EditPolicySchema, rawPolicy)
  // allowDialogueCuts ('never' | 'ask' | 'allow', default 'ask') is not in
  // EditPolicySchema yet (a StoryBook follow-up); read it from the policy or
  // brand payload when present. The schema parse strips unknown keys.
  const dialogueCuts = [rawPolicy?.allowDialogueCuts, storybook.brand?.allowDialogueCuts, storybook.package?.brand?.allowDialogueCuts]
    .find((value) => ['never', 'ask', 'allow'].includes(value)) ?? 'ask'
  policy.value = { ...policy.value, allowDialogueCuts: policy.value.allowDialogueCuts ?? dialogueCuts }
  const brand = parseOr(BrandSchema, storybook.brand ?? storybook.package?.brand)
  const pkg = storybook.package ?? null
  const targetSeconds = policy.value.targetDurationSeconds ?? pkg?.episode?.targetDurationSeconds ?? null
  const screenplay = buildScreenplay(pkg, timeline)
  const planVersion = previousPlanVersionId(log)
  return {
    project: {
      name: project?.name ?? null,
      episodeId: project?.studio?.episodeId ?? pkg?.episode?.id ?? null,
      episodeTitle: pkg?.episode?.title ?? null,
      aspect: pkg?.episode?.aspect ?? timeline?.studio?.aspect ?? null,
      language: pkg?.episode?.language ?? timeline?.studio?.language ?? null,
      audioBuses: project?.studio?.audioBuses ?? null,
    },
    fps: Number(timeline?.fps) || 24,
    timeline,
    assets: document?.assets || [],
    screenplay,
    sceneMap: buildSceneMap({ timeline, screenplay, targetSeconds }),
    policy: policy.value,
    policySource: policy.valid ? 'storybook/policy.json' : 'defaults',
    brand: brand.value,
    brandSource: brand.valid ? 'storybook/brand.json' : 'defaults',
    target: { seconds: targetSeconds, source: policy.value.targetDurationSeconds != null ? 'policy' : targetSeconds != null ? 'episode' : null },
    analyticsHints: pkg?.analyticsHints ?? { retention: [], reason: 'unmeasured' },
    shortsCandidates: pkg?.shortsCandidates || [],
    versions,
    currentVersionId,
    previousPlanVersionId: planVersion,
    userEditedClipIds: clipsTouchedByUserSince(log, planVersion),
    lastQa,
    reads: { audioAnalysis: reads.audioAnalysis instanceof Map ? reads.audioAnalysis : new Map(Object.entries(reads.audioAnalysis || {})) },
  }
}

// The scope a capability tool accepts (contract §0): {scenes?, scene?,
// range?, clipIds?, timelineId?}; empty means the whole active timeline.
export function resolveScope(context, scope = {}) {
  const raw = scope && typeof scope === 'object' ? scope : {}
  const known = context.sceneMap.map((entry) => entry.scene)
  const listed = [...(Array.isArray(raw.scenes) ? raw.scenes : []), ...(raw.scene != null ? [raw.scene] : [])].map(Number)
  const unknown = listed.filter((scene) => !known.includes(scene))
  if (unknown.length) {
    const error = new Error(`Scene ${unknown.join(', ')} is not in this episode (scenes ${known.join(', ') || 'none'}).`)
    error.code = 'VALIDATION_FAILED'
    throw error
  }
  if (raw.timelineId && context.timeline && raw.timelineId !== context.timeline.id) {
    const error = new Error(`Timeline ${raw.timelineId} is not the active timeline (${context.timeline.id}); switch to it first.`)
    error.code = 'VALIDATION_FAILED'
    throw error
  }
  const range = Array.isArray(raw.range) && raw.range.length === 2 ? raw.range.map(Number) : null
  const clipIds = Array.isArray(raw.clipIds) ? raw.clipIds.map(String) : []
  let scenes = listed.length ? [...new Set(listed)].sort((a, b) => a - b) : known
  if (!listed.length && range) {
    scenes = context.sceneMap.filter((entry) => entry.start != null && entry.end > range[0] && entry.start < range[1]).map((entry) => entry.scene)
  }
  if (!listed.length && clipIds.length) {
    const byId = new Map((context.timeline?.clips || []).map((clip) => [clip.id, clip]))
    scenes = [...new Set(clipIds.map((id) => sceneOfClip(byId.get(id))).filter((scene) => scene !== null))].sort((a, b) => a - b)
  }
  return { scenes, range, clipIds, whole: !listed.length && !range && !clipIds.length }
}

// What studio_get_context returns: the context without the whole document.
export function summarizeContext(context, scope = null) {
  const resolved = scope ? resolveScope(context, scope) : null
  const inScope = (scene) => !resolved || resolved.scenes.includes(scene)
  return {
    project: context.project,
    screenplay: context.screenplay.filter((scene) => inScope(scene.scene)),
    sceneMap: context.sceneMap.filter((entry) => inScope(entry.scene)),
    policy: context.policy,
    policySource: context.policySource,
    brand: {
      fonts: context.brand.fonts,
      colors: context.brand.colors,
      captionStyle: context.brand.captionStyle,
      transitionStyle: context.brand.transitionStyle,
      musicStyle: context.brand.musicStyle,
      hasLogo: Boolean(context.brand.logo?.assetId),
      hasIntro: Boolean(context.brand.introAssetId),
      hasOutro: Boolean(context.brand.outroAssetId),
      source: context.brandSource,
    },
    target: context.target,
    timeline: timelineSummary(context.timeline),
    versions: context.versions.map(({ id, name, parent, createdBy, createdAt, prompt }) => ({ id, name, parent, createdBy, createdAt, prompt })),
    currentVersionId: context.currentVersionId,
    userEditedClipIds: context.userEditedClipIds,
    lastQa: context.lastQa,
    analyticsHints: context.analyticsHints,
    intents: null,
  }
}

// Timing state of the active timeline, for TARGET_CHANGED: tracks, clips,
// transitions and markers, never selection or playhead.
export function documentFingerprint(document) {
  const timeline = currentTimeline(document)
  const text = JSON.stringify({
    id: timeline?.id ?? null,
    tracks: timeline?.tracks ?? [],
    clips: timeline?.clips ?? [],
    transitions: timeline?.transitions ?? [],
    markers: timeline?.markers ?? [],
  })
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}-${text.length}`
}

// For studio_search_assets: an asset's searchable text and its transcript.
export function assetSearchFields(asset) {
  const semantic = asset?.semantic || {}
  return {
    name: asset?.name || '',
    role: asset?.role ?? null,
    scene: Number.isInteger(semantic.scene) ? semantic.scene : null,
    text: [semantic.purpose, semantic.prompt, semantic.emotion, semantic.cameraDirection, ...(semantic.characters || []), ...(semantic.tags || [])].filter(Boolean).join(' '),
    transcript: semantic.text || '',
    duration: Number(asset?.duration ?? asset?.settings?.duration) || null,
  }
}

export const SEARCH_WEIGHTS = Object.freeze({ name: 3, transcript: 2, text: 1 })

export function searchAssets(context, { query = '', role = null, scene = null, durationRange = null, limit = 20 } = {}) {
  const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1)
  const results = []
  for (const asset of context.assets) {
    const fields = assetSearchFields(asset)
    if (role && fields.role !== role) continue
    if (scene != null && fields.scene !== Number(scene)) continue
    if (durationRange && fields.duration != null && (fields.duration < durationRange[0] || fields.duration > durationRange[1])) continue
    let score = 0
    const matched = []
    for (const word of words) {
      for (const key of ['name', 'transcript', 'text']) {
        if (fields[key].toLowerCase().includes(word)) {
          score += SEARCH_WEIGHTS[key]
          matched.push(`${key}:${word}`)
        }
      }
    }
    if (words.length && score === 0) continue
    results.push({
      assetId: asset.id,
      name: fields.name,
      type: asset.type,
      role: fields.role,
      scene: fields.scene,
      duration: fields.duration,
      offline: Boolean(asset.offline),
      score,
      matched,
      transcript: fields.transcript || undefined,
      onTimeline: (context.timeline?.clips || []).filter((clip) => clip.assetId === asset.id).map((clip) => clip.id),
    })
  }
  results.sort((a, b) => b.score - a.score || (a.scene ?? 1e9) - (b.scene ?? 1e9) || a.name.localeCompare(b.name))
  return results.slice(0, Math.max(1, Math.min(200, Number(limit) || 20)))
}

export { clipEnd, clipStart, isCaptionTrack, roleOfClip }
