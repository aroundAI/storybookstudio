// FILM-2011: ffprobe one downloaded file (contract IN4: duration, fps,
// dimensions, codecs, hasAudio). Same ffprobe and fields as main.js's
// probeVideoInfo, which is not exported; main.js passes the resolved
// binary path in (createStudioMain({ ffprobePath })).
const { spawn } = require('child_process')

const PROBE_TIMEOUT_MS = 30_000

function parseRatio(value) {
  if (typeof value !== 'string' || !value.includes('/')) return Number(value) || null
  const [num, den] = value.split('/').map(Number)
  if (!num || !den) return null
  return Math.round((num / den) * 1000) / 1000
}

function summarizeProbe(parsed) {
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : []
  const video = streams.find((stream) => stream?.codec_type === 'video') || null
  const audio = streams.find((stream) => stream?.codec_type === 'audio') || null
  const duration = Number(parsed?.format?.duration) || Number(video?.duration) || Number(audio?.duration) || null
  // A still image is a one-frame "video" stream with no meaningful rate.
  const still = Boolean(video) && ['png', 'mjpeg', 'webp', 'bmp', 'tiff', 'gif'].includes(video.codec_name) && !audio
  return {
    duration: still ? null : duration,
    fps: still ? null : parseRatio(video?.avg_frame_rate) || parseRatio(video?.r_frame_rate),
    width: Number(video?.width) || null,
    height: Number(video?.height) || null,
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  }
}

function createProbe(ffprobePath, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return function probe(filePath) {
    return new Promise((resolve, reject) => {
      if (!ffprobePath) {
        reject(new Error('FFprobe is not available.'))
        return
      }
      const args = ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,avg_frame_rate,r_frame_rate,width,height,duration:format=duration', '-of', 'json', filePath]
      const proc = spawn(ffprobePath, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        reject(new Error('FFprobe timed out.'))
      }, timeoutMs)
      proc.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      proc.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2000)
      })
      proc.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(stderr.trim() || `FFprobe exited with code ${code}`))
          return
        }
        try {
          resolve(summarizeProbe(JSON.parse(stdout)))
        } catch (error) {
          reject(error)
        }
      })
    })
  }
}

module.exports = { createProbe, summarizeProbe }
