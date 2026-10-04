// FILM-2017: the subject-tracking reframe. For each picture clip, where the
// subject is on its keyframes (faces first, else the primary subject; see
// reframeDetect.js), a crop window of the target aspect that follows it, and
// the set_clip_keyframes arguments that draw that window: a fill scale and
// position keyframes. Pure module: no Electron, no stores.
//
// Coordinates: a subject's cx/cy and the crop path are fractions of the
// source frame (0..1, from the top-left). The upstream editor draws a clip "fit" inside
// the canvas (exporter getBaseDrawRect), then applies transform.scaleX/Y
// (percent) and positionX/Y (canvas pixels) about the clip's centre; the
// keyframes below are in those units.
//
// Smoothing (spec): inside one clip the window never moves more than 15% of
// the output width between two keyframes. A larger jump happens only at a
// cut, which is a clip boundary: each clip's path is computed on its own.

export const MAX_STEP_FRACTION = 0.15
export const SAMPLE_EVERY_SECONDS = 1
export const MIN_SUBJECT_SCORE = 0.35
export const NO_SUBJECT_ISSUE = 'reframe_no_subject'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round = (value, places = 4) => Math.round(value * 10 ** places) / 10 ** places
const ratioOf = (aspect) => {
  const [w, h] = String(aspect).split(':').map(Number)
  if (!(w > 0 && h > 0)) throw Object.assign(new Error(`Not an aspect: ${aspect}`), { code: 'VALIDATION_FAILED' })
  return w / h
}

// The part of the source a target-aspect window covers, as fractions.
export function cropWindow({ sourceWidth, sourceHeight, targetAspect }) {
  const source = sourceWidth / sourceHeight
  const target = ratioOf(targetAspect)
  return target < source ? { w: target / source, h: 1 } : { w: 1, h: source / target }
}

// Fit-to-fill: the scale (percent) that makes a fit-drawn clip cover the canvas.
export function fillScale({ sourceWidth, sourceHeight, canvasWidth, canvasHeight }) {
  const fit = Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight)
  const fill = Math.max(canvasWidth / sourceWidth, canvasHeight / sourceHeight)
  return (fill / fit) * 100
}

// The subject a keyframe follows: the strongest face (score times area, so a
// close face beats a far one), else the primary subject when it is clear
// enough, else none.
export function pickSubject(sample) {
  const boxes = Array.isArray(sample?.boxes) ? sample.boxes : []
  const faces = boxes.filter((box) => box.kind === 'face')
  if (faces.length) return faces.reduce((best, box) => (box.score * box.w * box.h > best.score * best.w * best.h ? box : best))
  const subjects = boxes.filter((box) => box.kind !== 'face' && box.score >= MIN_SUBJECT_SCORE)
  if (subjects.length) return subjects.reduce((best, box) => (box.score > best.score ? box : best))
  return null
}

// Fill keyframes with no subject from their neighbours (linear between two,
// held at the ends). Returns null when no keyframe of the clip has one.
function fillGaps(values) {
  const known = values.map((value, index) => (value == null ? null : index)).filter((index) => index != null)
  if (known.length === 0) return null
  return values.map((value, index) => {
    if (value != null) return value
    const before = known.filter((k) => k < index).at(-1)
    const after = known.find((k) => k > index)
    if (before == null) return values[after]
    if (after == null) return values[before]
    const f = (index - before) / (after - before)
    return values[before] + (values[after] - values[before]) * f
  })
}

const movingAverage = (values, radius = 1) => values.map((_, index) => {
  const window = values.slice(Math.max(0, index - radius), index + radius + 1)
  return window.reduce((sum, value) => sum + value, 0) / window.length
})

// Each step at most maxStep, as close to the targets as that allows: the
// path that minimises the largest distance from any target (binary search
// on that distance, intervals propagated forward, then the path picked
// backward, nearest the target at each keyframe). A big move is spread
// evenly around the moment it happens rather than lagging behind it.
function feasibleIntervals(values, maxStep, distance, lo, hi) {
  const intervals = []
  for (let i = 0; i < values.length; i += 1) {
    let a = Math.max(lo, values[i] - distance)
    let b = Math.min(hi, values[i] + distance)
    if (i > 0) {
      a = Math.max(a, intervals[i - 1][0] - maxStep)
      b = Math.min(b, intervals[i - 1][1] + maxStep)
    }
    if (a > b + 1e-12) return null
    intervals.push([a, b])
  }
  return intervals
}

function rateLimit(values, maxStep, lo = 0, hi = 1) {
  if (values.length < 2) return [...values]
  let low = 0
  let high = 1
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2
    if (feasibleIntervals(values, maxStep, mid, lo, hi)) high = mid
    else low = mid
  }
  const intervals = feasibleIntervals(values, maxStep, high, lo, hi)
  const path = new Array(values.length)
  const last = values.length - 1
  path[last] = clamp(values[last], intervals[last][0], intervals[last][1])
  for (let i = last - 1; i >= 0; i -= 1) {
    const a = Math.max(intervals[i][0], path[i + 1] - maxStep)
    const b = Math.min(intervals[i][1], path[i + 1] + maxStep)
    path[i] = clamp(values[i], a, b)
  }
  return path
}

export function smoothAxis(values, { window, maxStep }) {
  const lo = window / 2
  const hi = 1 - window / 2
  if (hi <= lo) return values.map(() => 0.5)
  const clamped = values.map((value) => clamp(value, lo, hi))
  return rateLimit(movingAverage(clamped), maxStep, lo, hi)
}

