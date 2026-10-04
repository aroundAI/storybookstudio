// FILM-2017 AC3: the reframe. The crop path follows the subject, never
// jumps more than 15% of the output width inside a clip (a cut may), is
// written as set_clip_keyframes arguments, and a clip with no subject is
// centred and flagged. Detection: the saliency subject on a synthetic frame;
// pico on a real face is exercised by the delivery integration run.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_STEP_FRACTION,
  NO_SUBJECT_ISSUE,
  computeCropPath,
  cropWindow,
  fillScale,
  focalPointKeyframes,
  keyframesForCropPath,
  largestStep,
  reframeClip,
  sampleTimes,
} from '../../src/studio/reframe.js'
import { detectKeyframe, detectPrimarySubject } from '../../src/studio/reframeDetect.js'

const SRC = { sourceWidth: 1920, sourceHeight: 1080, targetAspect: '9:16' }
const face = (cx, score = 50) => ({ kind: 'face', cx, cy: 0.35, w: 0.12, h: 0.2, score })

// A subject that walks right, then teleports (a detector glitch, not a cut).
const walking = Array.from({ length: 24 }, (_, i) => ({ t: i, boxes: [face(i < 6 ? 0.3 + i * 0.02 : 0.85)] }))

test('the 9:16 window over 16:9 source is 31.6% of the width and the full height', () => {
  const window = cropWindow(SRC)
  assert.ok(Math.abs(window.w - 0.31640625) < 1e-9)
  assert.equal(window.h, 1)
  assert.ok(Math.abs(fillScale({ sourceWidth: 1920, sourceHeight: 1080, canvasWidth: 1080, canvasHeight: 1920 }) - 316.049) < 0.01)
})

test('inside one clip the window never moves more than 15% of the output width between keyframes', () => {
  const path = computeCropPath(walking, SRC)
  assert.equal(path.detected, true)
  assert.ok(largestStep(path) <= MAX_STEP_FRACTION + 1e-9, `largest step ${largestStep(path)}`)
  // It still gets there, at that pace: the last keyframes sit on the
  // subject's new place, clamped so the window stays inside the frame.
  const rightEdge = 1 - cropWindow(SRC).w / 2
  assert.ok(Math.abs(path.points.at(-1).cx - rightEdge) < 1e-3, `ends at ${path.points.at(-1).cx}`)
  // The move is spread around the jump, always in the subject's direction,
  // and the walking subject is in frame where the path starts.
  for (let i = 1; i < path.points.length; i += 1) assert.ok(path.points[i].cx >= path.points[i - 1].cx - 1e-9)
  assert.ok(Math.abs(path.points[0].cx - 0.3) < cropWindow(SRC).w / 2, `starts at ${path.points[0].cx}`)
  // Unsmoothed, the same path would have jumped about 1.7 widths.
  const raw = Math.abs(0.85 - 0.4) / cropWindow(SRC).w
  assert.ok(raw > 1, `raw jump ${raw}`)
})

test('a cut may jump: each clip gets its own path, so the second starts where its subject is', () => {
  const left = computeCropPath([{ t: 0, boxes: [face(0.2)] }, { t: 1, boxes: [face(0.2)] }], SRC)
  const right = computeCropPath([{ t: 0, boxes: [face(0.8)] }, { t: 1, boxes: [face(0.8)] }], SRC)
  const jumpAtCut = Math.abs(right.points[0].cx - left.points.at(-1).cx) / left.window.w
  assert.ok(jumpAtCut > 1, `the cut jumps ${jumpAtCut} widths`)
  assert.equal(largestStep(left), 0)
})

test('keyframes without a subject are filled from their neighbours, and the window stays inside the frame', () => {
  const samples = [{ t: 0, boxes: [face(0.02)] }, { t: 1, boxes: [] }, { t: 2, boxes: [face(0.02)] }]
  const path = computeCropPath(samples, SRC)
  const half = cropWindow(SRC).w / 2
  for (const point of path.points) assert.ok(Math.abs(point.cx - half) < 1e-4, `clamped to the left edge: ${point.cx}`)
})

