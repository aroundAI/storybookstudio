// FILM-2016 AC4: studio_edit_audio intents compile to primitives and bus
// changes, one reason per step (contract A1). FILM-2013 registers the tool
// and runs the plan; this module decides the steps. Pure.
//
//   compileAudioIntent({ intent, scope, params, context, policy })
//     → { steps: [{ tool, arguments: { …, studioMeta: { reason, scene } } }],
//         reasons: string[], expected: {…}, refused?: { code, reason } }
//
// intent: 'balance' | 'duck' | 'normalize' | 'fade'
// scope:  'episode' | { scenes?: number[], clipIds?: string[], range?: { start, end } }
// context: { timeline: { clips, tracks }, audioBuses (project.studio.audioBuses),
//            loudness?: { [clipId]: { integratedLufs } }, presetLufs? }
// Steps carry no previewOnly: the runner previews, then applies (A3, A4).
import { EditPolicySchema } from '../contracts/edit-policy.schema.mjs'
import {
  applyBusPatch,
  busForTrack,
  DIALOGUE_BUS,
  DUCK_ATTACK_MS,
  DUCK_RELEASE_MS,
  loudnessTargetFor,
  resolveAudioBuses,
  validateBusPatch,
} from '../audio/buses.js'
import { diffBuses } from '../audio/busActions.js'

export const AUDIO_INTENTS = Object.freeze(['balance', 'duck', 'normalize', 'fade'])
// Dialogue over the music bed, as heard (after ducking). The policy has no
// ratio field; 12 dB is a lead default the owner may change (FILM-2016 notes).
export const DEFAULT_DIALOGUE_OVER_MUSIC_DB = 12
export const BALANCE_TOLERANCE_DB = 1
export const MAX_CLIP_GAIN_STEP_DB = 6
export const NORMALIZE_TOLERANCE_DB = 0.5
export const MAX_NORMALIZE_GAIN_DB = 12
// Fades at cuts: a short de-click for speech and shot sound, a softer edge
// for beds. Never longer than half the clip (contract: fades never exceed
// the clip length).
export const FADE_AT_CUT_SECONDS = Object.freeze({ dialogue: 0.02, shotaudio: 0.05, sfx: 0.02, music: 0.5, ambience: 0.5, none: 0.05 })
const CUT_TOLERANCE_SECONDS = 1 / 48

const round2 = (value) => Math.round(value * 100) / 100
const round3 = (value) => Math.round(value * 1000) / 1000
const refuse = (reason) => ({ steps: [], reasons: [reason], expected: null, refused: { code: 'VALIDATION_FAILED', reason } })
const step = (tool, args, reason, scene = null) => ({ tool, arguments: { ...args, studioMeta: { reason, scene } } })
const sceneOf = (clip) => clip?.metadata?.semantic?.scene ?? null
const energyMean = (values) => 10 * Math.log10(values.reduce((sum, db) => sum + 10 ** (db / 10), 0) / values.length)
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function inScope(scope) {
  if (!scope || scope === 'episode') return () => true
  const scenes = Array.isArray(scope.scenes) ? new Set(scope.scenes) : null
  const clipIds = Array.isArray(scope.clipIds) ? new Set(scope.clipIds) : null
  const range = scope.range && Number.isFinite(scope.range.start) && Number.isFinite(scope.range.end) ? scope.range : null
  return (clip) => (!scenes || scenes.has(sceneOf(clip)))
    && (!clipIds || clipIds.has(clip.id))
    && (!range || (clip.startTime < range.end && clip.startTime + clip.duration > range.start))
}

function audioClips(context, scope) {
  const tracks = new Map((context?.timeline?.tracks || []).map((track) => [track.id, track]))
  const keep = inScope(scope)
  return (context?.timeline?.clips || [])
    .filter((clip) => clip.type === 'audio' && tracks.get(clip.trackId)?.type === 'audio' && !tracks.get(clip.trackId).muted && clip.enabled !== false && keep(clip))
    .map((clip) => ({ clip, track: tracks.get(clip.trackId), bus: busForTrack(tracks.get(clip.trackId)) ?? 'none' }))
}

