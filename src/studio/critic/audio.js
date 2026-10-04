// FILM-2014 V2: the audio analyser. Reads short-window RMS levels of the bus
// stems and the mix (measured by electron/studio/qa.js measureLevels over the
// audio tier's stems) plus the document's clip edges:
//   - dialogue-to-music ratio over every stretch of dialogue
//   - fades at cuts: bed clips (music, ambience, sfx) that start or stop hard
//   - abrupt level changes in the mix that no dialogue onset explains
// Issues use the QA shape and name duck_music or add_fade.
import { issue, mergeRanges } from '../review/qaChecks.js'
import { audioClips, round3, sceneOfRange } from '../review/renderPlan.js'

// Dialogue should sit this far above the music bed (broadcast practice is
// about 10 dB; under 8 dB words start to drown).
export const MIN_DIALOGUE_OVER_MUSIC_DB = 8
export const ABRUPT_CHANGE_DB = 12
// A bus quieter than this at an edge is inaudible; no fade needed.
export const AUDIBLE_DB = -40
export const SILENT_DB = -70
export const DIALOGUE_EDGE_SECONDS = 0.3
// Dialogue lines closer than this are one stretch for the ratio check.
export const DIALOGUE_STRETCH_GAP_SECONDS = 2
export const BED_BUSES = new Set(['music', 'ambience', 'sfx'])

const fmt = (seconds) => `${Number(seconds).toFixed(1)} s`
const toPower = (db) => (Number.isFinite(db) ? 10 ** (db / 10) : 0)
const toDb = (power) => (power > 0 ? 10 * Math.log10(power) : -Infinity)

// levels: { windowSeconds, from, buses: {bus: number[] dB}, mix: number[] dB }
function windowIndex(levels, time) {
  return Math.floor((time - (levels.from || 0)) / levels.windowSeconds)
}

// Mean level (power average) of `series` over [start, end), counting only
// windows where `gate` (another series) is above `gateDb`, when given.
export function meanDb(levels, series, start, end, { gate = null, gateDb = -50 } = {}) {
  if (!series) return -Infinity
  const a = Math.max(0, windowIndex(levels, start))
  const b = Math.min(series.length, windowIndex(levels, end))
  let sum = 0
  let n = 0
  for (let i = a; i < b; i += 1) {
    if (gate && !(gate[i] > gateDb)) continue
    sum += toPower(series[i])
    n += 1
  }
  return n ? toDb(sum / n) : -Infinity
}