test('a clip with no detectable subject is centred and flagged as a QA warning', () => {
  const clip = { id: 'clip-9', name: 'S3.2 empty corridor', startTime: 12, duration: 3 }
  const lowScore = [{ t: 0, boxes: [{ kind: 'subject', cx: 0.9, cy: 0.5, w: 1, h: 1, score: 0.1 }] }, { t: 1, boxes: [] }]
  const result = reframeClip({ clip, samples: lowScore, ...SRC, canvasWidth: 1080, canvasHeight: 1920, scene: 3 })
  assert.equal(result.path.detected, false)
  assert.ok(result.path.points.every((point) => point.cx === 0.5))
  assert.deepEqual(result.warning, {
    type: NO_SUBJECT_ISSUE,
    severity: 0.3,
    timeRange: { start: 12, end: 15 },
    scene: 3,
    detail: 'No face or clear subject in "S3.2 empty corridor"; the 9:16 crop is centred. Check the framing or set a focal point.',
  })
  // Centred: no horizontal offset at all.
  assert.ok(result.arguments.keyframes.filter((frame) => frame.property === 'positionX').every((frame) => frame.value === 0))
})

test('the keyframes are set_clip_keyframes arguments: a fill scale and positions that put the subject in the centre', () => {
  const path = computeCropPath([{ t: 0, boxes: [face(0.7)] }, { t: 2, boxes: [face(0.7)] }], SRC)
  const args = keyframesForCropPath(path, { clipId: 'clip-1', clipDuration: 2, sourceWidth: 1920, sourceHeight: 1080, canvasWidth: 1080, canvasHeight: 1920 })
  assert.equal(args.clipId, 'clip-1')
  assert.equal(args.replaceKeyframes, true)
  assert.equal(args.previewOnly, true)
  const scale = args.keyframes.find((frame) => frame.property === 'scaleX').value
  assert.ok(Math.abs(scale - 316.049) < 0.01)
  const x = args.keyframes.find((frame) => frame.property === 'positionX')
  // drawn width 3413.3 px; subject at 0.7 → shift left by 0.2 × 3413.3.
  assert.ok(Math.abs(x.value - -682.67) < 0.05, `positionX ${x.value}`)
  // Where the subject lands on the canvas: centre + (cx − 0.5) × drawn width + positionX.
  assert.ok(Math.abs(540 + (0.7 - 0.5) * 3413.33 + x.value - 540) < 0.1)
  for (const frame of args.keyframes) assert.ok(frame.timeSeconds >= 0 && frame.timeSeconds <= 2)
})

test('set_focal_point holds one window, clamped to the frame', () => {
  const step = focalPointKeyframes({ clip: { id: 'c', duration: 4 }, x: 1, y: 0.5, sourceWidth: 1920, sourceHeight: 1080, canvasWidth: 1080, canvasHeight: 1920, targetAspect: '9:16' })
  const x = step.keyframes.filter((frame) => frame.property === 'positionX')
  assert.equal(x.length, 1)
  assert.equal(x[0].easing, 'hold')
  assert.ok(Math.abs(x[0].value - -(0.5 - 0.31640625 / 2) * 3413.33) < 0.1)
  assert.throws(() => focalPointKeyframes({ clip: { id: 'c', duration: 4 }, x: 2, y: 0.5, sourceWidth: 1920, sourceHeight: 1080, canvasWidth: 1080, canvasHeight: 1920, targetAspect: '9:16' }), (error) => error.code === 'VALIDATION_FAILED')
})

test('keyframes are sampled every second and on the last frame', () => {
  assert.deepEqual(sampleTimes(3.5), [0, 1, 2, 3, 3.45])
  assert.deepEqual(sampleTimes(0.5), [0, 0.45])
})

// A bright square on a flat grey frame: the saliency subject is the square.
function frameWithSquare(width, height, cx, cy, size) {
  const gray = new Uint8Array(width * height).fill(90)
  for (let y = Math.round(cy * height - size / 2); y < cy * height + size / 2; y += 1) {
    for (let x = Math.round(cx * width - size / 2); x < cx * width + size / 2; x += 1) gray[y * width + x] = (x + y) % 4 < 2 ? 250 : 10
  }
  return gray
}

test('the primary-subject detector finds a lone subject and scores a flat frame as nothing', () => {
  const box = detectPrimarySubject(frameWithSquare(320, 180, 0.78, 0.4, 30), 320, 180)
  assert.ok(Math.abs(box.cx - 0.78) < 0.03 && Math.abs(box.cy - 0.4) < 0.03, JSON.stringify(box))
  assert.ok(box.score > 0.6, `score ${box.score}`)
  assert.equal(detectPrimarySubject(new Uint8Array(320 * 180).fill(90), 320, 180), null)
  // No face cascade: detectKeyframe falls back to the subject.
  const [subject] = detectKeyframe(frameWithSquare(320, 180, 0.25, 0.5, 30), 320, 180)
  assert.equal(subject.kind, 'subject')
  assert.ok(Math.abs(subject.cx - 0.25) < 0.03)
})
