/**
 * Audio analysis entry point for the renderer (get_audio_analysis, the
 * timeline's beat markers). The DSP is src/studio/audio/analysis.js.
 *
 * KB-190: in the desktop app the renderer never decodes audio. Chromium's
 * decodeAudioData segfaults the renderer on some macOS/Electron combinations
 * (any input), and a whole long file decoded at its native rate is a large
 * allocation in the window either way. There ffmpeg decodes the analysed
 * range and the same DSP runs on it in a utility process
 * (window.electronAPI.analyzeAudioFile → electron/studio/audioReads.js
 * analyzeFile). Web Audio remains only for the browser build.
 */
import { analyzeAudioBuffer } from '../studio/audio/analysis.js'

export { analyzeAudioBuffer }

const ANALYSIS_CACHE = new Map() // key -> result
const ANALYSIS_CACHE_MAX = 12

let sharedAudioContext = null

function getSharedAudioContext() {
  if (typeof window === 'undefined') return null
  if (sharedAudioContext) return sharedAudioContext
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) return null
  sharedAudioContext = new Ctor()
  return sharedAudioContext
}

async function fetchSourceBytes({ url }) {
  if (!url) throw new Error('No readable source for audio analysis (missing URL and file path).')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load audio source (${response.status}).`)
  return response.arrayBuffer()
}

async function analyzeInMainProcess(api, { url, absolutePath }, options) {
  const source = absolutePath || url
  if (!source) throw new Error('No readable source for audio analysis (missing URL and file path).')
  const result = await api.analyzeAudioFile(source, {
    startSeconds: options.startSeconds,
    endSeconds: options.endSeconds,
    silenceThresholdDb: options.silenceThresholdDb,
    minSilenceSeconds: options.minSilenceSeconds,
    includeLoudnessCurve: options.includeLoudnessCurve,
    maxCurvePoints: options.maxCurvePoints,
  })
  if (!result?.success) throw new Error(result?.error || 'Audio analysis failed in the main process.')
  return result.analysis
}

async function decodeAndAnalyze({ url }, options) {
  const context = getSharedAudioContext()
  if (!context) throw new Error('Web Audio API is not available.')
  const bytes = await fetchSourceBytes({ url })
  let audioBuffer
  try {
    audioBuffer = await context.decodeAudioData(bytes.slice(0))
  } catch (err) {
    throw new Error('Could not decode audio from this source (unsupported codec or no audio track).')
  }
  return analyzeAudioBuffer(audioBuffer, options)
}

/**
 * Decode + analyze an audio (or video-with-audio) source. Results are cached
 * by source + range + options that change the output.
 */
export async function analyzeAudioSource({ url = '', absolutePath = '' }, options = {}) {
  const cacheKey = [
    absolutePath || url,
    options.startSeconds ?? '',
    options.endSeconds ?? '',
    options.silenceThresholdDb ?? '',
    options.minSilenceSeconds ?? '',
    options.includeLoudnessCurve !== false ? (options.maxCurvePoints || 400) : 'nocurve',
  ].join('|')
  if (ANALYSIS_CACHE.has(cacheKey)) return ANALYSIS_CACHE.get(cacheKey)

  const api = typeof window !== 'undefined' ? window.electronAPI : null
  let result
  if (api?.isElectron === true) {
    if (typeof api.analyzeAudioFile !== 'function') throw new Error('This build cannot analyse audio: the desktop bridge has no analyzeAudioFile.')
    result = await analyzeInMainProcess(api, { url, absolutePath }, options)
  } else {
    result = await decodeAndAnalyze({ url }, options)
  }

  ANALYSIS_CACHE.set(cacheKey, result)
  if (ANALYSIS_CACHE.size > ANALYSIS_CACHE_MAX) {
    const first = ANALYSIS_CACHE.keys().next().value
    if (first) ANALYSIS_CACHE.delete(first)
  }
  return result
}
