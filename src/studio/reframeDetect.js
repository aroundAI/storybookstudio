// FILM-2017: what is in a keyframe, for the reframe. Two local detectors over
// a small grayscale frame (the main process decodes it with the bundled
// FFmpeg; nothing leaves the machine):
// - faces: pico's frontal face cascade (src/studio/vendor/pico.js, the
//   234 KB model in electron/studio/models/facefinder);
// - the primary subject, when no face is found: a saliency map (each pixel's
//   contrast with its surroundings, plus motion against the previous
//   keyframe), its weighted centre and spread. The score says how
//   concentrated the saliency is: a single subject on a plain background
//   scores high, an even texture scores low and is ignored (reframe.js
//   MIN_SUBJECT_SCORE), so that clip is centred and flagged instead.
// Boxes come back as fractions of the frame: {kind, cx, cy, w, h, score}.
import { clusterDetections, runCascade, unpackCascade } from './vendor/pico.js'

export const DETECT_WIDTH = 320
// pico's own demos keep clusters above 5; below that, false faces creep in.
export const FACE_MIN_SCORE = 5
const UNIFORM_SPREAD = 1 / Math.sqrt(12)

let cachedCascade = null
export function faceClassifier(bytes) {
  if (!cachedCascade || cachedCascade.bytes !== bytes) cachedCascade = { bytes, classify: unpackCascade(bytes) }
  return cachedCascade.classify
}

export function detectFaces(gray, width, height, classify) {
  const image = { pixels: gray, nrows: height, ncols: width, ldim: width }
  const minsize = Math.max(16, Math.round(Math.min(width, height) * 0.08))
  const detections = runCascade(image, classify, { shiftfactor: 0.1, minsize, maxsize: Math.min(width, height), scalefactor: 1.1 })
  return clusterDetections(detections, 0.2)
    .filter(([, , , q]) => q >= FACE_MIN_SCORE)
    .map(([r, c, s, q]) => ({ kind: 'face', cx: c / width, cy: r / height, w: s / width, h: s / height, score: q }))
}

// Box blur (radius r) on a grayscale frame, via an integral image.
function boxBlur(gray, width, height, r) {
  const integral = new Float64Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y += 1) {
    let row = 0
    for (let x = 0; x < width; x += 1) {
      row += gray[y * width + x]
      integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + row
    }
  }
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(height, y + r + 1)
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(width, x + r + 1)
      const sum = integral[y1 * (width + 1) + x1] - integral[y0 * (width + 1) + x1] - integral[y1 * (width + 1) + x0] + integral[y0 * (width + 1) + x0]
      out[y * width + x] = sum / ((x1 - x0) * (y1 - y0))
    }
  }
  return out
}

export function detectPrimarySubject(gray, width, height, previous = null) {
  const fine = boxBlur(gray, width, height, 1)
  const coarse = boxBlur(gray, width, height, Math.max(4, Math.round(width / 16)))
  let total = 0
  let sx = 0
  let sy = 0
  const weights = new Float32Array(width * height)
  for (let i = 0; i < weights.length; i += 1) {
    const contrast = Math.abs(fine[i] - coarse[i])
    const motion = previous && previous.length === gray.length ? Math.abs(gray[i] - previous[i]) : 0
    // Squared, so the strongest regions dominate the centre of mass.
    const w = (contrast + 0.5 * motion) ** 2
    weights[i] = w
    total += w
    sx += w * ((i % width) + 0.5)
    sy += w * (Math.floor(i / width) + 0.5)
  }
  if (total <= 1e-6) return null
  const cx = sx / total / width
  const cy = sy / total / height
  let vx = 0
  let vy = 0
  for (let i = 0; i < weights.length; i += 1) {
    const dx = ((i % width) + 0.5) / width - cx
    const dy = (Math.floor(i / width) + 0.5) / height - cy
    vx += weights[i] * dx * dx
    vy += weights[i] * dy * dy
  }
  const spreadX = Math.sqrt(vx / total)
  const spreadY = Math.sqrt(vy / total)
  const score = Math.max(0, Math.min(1, 1 - (spreadX + spreadY) / (2 * UNIFORM_SPREAD)))
  return { kind: 'subject', cx, cy, w: Math.min(1, 4 * spreadX), h: Math.min(1, 4 * spreadY), score: Math.round(score * 1000) / 1000 }
}

// One keyframe: faces when there are any, else the primary subject.
export function detectKeyframe(gray, width, height, { classify = null, previous = null } = {}) {
  const faces = classify ? detectFaces(gray, width, height, classify) : []
  if (faces.length) return faces
  const subject = detectPrimarySubject(gray, width, height, previous)
  return subject ? [subject] : []
}
