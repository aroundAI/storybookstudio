// FILM-2014: the three preview tiers the AI uses to see its own cut.
//
//   keyframes   one 640 px JPEG per cut and per 2 s, under <project>/cache/kf/
//   scene       a 720p, 24 fps, H.264 file of a scene or range, from proxies
//   audio       a WAV of the bus mix (and optionally one stem per bus)
//
// Each tier is a direct FFmpeg run from the render plan (src/studio/review/):
// none of them enters the media-preparation queue (electron/mediaPreparation.js),
// so a long proxy build or delivery encode never blocks a preview. They use
// the same bundled FFmpeg and hardware-encoder route as the upstream editor's exporter
// (hardwareExportFfmpeg.js). The canvas compositor in the hidden export window
// stays the delivery path for effects, text and kinetic captions; previews draw
// the picture cuts, the bus mix and traditional-subtitle boxes, which is what
// QA and the critic judge.
//
// Imports nothing from Electron; runs under `node --test`.
const fs = require('fs')
const fsp = fs.promises
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { resolveBinaries, runFfmpegOrThrow, probe, pool } = require('./ffmpegTools')

const KEYFRAME_DIR = path.join('cache', 'kf')
const PREVIEW_DIR = path.join('cache', 'preview')
const SCENE_PREVIEW_SHORT_SIDE = 720
const SCENE_PREVIEW_FPS = 24

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
]

const loadPlan = () => import('../../src/studio/review/renderPlan.js')
const loadGraph = () => import('../../src/studio/review/renderGraph.js')
const loadLayout = () => import('../../src/studio/review/captionLayout.js')
const loadBusMix = () => import('./audioBusMix.mjs')
const loadBuses = () => import('../../src/studio/audio/buses.js')
const loadCaptionMargins = () => import('../../src/studio/captions/layout.js')

function findFont(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null
  return FONT_CANDIDATES.find((file) => { try { return fs.statSync(file).isFile() } catch { return false } }) || null
}

function sceneRange(plan, project, scene, timelineId) {
  const timeline = plan.activeTimeline(project, timelineId)
  const clips = plan.pictureClips(timeline).filter((clip) => plan.sceneOfClip(clip) === scene)
  if (clips.length === 0) throw Object.assign(new Error(`Scene ${scene} has no picture clips.`), { code: 'NOT_FOUND' })
  return [Math.min(...clips.map(plan.clipStart)), Math.max(...clips.map(plan.clipEnd))]
}

function resolveRange(plan, project, { range, scene, timelineId }) {
  const duration = plan.programDuration(plan.activeTimeline(project, timelineId))
  if (Number.isInteger(scene)) return sceneRange(plan, project, scene, timelineId)
  if (Array.isArray(range) && range.length === 2) {
    const [a, b] = [Math.max(0, Number(range[0]) || 0), Math.min(duration, Number(range[1]) || duration)]
    if (!(b > a)) throw Object.assign(new Error('range must be [start, end] with end after start, inside the timeline.'), { code: 'VALIDATION_FAILED' })
    return [a, b]
  }
  if (!(duration > 0)) throw Object.assign(new Error('The timeline is empty.'), { code: 'VALIDATION_FAILED' })
  return [0, duration]
}

