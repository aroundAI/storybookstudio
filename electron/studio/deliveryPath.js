// FILM-2014 AC7: the delivery render and the delivery QA that FILM-2017's
// deliver.js takes as `render` and `qa` (createStudioDeliver's seams).
//
// render: the timeline at the preset's frame and frame rate from the render
//   plan (previewRender.renderVideo, captions placed in the aspect's safe
//   area when the preset burns them, audio through FILM-2016's bus mix
//   normalised to the preset's loudness) into a near-lossless intermediate,
//   then the final encode through Velorn's media-preparation queue as a
//   `delivery` job: VideoToolbox on macOS, NVENC on Windows/Linux, x264 when
//   the hardware encoder is missing or fails. A sidecar preset gets
//   FILM-2017's WebVTT. Returns what FILM-2017's renderDelivery returns.
// qa: electron/studio/qa.js on the delivered file against the preset (format,
//   duration, loudness, true peak, clipping, black, frozen, silence), plus
//   the delivery-only checks: the platform's longest file and StoryBook's
//   500 MB limit, and the reframe warnings the variant timeline carries.
//
// Imports nothing from Electron; runs under `node --test`.
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { createPreviewRenderer, loadPlan } = require('./previewRender')
const { createQa } = require('./qa')
const { resolveBinaries, runFfmpegOrThrow } = require('./ffmpegTools')
const { captionCues: vttCues, toVtt } = require('./deliveryRender')

const MAX_RENDER_BYTES = 500 * 1024 * 1024 // contracts/delivery-package.schema.mjs MAX_RENDER_BYTES

