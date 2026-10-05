// FILM-2013: the intent compilers' compile-time audio reads, in the main
// process with ffmpeg instead of the renderer's Web Audio. Chromium's
// decodeAudioData segfaults the renderer on some macOS/Electron combinations
// (any input, OfflineAudioContext included), which took the whole window and
// the MCP bridge down on the first studio_edit of a project with its media on
// disk. ffmpeg's silencedetect and ebur128 never touch the renderer, have no
// 60 s bridge limit, and are QA-grade. The result has the shape
// get_audio_analysis returns, so the compilers read it unchanged:
//   { success, clip: { clipId, timelineMapping, silencesTimeline }, analysis: { silences, loudness } }
const { spawn } = require('child_process')
const path = require('path')
const { pathToFileURL } = require('url')

const DEFAULT_SILENCE_DB = -45
const DEFAULT_MIN_SILENCE_SECONDS = 0.35
const round3 = (value) => Math.round(value * 1000) / 1000
const num = (value) => String(round3(Number(value) || 0))

function runFfmpeg(ffmpegPath, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stderr: String(error?.message || error) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }) })
  })
}

// silencedetect's start/end lines, relative to the window it analysed.
function parseSilences(stderr, windowLength) {
  const spans = []
  let open = null
  for (const line of String(stderr).split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (start) open = Math.max(0, Number(start[1]))
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line)
    if (end && open !== null) {
      spans.push({ start: round3(open), end: round3(Number(end[1])) })
      open = null
    }
  }
  if (open !== null && Number.isFinite(windowLength)) spans.push({ start: round3(open), end: round3(windowLength) })
  return spans
}

let loudnessModule = null
const loadLoudness = async () => {
  if (!loudnessModule) loudnessModule = await import(pathToFileURL(path.join(__dirname, 'audioBusMix.mjs')).href)
  return loudnessModule
}

function createAudioReads({ getFfmpegPath, run = runFfmpeg, measureLoudness = null, runAnalysis = null } = {}) {
  // item: { clipId, file, trimStart, trimEnd, startTime, timeScale, reverse, hasSpeedRamp,
  //         silenceThresholdDb?, minSilenceSeconds?, loudness? }
  async function analyzeClip(item) {
    const ffmpegPath = typeof getFfmpegPath === 'function' ? getFfmpegPath() : null
    if (!ffmpegPath) return { success: false, warning: 'ffmpeg is not available' }
    if (!item?.file) return { success: false, warning: `Clip ${item?.clipId} has no file on disk` }
    const start = Math.max(0, Number(item.trimStart) || 0)
    const end = Number(item.trimEnd)
    const length = Number.isFinite(end) && end > start ? end - start : null
    const threshold = Number(item.silenceThresholdDb ?? DEFAULT_SILENCE_DB)
    const minimum = Number(item.minSilenceSeconds ?? DEFAULT_MIN_SILENCE_SECONDS)
    const args = ['-hide_banner', '-nostats', '-ss', num(start), ...(length ? ['-t', num(length)] : []), '-i', item.file,
      '-af', `silencedetect=noise=${threshold}dB:d=${minimum}`, '-f', 'null', '-']
    const { code, stderr } = await run(ffmpegPath, args)
    if (code !== 0) return { success: false, warning: `silencedetect failed on ${path.basename(item.file)}: ${String(stderr).slice(-300)}` }
    const silences = parseSilences(stderr, length)
    const scale = Number(item.timeScale) > 0 ? Number(item.timeScale) : 1
    const mapped = !item.reverse && !item.hasSpeedRamp
    const result = {
      success: true,
      analysis: { silences, source: 'ffmpeg silencedetect', silenceThresholdDb: threshold, minSilenceSeconds: minimum },
      clip: {
        clipId: item.clipId,
        timelineMapping: mapped ? 'constant-speed' : 'unavailable',
        ...(mapped ? { silencesTimeline: silences.map((span) => ({ start: round3((Number(item.startTime) || 0) + span.start / scale), end: round3((Number(item.startTime) || 0) + span.end / scale) })) } : {}),
      },
    }
    if (item.loudness) {
      try {
        const measure = measureLoudness || (await loadLoudness()).measureLoudness
        const loud = await measure(ffmpegPath, item.file, { start, duration: length })
        result.analysis.loudness = { integratedLufs: loud.integratedLufs, integratedLufsApprox: loud.integratedLufs, truePeakDb: loud.truePeakDb, lra: loud.lra }
        result.loudness = { integratedLufsApprox: loud.integratedLufs }
      } catch (error) {
        result.analysis.loudnessWarning = String(error?.message || error)
      }
    }
    return result
  }

  // KB-190: get_audio_analysis (and the timeline's beat markers) for the
  // renderer, which must not decode. One analysis at a time, in `runAnalysis`
  // (an Electron utility process in the app, so a long file neither blocks
  // nor bloats the main process) or here when there is none (tests).
  let queue = Promise.resolve()
  function analyzeFile(file, options = {}) {
    const run = queue.then(() => {
      const ffmpegPath = typeof getFfmpegPath === 'function' ? getFfmpegPath() : null
      if (!ffmpegPath) return { success: false, error: 'ffmpeg is not available' }
      if (!file) return { success: false, error: 'No file to analyse.' }
      return (runAnalysis || analyzeFileInProcess)(ffmpegPath, file, options)
    })
    queue = run.catch(() => {})
    return run
  }

  return { analyzeClip, analyzeFile }
}

