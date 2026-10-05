// FILM-2016 AC3: the export mix on buses. export:mixAudio hands over its
// prepared inputs (each with the upstream editor's own per-clip filter chain) and the
// project's resolved audio buses; this module builds the FFmpeg graph:
//
//   clip chains → stem submixes (dialogue per language, music, sfx,
//   ambience, shotaudio, unbussed) → bus gain → dialogue key →
//   sidechaincompress onto each ducked bus → master sum → loudnorm to the
//   preset target (linear, two-pass) → the render's WAV, and optionally the
//   stems as WAVs beside the render with the same master gain, so they sum
//   to the mix.
//
// No Electron imports: main.js passes ffmpegPath, and tests run it with the
// bundled ffmpeg-static binary.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DIALOGUE = 'dialogue'
const BUS_ORDER = ['dialogue', 'music', 'sfx', 'ambience', 'shotaudio']
// The sidechain key: dialogue gated at the ducking threshold, then driven
// into a hard clip, so the key is a fixed level whenever dialogue sounds.
// A compressor fed a fixed key reduces by a fixed amount: duckDb, whatever
// the dialogue's own level (measured within 0.1 dB at -3..-20 dB).
const KEY_LEVEL = 0.5
const KEY_LEVEL_DB = 20 * Math.log10(KEY_LEVEL)
const SIDECHAIN_RATIO = 20
const DEFAULT_THRESHOLD_DB = -45
// QA's ceiling is -1 dBTP on the delivered file; the AAC encode adds up to
// ~2 dB of overshoot on transient material, so the mix stops at -2 dBTP,
// limited at 4x oversampling (a true-peak limiter) after loudnorm.
export const LOUDNORM_TRUE_PEAK_DB = -2
const TRUE_PEAK_OVERSAMPLE = 4

const num = (value, digits = 6) => {
  const fixed = Number(value).toFixed(digits)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}
const dbToGain = (db) => 10 ** (db / 20)

export function sidechainFilters({ duckDb, attackMs, releaseMs, thresholdDb = DEFAULT_THRESHOLD_DB }) {
  const depth = Math.abs(Number(duckDb) || 0)
  const threshold = Math.max(0.000977, dbToGain(KEY_LEVEL_DB - depth / (1 - 1 / SIDECHAIN_RATIO)))
  return {
    key: `agate=threshold=${num(dbToGain(thresholdDb))}:ratio=9000:range=0:attack=1:release=20,volume=80dB,asoftclip=type=hard:threshold=${KEY_LEVEL}`,
    compress: `sidechaincompress=threshold=${num(threshold)}:ratio=${SIDECHAIN_RATIO}:attack=${num(attackMs, 2)}:release=${num(releaseMs, 2)}:knee=1:detection=peak:level_sc=1:makeup=1:mix=1`,
  }
}

const safeLabel = (key) => String(key).replace(/[^A-Za-z0-9]/g, '_')

