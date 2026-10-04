// FILM-2017: renders one timeline of a project document to one delivery
// preset with the bundled FFmpeg, in the main process, with no window open.
//
// This is the delivery tier's interim renderer: FILM-2014 builds the
// hardware render path that replaces it (deliver.js takes `render` as an
// argument, so the swap is one line). What it draws, so a reviewer knows
// what a delivered file can and cannot show:
// - picture: the top visible video or image clip at each moment (earlier
//   video track wins, captions tracks excluded), drawn as Velorn draws it:
//   fit inside the frame, then scaleX/scaleY and positionX/positionY from the
//   clip transform or its keyframes. Position keyframes are interpolated
//   linearly (Velorn's easing curves are not reproduced). Gaps are black.
//   Not drawn: transitions, effects, text and shape clips, masks, opacity.
// - audio: every enabled audio clip on an audible track of the render's
//   language (or no language), at clip gain and track volume, mixed and
//   loudness-normalised to the preset's target in two passes.
// - captions: the captions clips of the render's language, burned in (the
//   preset's captionPolicy 'burn', inside the aspect's safe area) or written
//   as a WebVTT sidecar ('sidecar').
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { spawn } = require('child_process')

const EPS = 1e-6
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
const round3 = (value) => Math.round(value * 1000) / 1000
const clipStart = (clip) => num(clip.startTime)
const clipEnd = (clip) => clipStart(clip) + num(clip.duration)
const PICTURE_TYPES = new Set(['video', 'image'])
const CAPTION_TYPES = new Set(['captions', 'caption'])
// FILM-2016's safe areas (captions/layout.js), as margins for libass.
const SAFE_AREAS = {
  '9:16': { left: 0.05, right: 0.15, top: 0.08, bottom: 0.25 },
  '16:9': { left: 0.05, right: 0.05, top: 0.05, bottom: 0.08 },
  '1:1': { left: 0.05, right: 0.05, top: 0.05, bottom: 0.1 },
}

function runFfmpeg(binary, args, { signal, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!binary) {
      reject(Object.assign(new Error('FFmpeg is not available.'), { code: 'FFMPEG_UNAVAILABLE' }))
      return
    }
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener?.('abort', onAbort)
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-64 * 1024)
    })
    child.stdout.on('data', () => {})
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (signal?.aborted) reject(Object.assign(new Error('Render cancelled.'), { code: 'ABORTED' }))
      else if (code !== 0) reject(Object.assign(new Error(`FFmpeg failed: ${stderr.trim().split('\n').slice(-3).join(' ')}`), { code: 'RENDER_FAILED' }))
      else resolve({ stderr })
    })
  })
}

const timelineOf = (project, timelineId) => (project.timelines || []).find((timeline) => timeline.id === timelineId) || null
const trackLanguage = (track) => track?.language ?? null
const clipLanguage = (clip, track) => clip.metadata?.language ?? trackLanguage(track)
const inLanguage = (clip, track, language) => {
  const lang = clipLanguage(clip, track)
  return !lang || !language || lang === language
}

function assetPath(asset, projectDir) {
  const file = asset?.absolutePath || asset?.path
  if (!file) return null
  return path.isAbsolute(file) ? file : path.join(projectDir, file)
}

// Program length: the last picture or audio clip (captions may run longer).
function programDuration(timeline) {
  const tracks = new Map((timeline.tracks || []).map((track) => [track.id, track]))
  let end = 0
  for (const clip of timeline.clips || []) {
    const track = tracks.get(clip.trackId)
    if (clip.enabled === false || track?.role === 'captions' || CAPTION_TYPES.has(clip.type)) continue
    end = Math.max(end, clipEnd(clip))
  }
  return round3(end)
}

