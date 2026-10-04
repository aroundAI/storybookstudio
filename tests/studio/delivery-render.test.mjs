// FILM-2017: the delivery tier's renderer and inline QA, with the bundled
// FFmpeg on synthetic media. A 16:9 render with sidecar captions passes QA
// at the preset's loudness; a 9:16 render follows the reframe keyframes (the
// subject lands in the centre of the vertical frame); a loud file fails QA
// with the normalize_loudness repair.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolvePreset } from '../../src/studio/delivery/presets.js'
import { computeCropPath, keyframesForCropPath } from '../../src/studio/reframe.js'
import { embedKeyframes } from '../../src/studio/intents/variants.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('@derhuerst/ffprobe-static')
const { renderDelivery, propertyExpression } = require('../../electron/studio/deliveryRender.js')
const { checkDeliveredFile } = require('../../electron/studio/deliveryQa.js')

const ff = (...args) => execFileSync(ffmpegPath, ['-hide_banner', '-v', 'error', '-y', ...args])

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-render-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'assets'))
  // Grey 16:9 shot with a white square at x 75%, y 40%; quiet dialogue tone; a music bed.
  ff('-f', 'lavfi', '-i', 'color=c=0x404040:s=640x360:r=24:d=3', '-vf', 'drawbox=x=456:y=120:w=48:h=48:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'assets', 'shot.mp4'))
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-af', 'volume=-30dB', path.join(dir, 'assets', 'line.wav'))
  ff('-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=3', '-af', 'volume=-28dB', path.join(dir, 'assets', 'music.wav'))
  return dir
}

function project({ width = 1920, height = 1080, keyframes = null } = {}) {
  const timeline = {
    id: 'tl',
    width,
    height,
    fps: 24,
    tracks: [
      { id: 'cap', type: 'video', role: 'captions', language: 'en' },
      { id: 'v', type: 'video' },
      { id: 'd', type: 'audio', language: 'en' },
      { id: 'd-hi', type: 'audio', language: 'hi' },
      { id: 'm', type: 'audio' },
    ],
    clips: [
      { id: 'shot', trackId: 'v', type: 'video', assetId: 'shot', startTime: 0, duration: 3, trimStart: 0, speed: 1, transform: { positionX: 0, positionY: 0, scaleX: 100, scaleY: 100 }, ...(keyframes ? { keyframes } : {}) },
      { id: 'line', trackId: 'd', type: 'audio', assetId: 'line', startTime: 0.5, duration: 2, trimStart: 0, gainDb: 0 },
      { id: 'line-hi', trackId: 'd-hi', type: 'audio', assetId: 'line', startTime: 0, duration: 3, trimStart: 0, gainDb: 20 },
      { id: 'bed', trackId: 'm', type: 'audio', assetId: 'music', startTime: 0, duration: 3, trimStart: 0, gainDb: 0 },
      { id: 'captions', trackId: 'cap', type: 'captions', startTime: 0, duration: 3, captions: { cues: [{ id: 'c1', start: 0.5, end: 2.5, text: 'Who cut the power?' }] } },
    ],
  }
  return {
    timelines: [timeline],
    assets: [
      { id: 'shot', type: 'video', path: 'assets/shot.mp4', width: 640, height: 360 },
      { id: 'line', type: 'audio', path: 'assets/line.wav' },
      { id: 'music', type: 'audio', path: 'assets/music.wav' },
    ],
  }
}

test('a youtube_16x9 render hits the preset: h264/aac 1920x1080, -14 LUFS, sidecar captions, and passes QA', async (t) => {
  const dir = workspace(t)
  const preset = resolvePreset('youtube_16x9', { timeline: { fps: 24 } })
  const outputPath = path.join(dir, 'renders', 'v1', 'youtube_16x9-en.mp4')
  const rendered = await renderDelivery({ project: project(), projectDir: dir, timelineId: 'tl', preset, language: 'en', outputPath, ffmpegPath })
  assert.equal(rendered.durationSeconds, 3)
  assert.equal(rendered.audioClips, 2, 'the Hindi line is left out of an English render')
  assert.match(fs.readFileSync(rendered.captionsPath, 'utf8'), /00:00:00\.500 --> 00:00:02\.500\nWho cut the power\?/)
  assert.ok(fs.statSync(rendered.thumbnailPath).size > 0)
  const { qa, probe } = await checkDeliveredFile({ file: outputPath, preset, expectedDuration: 3, ffmpegPath, ffprobePath })
  assert.deepEqual(qa, { pass: true, issues: [] }, JSON.stringify(probe))
  assert.equal(probe.width, 1920)
  assert.equal(probe.height, 1080)
  assert.ok(Math.abs(probe.integratedLufs - -14) <= 1, `integrated ${probe.integratedLufs}`)
})