// inputs: [{ filters: string[], bus: 'dialogue'|…|null, language?: string|null, stemOnly?: boolean }]
// in input order (input i is FFmpeg input i).
// buses: resolved project.studio.audioBuses (buses.js resolveAudioBuses).
// Returns { filterComplex, mixLabel, stems: [{ key, bus, language, label }] }.
export function buildBusMixGraph({ inputs, buses, totalDuration, sampleRate = 48000, channels = 2, masterGain = 1, withStems = false }) {
  const layout = channels === 1 ? 'mono' : 'stereo'
  const pad = `apad=whole_dur=${num(totalDuration)},atrim=duration=${num(totalDuration)},asetpts=PTS-STARTPTS`
  const silence = (label) => `anullsrc=r=${sampleRate}:cl=${layout}:d=${num(totalDuration)}[${label}]`
  const parts = []

  // Group the clip chains into stems.
  const stems = new Map() // key -> { key, bus, language, stemOnly, labels[] }
  inputs.forEach((input, index) => {
    const bus = BUS_ORDER.includes(input.bus) ? input.bus : null
    const language = bus === DIALOGUE ? (input.language || 'und') : null
    const key = bus === DIALOGUE ? `dialogue-${language}` : (bus || 'unbussed')
    const label = `c${index}`
    parts.push(`[${index}:a]${[...input.filters, `aformat=sample_rates=${sampleRate}:channel_layouts=${layout}`].join(',')}[${label}]`)
    if (!stems.has(key)) stems.set(key, { key, bus, language, stemOnly: Boolean(input.stemOnly), labels: [] })
    const stem = stems.get(key)
    stem.labels.push(`[${label}]`)
    stem.stemOnly = stem.stemOnly && Boolean(input.stemOnly)
  })

  // Each stem: its clips summed over a silent bed (the bed keeps the length
  // exact, and sits first for the amix truncation reason main.js gives),
  // then its bus gain. Dialogue stems are never ducked.
  const busInputs = new Map() // bus|null -> labels feeding the bus
  const stemOutputs = []
  for (const stem of stems.values()) {
    const id = safeLabel(stem.key)
    parts.push(silence(`bed_${id}`))
    const all = [`[bed_${id}]`, ...stem.labels]
    const gainDb = stem.bus ? Number(buses?.[stem.bus]?.gainDb) || 0 : 0
    const gain = gainDb ? `,volume=${num(gainDb, 3)}dB` : ''
    parts.push(`${all.join('')}amix=inputs=${all.length}:duration=longest:dropout_transition=0:normalize=0,${pad}${gain}[s_${id}]`)
    if (stem.bus === DIALOGUE || stem.bus === null) {
      // Not ducked: the stem as heard is this signal.
      if (stem.stemOnly) {
        if (withStems) stemOutputs.push({ ...stem, label: `s_${id}` })
        else parts.push(`[s_${id}]anullsink`)
        continue
      }
      if (withStems) {
        parts.push(`[s_${id}]asplit=2[st_${id}][tb_${id}]`)
        stemOutputs.push({ ...stem, label: `st_${id}` })
      } else {
        parts.push(`[s_${id}]anull[tb_${id}]`)
      }
      const target = stem.bus ?? 'unbussed'
      if (!busInputs.has(target)) busInputs.set(target, [])
      busInputs.get(target).push(`[tb_${id}]`)
    } else {
      // music, sfx, ambience, shotaudio: one stem per bus; ducking (if any)
      // happens on the bus below, and the stem is taken after it.
      if (!busInputs.has(stem.bus)) busInputs.set(stem.bus, [])
      busInputs.get(stem.bus).push(`[s_${id}]`)
    }
  }

  // The dialogue bus: every audible dialogue stem; split for the master and
  // one sidechain key per ducked bus.
  const ducked = BUS_ORDER.filter((bus) => bus !== DIALOGUE && busInputs.has(bus) && buses?.[bus]?.duckUnder === DIALOGUE)
  const dialogueLabels = busInputs.get(DIALOGUE) || []
  const masterInputs = []
  if (dialogueLabels.length || ducked.length) {
    if (!dialogueLabels.length) {
      parts.push(silence('bed_dialogue_bus'))
      dialogueLabels.push('[bed_dialogue_bus]')
    }
    const sum = dialogueLabels.length === 1 ? `${dialogueLabels[0]}anull` : `${dialogueLabels.join('')}amix=inputs=${dialogueLabels.length}:duration=longest:dropout_transition=0:normalize=0`
    const outs = ['[bus_dialogue]', ...ducked.map((bus) => `[key_${bus}]`)]
    parts.push(`${sum},asplit=${outs.length}${outs.join('')}`)
    if (busInputs.has(DIALOGUE)) masterInputs.push('[bus_dialogue]')
    else parts.push('[bus_dialogue]anullsink')
  }

  for (const bus of BUS_ORDER.filter((name) => name !== DIALOGUE && busInputs.has(name))) {
    const labels = busInputs.get(bus)
    let current = labels.length === 1 ? labels[0] : null
    if (!current) {
      parts.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[sum_${bus}]`)
      current = `[sum_${bus}]`
    }
    if (ducked.includes(bus)) {
      const config = buses[bus]
      const { key, compress } = sidechainFilters({ duckDb: config.duckDb, attackMs: config.attackMs, releaseMs: config.releaseMs, thresholdDb: config.thresholdDb })
      parts.push(`[key_${bus}]${key}[kp_${bus}]`)
      parts.push(`${current}[kp_${bus}]${compress}[duck_${bus}]`)
      current = `[duck_${bus}]`
    }
    if (withStems) {
      parts.push(`${current}asplit=2[st_${bus}][bus_${bus}]`)
      const stem = stems.get(bus)
      stemOutputs.push({ ...stem, label: `st_${bus}` })
    } else {
      parts.push(`${current}anull[bus_${bus}]`)
    }
    masterInputs.push(`[bus_${bus}]`)
  }
  for (const label of busInputs.get('unbussed') || []) masterInputs.push(label)

  parts.push(silence('bed_master'))
  const all = ['[bed_master]', ...masterInputs]
  const master = Math.abs(masterGain - 1) < 1e-6 ? '' : `,volume=${num(masterGain)}`
  parts.push(`${all.join('')}amix=inputs=${all.length}:duration=longest:dropout_transition=0:normalize=0,${pad}${master}[premix]`)

  return {
    filterComplex: parts.join(';'),
    mixLabel: '[premix]',
    stems: stemOutputs.map(({ key, bus, language, label }) => ({ key, bus, language, label })),
  }
}

function runFfmpeg(ffmpegPath, args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stderr: error.message, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr, timedOut })
    })
  })
}

// FFmpeg's reason for failing, first: the lines that say what went wrong
// ("Cannot select channel layout …", "No such file …"), not the progress
// noise or a tail cut mid-line. Falls back to the last lines it printed.
const NOISE = /^(Press \[q\]|\s*Stream #|\s*Metadata:|\s*Duration:|Input #|Output #|\s*encoder\s*:|size=)/
const REASON = /(error|cannot|invalid|fail|no such|not found|unable|could not|unknown|denied|mismatch)/i
export function ffmpegFailureReason(stderr, { timedOut = false } = {}) {
  if (timedOut) return 'FFmpeg timed out.'
  const lines = String(stderr || '').split(/\r?\n/).map((line) => line.replace(/^\[[^\]]+ @ 0x[0-9a-f]+\]\s*/, '').trim()).filter((line) => line && !NOISE.test(line) && !/^[:.\s]*$/.test(line))
  const reasons = [...new Set(lines.filter((line) => REASON.test(line)))]
  // The specific line before FFmpeg's generic epilogue.
  const generic = /^(Error reinitializing filters!|Conversion failed!|Error while processing|Failed to inject frame)/
  const ordered = [...reasons.filter((line) => !generic.test(line)), ...reasons.filter((line) => generic.test(line))]
  const chosen = ordered.length ? ordered : lines.slice(-3)
  return (chosen.join('\n') || 'FFmpeg failed without saying why.').slice(0, 1500)
}

const lastJson = (text) => {
  const start = text.lastIndexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

// EBU R128 integrated loudness, true peak and LRA of a file, or of a window.
export async function measureLoudness(ffmpegPath, file, { start = null, duration = null, timeoutMs = 120000 } = {}) {
  const args = ['-hide_banner', '-nostats']
  if (start !== null) args.push('-ss', num(start))
  if (duration !== null) args.push('-t', num(duration))
  args.push('-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-')
  const { code, stderr } = await runFfmpeg(ffmpegPath, args, { timeoutMs })
  if (code !== 0) throw new Error(`ebur128 failed on ${path.basename(file)}: ${ffmpegFailureReason(stderr)}`)
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'))
  const pick = (pattern) => {
    const match = summary.match(pattern)
    return match ? Number(match[1]) : null
  }
  return {
    integratedLufs: pick(/I:\s+(-?[\d.]+|-inf)\s+LUFS/),
    lra: pick(/LRA:\s+(-?[\d.]+)\s+LU/),
    truePeakDb: pick(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/),
  }
}

const stemFileName = (baseName, stem) => `${baseName}.stem-${stem.key}.wav`

// The whole export: bus graph → premix (+ stems) → loudnorm measure → linear
// loudnorm on the master and the same gain on every stem.
export async function runStudioBusMix({
  ffmpegPath,
  inputs, // [{ inputPath, filters, bus, language, stemOnly }]
  buses,
  outputPath,
  totalDuration,
  sampleRate = 48000,
  channels = 2,
  masterGain = 1,
  loudnessTargetLufs = null,
  stems = null, // { directory, baseName } → WAVs beside the render
  timeoutMs = 180000,
}) {
  if (!inputs?.length) return { success: false, error: 'No eligible audio clips for mix.' }
  const layout = channels === 1 ? 'mono' : 'stereo'
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-busmix-'))
  try {
    const withStems = Boolean(stems?.directory)
    const graph = buildBusMixGraph({ inputs, buses, totalDuration, sampleRate, channels, masterGain, withStems })
    const premix = path.join(work, 'premix.wav')
    const args = ['-y', '-hide_banner']
    for (const input of inputs) args.push('-i', input.inputPath)
    args.push('-filter_complex', graph.filterComplex, '-map', graph.mixLabel, '-ar', String(sampleRate), '-ac', String(channels), '-c:a', 'pcm_f32le', premix)
    const rawStems = graph.stems.map((stem) => ({ ...stem, raw: path.join(work, `${safeLabel(stem.key)}.wav`) }))
    for (const stem of rawStems) args.push('-map', `[${stem.label}]`, '-ar', String(sampleRate), '-ac', String(channels), '-c:a', 'pcm_f32le', stem.raw)
    const mixed = await runFfmpeg(ffmpegPath, args, { timeoutMs })
    if (mixed.code !== 0) return { success: false, error: ffmpegFailureReason(mixed.stderr, { timedOut: mixed.timedOut }) }

    let gainDb = 0
    let loudness = null
    if (Number.isFinite(loudnessTargetLufs)) {
      const measure = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostats', '-i', premix, '-af', `loudnorm=I=${num(loudnessTargetLufs)}:TP=${LOUDNORM_TRUE_PEAK_DB}:LRA=50:print_format=json`, '-f', 'null', '-'], { timeoutMs })
      const first = lastJson(measure.stderr)
      if (measure.code !== 0 || !first) return { success: false, error: `Loudness measure failed: ${ffmpegFailureReason(measure.stderr, { timedOut: measure.timedOut })}` }
      const silent = first.input_i === '-inf' || !Number.isFinite(Number(first.input_i))
      if (silent) {
        loudness = { target: loudnessTargetLufs, input: null, output: null, normalizationType: 'none', reason: 'silent' }
        await fs.copyFile(premix, path.join(work, 'normalized.wav'))
      } else {
        // Linear mode keeps every peak under TP by construction (and the
        // stems summing to the mix); dynamic mode's limiter is not true-peak
        // accurate, so a 4x-oversampled limiter (latency-compensated) follows.
        const linearFits = Number(first.input_tp) + (loudnessTargetLufs - Number(first.input_i)) <= LOUDNORM_TRUE_PEAK_DB
        const limiter = linearFits ? '' : `,aformat=channel_layouts=${layout},aresample=${sampleRate * TRUE_PEAK_OVERSAMPLE},aformat=sample_rates=${sampleRate * TRUE_PEAK_OVERSAMPLE}:channel_layouts=${layout},alimiter=limit=${num(dbToGain(LOUDNORM_TRUE_PEAK_DB))}:attack=1:release=50:level=disabled:latency=1`
        const filter = `loudnorm=I=${num(loudnessTargetLufs)}:TP=${LOUDNORM_TRUE_PEAK_DB}:LRA=50:measured_I=${first.input_i}:measured_TP=${first.input_tp}:measured_LRA=${first.input_lra}:measured_thresh=${first.input_thresh}:offset=${first.target_offset}:linear=true:print_format=json${limiter},aresample=${sampleRate},aformat=sample_rates=${sampleRate}:channel_layouts=${layout}`
        // The layout is pinned on the chain and the output: when one gain
        // would push the true peak past TP, loudnorm turns dynamic, FFmpeg
        // re-initialises the graph mid-stream, and an unpinned output layout
        // fails to negotiate ("Cannot select channel layout").
        const second = await runFfmpeg(ffmpegPath, ['-y', '-hide_banner', '-nostats', '-i', premix, '-af', filter, '-ar', String(sampleRate), '-ac', String(channels), '-c:a', 'pcm_f32le', path.join(work, 'normalized.wav')], { timeoutMs })
        const result = lastJson(second.stderr)
        if (second.code !== 0 || !result) return { success: false, error: `Loudness normalize failed: ${ffmpegFailureReason(second.stderr, { timedOut: second.timedOut })}` }
        gainDb = Number(result.output_i) - Number(result.input_i)
        loudness = {
          target: loudnessTargetLufs,
          input: Number(result.input_i),
          output: Number(result.output_i),
          outputTruePeak: Number(result.output_tp),
          normalizationType: result.normalization_type,
        }
      }
    } else {
      await fs.copyFile(premix, path.join(work, 'normalized.wav'))
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const out = await runFfmpeg(ffmpegPath, ['-y', '-hide_banner', '-i', path.join(work, 'normalized.wav'), '-ar', String(sampleRate), '-ac', String(channels), '-c:a', 'pcm_s16le', outputPath], { timeoutMs })
    if (out.code !== 0) return { success: false, error: `Mix encode failed: ${ffmpegFailureReason(out.stderr, { timedOut: out.timedOut })}` }

    const written = []
    if (withStems) {
      await fs.mkdir(stems.directory, { recursive: true })
      for (const stem of rawStems) {
        const file = path.join(stems.directory, stemFileName(stems.baseName || 'render', stem))
        const gain = gainDb ? ['-af', `volume=${num(gainDb, 4)}dB`] : []
        const done = await runFfmpeg(ffmpegPath, ['-y', '-hide_banner', '-i', stem.raw, ...gain, '-c:a', 'pcm_s24le', file], { timeoutMs })
        if (done.code !== 0) return { success: false, error: `Stem ${stem.key} failed: ${ffmpegFailureReason(done.stderr, { timedOut: done.timedOut })}` }
        written.push({ key: stem.key, bus: stem.bus, language: stem.language, path: file })
      }
    }
    return {
      success: true,
      gainDb,
      loudness,
      // Stems sum to the mix only when loudnorm applied one static gain.
      stemsSumToMix: withStems ? (loudness ? loudness.normalizationType === 'linear' || loudness.normalizationType === 'none' : true) : null,
      stems: written,
      filterComplex: graph.filterComplex,
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}