function pictureSegments(timeline, project, projectDir) {
  const tracks = (timeline.tracks || []).filter((track) => track.type === 'video' && track.role !== 'captions' && track.visible !== false)
  const order = new Map(tracks.map((track, index) => [track.id, index]))
  const assets = new Map((project.assets || []).map((asset) => [asset.id, asset]))
  const clips = (timeline.clips || []).filter((clip) => order.has(clip.trackId) && clip.enabled !== false && PICTURE_TYPES.has(clip.type) && num(clip.duration) > EPS)
  const duration = programDuration(timeline)
  const bounds = [...new Set([0, duration, ...clips.flatMap((clip) => [clipStart(clip), clipEnd(clip)])])].filter((t) => t >= 0 && t <= duration + EPS).sort((a, b) => a - b)
  const segments = []
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const [start, end] = [bounds[i], bounds[i + 1]]
    if (end - start <= 1e-3) continue
    const mid = (start + end) / 2
    const top = clips.filter((clip) => clipStart(clip) <= mid && clipEnd(clip) > mid).sort((a, b) => order.get(a.trackId) - order.get(b.trackId))[0] || null
    const last = segments.at(-1)
    if (last && last.clip?.id === top?.id) {
      last.end = end
      continue
    }
    const asset = top ? assets.get(top.assetId) : null
    segments.push({ start, end, clip: top, asset, file: top ? assetPath(asset, projectDir) : null })
  }
  return { segments, duration }
}

// A transform property at clip time t: its keyframes (linear between them,
// held outside them) or the static transform value.
function propertyAt(clip, property, t, fallback) {
  const frames = clip.keyframes?.[property]
  if (Array.isArray(frames) && frames.length) {
    if (t <= frames[0].time) return num(frames[0].value, fallback)
    for (let i = 1; i < frames.length; i += 1) {
      if (t <= frames[i].time) {
        const a = frames[i - 1]
        const b = frames[i]
        if (a.easing === 'hold' || b.time - a.time < EPS) return num(a.value, fallback)
        return num(a.value) + (num(b.value) - num(a.value)) * ((t - a.time) / (b.time - a.time))
      }
    }
    return num(frames.at(-1).value, fallback)
  }
  return num(clip.transform?.[property], fallback)
}

// An FFmpeg expression in t (segment-local seconds) for a keyframed property.
function propertyExpression(clip, property, segmentClipStart, fallback, map) {
  const frames = (clip.keyframes?.[property] || []).filter((frame) => Number.isFinite(Number(frame.time)))
  if (frames.length < 2) return String(round3(map(propertyAt(clip, property, segmentClipStart, fallback))))
  const local = frames.map((frame) => ({ t: round3(frame.time - segmentClipStart), v: round3(map(num(frame.value))), hold: frame.easing === 'hold' }))
  let expression = String(local.at(-1).v)
  for (let i = local.length - 1; i >= 1; i -= 1) {
    const a = local[i - 1]
    const b = local[i]
    const span = Math.max(1e-3, b.t - a.t)
    const segment = a.hold ? `${a.v}` : `(${a.v}+(${round3(b.v - a.v)})*(t-(${a.t}))/${round3(span)})`
    expression = `if(lt(t,${b.t}),${segment},${expression})`
  }
  return `if(lt(t,${local[0].t}),${local[0].v},${expression})`
}