const measured = (context, clip) => {
  const value = context?.loudness?.[clip.id]?.integratedLufs
  return Number.isFinite(value) ? value : null
}

function compileDuck({ params, context, policy }) {
  const buses = Array.isArray(params.buses) && params.buses.length ? params.buses : ['music']
  if (buses.includes(DIALOGUE_BUS)) return refuse('The dialogue bus is never ducked.')
  const current = resolveAudioBuses(context?.audioBuses, { policy })
  if (!current) return refuse('This project has no audio buses (open it from a StoryBook episode).')
  const enabled = params.enabled !== false
  const duckDb = Number.isFinite(params.duckDb) ? params.duckDb : policy.music.duckDb
  const patch = Object.fromEntries(buses.map((bus) => [bus, enabled
    ? { duckUnder: DIALOGUE_BUS, duckDb, attackMs: DUCK_ATTACK_MS, releaseMs: DUCK_RELEASE_MS }
    : { duckUnder: null }]))
  const problems = validateBusPatch(patch)
  if (problems.length) return refuse(problems.join('; '))
  const changes = diffBuses(current, applyBusPatch(current, patch, { policy }))
  const what = enabled ? `duck ${buses.join(' and ')} ${duckDb} dB under dialogue (${DUCK_ATTACK_MS} ms attack, ${DUCK_RELEASE_MS} ms release)` : `stop ducking ${buses.join(' and ')}`
  const source = Number.isFinite(params.duckDb) ? 'as asked' : `policy music.duckDb ${policy.music.duckDb} dB`
  if (!changes.length) return { steps: [], reasons: [`Already set: ${what}.`], expected: { buses: patch } }
  const reason = `${what[0].toUpperCase()}${what.slice(1)}, ${source}; the dialogue bus is never ducked.`
  return { steps: [step('set_audio_buses', { buses: patch }, reason)], reasons: [reason], expected: { buses: patch, changes } }
}

function compileNormalize({ scope, params, context, policy }) {
  const current = resolveAudioBuses(context?.audioBuses, { policy })
  if (!current) return refuse('This project has no audio buses (open it from a StoryBook episode).')
  const target = Number.isFinite(params.targetLufs) ? params.targetLufs
    : Number.isFinite(context?.presetLufs) ? context.presetLufs
      : loudnessTargetFor({ preset: params.preset ?? null, policy })
  const steps = []
  const reasons = []
  const source = Number.isFinite(params.targetLufs) ? 'as asked' : Number.isFinite(context?.presetLufs) || params.preset ? 'the delivery preset' : 'policy loudnessTargetLufs'
  if (current.master.limiterLufs !== target) {
    const reason = `Normalize the master to ${target} LUFS (${source}); the export's loudnorm pass lands within ±1 LU of it.`
    steps.push(step('set_audio_buses', { buses: { master: { limiterLufs: target } } }, reason))
    reasons.push(reason)
  } else {
    reasons.push(`The master already normalizes to ${target} LUFS.`)
  }
  // Bus level: dialogue lines levelled to the target, so the master's single
  // gain does not leave quiet lines quiet. Unmeasured lines are left alone.
  const dialogue = audioClips(context, scope).filter((entry) => entry.bus === DIALOGUE_BUS)
  const unmeasured = dialogue.filter((entry) => measured(context, entry.clip) === null)
  if (unmeasured.length) reasons.push(`${unmeasured.length} dialogue clip(s) have no loudness measurement and keep their gain.`)
  const reference = Number.isFinite(params.dialogueLufs) ? params.dialogueLufs : target
  for (const { clip } of dialogue) {
    const lufs = measured(context, clip)
    if (lufs === null) continue
    const now = Number(clip.gainDb) || 0
    const heard = lufs + now + current.dialogue.gainDb
    const delta = Math.max(-MAX_NORMALIZE_GAIN_DB, Math.min(MAX_NORMALIZE_GAIN_DB, reference - heard))
    if (Math.abs(delta) < NORMALIZE_TOLERANCE_DB) continue
    const reason = `Dialogue "${clip.name || clip.id}" plays at ${round2(heard)} LUFS; ${delta > 0 ? 'raise' : 'lower'} it ${round2(Math.abs(delta))} dB to sit at ${reference} LUFS with the other lines.`
    steps.push(step('set_clip_audio', { clipId: clip.id, gainDb: round2(now + delta) }, reason, sceneOf(clip)))
    reasons.push(reason)
  }
  return { steps, reasons, expected: { masterLufs: target, toleranceLu: 1, dialogueLufs: reference } }
}

