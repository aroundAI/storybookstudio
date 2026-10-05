// FILM-2014: FFmpeg argument and filter-graph builders for the preview tiers.
// Pure: they take the render plan (renderPlan.js) and return argv arrays and
// filtergraph strings; electron/studio/previewRender.js runs them. No user
// text enters a filter expression: captions reach drawtext through textfile=.
import { cueRect } from './captionLayout.js'
import { EPS, round3 } from './renderPlan.js'

export const SAMPLE_RATE = 48000
const sec = (value) => round3(Math.max(0, value)).toString()
const even = (value) => Math.max(2, Math.round(value / 2) * 2)
// FFmpeg filter option values: escape the characters the graph parser splits on.
export const escapeFilterValue = (value) => String(value).replace(/\\/g, '/').replace(/([:',;\[\]=])/g, '\\$1')

export function frameSize(frame, { width = null, shortSide = null } = {}) {
  const ratio = frame.width / frame.height
  if (width) return { width: even(width), height: even(width / ratio) }
  if (shortSide) return ratio >= 1 ? { width: even(shortSide * ratio), height: even(shortSide) } : { width: even(shortSide), height: even(shortSide / ratio) }
  return { width: even(frame.width), height: even(frame.height) }
}

const fitFilter = ({ width, height }) =>
  `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`

// One JPEG for one keyframe. A gap or offline media is a black frame, so the
// set always has one image per keyframe time.
export function keyframeArgs(segment, time, outFile, size, { drawtext = null } = {}) {
  const filters = []
  let input
  if (segment?.file && (segment.kind === 'video' || segment.kind === 'image')) {
    const seek = segment.kind === 'video' ? segment.sourceStart + (time - segment.start) * (segment.speed || 1) : 0
    input = segment.kind === 'video' ? ['-ss', sec(seek), '-i', segment.file] : ['-i', segment.file]
    filters.push(fitFilter(size))
  } else {
    const color = segment?.kind === 'solid' && /^#[0-9a-f]{6}$/i.test(segment.color || '') ? `0x${segment.color.slice(1)}` : 'black'
    input = ['-f', 'lavfi', '-i', `color=c=${color}:s=${size.width}x${size.height}:d=0.1`]
  }
  if (drawtext) filters.push(drawtext)
  return [...input, '-frames:v', '1', '-vf', filters.join(',') || 'null', '-q:v', '4', '-y', outFile]
}

// drawtext filters for the cues active in [from, to), positioned by
// captionLayout on a `size` frame; `textFileFor(cue)` gives the file holding
// each cue's wrapped text. `timeOffset` shifts cue times into the output's
// clock (a range starting at 30 s draws a 31 s cue at 1 s).
export function captionDrawtextFilters(cues, size, { fontFile, textFileFor, from = 0, to = Infinity, timeOffset = 0, enableByTime = true } = {}) {
  if (!fontFile) return []
  return cues
    .filter((entry) => entry.end > from + EPS && entry.start < to - EPS)
    .map((entry) => {
      const rect = cueRect(entry.cue, entry.clip, size)
      const lineHeight = Math.round(rect.fontSize * (rect.traditional ? 1.3 : 1.15))
      const parts = [
        `fontfile='${escapeFilterValue(fontFile)}'`,
        `textfile='${escapeFilterValue(textFileFor(entry))}'`,
        `fontsize=${rect.fontSize}`,
        'fontcolor=white',
        `line_spacing=${Math.max(0, lineHeight - rect.fontSize)}`,
        'box=1',
        'boxcolor=black@0.6',
        `boxborderw=${Math.max(2, Math.round(rect.fontSize * 0.3))}`,
        `x=${Math.max(0, rect.px.x + Math.round(rect.fontSize * 0.3))}`,
        `y=${Math.max(0, rect.px.y + Math.round(rect.fontSize * 0.3))}`,
      ]
      if (enableByTime) parts.push(`enable='between(t\\,${sec(entry.start - timeOffset)}\\,${sec(entry.end - timeOffset)})'`)
      return `drawtext=${parts.join(':')}`
    })
}

// The video of [from, to) as one concat graph: each segment trimmed from its
// source, fitted to `size`, at `fps`; gaps and offline media are black.
export function sceneVideoGraph(segments, { from, to, size, fps }) {
  const inputs = []
  const chains = []
  const labels = []
  for (const segment of segments) {
    const start = Math.max(segment.start, from)
    const end = Math.min(segment.end, to)
    if (end - start <= EPS) continue
    const duration = end - start
    const label = `v${labels.length}`
    if (segment.file && segment.kind === 'video') {
      const speed = segment.speed || 1
      const seek = segment.sourceStart + (start - segment.start) * speed
      inputs.push(['-ss', sec(seek), '-t', sec(duration * speed + 0.1), '-i', segment.file])
      const index = inputs.length - 1
      const retime = Math.abs(speed - 1) > EPS ? `setpts=(PTS-STARTPTS)/${speed}` : 'setpts=PTS-STARTPTS'
      chains.push(`[${index}:v]${retime},${fitFilter(size)},fps=${fps},trim=duration=${sec(duration)},setpts=PTS-STARTPTS,format=yuv420p[${label}]`)
    } else if (segment.file && segment.kind === 'image') {
      inputs.push(['-loop', '1', '-t', sec(duration + 0.1), '-i', segment.file])
      chains.push(`[${inputs.length - 1}:v]${fitFilter(size)},fps=${fps},trim=duration=${sec(duration)},setpts=PTS-STARTPTS,format=yuv420p[${label}]`)
    } else {
      const color = segment.kind === 'solid' && /^#[0-9a-f]{6}$/i.test(segment.color || '') ? `0x${segment.color.slice(1)}` : 'black'
      chains.push(`color=c=${color}:s=${size.width}x${size.height}:r=${fps}:d=${sec(duration)},format=yuv420p,setsar=1[${label}]`)
    }
    labels.push(label)
  }
  if (labels.length === 0) {
    chains.push(`color=c=black:s=${size.width}x${size.height}:r=${fps}:d=${sec(to - from)},format=yuv420p,setsar=1[v0]`)
    labels.push('v0')
  }
  chains.push(`${labels.map((l) => `[${l}]`).join('')}concat=n=${labels.length}:v=1:a=0[vout]`)
  return { inputs, filter: chains.join(';'), out: 'vout' }
}

const dbFilter = (db) => (Number.isFinite(db) && Math.abs(db) > 1e-3 ? `volume=${round3(db)}dB` : null)

// One clip's chain, from its whole source file to its place in [from, to):
// trim to the used span, retime, clip and track gain, the clip's own fades,
// delay to its start. Null when the clip does not sound inside the range.
// The same chain feeds both mixes below.
export function clipFilters(clip, { from, to }) {
  if (!clip.file || clip.hasAudio === false) return null
  const start = Math.max(clip.start, from)
  const end = Math.min(clip.start + clip.duration, to)
  if (end - start <= EPS) return null
  const speed = clip.speed || 1
  const seek = clip.sourceStart + (start - clip.start) * speed
  const filters = [`atrim=start=${sec(seek)}:duration=${sec((end - start) * speed + 0.05)}`, 'asetpts=PTS-STARTPTS', `aresample=${SAMPLE_RATE}`, 'aformat=sample_fmts=fltp:channel_layouts=stereo']
  if (Math.abs(speed - 1) > EPS && speed >= 0.5 && speed <= 2) filters.push(`atempo=${speed}`)
  filters.push(`atrim=duration=${sec(end - start)}`)
  const gain = dbFilter(clip.gainDb + (Number.isFinite(clip.trackGainDb) ? clip.trackGainDb : -120))
  if (gain) filters.push(gain)
  // Fades belong to the clip's own edges; a range that starts inside a clip
  // keeps its fade-out and drops the fade-in it began after.
  if (clip.fadeIn > EPS && start - clip.start < EPS) filters.push(`afade=t=in:st=0:d=${sec(clip.fadeIn)}`)
  if (clip.fadeOut > EPS && clip.start + clip.duration - clip.fadeOut < end) {
    filters.push(`afade=t=out:st=${sec(clip.start + clip.duration - clip.fadeOut - start)}:d=${sec(clip.fadeOut)}`)
  }
  const delayMs = Math.round((start - from) * 1000)
  if (delayMs > 0) filters.push(`adelay=${delayMs}|${delayMs}`)
  return filters
}

// The mix of [from, to) for a project with no audio buses (a plain the upstream editor
// project): clips summed per bus label for stems, then the master gain and
// the master limiter insert. A Studio project mixes through FILM-2016's bus
// graph instead (electron/studio/audioBusMix.mjs, the export's own), so
// ducking and loudness normalisation have one implementation.
export function audioMixGraph(clips, { from, to, masterGainDb = 0, limiter = null, stems = false, inputOffset = 0 }) {
  const duration = to - from
  const inputs = []
  const chains = []
  const byBus = new Map()
  for (const clip of clips) {
    const filters = clipFilters(clip, { from, to })
    if (!filters) continue
    inputs.push(['-i', clip.file])
    const index = inputOffset + inputs.length - 1
    const label = `a${inputs.length - 1}`
    chains.push(`[${index}:a]${filters.join(',')}[${label}]`)
    if (!byBus.has(clip.bus)) byBus.set(clip.bus, [])
    byBus.get(clip.bus).push(label)
  }
  const busLabels = []
  for (const [bus, labels] of byBus) {
    const busLabel = `bus_${bus}`
    chains.push(`${labels.map((l) => `[${l}]`).join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,apad,atrim=duration=${sec(duration)}[${busLabel}]`)
    busLabels.push({ bus, label: busLabel })
  }
  chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=duration=${sec(duration)}[silence]`)
  const outputs = []
  const mixInputs = ['silence']
  for (const { bus, label } of busLabels) {
    if (stems) {
      chains.push(`[${label}]asplit=2[${label}_m][${label}_s]`)
      mixInputs.push(`${label}_m`)
      outputs.push({ bus, label: `${label}_s` })
    } else mixInputs.push(label)
  }
  const master = [`${mixInputs.map((l) => `[${l}]`).join('')}amix=inputs=${mixInputs.length}:normalize=0:dropout_transition=0`, `atrim=duration=${sec(duration)}`]
  const masterGain = dbFilter(masterGainDb)
  if (masterGain) master.push(masterGain)
  if (limiter) master.push(`alimiter=limit=${round3(10 ** (limiter.ceilingDb / 20))}:level=disabled`)
  chains.push(`${master.join(',')}[mix]`)
  return { inputs, filter: chains.join(';'), out: 'mix', stems: outputs }
}