// samples: [{t, boxes:[{kind:'face'|'subject', cx, cy, w, h, score}]}], t
// clip-relative seconds, sorted. Returns the smoothed path and whether any
// subject was found.
export function computeCropPath(samples, { sourceWidth, sourceHeight, targetAspect, maxStepFraction = MAX_STEP_FRACTION }) {
  const window = cropWindow({ sourceWidth, sourceHeight, targetAspect })
  const sorted = [...(samples || [])].sort((a, b) => a.t - b.t)
  if (sorted.length === 0) return { window, detected: false, points: [{ t: 0, cx: 0.5, cy: 0.5 }] }
  const picks = sorted.map(pickSubject)
  const xs = fillGaps(picks.map((box) => (box ? box.cx : null)))
  if (!xs) return { window, detected: false, points: sorted.map((sample) => ({ t: sample.t, cx: 0.5, cy: 0.5 })) }
  // Faces sit in the upper third of a good vertical frame: aim the window's
  // centre a little below the face, never off the frame.
  const ys = fillGaps(picks.map((box) => (box ? box.cy + (box.kind === 'face' ? box.h * 0.6 : 0) : null)))
  // Less 1e-4 so rounding the points to 4 places cannot push a step over.
  const cx = smoothAxis(xs, { window: window.w, maxStep: maxStepFraction * window.w - 1e-4 })
  const cy = smoothAxis(ys, { window: window.h, maxStep: maxStepFraction * window.h - 1e-4 })
  return {
    window,
    detected: true,
    points: sorted.map((sample, i) => ({ t: round(sample.t, 3), cx: round(cx[i]), cy: round(cy[i]) })),
  }
}

// Largest move between two consecutive keyframes, as a fraction of the
// output width (the spec's 15% rule is checked against this).
export function largestStep(path) {
  let largest = 0
  for (let i = 1; i < path.points.length; i += 1) {
    largest = Math.max(largest, Math.abs(path.points[i].cx - path.points[i - 1].cx) / path.window.w)
  }
  return largest
}

// The set_clip_keyframes arguments that draw `path` on a canvas.
export function keyframesForCropPath(path, { clipId, clipDuration, sourceWidth, sourceHeight, canvasWidth, canvasHeight, previewOnly = true }) {
  const scale = fillScale({ sourceWidth, sourceHeight, canvasWidth, canvasHeight })
  const fit = Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight)
  const drawnWidth = sourceWidth * fit * (scale / 100)
  const drawnHeight = sourceHeight * fit * (scale / 100)
  const hold = path.points.length === 1
  const at = (t) => round(clamp(t, 0, Math.max(0, Number(clipDuration) || 0)), 3)
  const keyframes = [
    { property: 'scaleX', timeSeconds: 0, value: round(scale, 3), easing: 'hold' },
    { property: 'scaleY', timeSeconds: 0, value: round(scale, 3), easing: 'hold' },
  ]
  for (const point of path.points) {
    const easing = hold ? 'hold' : 'easeInOut'
    keyframes.push({ property: 'positionX', timeSeconds: at(point.t), value: round((0.5 - point.cx) * drawnWidth, 2), easing })
    keyframes.push({ property: 'positionY', timeSeconds: at(point.t), value: round((0.5 - point.cy) * drawnHeight, 2), easing })
  }
  return { clipId, keyframes, replaceKeyframes: true, previewOnly }
}

// One clip, start to finish: path, keyframe arguments and, when nothing was
// detected, the QA warning (the clip is centred).
export function reframeClip({ clip, samples, sourceWidth, sourceHeight, canvasWidth, canvasHeight, targetAspect, scene = null, previewOnly = true }) {
  const path = computeCropPath(samples, { sourceWidth, sourceHeight, targetAspect })
  const args = keyframesForCropPath(path, { clipId: clip.id, clipDuration: clip.duration, sourceWidth, sourceHeight, canvasWidth, canvasHeight, previewOnly })
  const start = Number(clip.startTime) || 0
  const warning = path.detected
    ? null
    : {
        type: NO_SUBJECT_ISSUE,
        severity: 0.3,
        timeRange: { start: round(start, 3), end: round(start + (Number(clip.duration) || 0), 3) },
        scene,
        detail: `No face or clear subject in "${clip.name || clip.id}"; the ${targetAspect} crop is centred. Check the framing or set a focal point.`,
      }
  return { clipId: clip.id, path, arguments: args, largestStep: largestStep(path), warning }
}

// set_focal_point: a fixed window centred on (x, y), clamped to the frame.
export function focalPointKeyframes({ clip, x, y, sourceWidth, sourceHeight, canvasWidth, canvasHeight, targetAspect, previewOnly = true }) {
  if (![x, y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw Object.assign(new Error('x and y are fractions of the frame, 0 to 1.'), { code: 'VALIDATION_FAILED' })
  }
  const window = cropWindow({ sourceWidth, sourceHeight, targetAspect })
  const path = {
    window,
    detected: true,
    points: [{ t: 0, cx: clamp(x, window.w / 2, 1 - window.w / 2), cy: clamp(y, window.h / 2, 1 - window.h / 2) }],
  }
  return keyframesForCropPath(path, { clipId: clip.id, clipDuration: clip.duration, sourceWidth, sourceHeight, canvasWidth, canvasHeight, previewOnly })
}

// Keyframe times for a clip: every SAMPLE_EVERY_SECONDS from its start and
// its last frame, clip-relative.
export function sampleTimes(duration, every = SAMPLE_EVERY_SECONDS) {
  const total = Math.max(0, Number(duration) || 0)
  const times = []
  for (let t = 0; t < total - 0.05; t += every) times.push(round(t, 3))
  times.push(round(Math.max(0, total - 0.05), 3))
  return [...new Set(times)]
}

// The source-frame position (seconds into the media) shown at clip time t.
export const sourceTimeAt = (clip, t) => (Number(clip.trimStart) || 0) + t * (Number(clip.speed) || 1)