function createPreviewRenderer(options = {}) {
  const { ffmpegPath, ffprobePath } = resolveBinaries(options)
  const concurrency = Math.max(1, options.concurrency || Math.min(8, os.availableParallelism?.() || os.cpus().length || 4))
  const fontFile = findFont(options.fontFile)
  const audioProbe = new Map()

  async function hasAudio(file) {
    let stat
    try { stat = await fsp.stat(file) } catch { return false }
    const key = `${file}\u0000${stat.size}\u0000${stat.mtimeMs}`
    if (!audioProbe.has(key)) audioProbe.set(key, probe(ffprobePath, file).then((info) => Boolean(info.audio)).catch(() => false))
    return audioProbe.get(key)
  }

  async function writeCueTexts(dir, cues, layout, size) {
    await fsp.mkdir(dir, { recursive: true })
    const files = new Map()
    await Promise.all(cues.map(async (entry, index) => {
      const rect = layout.cueRect(entry.cue, entry.clip, size)
      const file = path.join(dir, `cue-${index}.txt`)
      await fsp.writeFile(file, rect.lines.join('\n'))
      files.set(entry, file)
    }))
    return (entry) => files.get(entry)
  }

  // Tier 1. Keyframes for the whole timeline or `range` ([start, end] s).
  async function renderKeyframes({ project, projectDir, timelineId = null, range = null, captions = true, outDir = null, every, signal } = {}) {
    const started = Date.now()
    const [plan, graph, layout] = await Promise.all([loadPlan(), loadGraph(), loadLayout()])
    const segments = plan.pictureSegments(project, { timelineId, projectDir })
    const times = plan.keyframeTimes(segments, { range, every })
    const frame = plan.timelineFrame(project, timelineId)
    const size = graph.frameSize(frame, { width: plan.KEYFRAME_WIDTH })
    const dir = outDir || path.join(projectDir, KEYFRAME_DIR)
    await fsp.mkdir(dir, { recursive: true })
    for (const name of await fsp.readdir(dir)) if (/^kf-\d+\.jpg$/.test(name)) await fsp.unlink(path.join(dir, name)).catch(() => {})
    const cues = captions && fontFile ? plan.captionCues(project, { timelineId }) : []
    const textFileFor = cues.length ? await writeCueTexts(path.join(dir, '.cues'), cues, layout, size) : null
    const frames = await pool(times.map(({ time, reason }) => async () => {
      const segment = plan.segmentAt(segments, time)
      const file = path.join(dir, `kf-${String(Math.round(time * 1000)).padStart(7, '0')}.jpg`)
      const active = cues.filter((entry) => entry.start <= time && entry.end > time)
      const complex = active.filter((entry) => graph.needsComplexShaping(entry.text))
      const script = complex.length ? file.replace(/\.jpg$/, '.ass') : null
      if (script) await fsp.writeFile(script, graph.captionAssScript(complex, size, { enableByTime: false }))
      const drawtext = active.length
        ? [...graph.captionDrawtextFilters(active, size, { fontFile, textFileFor, enableByTime: false }), ...(script ? [graph.assFilter(script)] : [])].join(',') || null
        : null
      await runFfmpegOrThrow(ffmpegPath, ['-loglevel', 'error', ...graph.keyframeArgs(segment, time, file, size, { drawtext })], { signal, timeoutMs: 30000 })
      if (script) await fsp.rm(script, { force: true }).catch(() => {})
      return {
        time,
        reason,
        file,
        clipId: segment?.clipId ?? null,
        shotId: segment?.shotId ?? null,
        scene: segment?.scene ?? null,
        offline: Boolean(segment?.offline),
        captions: active.map((entry) => entry.text),
      }
    }), concurrency)
    return { dir, width: size.width, height: size.height, count: frames.length, frames, ms: Date.now() - started, captionsDrawn: Boolean(fontFile) || cues.length === 0 }
  }

  async function mixInputs(plan, project, projectDir, timelineId, language = null) {
    const clips = plan.audioClips(project, { timelineId, projectDir, language })
    await Promise.all(clips.map(async (clip) => { clip.hasAudio = clip.file ? await hasAudio(clip.file) : false }))
    return clips
  }

  function limiterOf(timeline) {
    const insert = (timeline?.masterAudioInserts || []).find((entry) => entry?.type === 'limiter' && entry.enabled !== false)
    if (!insert) return null
    const ceiling = Number(insert.ceilingDb ?? insert.params?.ceilingDb)
    return { ceilingDb: Number.isFinite(ceiling) ? Math.min(0, Math.max(-24, ceiling)) : -1 }
  }

  // Tier 3. The mix of the timeline or a range as a 48 kHz stereo WAV; with
  // `stems`, one WAV per bus beside it (the critic's dialogue/music ratio).
  // A Studio project (project.studio.audioBuses) mixes through FILM-2016's
  // bus graph, the export's own: sidechain ducking under dialogue and the
  // loudnorm pass to the master target, so the preview sounds like the
  // delivery. A plain upstream project sums its tracks with the master gain.
  async function renderAudioMix({ project, projectDir, timelineId = null, range = null, scene = null, stems = false, output = null, policy = null, language = null, loudnessTargetLufs = null, signal } = {}) {
    const started = Date.now()
    const [plan, graph] = await Promise.all([loadPlan(), loadGraph()])
    const [from, to] = resolveRange(plan, project, { range, scene, timelineId })
    const timeline = plan.activeTimeline(project, timelineId)
    const clips = await mixInputs(plan, project, projectDir, timelineId, language)
    const file = output || path.join(projectDir, PREVIEW_DIR, `mix-${Math.round(from * 1000)}-${Math.round(to * 1000)}.wav`)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const stemFiles = {}
    let loudness = null
    if (project?.studio?.audioBuses) {
      const [{ runStudioBusMix }, { resolveAudioBuses }] = await Promise.all([loadBusMix(), loadBuses()])
      const buses = resolveAudioBuses(project.studio.audioBuses, { policy })
      const inputs = clips.flatMap((clip) => {
        const filters = graph.clipFilters(clip, { from, to })
        return filters ? [{ inputPath: clip.file, filters, bus: clip.bus, language: clip.language ?? null }] : []
      })
      if (signal?.aborted) throw Object.assign(new Error('Render cancelled.'), { code: 'ABORTED' })
      const stemDir = path.join(path.dirname(file), `${path.basename(file, '.wav')}.stems`)
      if (stems) await fsp.rm(stemDir, { recursive: true, force: true })
      const mixed = inputs.length
        ? await runStudioBusMix({
          ffmpegPath, inputs, buses, outputPath: file, totalDuration: to - from,
          masterGain: 10 ** (plan.masterGainDb(timeline) / 20),
          loudnessTargetLufs: Number.isFinite(loudnessTargetLufs) ? loudnessTargetLufs : buses.master.limiterLufs,
          stems: stems ? { directory: stemDir, baseName: path.basename(file, '.wav') } : null,
        })
        : null
      if (!mixed) {
        await runFfmpegOrThrow(ffmpegPath, ['-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=${graph.SAMPLE_RATE}:cl=stereo`, '-t', String(to - from), '-c:a', 'pcm_s16le', '-y', file], { signal })
      } else if (!mixed.success) {
        throw Object.assign(new Error(`Audio bus mix failed: ${String(mixed.error || 'FFmpeg gave no reason').slice(0, 1500)}`), { code: 'FFMPEG_FAILED' })
      } else {
        loudness = mixed.loudness
        const language = timeline?.studio?.language || null
        for (const stem of mixed.stems || []) {
          const bus = stem.bus || 'unbussed'
          if (bus === 'dialogue' && stemFiles.dialogue && stem.language !== language) continue
          stemFiles[bus] = stem.path
        }
      }
    } else {
      const mix = graph.audioMixGraph(clips, { from, to, masterGainDb: plan.masterGainDb(timeline), limiter: limiterOf(timeline), stems })
      const args = mix.inputs.length
        ? ['-loglevel', 'error', ...mix.inputs.flat(), '-filter_complex', mix.filter, '-map', `[${mix.out}]`, '-c:a', 'pcm_s16le', '-ar', String(graph.SAMPLE_RATE), '-y', file]
        : ['-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=${graph.SAMPLE_RATE}:cl=stereo`, '-t', String(to - from), '-c:a', 'pcm_s16le', '-y', file]
      for (const stem of mix.stems) {
        const stemFile = file.replace(/\.wav$/, `.${stem.bus}.wav`)
        stemFiles[stem.bus] = stemFile
        args.push('-map', `[${stem.label}]`, '-c:a', 'pcm_s16le', '-ar', String(graph.SAMPLE_RATE), '-y', stemFile)
      }
      await runFfmpegOrThrow(ffmpegPath, args, { signal })
    }
    return { file, stems: stemFiles, range: [from, to], duration: to - from, ms: Date.now() - started, clips: clips.filter((clip) => clip.hasAudio).length, busMix: Boolean(project?.studio?.audioBuses), loudness }
  }

  // Tier 2 (and the full-size render the timings and delivery checks use):
  // picture + bus mix + subtitle boxes for a scene or range, encoded H.264.
  // `size` ({width, height}) renders at a delivery preset's frame;
  // `captionsSafeArea` (an aspect) places every cue FILM-2016's way inside that
  // aspect's safe area, as a burned delivery must; encoder 'intermediate' is
  // a near-lossless .mov with PCM audio for the media-preparation queue's
  // delivery encode.
  async function renderVideo({ project, projectDir, timelineId = null, range = null, scene = null, output = null, shortSide = SCENE_PREVIEW_SHORT_SIDE, fullSize = false, size: frameOverride = null, fps = SCENE_PREVIEW_FPS, encoder = 'libx264', preferProxy = true, captions = true, captionsSafeArea = null, audio = true, policy = null, language = null, loudnessTargetLufs = null, signal } = {}) {
    const started = Date.now()
    const [plan, graph, layout] = await Promise.all([loadPlan(), loadGraph(), loadLayout()])
    const [from, to] = resolveRange(plan, project, { range, scene, timelineId })
    const frame = plan.timelineFrame(project, timelineId)
    const size = frameOverride ? graph.frameSize(frameOverride) : fullSize ? graph.frameSize(frame) : graph.frameSize(frame, { shortSide })
    const segments = plan.pictureSegments(project, { timelineId, projectDir, preferProxy })
    const video = graph.sceneVideoGraph(segments, { from, to, size, fps })
    const chains = [video.filter]
    let videoOut = video.out
    const workDir = path.join(projectDir, PREVIEW_DIR, `.work-${crypto.randomUUID()}`)
    try {
      let cues = captions && fontFile ? plan.captionCues(project, { timelineId, language }).filter((entry) => entry.end > from && entry.start < to) : []
      if (captionsSafeArea && cues.length) {
        const { safeAreaFor } = await loadCaptionMargins()
        // A cue placed for another aspect (a 16:9 master boxed into a 9:16 render) is placed again for this one.
        cues = cues.map((entry) => (entry.cue.globalOverrides?.safeArea && (entry.cue.globalOverrides.aspect ?? captionsSafeArea) === captionsSafeArea ? entry : { ...entry, cue: { ...entry.cue, globalOverrides: { ...(entry.cue.globalOverrides || {}), safeArea: safeAreaFor(captionsSafeArea), aspect: captionsSafeArea } } }))
      }
      if (cues.length) {
        const textFileFor = await writeCueTexts(workDir, cues, layout, size)
        const draw = graph.captionDrawtextFilters(cues, size, { fontFile, textFileFor, from, to, timeOffset: from })
        if (draw.length) {
          chains.push(`[${videoOut}]${draw.join(',')}[vcap]`)
          videoOut = 'vcap'
        }
        // FILM-2019: Devanagari and other complex scripts through libass.
        const complex = cues.filter((entry) => graph.needsComplexShaping(entry.text))
        if (complex.length) {
          const script = path.join(workDir, 'captions.ass')
          await fsp.writeFile(script, graph.captionAssScript(complex, size, { from, to, timeOffset: from }))
          chains.push(`[${videoOut}]${graph.assFilter(script)}[vass]`)
          videoOut = 'vass'
        }
      }
      const inputs = [...video.inputs]
      let audioOut = null
      let mixed = null
      if (audio) {
        mixed = await renderAudioMix({ project, projectDir, timelineId, range: [from, to], output: path.join(workDir, 'mix.wav'), policy, language, loudnessTargetLufs, signal })
        inputs.push(['-i', mixed.file])
        audioOut = `${inputs.length - 1}:a`
      }
      const file = output || path.join(projectDir, PREVIEW_DIR, Number.isInteger(scene) ? `scene-${scene}.mp4` : `range-${Math.round(from * 1000)}-${Math.round(to * 1000)}.mp4`)
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const encode = encoder === 'intermediate'
        ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10']
        : encoder === 'h264_videotoolbox'
        ? ['-c:v', 'h264_videotoolbox', '-b:v', fullSize ? '12M' : '4M', '-allow_sw', '0', '-realtime', '1']
        : encoder === 'h264_nvenc'
          ? ['-c:v', 'h264_nvenc', '-preset', 'p2', '-cq', '23']
          : ['-c:v', 'libx264', '-preset', fullSize ? 'fast' : 'veryfast', '-crf', fullSize ? '20' : '26']
      const args = ['-loglevel', 'error', ...inputs.flat(), '-filter_complex', chains.join(';'), '-map', `[${videoOut}]`]
      if (audioOut) args.push('-map', audioOut, ...(encoder === 'intermediate' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '192k']), '-ar', '48000')
      args.push(...encode, '-pix_fmt', 'yuv420p', '-r', String(fps), ...(encoder === 'intermediate' ? [] : ['-movflags', '+faststart']), '-t', String(to - from), '-y', file)
      await runFfmpegOrThrow(ffmpegPath, args, { signal })
      const ms = Date.now() - started
      return { file, range: [from, to], duration: to - from, width: size.width, height: size.height, fps, encoder, ms, realtimeFactor: (to - from) / (ms / 1000), captionCues: cues.length, audioClips: mixed?.clips ?? 0, loudness: mixed?.loudness ?? null }
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const renderScenePreview = (args = {}) => renderVideo({ ...args, fullSize: false, shortSide: SCENE_PREVIEW_SHORT_SIDE, fps: SCENE_PREVIEW_FPS, preferProxy: true })

  return { renderKeyframes, renderScenePreview, renderAudioMix, renderVideo, fontFile, ffmpegPath, ffprobePath }
}

module.exports = { createPreviewRenderer, resolveRange, loadPlan, KEYFRAME_DIR, PREVIEW_DIR, SCENE_PREVIEW_SHORT_SIDE, SCENE_PREVIEW_FPS, findFont }