async function renderSegment({ segment, preset, fps, ffmpegPath, outFile, signal }) {
  const { width, height } = preset
  const length = round3(segment.end - segment.start)
  const base = ['-hide_banner', '-nostdin', '-y', '-v', 'error']
  const encode = ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-r', String(fps), outFile]
  if (!segment.clip || !segment.file || !fs.existsSync(segment.file)) {
    await runFfmpeg(ffmpegPath, [...base, '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${length}`, '-t', String(length), ...encode], { signal })
    return
  }
  const clip = segment.clip
  const speed = num(clip.speed, 1) || 1
  const clipTimeAtStart = segment.start - clipStart(clip)
  const sourceStart = Math.max(0, num(clip.trimStart) + clipTimeAtStart * speed)
  const srcW = num(segment.asset?.width, 0) || num(segment.asset?.settings?.width, 0) || 1920
  const srcH = num(segment.asset?.height, 0) || num(segment.asset?.settings?.height, 0) || 1080
  const fit = Math.min(width / srcW, height / srcH)
  const scaleX = propertyAt(clip, 'scaleX', clipTimeAtStart, 100) / 100
  const scaleY = propertyAt(clip, 'scaleY', clipTimeAtStart, 100) / 100
  const drawnW = Math.max(2, Math.round((srcW * fit * scaleX) / 2) * 2)
  const drawnH = Math.max(2, Math.round((srcH * fit * scaleY) / 2) * 2)
  // overlay x/y: top-left of the drawn media; Velorn centres it, then moves it by positionX/Y.
  const x = propertyExpression(clip, 'positionX', clipTimeAtStart, 0, (value) => (width - drawnW) / 2 + value)
  const y = propertyExpression(clip, 'positionY', clipTimeAtStart, 0, (value) => (height - drawnH) / 2 + value)
  const input = segment.clip.type === 'image'
    ? ['-loop', '1', '-t', String(length), '-i', segment.file]
    : ['-ss', String(round3(sourceStart)), '-t', String(round3(length * speed)), '-i', segment.file]
  const speedFilter = speed !== 1 && segment.clip.type !== 'image' ? `setpts=PTS/${speed},` : ''
  const graph = [
    `color=c=black:s=${width}x${height}:r=${fps}:d=${length}[bg]`,
    `[0:v]${speedFilter}fps=${fps},scale=${drawnW}:${drawnH}:flags=bicubic,setsar=1[fg]`,
    `[bg][fg]overlay=x='${x}':y='${y}':eval=frame:eof_action=repeat,trim=duration=${length}[v]`,
  ].join(';')
  await runFfmpeg(ffmpegPath, [...base, ...input, '-filter_complex', graph, '-map', '[v]', '-t', String(length), ...encode], { signal })
}

function audioClipsFor(timeline, project, projectDir, language) {
  const tracks = new Map((timeline.tracks || []).map((track) => [track.id, track]))
  const assets = new Map((project.assets || []).map((asset) => [asset.id, asset]))
  return (timeline.clips || [])
    .filter((clip) => clip.type === 'audio' && clip.enabled !== false && num(clip.duration) > EPS)
    .filter((clip) => {
      const track = tracks.get(clip.trackId)
      return track && !track.muted && inLanguage(clip, track, language)
    })
    .map((clip) => {
      const track = tracks.get(clip.trackId)
      const file = assetPath(assets.get(clip.assetId), projectDir)
      const gainDb = num(clip.gainDb) + 20 * Math.log10(Math.max(1e-4, num(track.volume, 100) / 100)) + 20 * Math.log10(Math.max(1e-4, num(clip.volume, 100) / 100))
      return { clip, file, gainDb, speed: num(clip.speed, 1) || 1 }
    })
    .filter((entry) => entry.file && fs.existsSync(entry.file))
}

async function mixAudio({ timeline, project, projectDir, language, duration, ffmpegPath, outFile, signal }) {
  const clips = audioClipsFor(timeline, project, projectDir, language)
  const base = ['-hide_banner', '-nostdin', '-y', '-v', 'error']
  if (!clips.length) {
    await runFfmpeg(ffmpegPath, [...base, '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', String(duration), '-c:a', 'pcm_s16le', outFile], { signal })
    return { clips: 0 }
  }
  const inputs = []
  const chains = []
  clips.forEach((entry, index) => {
    inputs.push('-ss', String(round3(num(entry.clip.trimStart))), '-t', String(round3(num(entry.clip.duration) * entry.speed)), '-i', entry.file)
    const delay = Math.max(0, Math.round(clipStart(entry.clip) * 1000))
    const tempo = entry.speed !== 1 ? `atempo=${Math.min(2, Math.max(0.5, entry.speed))},` : ''
    chains.push(`[${index}:a]${tempo}aresample=48000,aformat=channel_layouts=stereo,volume=${round3(entry.gainDb)}dB,adelay=${delay}|${delay}[a${index}]`)
  })
  const graph = `${chains.join(';')};${clips.map((_, index) => `[a${index}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad,atrim=duration=${duration}[mix]`
  await runFfmpeg(ffmpegPath, [...base, ...inputs, '-filter_complex', graph, '-map', '[mix]', '-c:a', 'pcm_s16le', '-ar', '48000', outFile], { signal })
  return { clips: clips.length }
}

// Two passes: measure the mix's integrated loudness (EBU R128), then one
// linear gain to the target and a peak limiter at -3 dBFS (headroom for the AAC encode) so the true peak
// stays under QA's -1 dBTP. (loudnorm's own second pass falls back to its
// dynamic mode whenever the gain would push a peak over the ceiling; that
// mode resamples to 192 kHz and misses the target on short files.)
const PEAK_LIMIT = 10 ** (-3 / 20)
async function normalizeLoudness({ input, target, ffmpegPath, outFile, signal }) {
  const measure = `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`
  const { stderr } = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-y', '-v', 'info', '-i', input, '-af', `aformat=channel_layouts=stereo,${measure}`, '-f', 'null', '-'], { signal })
  const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)
  let measured = null
  try {
    measured = JSON.parse(json)
  } catch {
    measured = null
  }
  const inputLufs = Number(measured?.input_i)
  const silent = !Number.isFinite(inputLufs) || inputLufs < -70
  const gainDb = silent ? 0 : round3(target - inputLufs)
  const filter = `aformat=channel_layouts=stereo,volume=${gainDb}dB,alimiter=limit=${round3(PEAK_LIMIT)}:attack=5:release=50:level=false,aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo`
  await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', input, '-af', filter, '-c:a', 'pcm_s16le', outFile], { signal })
  return { measuredLufs: silent ? null : inputLufs, gainDb }
}

const vttTime = (seconds) => {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}

// The cues of the render's language, in program time.
function captionCues(timeline, language, duration) {
  const tracks = new Map((timeline.tracks || []).map((track) => [track.id, track]))
  const cues = []
  for (const clip of timeline.clips || []) {
    if (!CAPTION_TYPES.has(clip.type) || clip.enabled === false || !clip.captions?.cues) continue
    const track = tracks.get(clip.trackId)
    if (!inLanguage(clip, track, language)) continue
    for (const cue of clip.captions.cues) {
      const start = clipStart(clip) + num(cue.start)
      const end = Math.min(clipStart(clip) + num(cue.end), clipEnd(clip), duration)
      if (end > start + EPS && String(cue.text || '').trim()) cues.push({ start, end, text: String(cue.text).trim() })
    }
  }
  return cues.sort((a, b) => a.start - b.start)
}

const toVtt = (cues) => `WEBVTT\n\n${cues.map((cue, i) => `${i + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text}\n`).join('\n')}`
const toSrt = (cues) => cues.map((cue, i) => `${i + 1}\n${vttTime(cue.start).replace('.', ',')} --> ${vttTime(cue.end).replace('.', ',')}\n${cue.text}\n`).join('\n')

// libass sizes and margins are in its default 384x288 script space.
function burnStyle(aspect, height) {
  const safe = SAFE_AREAS[aspect] || SAFE_AREAS['16:9']
  const fontSize = aspect === '9:16' ? 11 : aspect === '1:1' ? 14 : 16
  void height
  return `Fontname=Arial,Fontsize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1.2,Shadow=0,Alignment=2,MarginV=${Math.round(288 * safe.bottom) + 4},MarginL=${Math.round(384 * safe.left)},MarginR=${Math.round(384 * safe.right)}`
}

const escapeFilterPath = (file) => file.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")

async function renderDelivery({ project, projectDir, timelineId, preset, language = null, outputPath, ffmpegPath, signal = null, onProgress = () => {}, workDir = null }) {
  const timeline = timelineOf(project, timelineId)
  if (!timeline) throw Object.assign(new Error(`Timeline ${timelineId} is not in the project.`), { code: 'NOT_FOUND' })
  const fps = num(preset.fps, num(timeline.fps, 24))
  const { segments, duration } = pictureSegments(timeline, project, projectDir)
  if (!(duration > 0)) throw Object.assign(new Error('The timeline is empty.'), { code: 'VALIDATION_FAILED' })
  await fsp.mkdir(path.dirname(outputPath), { recursive: true })
  const temp = workDir || (await fsp.mkdtemp(path.join(path.dirname(outputPath), '.render-')))
  await fsp.mkdir(temp, { recursive: true })
  const total = segments.length + 3
  try {
    const parts = []
    for (const [index, segment] of segments.entries()) {
      const outFile = path.join(temp, `seg-${String(index).padStart(4, '0')}.mp4`)
      await renderSegment({ segment, preset, fps, ffmpegPath, outFile, signal })
      parts.push(outFile)
      onProgress({ phase: 'picture', done: index + 1, total })
    }
    const list = path.join(temp, 'concat.txt')
    await fsp.writeFile(list, parts.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'))
    const mixed = path.join(temp, 'mix.wav')
    const mix = await mixAudio({ timeline, project, projectDir, language, duration, ffmpegPath, outFile: mixed, signal })
    const normalized = path.join(temp, 'mix-norm.wav')
    const loudness = await normalizeLoudness({ input: mixed, target: preset.audioLufs, ffmpegPath, outFile: normalized, signal })
    onProgress({ phase: 'audio', done: segments.length + 1, total })

    const cues = captionCues(timeline, language, duration)
    let captionsPath = null
    const videoFilters = []
    if (cues.length && preset.captionPolicy === 'burn') {
      const srt = path.join(temp, 'captions.srt')
      await fsp.writeFile(srt, toSrt(cues))
      videoFilters.push(`subtitles='${escapeFilterPath(srt)}':force_style='${burnStyle(preset.aspect, preset.height)}'`)
    } else if (cues.length && preset.captionPolicy === 'sidecar') {
      captionsPath = outputPath.replace(/\.mp4$/i, '.vtt')
      await fsp.writeFile(captionsPath, toVtt(cues))
    }
    const temporary = `${outputPath}.partial.mp4`
    await runFfmpeg(ffmpegPath, [
      '-hide_banner', '-nostdin', '-y', '-v', 'error',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-i', normalized,
      ...(videoFilters.length ? ['-vf', videoFilters.join(',')] : []),
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'medium', '-b:v', `${preset.bitrate}k`, '-maxrate', `${Math.round(preset.bitrate * 1.5)}k`, '-bufsize', `${preset.bitrate * 2}k`,
      '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(Math.round(fps * 2)),
      '-c:a', 'aac', '-b:a', `${preset.audioBitrate}k`, '-ar', '48000', '-ac', '2',
      '-t', String(duration), '-movflags', '+faststart', temporary,
    ], { signal })
    await fsp.rename(temporary, outputPath)
    onProgress({ phase: 'encode', done: segments.length + 2, total })

    const thumbnailPath = outputPath.replace(/\.mp4$/i, '.jpg')
    await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-ss', String(Math.min(1, duration / 2)), '-i', outputPath, '-frames:v', '1', '-vf', `scale='min(1280,iw)':-2`, '-q:v', '3', thumbnailPath], { signal })
    onProgress({ phase: 'done', done: total, total })
    return { outputPath, durationSeconds: duration, captionsPath, thumbnailPath, audioClips: mix.clips, sourceLufs: loudness.measuredLufs, captionCues: cues.length }
  } finally {
    if (!workDir) await fsp.rm(temp, { recursive: true, force: true })
  }
}

module.exports = { renderDelivery, pictureSegments, programDuration, propertyAt, propertyExpression, captionCues, toVtt, audioClipsFor, runFfmpeg }
