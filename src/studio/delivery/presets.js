// FILM-2017: the six delivery presets, with what each one encodes. The
// names and aspects are StoryBook's (contracts/render-presets.mjs, FILM-2003):
// request_render_upload refuses any other name, and a test holds this table
// to that one. What this file adds is the encode: frame, fps, codec, bitrate,
// audio, the loudness target, the longest file the platform takes, and
// whether captions are burned into the picture or sent beside it.
//
// fps null keeps the timeline's rate; width/height null (master only) keep
// the timeline's frame. audioLufs null (master) means the edit policy's
// target, which is how FILM-2016's loudnessTargetFor reads it.
//
// Caption policy (spec open question, lead default, owner may change): burn
// for the vertical platforms, which autoplay muted and show no sidecar track
// reliably; sidecar for youtube_16x9 and master, where captions stay a
// separate WebVTT file. square_1x1 is a feed post and burns as the vertical
// ones do.
import { RENDER_PRESETS, RENDER_PRESET_NAMES } from '../contracts/render-presets.mjs'

export const CAPTION_POLICIES = Object.freeze(['burn', 'sidecar', 'none'])

const preset = (fields) => Object.freeze({ codec: 'h264', audioCodec: 'aac', audioBitrate: 192, ...fields })

export const DELIVERY_PRESETS = Object.freeze({
  youtube_16x9: preset({ name: 'youtube_16x9', width: 1920, height: 1080, fps: null, bitrate: 12000, audioLufs: -14, maxDuration: null, captionPolicy: 'sidecar' }),
  shorts_9x16: preset({ name: 'shorts_9x16', width: 1080, height: 1920, fps: 30, bitrate: 10000, audioLufs: -14, maxDuration: 180, captionPolicy: 'burn' }),
  tiktok_9x16: preset({ name: 'tiktok_9x16', width: 1080, height: 1920, fps: 30, bitrate: 8000, audioLufs: -14, maxDuration: 600, captionPolicy: 'burn' }),
  reels_9x16: preset({ name: 'reels_9x16', width: 1080, height: 1920, fps: 30, bitrate: 8000, audioLufs: -16, maxDuration: 180, captionPolicy: 'burn' }),
  square_1x1: preset({ name: 'square_1x1', width: 1080, height: 1080, fps: 30, bitrate: 8000, audioLufs: -14, maxDuration: null, captionPolicy: 'burn' }),
  master: preset({ name: 'master', width: null, height: null, fps: null, bitrate: 40000, audioBitrate: 320, audioLufs: null, maxDuration: null, captionPolicy: 'sidecar' }),
})

export const DELIVERY_PRESET_NAMES = Object.freeze(Object.keys(DELIVERY_PRESETS))
export const VERTICAL_PRESET_NAMES = Object.freeze(DELIVERY_PRESET_NAMES.filter((name) => RENDER_PRESETS[name]?.aspect === '9:16'))
export const DEFAULT_LANGUAGE = 'en'
// The policy's loudness when it names none (FILM-2016's DEFAULT_LOUDNESS_LUFS).
export const DEFAULT_LOUDNESS_LUFS = -14

export const isDeliveryPreset = (name) => Object.prototype.hasOwnProperty.call(DELIVERY_PRESETS, name)

export function presetFor(name) {
  if (!isDeliveryPreset(name)) {
    throw Object.assign(new Error(`Unknown delivery preset "${name}". Use one of ${DELIVERY_PRESET_NAMES.join(', ')}.`), { code: 'VALIDATION_FAILED' })
  }
  return DELIVERY_PRESETS[name]
}

const ASPECTS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 }

export function aspectOf(width, height) {
  const ratio = width / height
  let best = null
  for (const [name, value] of Object.entries(ASPECTS)) {
    if (Math.abs(ratio - value) < 0.02 && (!best || Math.abs(ratio - value) < Math.abs(ratio - ASPECTS[best]))) best = name
  }
  return best
}

// The frame, fps and loudness a render of `name` actually uses, given the
// timeline it renders and the edit policy.
export function resolvePreset(name, { timeline = null, policy = null } = {}) {
  const base = presetFor(name)
  const even = (value) => Math.max(2, Math.round(value / 2) * 2)
  const width = base.width ?? even(Number(timeline?.width) || 1920)
  const height = base.height ?? even(Number(timeline?.height) || 1080)
  const fps = base.fps ?? (Number(timeline?.fps) || 24)
  const policyLufs = Number(policy?.loudnessTargetLufs ?? policy?.audio?.loudnessTargetLufs)
  const audioLufs = base.audioLufs ?? (Number.isFinite(policyLufs) ? policyLufs : DEFAULT_LOUDNESS_LUFS)
  return { ...base, width, height, fps, audioLufs, aspect: RENDER_PRESETS[name].aspect ?? aspectOf(width, height) ?? '16:9' }
}

export const deliveryFileName = (presetName, language = DEFAULT_LANGUAGE) => `${presetName}-${language}.mp4`

// renders/<version>/<preset>-<lang>.mp4, relative to the project folder.
export function deliveryRelPath(version, presetName, language = DEFAULT_LANGUAGE) {
  const safeVersion = String(version || 'latest').replace(/[^A-Za-z0-9._-]/g, '_') || 'latest'
  return `renders/${safeVersion}/${deliveryFileName(presetName, language)}`
}

// Video plus audio at the preset's bitrates, plus 1% container overhead.
export function estimateBytes(presetName, durationSeconds) {
  const { bitrate, audioBitrate } = presetFor(presetName)
  const seconds = Math.max(0, Number(durationSeconds) || 0)
  return Math.round(((bitrate + audioBitrate) * 1000 * seconds) / 8 * 1.01)
}

// The settings the upstream editor's export_timeline takes for this preset (the
// renderer's export worker), used by export_delivery_batch.
export function exportSettingsForPreset(name, { timeline = null, policy = null, language = DEFAULT_LANGUAGE } = {}) {
  const resolved = resolvePreset(name, { timeline, policy })
  return {
    width: resolved.width,
    height: resolved.height,
    fps: resolved.fps,
    videoCodec: resolved.codec,
    audioCodec: resolved.audioCodec,
    qualityMode: 'bitrate',
    bitrateKbps: resolved.bitrate,
    audioBitrateKbps: resolved.audioBitrate,
    audioSampleRate: 48000,
    normalizeAudio: true,
    loudnessTarget: resolved.audioLufs,
    deliveryFraming: resolved.aspect === aspectOf(Number(timeline?.width) || 1920, Number(timeline?.height) || 1080) ? 'fit' : 'fill',
    captionPolicy: resolved.captionPolicy,
    language,
    deliveryPreset: resolved.name,
  }
}

// Every preset name StoryBook knows has an encode here, and no other name.
export function presetTableProblems() {
  const problems = []
  const ours = new Set(DELIVERY_PRESET_NAMES)
  for (const name of RENDER_PRESET_NAMES) if (!ours.has(name)) problems.push(`missing preset ${name}`)
  for (const name of ours) if (!RENDER_PRESET_NAMES.includes(name)) problems.push(`preset ${name} is not in StoryBook's contract`)
  for (const name of DELIVERY_PRESET_NAMES) {
    const entry = DELIVERY_PRESETS[name]
    const expected = RENDER_PRESETS[name]?.aspect ?? null
    if (entry.width && entry.height && expected && aspectOf(entry.width, entry.height) !== expected) problems.push(`${name} is ${entry.width}x${entry.height}, not ${expected}`)
    if (!CAPTION_POLICIES.includes(entry.captionPolicy)) problems.push(`${name} has caption policy ${entry.captionPolicy}`)
  }
  return problems
}
