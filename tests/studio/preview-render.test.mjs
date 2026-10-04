// FILM-2014 AC1: the three preview tiers on the 20-shot rough cut (FILM-2012
// B's buildProject over the FILM-2001 fixture, media made with FFmpeg), and
// the media-preparation queue's preview bypass and delivery kind (AC7).
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { cutTimes, keyframeTimes, pictureSegments } from '../../src/studio/review/renderPlan.js'
import { buildMediaProject, FFMPEG, FFPROBE, makeVideo, removeDir, tempDir } from './helpers/review-media.mjs'

const require = createRequire(import.meta.url)
const { createPreviewRenderer } = require('../../electron/studio/previewRender.js')
const { probe } = require('../../electron/studio/ffmpegTools.js')
const { createMediaPreparationService } = require('../../electron/mediaPreparation.js')
const { createQa } = require('../../electron/studio/qa.js')

const renderer = createPreviewRenderer({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE })
let dir
let fixture

before(async () => {
  dir = await tempDir('preview')
  fixture = await buildMediaProject(dir)
})
after(() => removeDir(dir))

test('the render plan: one segment per shot, the offline shot 20 as an offline segment, cuts where shots change', () => {
  const segments = pictureSegments(fixture.project, { projectDir: dir })
  const shots = segments.filter((segment) => segment.kind === 'video')
  assert.equal(shots.length, 20)
  assert.equal(shots.filter((segment) => segment.offline).length, 1, 'shot 20 was never generated')
  assert.equal(cutTimes(segments).length, 19)
  const times = keyframeTimes(segments)
  for (const cut of cutTimes(segments)) assert.ok(times.some((kf) => kf.reason === 'cut' && Math.abs(kf.time - cut - 0.05) < 1e-6), `no keyframe after the cut at ${cut}`)
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i].time - times[i - 1].time >= 0.25 - 1e-9)
  assert.ok(times.every((kf, i) => i === 0 || kf.time - times[i - 1].time <= 2 + 0.25), 'about 2 s between keyframes (a cut frame may replace a tick within 0.25 s)')
})

test('keyframes: one 640 px JPEG per cut and per 2 s under cache/kf/, mapped to clip and scene, under 5 s for the 99 s cut', async () => {
  const result = await renderer.renderKeyframes({ project: fixture.project, projectDir: dir })
  assert.equal(result.dir, path.join(dir, 'cache', 'kf'))
  assert.equal(readdirSync(result.dir).filter((name) => name.endsWith('.jpg')).length, result.count)
  assert.ok(result.count >= 50 && result.count <= 75, `${result.count} keyframes`)
  const info = await probe(FFPROBE, result.frames[3].file)
  assert.deepEqual([info.video.width, info.video.height], [640, 360])
  assert.equal(result.frames.find((f) => f.time >= 20 && f.time < 21).scene, 2)
  assert.ok(result.frames.some((f) => f.offline), 'the offline shot still gets a (black) keyframe')
  assert.ok(result.frames.some((f) => f.captions.length > 0), 'caption text rides along for the vision step')
  assert.ok(result.ms < 5000, `keyframes took ${result.ms} ms`)
  // A second render replaces the set rather than piling up.
  const again = await renderer.renderKeyframes({ project: fixture.project, projectDir: dir, range: [0, 10] })
  assert.equal(readdirSync(result.dir).filter((name) => name.endsWith('.jpg')).length, again.count)
})

test('scene preview: 720p, 24 fps, H.264 with the bus mix, faster than real time', async () => {
  const result = await renderer.renderScenePreview({ project: fixture.project, projectDir: dir, scene: 2 })
  const info = await probe(FFPROBE, result.file)
  assert.deepEqual([info.video.width, info.video.height, info.video.codec, Math.round(info.video.fps)], [1280, 720, 'h264', 24])
  assert.equal(info.audio.codec, 'aac')
  assert.ok(Math.abs(info.duration - 20) < 0.2, `scene 2 is 19 s → 39 s; got ${info.duration}`)
  assert.ok(result.realtimeFactor > 1, `rendered at ${result.realtimeFactor.toFixed(1)}x real time`)
})

