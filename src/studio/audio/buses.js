// FILM-2016: audio buses. The single source for the bus model the builder
// writes (project.studio.audioBuses), the preview graph and the export mix
// read, and the audio intents change. Pure: no Electron, no stores.
//
//   project.studio.audioBuses = {
//     dialogue:  { gainDb },
//     music:     { gainDb, duckUnder: 'dialogue' | null, duckDb, attackMs, releaseMs },
//     sfx:       { gainDb },
//     ambience:  { gainDb },
//     shotaudio: { gainDb, duckUnder: 'dialogue', duckDb, attackMs, releaseMs },
//     master:    { limiterLufs },
//   }
//
// Ducking is a sidechain from the dialogue bus onto another bus: while the
// dialogue bus carries sound, the ducked bus sits `duckDb` lower, reached in
// `attackMs` and released over `releaseMs`. The dialogue bus is never ducked.

export const AUDIO_BUSES = Object.freeze(['dialogue', 'music', 'sfx', 'ambience', 'shotaudio'])
export const DIALOGUE_BUS = 'dialogue'
export const MASTER_BUS = 'master'
export const DEFAULT_DUCK_DB = -8
export const DUCK_ATTACK_MS = 120
export const DUCK_RELEASE_MS = 400
// Dialogue louder than this (dBFS, RMS) counts as "dialogue present" for the
// preview follower and the export sidechain key alike.
export const DUCK_THRESHOLD_DB = -45
export const BUS_GAIN_RANGE_DB = Object.freeze({ min: -60, max: 12 })
export const DUCK_DB_RANGE = Object.freeze({ min: -40, max: 0 })
export const LUFS_RANGE = Object.freeze({ min: -31, max: -5 })
export const DEFAULT_LOUDNESS_LUFS = -14