const ANALYSIS_SAMPLE_RATE = 22050
const MAX_ANALYSIS_SECONDS = 30 * 60

let dspModule = null
const loadDsp = async () => {
  if (!dspModule) dspModule = await import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'studio', 'audio', 'analysis.js')).href)
  return dspModule
}

// ffmpeg decodes only the analysed range, at ANALYSIS_SAMPLE_RATE, mono or
// stereo, and the renderer's own DSP (src/studio/audio/analysis.js) runs on
// that PCM: the result has the shape analyzeAudioSource always returned.
async function analyzeFileInProcess(ffmpegPath, file, options = {}) {
  const start = Math.max(0, Number(options.startSeconds) || 0)
  const end = Number(options.endSeconds)
  const length = Number.isFinite(end) && end > start ? end - start : null
  if (length !== null && length > MAX_ANALYSIS_SECONDS) {
    return { success: false, error: `The range is ${Math.round(length)} s; audio analysis covers at most ${MAX_ANALYSIS_SECONDS / 60} minutes. Analyse a clip of it instead.` }
  }
  const decoded = await decodePcm(ffmpegPath, file, { start, length })
  if (decoded.error) return { success: false, error: decoded.error }
  const { analyzeAudioBuffer } = await loadDsp()
  const analysis = analyzeAudioBuffer(decoded.buffer, {
    silenceThresholdDb: options.silenceThresholdDb,
    minSilenceSeconds: options.minSilenceSeconds,
    includeLoudnessCurve: options.includeLoudnessCurve,
    maxCurvePoints: options.maxCurvePoints,
  })
  return { success: true, analysis: { ...analysis, decodedBy: 'ffmpeg, outside the window' } }
}

// The app's runAnalysis: each analysis in its own Electron utility process
// (electron/studio/audioAnalysisProcess.js), ended once it answers.
function utilityProcessAnalysis(utilityProcess, { timeoutMs = 180000 } = {}) {
  return (ffmpegPath, file, options) => new Promise((resolve) => {
    const child = utilityProcess.fork(path.join(__dirname, 'audioAnalysisProcess.js'), [], { serviceName: 'Audio analysis', stdio: 'ignore' })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => { child.kill(); finish({ success: false, error: `Audio analysis of ${path.basename(file)} took longer than ${timeoutMs / 1000} s.` }) }, timeoutMs)
    child.once('message', (result) => { finish(result); child.kill() })
    child.once('exit', (code) => finish({ success: false, error: `The audio analysis process exited (${code}) without an answer.` }))
    child.postMessage({ ffmpegPath, file, options })
  })
}