// Binary paths are read when a delivery runs (main.js resolves them after
// createStudioMain), through getFfmpegPath/getFfprobePath or the fixed values.
function createDeliveryPath({ ffmpegPath = null, ffprobePath = null, getFfmpegPath: readFfmpeg = () => ffmpegPath, getFfprobePath: readFfprobe = () => ffprobePath, getMediaPreparation = () => null, renderer = null, qa = null, owner = 'studio-delivery' } = {}) {
  // Unset paths fall back to the bundled ffmpeg-static / ffprobe-static.
  const getFfmpegPath = () => resolveBinaries({ ffmpegPath: readFfmpeg(), ffprobePath: readFfprobe() }).ffmpegPath
  const getFfprobePath = () => resolveBinaries({ ffmpegPath: readFfmpeg(), ffprobePath: readFfprobe() }).ffprobePath
  const renderers = new Map()
  const rendererFor = (binary) => {
    if (renderer) return renderer
    const key = binary || getFfmpegPath() || ''
    if (!renderers.has(key)) renderers.set(key, createPreviewRenderer({ ffmpegPath: binary || getFfmpegPath(), ffprobePath: getFfprobePath() }))
    return renderers.get(key)
  }
  let lazyChecker = qa
  const checker = () => (lazyChecker ||= createQa({ ffmpegPath: getFfmpegPath(), ffprobePath: getFfprobePath() }))

  async function render({ project, projectDir, timelineId, preset, language = null, outputPath, ffmpegPath: binary = null, signal = null, onProgress = () => {} }) {
    const plan = await loadPlan()
    const timeline = plan.activeTimeline(project, timelineId)
    if (!timeline) throw Object.assign(new Error(`Timeline ${timelineId} is not in the project.`), { code: 'NOT_FOUND' })
    const duration = plan.programDuration(timeline)
    if (!(duration > 0)) throw Object.assign(new Error('The timeline is empty.'), { code: 'VALIDATION_FAILED' })
    const fps = Number(preset.fps) || plan.timelineFrame(project, timelineId).fps
    await fsp.mkdir(path.dirname(outputPath), { recursive: true })
    const intermediate = outputPath.replace(/\.mp4$/i, '') + '.intermediate.mov'
    const ffmpeg = binary || getFfmpegPath()
    try {
      const rendered = await rendererFor(ffmpeg).renderVideo({
        project, projectDir, timelineId, range: [0, duration], output: intermediate,
        size: { width: preset.width, height: preset.height }, fps, encoder: 'intermediate', preferProxy: false,
        captions: preset.captionPolicy === 'burn', captionsSafeArea: preset.captionPolicy === 'burn' ? preset.aspect : null,
        language, loudnessTargetLufs: preset.audioLufs, signal,
      })
      onProgress({ phase: 'picture', done: 1, total: 3 })

      let captionsPath = null
      let captionCues = rendered.captionCues
      if (preset.captionPolicy === 'sidecar') {
        const cues = vttCues(timeline, language, duration)
        captionCues = cues.length
        if (cues.length) {
          captionsPath = outputPath.replace(/\.mp4$/i, '.vtt')
          await fsp.writeFile(captionsPath, toVtt(cues))
        }
      }

      const service = getMediaPreparation()
      let encoded
      if (service) {
        encoded = await service.enqueue({ kind: 'delivery', inputPath: intermediate, outputPath, targetWidth: preset.width, targetHeight: preset.height, targetBitrateKbps: preset.bitrate, ownerId: owner, label: path.basename(outputPath) })
        if (!encoded?.success) throw Object.assign(new Error(`Delivery encode failed: ${encoded?.error || 'unknown error'}`), { code: encoded?.cancelled ? 'ABORTED' : 'ENCODE_FAILED' })
      } else {
        // No queue (a test, a headless run): the x264 fallback directly.
        const kbps = Number(preset.bitrate) || 8000
        await runFfmpegOrThrow(ffmpeg, ['-loglevel', 'error', '-i', intermediate, '-c:v', 'libx264', '-preset', 'fast', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`, '-pix_fmt', 'yuv420p', '-g', String(Math.round(fps * 2)), '-c:a', 'aac', '-b:a', `${Number(preset.audioBitrate) || 192}k`, '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-y', outputPath], { signal })
        encoded = { success: true, encoder: 'libx264', hardware: false, fallbackReason: 'no media-preparation queue' }
      }
      onProgress({ phase: 'encode', done: 2, total: 3 })

      const thumbnailPath = outputPath.replace(/\.mp4$/i, '.jpg')
      await runFfmpegOrThrow(ffmpeg, ['-loglevel', 'error', '-ss', String(Math.min(1, duration / 2)), '-i', outputPath, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', '-y', thumbnailPath], { signal })
      onProgress({ phase: 'done', done: 3, total: 3 })
      return {
        outputPath,
        durationSeconds: duration,
        captionsPath,
        thumbnailPath,
        audioClips: rendered.audioClips,
        sourceLufs: rendered.loudness?.input ?? null,
        captionCues,
        encoder: encoded.encoder ?? null,
        hardware: Boolean(encoded.hardware),
        fallbackReason: encoded.fallbackReason ?? null,
      }
    } finally {
      await fsp.rm(intermediate, { force: true }).catch(() => {})
    }
  }

  // FILM-2017's qa signature: ({file, preset, expectedDuration, warnings}) → {qa, probe, checker}.
  async function check({ file, preset, expectedDuration = null, warnings = [] }) {
    const target = { name: preset.name, width: preset.width, height: preset.height, fps: preset.fps, videoCodec: preset.codec || 'h264', audioCodec: preset.audioCodec || 'aac', audioLufs: preset.audioLufs }
    const { qa: result, measurement } = await checker().runQa({ file, preset: target, expectedDuration, documentChecks: false })
    const issues = [...result.issues]
    const bytes = fs.statSync(file).size
    const seconds = measurement.probe.duration
    if (Number.isFinite(preset.maxDuration) && seconds > preset.maxDuration) {
      issues.push({ type: 'max_duration', severity: 0.8, timeRange: null, scene: null, detail: `${seconds.toFixed(1)} s is over ${preset.name}'s ${preset.maxDuration} s limit.`, repairIntent: 're-time' })
    }
    if (bytes > MAX_RENDER_BYTES) {
      issues.push({ type: 'file_size', severity: 1, timeRange: null, scene: null, detail: `${(bytes / 1048576).toFixed(0)} MB is over StoryBook's 500 MB render limit.` })
    }
    for (const warning of warnings) issues.push({ ...warning })
    const video = measurement.probe.video || {}
    const audio = measurement.probe.audio || {}
    return {
      qa: { pass: issues.every((entry) => entry.severity < 0.5), issues: issues.slice(0, 500) },
      probe: { durationSeconds: seconds, videoCodec: video.codec ?? null, audioCodec: audio.codec ?? null, width: video.width ?? null, height: video.height ?? null, fps: video.fps ?? null, bytes, integratedLufs: measurement.loudness?.integratedLufs ?? null, truePeakDbtp: measurement.loudness?.truePeakDbtp ?? null },
      checker: 'FILM-2014 qa.js',
    }
  }

  return { render, check }
}

module.exports = { createDeliveryPath }