function compileBalance({ scope, params, context, policy }) {
  const current = resolveAudioBuses(context?.audioBuses, { policy })
  if (!current) return refuse('This project has no audio buses (open it from a StoryBook episode).')
  const target = Number.isFinite(params.ratioDb) ? params.ratioDb : DEFAULT_DIALOGUE_OVER_MUSIC_DB
  const clips = audioClips(context, scope)
  const dialogue = clips.filter((entry) => entry.bus === DIALOGUE_BUS)
  // A bed spans scenes and carries none: it counts wherever it plays under
  // the dialogue in scope.
  const music = audioClips(context, 'episode').filter((entry) => entry.bus === 'music')
  if (!dialogue.length || !music.length) return refuse('Balance needs dialogue and music in scope.')
  const missing = [...dialogue, ...music].filter((entry) => measured(context, entry.clip) === null)
  if (missing.length) return refuse(`unmeasured: ${missing.length} clip(s) in scope have no loudness (${missing.slice(0, 3).map((entry) => entry.clip.id).join(', ')}); measure them first (get_audio_analysis or measureLoudness).`)

  const musicDuck = current.music.duckUnder === DIALOGUE_BUS ? current.music.duckDb : 0
  const scenes = [...new Set(dialogue.map((entry) => sceneOf(entry.clip)))]
  const segments = []
  for (const scene of scenes) {
    const lines = dialogue.filter((entry) => sceneOf(entry.clip) === scene)
    const start = Math.min(...lines.map((entry) => entry.clip.startTime))
    const end = Math.max(...lines.map((entry) => entry.clip.startTime + entry.clip.duration))
    const beds = music.filter((entry) => entry.clip.startTime < end && entry.clip.startTime + entry.clip.duration > start)
    if (!beds.length) continue
    const dialogueLufs = energyMean(lines.map((entry) => measured(context, entry.clip) + (Number(entry.clip.gainDb) || 0) + current.dialogue.gainDb))
    const musicLufs = energyMean(beds.map((entry) => measured(context, entry.clip) + (Number(entry.clip.gainDb) || 0) + current.music.gainDb + musicDuck))
    segments.push({ scene, start, end, lines, ratioDb: dialogueLufs - musicLufs })
  }
  if (!segments.length) return refuse('No music plays under the dialogue in scope.')

  // One move for the whole bed on the music bus (the median correction),
  // then each scene's remainder on its dialogue lines.
  const steps = []
  const reasons = []
  const busMove = round2(median(segments.map((segment) => segment.ratioDb - target)))
  if (Math.abs(busMove) >= BALANCE_TOLERANCE_DB) {
    const gainDb = round2(current.music.gainDb + busMove)
    const reason = `Dialogue sits a median ${round2(median(segments.map((segment) => segment.ratioDb)))} dB over the music; ${busMove > 0 ? 'raise' : 'lower'} the music bus ${Math.abs(busMove)} dB toward ${target} dB under dialogue.`
    steps.push(step('set_audio_buses', { buses: { music: { gainDb } } }, reason))
    reasons.push(reason)
  }
  const after = []
  for (const segment of segments) {
    const remainder = round2(segment.ratioDb - busMove - target)
    let lineMove = 0
    if (Math.abs(remainder) >= BALANCE_TOLERANCE_DB) {
      lineMove = round2(Math.max(-MAX_CLIP_GAIN_STEP_DB, Math.min(MAX_CLIP_GAIN_STEP_DB, -remainder)))
      for (const { clip } of segment.lines) {
        const reason = `Scene ${segment.scene}: dialogue is ${round2(segment.ratioDb - busMove)} dB over the music after the bus move; ${lineMove > 0 ? 'raise' : 'lower'} "${clip.name || clip.id}" ${Math.abs(lineMove)} dB to reach ${target} dB.`
        steps.push(step('set_clip_audio', { clipId: clip.id, gainDb: round2((Number(clip.gainDb) || 0) + lineMove) }, reason, segment.scene))
        reasons.push(reason)
      }
    }
    after.push({ scene: segment.scene, ratioDbBefore: round2(segment.ratioDb), ratioDbAfter: round2(segment.ratioDb - busMove + lineMove) })
  }
  if (!steps.length) reasons.push(`Every scene is within ${BALANCE_TOLERANCE_DB} dB of ${target} dB dialogue over music.`)
  return { steps, reasons, expected: { targetRatioDb: target, toleranceDb: BALANCE_TOLERANCE_DB, segments: after } }
}