export const windowsOf = (levels, start, end) => {
  const a = Math.max(0, windowIndex(levels, start))
  const b = windowIndex(levels, end)
  return Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k)
}
const median = (values) => {
  const sorted = [...values].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function levelAt(levels, series, time, span = 0.2) {
  return meanDb(levels, series, time, time + span)
}

export function analyseAudio({ project, timelineId = null, levels, policy = {} } = {}) {
  if (!levels) return []
  const issues = []
  const clips = audioClips(project, { timelineId })
  const dialogue = levels.buses?.dialogue
  const music = levels.buses?.music

  // 1. Dialogue-to-music ratio per dialogue stretch.
  if (dialogue && music && policy.music?.enabled !== false) {
    const spans = mergeRanges(clips.filter((c) => c.bus === 'dialogue').map((c) => ({ start: c.start, end: c.start + c.duration })), DIALOGUE_STRETCH_GAP_SECONDS)
    const bad = []
    for (const span of spans) {
      // Medians over the windows where dialogue sounds: the ducker's attack
      // leaves the first ~120 ms of each line loud by design, and a power
      // mean would let those few windows decide the whole stretch.
      const windows = windowsOf(levels, span.start, span.end).filter((i) => dialogue[i] > -50 && Number.isFinite(music[i]))
      if (windows.length === 0) continue
      const bed = median(windows.map((i) => music[i]))
      if (bed < SILENT_DB) continue
      const voice = median(windows.map((i) => dialogue[i]))
      const ratio = median(windows.map((i) => dialogue[i] - music[i]))
      if (ratio < MIN_DIALOGUE_OVER_MUSIC_DB) bad.push({ ...span, ratio, voice, bed })
    }
    for (const run of bad) {
      issues.push(issue({
        type: 'music_over_dialogue',
        severity: 0.5 + Math.min(0.4, (MIN_DIALOGUE_OVER_MUSIC_DB - run.ratio) / 20),
        timeRange: { start: round3(run.start), end: round3(run.end) },
        scene: sceneOfRange(project, run.start, run.end, { timelineId }),
        detail: `Dialogue sits ${run.ratio.toFixed(1)} dB above the music from ${fmt(run.start)} to ${fmt(run.end)} (median while dialogue sounds: dialogue ${run.voice.toFixed(1)} dB, music ${run.bed.toFixed(1)} dB RMS); it needs ${MIN_DIALOGUE_OVER_MUSIC_DB} dB to stay clear.`,
        repairIntent: 'duck_music',
      }))
    }
  }

  // 2. Fades at bed clip edges.
  const programEnd = Math.max(0, ...clips.map((c) => c.start + c.duration))
  for (const clip of clips.filter((c) => BED_BUSES.has(c.bus))) {
    const series = levels.buses?.[clip.bus]
    const edges = [
      { at: clip.start, kind: 'start', fade: clip.fadeIn, level: levelAt(levels, series, clip.start + 0.05) },
      { at: clip.start + clip.duration, kind: 'end', fade: clip.fadeOut, level: levelAt(levels, series, clip.start + clip.duration - 0.25) },
    ]
    for (const edge of edges) {
      if (edge.fade > 0.01 || edge.level < AUDIBLE_DB) continue
      if (edge.kind === 'start' && edge.at < 0.05) continue
      if (edge.kind === 'end' && edge.at > programEnd + 0.05) continue
      issues.push(issue({
        type: 'hard_audio_edge',
        severity: 0.4,
        timeRange: { start: round3(Math.max(0, edge.at - 0.1)), end: round3(edge.at + 0.1) },
        scene: sceneOfRange(project, edge.at - 0.1, edge.at + 0.1, { timelineId }),
        detail: `${clip.name} (${clip.bus}) ${edge.kind === 'start' ? 'starts' : 'stops'} at ${fmt(edge.at)} at ${edge.level.toFixed(0)} dB with no fade.`,
        repairIntent: 'add_fade',
      }))
    }
  }

  // 3. Abrupt changes in the mix not caused by dialogue starting or stopping.
  const mix = levels.mix
  if (mix) {
    // A line starting or stopping moves the mix by design; only changes away
    // from every dialogue edge count.
    const dialogueEdges = clips.filter((c) => c.bus === 'dialogue').flatMap((c) => [c.start, c.start + c.duration])
    const nearDialogueEdge = (time) => dialogueEdges.some((edge) => Math.abs(edge - time) <= DIALOGUE_EDGE_SECONDS)
    const hits = []
    for (let i = 2; i < mix.length; i += 1) {
      const before = toDb((toPower(mix[i - 2]) + toPower(mix[i - 1])) / 2)
      const after = mix[i]
      if (!Number.isFinite(after) && !Number.isFinite(before)) continue
      const change = (Number.isFinite(after) ? after : SILENT_DB) - (Number.isFinite(before) ? before : SILENT_DB)
      if (Math.abs(change) < ABRUPT_CHANGE_DB) continue
      const time = (levels.from || 0) + i * levels.windowSeconds
      if (nearDialogueEdge(time)) continue
      hits.push({ start: time - levels.windowSeconds, end: time + levels.windowSeconds, change })
    }
    for (const hit of mergeRanges(hits, 0.3)) {
      const change = hits.find((h) => h.start >= hit.start - 1e-6)?.change ?? 0
      issues.push(issue({
        type: 'abrupt_level_change',
        severity: 0.4 + Math.min(0.3, (Math.abs(change) - ABRUPT_CHANGE_DB) / 30),
        timeRange: hit,
        scene: sceneOfRange(project, hit.start, hit.end, { timelineId }),
        detail: `The mix jumps ${change > 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(0)} dB within ${fmt(hit.end - hit.start)} at ${fmt(hit.start)}, and no dialogue starts or stops there.`,
        repairIntent: 'add_fade',
      }))
    }
  }
  return issues
}