// Platform targets per delivery preset (FILM-2014 / FILM-2017: -14 LUFS
// YouTube and Shorts, -16 Reels). `master` follows the policy. A preset
// object from FILM-2017's presets.js carrying `audioLufs` wins over this.
export const PRESET_LOUDNESS_LUFS = Object.freeze({
  youtube_16x9: -14,
  shorts_9x16: -14,
  tiktok_9x16: -14,
  reels_9x16: -16,
  square_1x1: -14,
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const round2 = (value) => Math.round(value * 100) / 100

export const dbToGain = (db) => (db === -Infinity ? 0 : 10 ** (db / 20))
export const gainToDb = (gain) => (gain > 0 ? 20 * Math.log10(gain) : -Infinity)

export const isAudioBus = (bus) => AUDIO_BUSES.includes(bus)

export function busForTrack(track) {
  if (!track || track.type !== 'audio') return null
  return isAudioBus(track.bus) ? track.bus : null
}

export function loudnessTargetFor({ preset = null, policy = null } = {}) {
  if (preset && typeof preset === 'object' && finite(preset.audioLufs)) return preset.audioLufs
  const name = typeof preset === 'string' ? preset : preset?.name
  if (name && finite(PRESET_LOUDNESS_LUFS[name])) return PRESET_LOUDNESS_LUFS[name]
  return finite(policy?.loudnessTargetLufs) ? policy.loudnessTargetLufs : DEFAULT_LOUDNESS_LUFS
}

const duckFor = (policy) => ({
  duckUnder: DIALOGUE_BUS,
  duckDb: finite(policy?.music?.duckDb) ? policy.music.duckDb : DEFAULT_DUCK_DB,
  attackMs: DUCK_ATTACK_MS,
  releaseMs: DUCK_RELEASE_MS,
})

// What a fresh project carries. Music ducks when the policy says so; shot
// audio (Veo's own sound) always ducks rather than mutes (FILM-2016 notes).
export function defaultAudioBuses(policy = null, { preset = null } = {}) {
  const duck = duckFor(policy)
  const musicDucks = policy?.music?.duckUnderDialogue !== false
  return {
    dialogue: { gainDb: 0 },
    music: { gainDb: 0, ...(musicDucks ? duck : { duckUnder: null }) },
    sfx: { gainDb: 0 },
    ambience: { gainDb: 0 },
    shotaudio: { gainDb: 0, ...duck },
    master: { limiterLufs: loudnessTargetFor({ preset, policy }) },
  }
}

// A stored config with every bus present and the dialogue bus never ducked.
// A ducked bus missing its timing gets the defaults. null in, null out (a
// plain upstream project has no buses and mixes as it always has).
export function resolveAudioBuses(stored, { policy = null, preset = null } = {}) {
  if (!stored || typeof stored !== 'object') return null
  const defaults = defaultAudioBuses(policy, { preset })
  const resolved = {}
  for (const bus of AUDIO_BUSES) {
    const entry = { ...defaults[bus], ...(stored[bus] && typeof stored[bus] === 'object' ? stored[bus] : {}) }
    if (!finite(entry.gainDb)) entry.gainDb = 0
    if (bus === DIALOGUE_BUS) {
      resolved[bus] = { gainDb: entry.gainDb }
      continue
    }
    if (entry.duckUnder === DIALOGUE_BUS) {
      const duck = duckFor(policy)
      resolved[bus] = {
        gainDb: entry.gainDb,
        duckUnder: DIALOGUE_BUS,
        duckDb: finite(entry.duckDb) ? entry.duckDb : duck.duckDb,
        attackMs: finite(entry.attackMs) ? entry.attackMs : DUCK_ATTACK_MS,
        releaseMs: finite(entry.releaseMs) ? entry.releaseMs : DUCK_RELEASE_MS,
      }
    } else if ('duckUnder' in entry) {
      resolved[bus] = { gainDb: entry.gainDb, duckUnder: null }
    } else {
      resolved[bus] = { gainDb: entry.gainDb }
    }
  }
  const master = { ...defaults.master, ...(stored.master && typeof stored.master === 'object' ? stored.master : {}) }
  resolved.master = { limiterLufs: finite(master.limiterLufs) ? master.limiterLufs : defaults.master.limiterLufs }
  return resolved
}

export const duckedBuses = (buses) => AUDIO_BUSES.filter((bus) => bus !== DIALOGUE_BUS && buses?.[bus]?.duckUnder === DIALOGUE_BUS)

const inRange = (value, { min, max }) => finite(value) && value >= min && value <= max

// Reasons a patch cannot apply, [] when it can. A patch is
// { [bus]: { gainDb?, duckUnder?: 'dialogue' | null, duckDb?, attackMs?, releaseMs? }, master?: { limiterLufs? } }.
export function validateBusPatch(patch) {
  const problems = []
  if (!patch || typeof patch !== 'object') return ['A bus patch is an object keyed by bus.']
  for (const [bus, change] of Object.entries(patch)) {
    if (bus !== MASTER_BUS && !isAudioBus(bus)) {
      problems.push(`unknown bus "${bus}" (buses: ${AUDIO_BUSES.join(', ')}, master)`)
      continue
    }
    if (!change || typeof change !== 'object') {
      problems.push(`${bus}: the change is an object`)
      continue
    }
    if (bus === MASTER_BUS) {
      if ('limiterLufs' in change && !inRange(change.limiterLufs, LUFS_RANGE)) problems.push(`master.limiterLufs must be ${LUFS_RANGE.min}..${LUFS_RANGE.max} LUFS`)
      continue
    }
    if ('gainDb' in change && !inRange(change.gainDb, BUS_GAIN_RANGE_DB)) problems.push(`${bus}.gainDb must be ${BUS_GAIN_RANGE_DB.min}..${BUS_GAIN_RANGE_DB.max} dB`)
    const ducking = ['duckUnder', 'duckDb', 'attackMs', 'releaseMs'].filter((key) => key in change)
    if (bus === DIALOGUE_BUS && ducking.some((key) => !(key === 'duckUnder' && change.duckUnder === null))) {
      problems.push('the dialogue bus is never ducked')
      continue
    }
    if ('duckUnder' in change && change.duckUnder !== null && change.duckUnder !== DIALOGUE_BUS) problems.push(`${bus}.duckUnder is "dialogue" or null`)
    if ('duckDb' in change && !inRange(change.duckDb, DUCK_DB_RANGE)) problems.push(`${bus}.duckDb must be ${DUCK_DB_RANGE.min}..${DUCK_DB_RANGE.max} dB`)
    if ('attackMs' in change && !inRange(change.attackMs, { min: 1, max: 2000 })) problems.push(`${bus}.attackMs must be 1..2000`)
    if ('releaseMs' in change && !inRange(change.releaseMs, { min: 1, max: 5000 })) problems.push(`${bus}.releaseMs must be 1..5000`)
  }
  return problems
}

export function applyBusPatch(current, patch, { policy = null } = {}) {
  const problems = validateBusPatch(patch)
  if (problems.length) throw new Error(`Bus change refused: ${problems.join('; ')}`)
  const base = resolveAudioBuses(current ?? defaultAudioBuses(policy), { policy })
  const next = JSON.parse(JSON.stringify(base))
  for (const [bus, change] of Object.entries(patch)) {
    next[bus] = { ...next[bus], ...change }
    if (bus !== MASTER_BUS && next[bus].duckUnder === DIALOGUE_BUS) {
      next[bus] = { ...duckFor(policy), ...next[bus] }
    }
  }
  return resolveAudioBuses(next, { policy })
}

// The ducker both paths run: dialogue above the threshold pulls the bus to
// duckDb in attackMs; below it, the bus returns to 0 dB over releaseMs.
export function duckingParams(busConfig) {
  if (!busConfig || busConfig.duckUnder !== DIALOGUE_BUS) return null
  return {
    duckDb: round2(busConfig.duckDb),
    attackMs: busConfig.attackMs,
    releaseMs: busConfig.releaseMs,
    thresholdDb: DUCK_THRESHOLD_DB,
  }
}

// Which stem a track feeds: one dialogue stem per language, one per other bus.
export function stemKeyFor(track) {
  const bus = busForTrack(track)
  if (!bus) return null
  return bus === DIALOGUE_BUS ? `dialogue-${track.language || 'und'}` : bus
}

// Caption transcription hears speech: on a bussed project, the dialogue bus
// and shot audio (Veo shots can carry their own lines); music, sfx and
// ambience are muted for the ASR mix. Unbussed tracks are heard as before.
export const TRANSCRIBED_BUSES = Object.freeze([DIALOGUE_BUS, 'shotaudio'])
export function isTranscribedTrack(track) {
  const bus = busForTrack(track)
  return bus === null || TRANSCRIBED_BUSES.includes(bus)
}
export const transcriptionTracks = (tracks) => (tracks || []).map((track) => (isTranscribedTrack(track) ? track : { ...track, muted: true }))
