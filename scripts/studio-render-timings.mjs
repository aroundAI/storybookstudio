// FILM-2014: render timings on this machine, for RELEASE_CHECKLIST.md.
//   node scripts/studio-render-timings.mjs [--keep]
// Builds the 20-shot rough cut (99 s) with 1080p sources made by FFmpeg, then
// times each preview tier, a full 1080p render with VideoToolbox/NVENC and
// with x264, and the delivery encode through the media-preparation queue.
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { buildMediaProject, removeDir, tempDir } from '../tests/studio/helpers/review-media.mjs'

const require = createRequire(import.meta.url)
const { createPreviewRenderer } = require('../electron/studio/previewRender.js')
const { createQa } = require('../electron/studio/qa.js')
const { probe, resolveBinaries } = require('../electron/studio/ffmpegTools.js')
const { createMediaPreparationService } = require('../electron/mediaPreparation.js')

const { ffmpegPath, ffprobePath } = resolveBinaries()
const hardware = process.platform === 'darwin' ? 'h264_videotoolbox' : 'h264_nvenc'
const dir = await tempDir('timings')
const rows = []
const time = async (label, fn, seconds) => {
  const started = Date.now()
  const result = await fn()
  const ms = Date.now() - started
  rows.push({ label, ms, realtime: seconds ? (seconds / (ms / 1000)).toFixed(1) + 'x' : '' })
  return result
}

try {
  const fixture = await buildMediaProject(dir, { width: 1920, height: 1080 })
  const { project } = fixture
  const duration = 99
  const renderer = createPreviewRenderer({ ffmpegPath, ffprobePath })
  const kf = await time('keyframes, whole cut (640 px JPEGs)', () => renderer.renderKeyframes({ project, projectDir: dir }))
  rows.at(-1).label += `, ${kf.count} frames`
  await time('scene preview, scene 3 (720p24 x264, 21 s)', () => renderer.renderScenePreview({ project, projectDir: dir, scene: 3 }), 21)
  await time('scene preview, whole cut (720p24 x264)', () => renderer.renderScenePreview({ project, projectDir: dir }), duration)
  await time('audio tier, bus mix + 5 stems (WAV)', () => renderer.renderAudioMix({ project, projectDir: dir, stems: true }), duration)
  const master = path.join(dir, 'master-1080p.mp4')
  await time(`full render 1080p24, ${hardware}`, () => renderer.renderVideo({ project, projectDir: dir, fullSize: true, encoder: hardware, preferProxy: false, output: master }), duration)
  await time('full render 1080p24, libx264 fast', () => renderer.renderVideo({ project, projectDir: dir, fullSize: true, encoder: 'libx264', preferProxy: false, output: path.join(dir, 'master-x264.mp4') }), duration)
  const qa = createQa({ ffmpegPath, ffprobePath })
  await time('QA pass on the 1080p render', () => qa.runQa({ file: master, project, projectDir: dir, policy: fixture.policy, pkg: fixture.pkg, preset: 'youtube_16x9' }))
  const service = createMediaPreparationService({
    ffmpegPath,
    probeVideoInfo: async (file) => {
      const info = await probe(ffprobePath, file)
      return { success: true, hasVideo: Boolean(info.video), hasAudio: Boolean(info.audio), duration: info.duration, fps: info.video?.fps, width: info.video?.width, height: info.video?.height, videoCodec: info.video?.codec, pixelFormat: info.video?.pixFmt }
    },
    probeHardwareEncoder: async () => ({ ok: true }),
  })
  const delivered = await time('delivery queue encode 1080p (hardware, fallback x264)', () => service.enqueue({ kind: 'delivery', inputPath: master, outputPath: path.join(dir, 'delivery', 'youtube.mp4'), targetWidth: 1920, targetHeight: 1080, ownerId: 'timings' }), duration)
  rows.at(-1).label += ` → ${delivered.encoder}${delivered.fallbackReason ? ' (fell back)' : ''}`
} finally {
  if (!process.argv.includes('--keep')) await removeDir(dir)
}

const cpu = os.cpus()[0]?.model || os.arch()
console.log(`Machine: ${cpu}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${process.platform} ${os.release()}; FFmpeg: ffmpeg-static`)
console.log('| Step | Time | Speed |\n|---|---|---|')
for (const row of rows) console.log(`| ${row.label} | ${(row.ms / 1000).toFixed(2)} s | ${row.realtime} |`)