test("audio tier: FILM-2016's bus mix (ducking, loudnorm to the master target) as a 48 kHz WAV, and one stem per bus", async () => {
  const result = await renderer.renderAudioMix({ project: fixture.project, projectDir: dir, stems: true, policy: fixture.policy })
  assert.equal(result.busMix, true)
  assert.equal(result.loudness.target, -14)
  const measured = await createQa({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE }).measure(result.file)
  assert.ok(Math.abs(measured.loudness.integratedLufs - -14) <= 1, `the preview sounds like the delivery: ${measured.loudness.integratedLufs} LUFS`)
  const info = await probe(FFPROBE, result.file)
  assert.equal(info.audio.codec, 'pcm_s16le')
  assert.equal(info.audio.sampleRate, 48000)
  assert.equal(info.video, null)
  assert.ok(Math.abs(info.duration - 99) < 0.1)
  assert.deepEqual(Object.keys(result.stems).sort(), ['ambience', 'dialogue', 'music', 'sfx', 'shotaudio'])
  for (const file of Object.values(result.stems)) assert.ok(existsSync(file))
})

test('media preparation: a preview proxy bypasses the queue while a long delivery encodes; delivery waits its turn', async () => {
  const long = path.join(dir, 'long-master.mp4')
  const short = path.join(dir, 'short-shot.mp4')
  await Promise.all([makeVideo(long, { duration: 40, width: 1920, height: 1080 }), makeVideo(short, { duration: 2 })])
  const service = createMediaPreparationService({
    ffmpegPath: FFMPEG,
    probeVideoInfo: async (file) => {
      const info = await probe(FFPROBE, file)
      return { success: true, hasVideo: Boolean(info.video), hasAudio: Boolean(info.audio), duration: info.duration, fps: info.video?.fps, width: info.video?.width, height: info.video?.height, videoCodec: info.video?.codec, pixelFormat: info.video?.pixFmt }
    },
    platform: 'test', // no hardware encoder route: x264, deterministic
  })
  const delivery = service.enqueue({ kind: 'delivery', inputPath: long, outputPath: path.join(dir, 'out', 'delivery.mp4'), targetWidth: 1080, targetHeight: 1920, ownerId: 'deliver' })
  const queuedProxy = service.enqueue({ kind: 'proxy', inputPath: short, outputPath: path.join(dir, 'out', 'queued-proxy.mp4'), targetHeight: 360, ownerId: 'import' })
  const preview = service.enqueue({ kind: 'proxy', inputPath: short, outputPath: path.join(dir, 'out', 'preview-proxy.mp4'), targetHeight: 360, ownerId: 'preview', bypassQueue: true })
  const first = await Promise.race([preview.then(() => 'preview'), delivery.then(() => 'delivery'), queuedProxy.then(() => 'queued proxy')])
  assert.equal(first, 'preview', 'the bypassing preview finished first')
  const status = service.getStatus()
  assert.equal(status.jobs.find((job) => job.ownerId === 'deliver').status, 'encoding', 'the delivery was still encoding')
  assert.equal(status.jobs.find((job) => job.ownerId === 'import').status, 'queued', 'a normal proxy still waits behind it')
  const done = await delivery
  assert.equal(done.success, true, done.error)
  const info = await probe(FFPROBE, path.join(dir, 'out', 'delivery.mp4'))
  assert.deepEqual([info.video.width, info.video.height], [1080, 1920], 'delivered at the preset frame, letterboxed')
  assert.equal((await queuedProxy).success, true)
  const refused = await service.enqueue({ kind: 'delivery', inputPath: long, outputPath: path.join(dir, 'out', 'x.mp4'), ownerId: 'x', bypassQueue: true })
  assert.equal(refused.success, false)
  assert.match(refused.error, /only previews bypass/)
})