test('a shorts_9x16 render draws the reframe keyframes: the subject sits in the middle of the vertical frame', async (t) => {
  const dir = workspace(t)
  const path9x16 = computeCropPath([{ t: 0, boxes: [{ kind: 'subject', cx: 0.75, cy: 0.4, w: 0.1, h: 0.1, score: 0.9 }] }, { t: 2.9, boxes: [{ kind: 'subject', cx: 0.75, cy: 0.4, w: 0.1, h: 0.1, score: 0.9 }] }], { sourceWidth: 640, sourceHeight: 360, targetAspect: '9:16' })
  const step = keyframesForCropPath(path9x16, { clipId: 'shot', clipDuration: 3, sourceWidth: 640, sourceHeight: 360, canvasWidth: 1080, canvasHeight: 1920 })
  const doc = project({ width: 1080, height: 1920 })
  embedKeyframes(doc.timelines[0], [step])
  const preset = resolvePreset('shorts_9x16', {})
  const outputPath = path.join(dir, 'renders', 'v1', 'shorts_9x16-en.mp4')
  await renderDelivery({ project: doc, projectDir: dir, timelineId: 'tl', preset, language: 'en', outputPath, ffmpegPath })
  // The subject (x 0.75, y 0.4) is centred horizontally: 0.75 is far enough
  // from the right edge (window half-width 0.158) not to be clamped.
  const pixel = execFileSync(ffmpegPath, ['-v', 'error', '-ss', '0.2', '-i', outputPath, '-frames:v', '1', '-vf', `crop=4:4:538:${Math.round(0.4 * 1920 + 3)},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'])
  assert.ok(pixel[0] > 200, `centre pixel ${pixel[0]} (white is the subject)`)
  const { qa, probe } = await checkDeliveredFile({ file: outputPath, preset, expectedDuration: 3, ffmpegPath, ffprobePath })
  assert.equal(probe.width, 1080)
  assert.equal(probe.height, 1920)
  assert.equal(qa.pass, true, JSON.stringify(qa))
})

test('a loud file fails QA with the normalize_loudness repair; a reframe warning rides along', async (t) => {
  const dir = workspace(t)
  const file = path.join(dir, 'loud.mp4')
  ff('-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=24:d=3', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=3', '-af', 'volume=17dB', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file)
  const preset = resolvePreset('youtube_16x9', { timeline: { fps: 24 } })
  const warning = { type: 'reframe_no_subject', severity: 0.3, timeRange: { start: 0, end: 3 }, scene: 1, detail: 'centred' }
  const { qa, probe } = await checkDeliveredFile({ file, preset, expectedDuration: 3, warnings: [warning], ffmpegPath, ffprobePath })
  assert.equal(qa.pass, false)
  const loudness = qa.issues.find((issue) => issue.type === 'loudness')
  assert.ok(loudness, JSON.stringify(qa.issues))
  assert.equal(loudness.repairIntent, 'normalize_loudness')
  assert.ok(probe.integratedLufs > -10, `integrated ${probe.integratedLufs}`)
  assert.ok(qa.issues.some((issue) => issue.type === 'reframe_no_subject'))
})

test('position keyframes become a piecewise-linear FFmpeg expression in segment time', () => {
  const clip = { keyframes: { positionX: [{ time: 0, value: 0 }, { time: 2, value: 100 }, { time: 3, value: 100, easing: 'hold' }] } }
  assert.equal(propertyExpression(clip, 'positionX', 1, 0, (v) => v + 10), 'if(lt(t,-1),10,if(lt(t,1),(10+(100)*(t-(-1))/2),if(lt(t,2),(110+(0)*(t-(1))/1),110)))')
  assert.equal(propertyExpression({ transform: { positionX: 7 } }, 'positionX', 0, 0, (v) => v), '7')
})