function compileFade({ scope, params, context }) {
  const pictures = (context?.timeline?.clips || []).filter((clip) => clip.type === 'video')
  const cuts = [...new Set(pictures.flatMap((clip) => [clip.startTime, clip.startTime + clip.duration]).map(round3))]
  const atCut = (time) => cuts.some((cut) => Math.abs(cut - time) <= CUT_TOLERANCE_SECONDS)
  const groups = new Map()
  for (const { clip, bus } of audioClips(context, scope)) {
    const want = Math.min(Number.isFinite(params.seconds) ? params.seconds : FADE_AT_CUT_SECONDS[bus], clip.duration / 2)
    const fadeIn = atCut(clip.startTime) && (Number(clip.fadeIn) || 0) < want - 1e-6 ? round3(want) : undefined
    const fadeOut = atCut(clip.startTime + clip.duration) && (Number(clip.fadeOut) || 0) < want - 1e-6 ? round3(want) : undefined
    if (fadeIn === undefined && fadeOut === undefined) continue
    const key = `${bus}|${fadeIn}|${fadeOut}`
    if (!groups.has(key)) groups.set(key, { bus, fadeIn, fadeOut, clips: [] })
    groups.get(key).clips.push(clip)
  }
  const steps = []
  const reasons = []
  for (const group of groups.values()) {
    const edges = [group.fadeIn !== undefined ? `${group.fadeIn} s fade-in` : null, group.fadeOut !== undefined ? `${group.fadeOut} s fade-out` : null].filter(Boolean).join(' and ')
    const reason = `${group.clips.length} ${group.bus} clip(s) meet a picture cut with no fade: ${edges} so the cut does not click (no fade longer than half its clip).`
    const args = { clipIds: group.clips.map((clip) => clip.id) }
    if (group.fadeIn !== undefined) args.fadeInSeconds = group.fadeIn
    if (group.fadeOut !== undefined) args.fadeOutSeconds = group.fadeOut
    const scenes = [...new Set(group.clips.map(sceneOf))]
    steps.push(step('set_clip_audio', args, reason, scenes.length === 1 ? scenes[0] : null))
    reasons.push(reason)
  }
  if (!steps.length) reasons.push('Every audio edge on a cut already has its fade.')
  return { steps, reasons, expected: { fades: steps.reduce((sum, entry) => sum + entry.arguments.clipIds.length, 0) } }
}

export function compileAudioIntent({ intent, scope = 'episode', params = {}, context = {}, policy: policyInput = {} } = {}) {
  if (!AUDIO_INTENTS.includes(intent)) return refuse(`Unknown audio intent "${intent}" (${AUDIO_INTENTS.join(', ')}).`)
  const policy = EditPolicySchema.parse(policyInput ?? {})
  const args = { scope, params: params || {}, context, policy }
  switch (intent) {
    case 'duck': return compileDuck(args)
    case 'normalize': return compileNormalize(args)
    case 'balance': return compileBalance(args)
    default: return compileFade(args)
  }
}
