// FILM-2017: subject detection on a clip's keyframes, for the reframe. The
// bundled FFmpeg decodes each keyframe to a small grayscale frame; the
// detectors in src/studio/reframeDetect.js (pico faces, else a saliency
// subject) run on it here in the main process. Local only: the model is the
// file beside this one (models/facefinder), nothing goes over the network.
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { pathToFileURL } = require('url')

const MODEL_PATH = path.join(__dirname, 'models', 'facefinder')
const DETECT_WIDTH = 320

// ESM modules under src/studio (package.json "type": "module"); packaged in
// the app by package.json build.files.
const studioModule = (relative) => import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'studio', relative)).href)

function grayFrame(ffmpegPath, file, seconds, { width = DETECT_WIDTH, height } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-v', 'error', '-ss', String(Math.max(0, seconds)), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:${height}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1']
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      const buffer = Buffer.concat(chunks)
      if (code !== 0 || buffer.length < width * height) reject(new Error(stderr.trim() || `No frame at ${seconds}s in ${path.basename(file)}`))
      else resolve(new Uint8Array(buffer.buffer, buffer.byteOffset, width * height))
    })
  })
}

// Keyframe samples for one clip: [{t (clip-relative), boxes}], ready for
// reframe.computeCropPath. Images are one keyframe.
async function detectClipSamples({ clip, file, sourceWidth, sourceHeight, ffmpegPath, modelBytes = null }) {
  if (!file || !fs.existsSync(file)) return { samples: [], missing: true }
  const { faceClassifier, detectKeyframe } = await studioModule('reframeDetect.js')
  const { sampleTimes, sourceTimeAt } = await studioModule('reframe.js')
  const classify = faceClassifier(modelBytes || new Uint8Array(fs.readFileSync(MODEL_PATH)))
  const height = Math.max(2, Math.round((DETECT_WIDTH * sourceHeight) / sourceWidth / 2) * 2)
  const times = clip.type === 'image' ? [0] : sampleTimes(clip.duration)
  const samples = []
  let previous = null
  for (const t of times) {
    let gray
    try {
      gray = await grayFrame(ffmpegPath, file, clip.type === 'image' ? 0 : sourceTimeAt(clip, t), { height })
    } catch {
      continue
    }
    samples.push({ t, boxes: detectKeyframe(gray, DETECT_WIDTH, height, { classify, previous }) })
    previous = gray
  }
  return { samples, missing: false }
}

module.exports = { detectClipSamples, grayFrame, MODEL_PATH, DETECT_WIDTH, studioModule }
