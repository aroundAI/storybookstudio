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

function createAudioReads({ getFfmpegPath, run = runFfmpeg, measureLoudness = null } = {}) {
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
  return { analyzeClip }
}

module.exports = { createAudioReads, parseSilences, DEFAULT_SILENCE_DB, DEFAULT_MIN_SILENCE_SECONDS }