// A WAV from ffmpeg's pipe: { channels, sampleRate, dataOffset } once the
// header up to the data chunk has arrived, else null. The piped header's
// sizes are placeholders, so the data runs to the end of the stream.
function parseWavHeader(bytes) {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let format = null
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    if (id === 'data') return format ? { ...format, dataOffset: offset + 8 } : null
    if (id === 'fmt ' && offset + 8 + 16 <= bytes.length) {
      format = { channels: bytes.readUInt16LE(offset + 10), sampleRate: bytes.readUInt32LE(offset + 12), bitsPerSample: bytes.readUInt16LE(offset + 22) }
    }
    offset += 8 + size + (size % 2)
  }
  return null
}

// The range as 32-bit float PCM, mono or stereo (more channels mix down), in
// an AudioBuffer-shaped object. A source longer than MAX_ANALYSIS_SECONDS is
// stopped as soon as it passes the limit, so memory stays bounded.
function decodePcm(ffmpegPath, file, { start, length, timeoutMs = 120000 }) {
  const args = ['-hide_banner', '-nostats', '-v', 'error', '-ss', num(start), ...(length ? ['-t', num(length)] : []), '-i', file,
    '-vn', '-map_metadata', '-1', '-af', 'aformat=sample_fmts=flt:channel_layouts=mono|stereo', '-ar', String(ANALYSIS_SAMPLE_RATE),
    '-c:a', 'pcm_f32le', '-f', 'wav', 'pipe:1']
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const chunks = []
    let received = 0
    let header = null
    let limitBytes = Infinity
    let stopped = null
    let stderr = ''
    const stop = (reason) => { if (!stopped) { stopped = reason; child.kill('SIGKILL') } }
    const timer = setTimeout(() => stop(`decoding ${path.basename(file)} took longer than ${timeoutMs / 1000} s`), timeoutMs)
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk)
      received += chunk.length
      if (!header) {
        header = parseWavHeader(Buffer.concat(chunks))
        if (header) limitBytes = header.dataOffset + MAX_ANALYSIS_SECONDS * header.sampleRate * header.channels * 4
      }
      if (received > limitBytes) stop(`${path.basename(file)} is longer than ${MAX_ANALYSIS_SECONDS / 60} minutes; audio analysis covers at most that. Analyse a clip of it instead.`)
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); resolve({ error: `ffmpeg could not start: ${error?.message || error}` }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (stopped) return resolve({ error: stopped })
      if (code !== 0) return resolve({ error: `Could not decode audio from ${path.basename(file)}: ${String(stderr).trim().slice(-300) || `ffmpeg exited ${code}`}` })
      const wav = header || parseWavHeader(Buffer.concat(chunks))
      if (!wav || wav.bitsPerSample !== 32 || wav.channels < 1) return resolve({ error: `${path.basename(file)} has no audio track to analyse.` })
      // One copy of the samples, 4-byte aligned, then one array per channel
      // (a mono source keeps that copy as its only channel).
      const frames = Math.floor((received - wav.dataOffset) / (4 * wav.channels))
      const samples = new Float32Array(frames * wav.channels)
      const target = new Uint8Array(samples.buffer)
      let skip = wav.dataOffset
      let at = 0
      for (const chunk of chunks.splice(0)) {
        const from = Math.min(skip, chunk.length)
        skip -= from
        const part = chunk.subarray(from, from + Math.max(0, target.length - at))
        target.set(part, at)
        at += part.length
      }
      const channels = wav.channels === 1 ? [samples] : Array.from({ length: wav.channels }, (_, c) => {
        const channel = new Float32Array(frames)
        for (let frame = 0; frame < frames; frame += 1) channel[frame] = samples[frame * wav.channels + c]
        return channel
      })
      resolve({ buffer: { sampleRate: wav.sampleRate, length: frames, numberOfChannels: wav.channels, getChannelData: (c) => channels[c] } })
    })
  })
}

module.exports = { createAudioReads, analyzeFileInProcess, utilityProcessAnalysis, parseSilences, parseWavHeader, DEFAULT_SILENCE_DB, DEFAULT_MIN_SILENCE_SECONDS, ANALYSIS_SAMPLE_RATE, MAX_ANALYSIS_SECONDS }
