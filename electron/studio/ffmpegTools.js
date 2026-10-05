// FILM-2014: spawning FFmpeg and ffprobe for the preview tiers and QA.
// Takes binary paths as arguments (main.js passes its packaged ffmpeg-static
// paths), so it imports nothing from Electron and runs under `node --test`.
const { spawn } = require('child_process')

// QA reads whole filter logs (silencedetect over a 10-minute cut is long);
// beyond this only the tail is kept, which still holds every summary block.
const MAX_STDERR_BYTES = 16 * 1024 * 1024

function defaultBinaries() {
  let ffmpegPath = null
  let ffprobePath = null
  try { ffmpegPath = require('ffmpeg-static') } catch { /* not installed */ }
  try { ffprobePath = require('@derhuerst/ffprobe-static') } catch { /* not installed */ }
  if (ffmpegPath) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked')
  if (ffprobePath) ffprobePath = ffprobePath.replace('app.asar', 'app.asar.unpacked')
  return { ffmpegPath, ffprobePath }
}

function resolveBinaries({ ffmpegPath, ffprobePath } = {}) {
  const defaults = defaultBinaries()
  return { ffmpegPath: ffmpegPath || process.env.STORYBOOKSTUDIO_FFMPEG_PATH || defaults.ffmpegPath, ffprobePath: ffprobePath || defaults.ffprobePath }
}

// Runs a binary to completion. Resolves {code, stdout, stderr, ms}; never
// rejects on a non-zero exit (QA reads the log either way), only on spawn
// failure or abort.
function run(binary, args, { signal, timeoutMs = 10 * 60 * 1000, stdoutAsBuffer = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!binary) {
      reject(Object.assign(new Error('FFmpeg is not available.'), { code: 'FFMPEG_UNAVAILABLE' }))
      return
    }
    const started = Date.now()
    let child
    try {
      child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    const stdout = []
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }
    const onAbort = () => {
      try { child.kill('SIGKILL') } catch { /* gone */ }
      finish(reject, Object.assign(new Error('Render cancelled.'), { code: 'ABORTED' }))
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* gone */ }
      finish(reject, Object.assign(new Error(`${args.includes('-show_streams') ? 'ffprobe' : 'FFmpeg'} timed out after ${timeoutMs} ms.`), { code: 'TIMEOUT' }))
    }, timeoutMs)
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > MAX_STDERR_BYTES) stderr = stderr.slice(-MAX_STDERR_BYTES)
    })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) => {
      const out = Buffer.concat(stdout)
      finish(resolve, { code, stdout: stdoutAsBuffer ? out : out.toString(), stderr, ms: Date.now() - started })
    })
  })
}

async function runFfmpeg(ffmpegPath, args, options = {}) {
  const result = await run(ffmpegPath, ['-hide_banner', '-nostdin', ...args], options)
  return result
}

async function runFfmpegOrThrow(ffmpegPath, args, options = {}) {
  const result = await runFfmpeg(ffmpegPath, args, options)
  if (result.code !== 0) {
    const tail = result.stderr.trim().split(/\r?\n/).slice(-6).join('\n')
    throw Object.assign(new Error(`FFmpeg failed (exit ${result.code}): ${tail}`), { code: 'FFMPEG_FAILED', stderr: result.stderr })
  }
  return result
}

const ratio = (value) => {
  const [a, b] = String(value || '').split('/').map(Number)
  return Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : Number.isFinite(a) ? a : null
}

// ffprobe as one object: {duration, video, audio, formatName}; null streams when absent.
async function probe(ffprobePath, file, options = {}) {
  const result = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], options)
  if (result.code !== 0) {
    throw Object.assign(new Error(`ffprobe could not read ${file}: ${result.stderr.trim().split('\n').pop()}`), { code: 'PROBE_FAILED' })
  }
  const json = JSON.parse(result.stdout || '{}')
  const video = (json.streams || []).find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
  const audio = (json.streams || []).find((stream) => stream.codec_type === 'audio')
  return {
    duration: Number(json.format?.duration) || Number(video?.duration) || Number(audio?.duration) || 0,
    formatName: json.format?.format_name ?? null,
    bitRate: Number(json.format?.bit_rate) || null,
    video: video ? {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      fps: ratio(video.avg_frame_rate) || ratio(video.r_frame_rate),
      pixFmt: video.pix_fmt ?? null,
      duration: Number(video.duration) || null,
    } : null,
    audio: audio ? {
      codec: audio.codec_name,
      sampleRate: Number(audio.sample_rate) || null,
      channels: audio.channels ?? null,
      duration: Number(audio.duration) || null,
    } : null,
  }
}

// Runs `tasks` (functions returning promises) with at most `limit` in flight.
async function pool(tasks, limit) {
  const results = new Array(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const index = next
      next += 1
      results[index] = await tasks[index]()
    }
  })
  await Promise.all(workers)
  return results
}

module.exports = { MAX_STDERR_BYTES, defaultBinaries, resolveBinaries, run, runFfmpeg, runFfmpegOrThrow, probe, pool }
