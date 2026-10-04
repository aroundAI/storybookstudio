// FILM-2014 AC7: the delivery render FILM-2017's deliver.js takes as `render`
// goes through the upstream editor's media-preparation queue (VideoToolbox on macOS, x264
// fallback), lands at the preset's frame with its loudness, and the delivery
// QA (`qa`) passes it; a planted fault fails it.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { resolvePreset } from '../../src/studio/delivery/presets.js'
import { buildMediaProject, clone, FFMPEG, FFPROBE, removeDir, tempDir, withoutOfflineClips } from './helpers/review-media.mjs'
import { applyStep } from './helpers/apply-plan.mjs'

const require = createRequire(import.meta.url)
const { createDeliveryPath } = require('../../electron/studio/deliveryPath.js')
const { createMediaPreparationService } = require('../../electron/mediaPreparation.js')
const { probe } = require('../../electron/studio/ffmpegTools.js')

let dir
let fixture
let project

const probeVideoInfo = async (file) => {
  const info = await probe(FFPROBE, file)
  return { success: true, hasVideo: Boolean(info.video), hasAudio: Boolean(info.audio), duration: info.duration, fps: info.video?.fps, width: info.video?.width, height: info.video?.height, videoCodec: info.video?.codec, pixelFormat: info.video?.pixFmt }
}
const queue = (options = {}) => createMediaPreparationService({ ffmpegPath: FFMPEG, probeVideoInfo, ...options })

before(async () => {
  dir = await tempDir('delivery')
  fixture = await buildMediaProject(dir)
  // Without the clips that have no media; shot 20's slot (94-99 s) is cut so
  // nothing renders black at the end.
  project = applyStep(withoutOfflineClips(fixture.project), { tool: 'extract_range', arguments: { startSeconds: 94, endSeconds: 100 } })
})
after(() => removeDir(dir))

test('shorts_9x16 through the queue: 1080x1920, the preset loudness, captions burned in the safe area; the delivery QA passes it', async () => {
  const service = queue({ platform: 'test' })
  const delivery = createDeliveryPath({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, getMediaPreparation: () => service })
  const preset = resolvePreset('shorts_9x16', { timeline: project.timelines[0], policy: fixture.policy })
  const outputPath = path.join(dir, 'renders', 'v1', 'shorts_9x16-en.mp4')
  const rendered = await delivery.render({ project, projectDir: dir, timelineId: project.currentTimelineId, preset, language: 'en', outputPath })
  assert.equal(rendered.outputPath, outputPath)
  assert.equal(rendered.encoder, 'libx264', 'no hardware route on this platform: the x264 fallback')
  assert.ok(rendered.captionCues > 0)
  assert.ok(rendered.audioClips > 0)
  assert.ok(service.getStatus().jobs.some((job) => job.kind === 'delivery' && job.status === 'ready'), 'the encode was a media-preparation delivery job')
  const info = await probe(FFPROBE, outputPath)
  assert.deepEqual([info.video.width, info.video.height, info.video.codec, Math.round(info.video.fps), info.audio.codec], [1080, 1920, 'h264', 30, 'aac'])
  const checked = await delivery.check({ file: outputPath, preset, expectedDuration: rendered.durationSeconds })
  assert.equal(checked.checker, 'FILM-2014 qa.js')
  assert.equal(checked.qa.pass, true, JSON.stringify(checked.qa.issues))
  assert.ok(Math.abs(checked.probe.integratedLufs - -14) <= 1, `${checked.probe.integratedLufs} LUFS`)
  // Reels holds the same file to -16 LUFS, and a 60 s platform limit to its length.
  const reels = await delivery.check({ file: outputPath, preset: { ...resolvePreset('reels_9x16', { timeline: project.timelines[0] }), maxDuration: 60 }, expectedDuration: rendered.durationSeconds })
  assert.deepEqual(reels.qa.issues.filter((i) => i.severity >= 0.5).map((i) => i.type).sort(), ['loudness', 'max_duration'])
})

test('a planted fault fails the delivery QA: a timeline with a 3 s hole renders black and silent there', async () => {
  const delivery = createDeliveryPath({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE })
  const holed = clone(project)
  holed.timelines[0].clips = holed.timelines[0].clips.filter((clip) => !(clip.startTime >= 19 && clip.startTime < 39 && clip.trackId === 'video-1' && clip.startTime < 24))
  const preset = resolvePreset('youtube_16x9', { timeline: holed.timelines[0], policy: fixture.policy })
  const outputPath = path.join(dir, 'renders', 'v2', 'youtube_16x9-en.mp4')
  const rendered = await delivery.render({ project: holed, projectDir: dir, timelineId: holed.currentTimelineId, preset, language: 'en', outputPath })
  assert.equal(rendered.fallbackReason, 'no media-preparation queue')
  assert.ok(rendered.captionsPath?.endsWith('.vtt'), 'youtube_16x9 keeps captions as a sidecar')
  const checked = await delivery.check({ file: outputPath, preset, expectedDuration: rendered.durationSeconds })
  assert.equal(checked.qa.pass, false)
  assert.ok(checked.qa.issues.some((i) => i.type === 'black_frames' && i.timeRange.start >= 18.5 && i.timeRange.start <= 19.5), JSON.stringify(checked.qa.issues))
})

test('on macOS the delivery encode uses VideoToolbox through the queue, and a 94 s 1080p render runs faster than real time', { skip: process.platform !== 'darwin' && 'VideoToolbox is macOS only' }, async (t) => {
  const service = queue({ probeHardwareEncoder: async () => ({ ok: true }) })
  const delivery = createDeliveryPath({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, getMediaPreparation: () => service })
  const preset = resolvePreset('youtube_16x9', { timeline: project.timelines[0], policy: fixture.policy })
  const outputPath = path.join(dir, 'renders', 'v3', 'youtube_16x9-en.mp4')
  const started = Date.now()
  const rendered = await delivery.render({ project, projectDir: dir, timelineId: project.currentTimelineId, preset, language: 'en', outputPath })
  const seconds = (Date.now() - started) / 1000
  const info = await probe(FFPROBE, outputPath)
  assert.deepEqual([info.video.width, info.video.height], [1920, 1080])
  if (!rendered.hardware) {
    // A VM without a GPU (GitHub's macOS runners) cannot open a VideoToolbox
    // session: the queue falls back to x264 and says why.
    assert.equal(rendered.encoder, 'libx264')
    assert.match(rendered.fallbackReason || '', /videotoolbox|compression session/i)
    t.skip(`no VideoToolbox session here, fell back to x264: ${String(rendered.fallbackReason).split('\n')[0].slice(0, 160)}`)
    return
  }
  assert.equal(rendered.encoder, 'h264_videotoolbox')
  assert.ok(rendered.durationSeconds / seconds > 1, `${rendered.durationSeconds} s rendered in ${seconds.toFixed(1)} s`)
  console.log(`# delivery 1080p ${rendered.durationSeconds} s via ${rendered.encoder}: ${seconds.toFixed(1)} s (${(rendered.durationSeconds / seconds).toFixed(1)}x real time)`)
})
