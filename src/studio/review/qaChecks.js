// FILM-2014 V1: the deterministic QA checks, as pure functions. electron/
// studio/qa.js runs FFmpeg and ffprobe and hands their logs here; the checks
// on the document (captions, media health, script coverage) read the project
// directly. Every threshold comes from the render targets (presetTargets.js:
// preset + policy) or from QA_DEFAULTS below, never from a model, so the same
// render always gives the same result. Each issue a repair can fix names its
// repairIntent (REPAIR_INTENTS, FILM-2003's contract).
import { QaResultSchema } from '../contracts/qa-result.schema.mjs'
import { checkCaptionSafeArea } from '../captions/style.js'
import { activeTimeline, captionCues, isAbsolutePath, joinPath, pictureClips, pictureSegments, programDuration, round3, sceneOfRange, timelineFrame, trackMap } from './renderPlan.js'

export const QA_DEFAULTS = Object.freeze({
  blackMinSeconds: 0.5,
  blackPixelThreshold: 0.1,
  freezeMinSeconds: 2,
  freezeNoiseDb: -60,
  silenceNoiseDb: -50,
  // EditPolicySchema (FILM-2004) has no silence bound yet; a policy that
  // carries `maxSilenceSeconds` wins over this.
  maxSilenceSeconds: 1.5,
  clipPeakDbfs: -0.1,
  clipFlatFactor: 1,
  clipOverDbfs: 0.5,
  clipWindowSamples: 4800,
  sampleRate: 48000,
})

// An issue at or above this severity fails the render; below it is advice.
export const FAIL_SEVERITY = 0.5

const clamp01 = (value) => Math.max(0, Math.min(1, value))
const sev = (value) => Math.round(clamp01(value) * 100) / 100
const fmt = (seconds) => `${Number(seconds).toFixed(1)} s`
const range = (start, end) => ({ start: round3(Math.max(0, start)), end: round3(Math.max(start, end)) })

export function issue({ type, severity, timeRange = null, scene = null, detail, repairIntent }) {
  const out = { type, severity: sev(severity), timeRange, scene: Number.isInteger(scene) && scene > 0 ? scene : null, detail: String(detail).slice(0, 2000) }
  if (repairIntent) out.repairIntent = repairIntent
  return out
}

// ---------- log parsers ----------

// The last ebur128 summary block (FFmpeg can print one per graph init).
export function parseEbur128(log) {
  const blocks = String(log || '').split(/Summary:/).slice(1)
  const last = blocks.at(-1)
  if (!last) return null
  const read = (re) => {
    const match = re.exec(last)
    if (!match) return null
    return match[1] === '-inf' ? -Infinity : Number(match[1])
  }
  return {
    integratedLufs: read(/I:\s+(-?inf|-?[\d.]+) LUFS/),
    loudnessRangeLu: read(/LRA:\s+(-?inf|-?[\d.]+) LU/),
    truePeakDbtp: read(/Peak:\s+(-?inf|-?[\d.]+) dBFS/),
  }
}

function spans(log, startKey, endKey) {
  const out = []
  let open = null
  const re = new RegExp(`(${startKey}|${endKey})[:=]\\s*(-?[\\d.]+)`, 'g')
  for (const match of String(log || '').matchAll(re)) {
    const value = Number(match[2])
    if (match[1] === startKey) open = value
    else if (open !== null) {
      out.push(range(open, value))
      open = null
    }
  }
  return { spans: out, open }
}

// silencedetect / freezedetect leave the last span open when the file ends
// inside it; `duration` closes it.
export function parseSilences(log, duration = null) {
  const { spans: out, open } = spans(log, 'silence_start', 'silence_end')
  if (open !== null && duration) out.push(range(open, duration))
  return out
}

export function parseFreezes(log, duration = null) {
  const { spans: out, open } = spans(log, 'lavfi.freezedetect.freeze_start', 'lavfi.freezedetect.freeze_end')
  if (open !== null && duration) out.push(range(open, duration))
  return out
}

export function parseBlack(log) {
  return [...String(log || '').matchAll(/black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)/g)].map((m) => range(Number(m[1]), Number(m[2])))
}

// ametadata print output of per-window astats.
export function parseAstatsWindows(text) {
  const windows = []
  let current = null
  for (const line of String(text || '').split(/\r?\n/)) {
    const frame = /pts_time:\s*(-?[\d.]+)/.exec(line)
    if (frame) {
      current = { time: Number(frame[1]), peakDb: null, flat: 0, peakCount: 0 }
      windows.push(current)
      continue
    }
    const kv = /lavfi\.astats\.Overall\.(\w+)=(-?inf|-?[\d.]+)/.exec(line)
    if (!kv || !current) continue
    const value = kv[2] === '-inf' ? -Infinity : Number(kv[2])
    if (kv[1] === 'Peak_level') current.peakDb = value
    if (kv[1] === 'Flat_factor') current.flat = value
    if (kv[1] === 'Peak_count') current.peakCount = value
  }
  return windows
}

export function mergeRanges(ranges, gap = 0) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out = []
  for (const r of sorted) {
    const last = out.at(-1)
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out.map((r) => range(r.start, r.end))
}

// A window clips when its peak sits at full scale with a flat top (several
// consecutive samples at the peak), which a clean full-scale wave never has;
// or, in a lossy (AAC) file, when the decoded peak overshoots full scale by
// more than `overDbfs`: the encoder's ringing around flattened tops.
export function clippedRanges(windows, { windowSeconds = QA_DEFAULTS.clipWindowSamples / QA_DEFAULTS.sampleRate, peakDbfs = QA_DEFAULTS.clipPeakDbfs, flatFactor = QA_DEFAULTS.clipFlatFactor, overDbfs = QA_DEFAULTS.clipOverDbfs } = {}) {
  const hits = windows
    .filter((w) => w.peakDb !== null && ((w.peakDb >= peakDbfs && w.flat > flatFactor) || w.peakDb > overDbfs))
    .map((w) => range(w.time, w.time + windowSeconds))
  return mergeRanges(hits, windowSeconds)
}

// ---------- context ----------

// What maps a time in the rendered file back to the document: the render's
// start on the timeline (a range render starts later) and the project.
export function makeContext({ project = null, timelineId = null, timeOffset = 0, projectDir = null } = {}) {
  return {
    project,
    timelineId,
    projectDir,
    timeOffset,
    sceneFor: (start, end) => (project ? sceneOfRange(project, start + timeOffset, end + timeOffset, { timelineId }) : null),
    toTimeline: (r) => range(r.start + timeOffset, r.end + timeOffset),
  }
}

// ---------- render checks ----------

export function loudnessIssues(stats, targets) {
  const issues = []
  if (!stats) return [issue({ type: 'loudness', severity: 0.6, detail: 'The loudness meter produced no reading; the render may have no audio stream.' })]
  const { integratedLufs, truePeakDbtp } = stats
  if (integratedLufs === -Infinity || integratedLufs === null || integratedLufs <= -69) {
    issues.push(issue({ type: 'loudness', severity: 0.9, detail: `The render is silent (integrated loudness ${integratedLufs === null ? 'unknown' : '-70 LUFS or lower'}).` }))
    return issues
  }
  const off = integratedLufs - targets.loudnessLufs
  if (Math.abs(off) > targets.loudnessToleranceLu) {
    issues.push(issue({
      type: 'loudness',
      severity: 0.5 + 0.1 * (Math.abs(off) - targets.loudnessToleranceLu),
      detail: `Integrated loudness is ${integratedLufs.toFixed(1)} LUFS; the ${targets.preset || 'policy'} target is ${targets.loudnessLufs} LUFS (±${targets.loudnessToleranceLu} LU), ${Math.abs(off).toFixed(1)} LU ${off > 0 ? 'too loud' : 'too quiet'}.`,
      repairIntent: 'normalize_loudness',
    }))
  }
  if (Number.isFinite(truePeakDbtp) && truePeakDbtp > targets.truePeakMaxDbtp) {
    issues.push(issue({
      type: 'true_peak',
      severity: 0.6 + 0.1 * (truePeakDbtp - targets.truePeakMaxDbtp),
      detail: `True peak is ${truePeakDbtp.toFixed(1)} dBTP, above the ${targets.truePeakMaxDbtp} dBTP ceiling; it will clip after the platform's encode.`,
      repairIntent: 'normalize_loudness',
    }))
  }
  return issues
}

export function clippingIssues(ranges, ctx) {
  return ranges.map((r) => {
    const t = ctx.toTimeline(r)
    return issue({
      type: 'clipping',
      severity: 0.7 + Math.min(0.3, (r.end - r.start) / 10),
      timeRange: t,
      scene: ctx.sceneFor(r.start, r.end),
      detail: `The mix clips (flat-topped samples at full scale) for ${fmt(r.end - r.start)} from ${fmt(t.start)}.`,
      repairIntent: 'normalize_loudness',
    })
  })
}

// Black frames: from a gap in the cut (close it), offline media (relink), or
// the footage itself (no edit fixes that: a card for the user).
export function blackIssues(ranges, ctx, { minSeconds = QA_DEFAULTS.blackMinSeconds } = {}) {
  const segments = ctx.project ? pictureSegments(ctx.project, { timelineId: ctx.timelineId, projectDir: ctx.projectDir }) : []
  return ranges.filter((r) => r.end - r.start >= minSeconds).map((r) => {
    const t = ctx.toTimeline(r)
    const under = segments.filter((s) => s.end > t.start + 0.01 && s.start < t.end - 0.01)
    const cause = under.some((s) => s.kind === 'gap') ? 'gap' : under.some((s) => s.offline) ? 'offline' : 'footage'
    return issue({
      type: 'black_frames',
      severity: (r.end - r.start >= 1 ? 0.7 : 0.5),
      timeRange: t,
      scene: ctx.sceneFor(r.start, r.end),
      detail: `${fmt(r.end - r.start)} of black from ${fmt(t.start)}${cause === 'gap' ? ': nothing is on the picture track there' : cause === 'offline' ? ': the clip there has no media' : ': the footage itself is black'}.`,
      repairIntent: cause === 'gap' ? 're-time' : cause === 'offline' ? 'replace_missing_media' : undefined,
    })
  })
}

export function freezeIssues(ranges, blackRanges, ctx, { minSeconds = QA_DEFAULTS.freezeMinSeconds } = {}) {
  const insideBlack = (r) => blackRanges.some((b) => r.start >= b.start - 0.1 && r.end <= b.end + 0.1)
  return ranges.filter((r) => r.end - r.start >= minSeconds && !insideBlack(r)).map((r) => {
    const t = ctx.toTimeline(r)
    return issue({
      type: 'frozen_frames',
      severity: 0.5 + Math.min(0.3, (r.end - r.start - minSeconds) / 10),
      timeRange: t,
      scene: ctx.sceneFor(r.start, r.end),
      detail: `The picture does not change for ${fmt(r.end - r.start)} from ${fmt(t.start)}.`,
      repairIntent: 're-time',
    })
  })
}

export function maxSilenceFor(policy) {
  return Number.isFinite(policy?.maxSilenceSeconds) ? policy.maxSilenceSeconds : QA_DEFAULTS.maxSilenceSeconds
}

export function silenceIssues(ranges, ctx, { maxSeconds = QA_DEFAULTS.maxSilenceSeconds } = {}) {
  return ranges.filter((r) => r.end - r.start > maxSeconds).map((r) => {
    const t = ctx.toTimeline(r)
    return issue({
      type: 'silence',
      severity: 0.5 + Math.min(0.4, (r.end - r.start - maxSeconds) / 5),
      timeRange: t,
      scene: ctx.sceneFor(r.start, r.end),
      detail: `${fmt(r.end - r.start)} of silence from ${fmt(t.start)}; the limit is ${fmt(maxSeconds)}.`,
      repairIntent: 'trim_silence',
    })
  })
}

// ffprobe against the targets: duration against policy, then the format.
export function probeIssues(probe, targets, { expectedDuration = null } = {}) {
  const issues = []
  if (!probe) return [issue({ type: 'unreadable', severity: 1, detail: 'ffprobe could not read the render.' })]
  if (Number.isFinite(targets.targetDurationSeconds) && targets.targetDurationSeconds > 0) {
    const off = (probe.duration - targets.targetDurationSeconds) / targets.targetDurationSeconds
    if (Math.abs(off) > targets.durationTolerance) {
      issues.push(issue({
        type: 'duration',
        severity: 0.5 + Math.min(0.4, Math.abs(off) - targets.durationTolerance),
        detail: `The cut runs ${fmt(probe.duration)}; the policy target is ${fmt(targets.targetDurationSeconds)} (±${Math.round(targets.durationTolerance * 100)}%), ${Math.abs(off * 100).toFixed(0)}% ${off > 0 ? 'long' : 'short'}.`,
        repairIntent: 're-time',
      }))
    }
  }
  if (Number.isFinite(expectedDuration) && expectedDuration > 0 && Math.abs(probe.duration - expectedDuration) > Math.max(0.5, expectedDuration * 0.01)) {
    issues.push(issue({ type: 'render_duration', severity: 0.8, detail: `The file is ${fmt(probe.duration)} but the timeline is ${fmt(expectedDuration)}; the render was cut short or padded.` }))
  }
  if (!probe.video) issues.push(issue({ type: 'video_stream', severity: 1, detail: 'The render has no video stream.' }))
  else {
    if (targets.videoCodec && probe.video.codec !== targets.videoCodec) {
      issues.push(issue({ type: 'video_codec', severity: 0.9, detail: `Video codec is ${probe.video.codec}; ${targets.preset || 'the preset'} needs ${targets.videoCodec}.` }))
    }
    if (targets.width && targets.height && (probe.video.width !== targets.width || probe.video.height !== targets.height)) {
      issues.push(issue({ type: 'resolution', severity: 0.9, detail: `Frame is ${probe.video.width}x${probe.video.height}; ${targets.preset || 'the preset'} needs ${targets.width}x${targets.height}.` }))
    }
    if (Number.isFinite(targets.fps) && Number.isFinite(probe.video.fps) && Math.abs(probe.video.fps - targets.fps) > 0.05) {
      issues.push(issue({ type: 'frame_rate', severity: 0.8, detail: `Frame rate is ${probe.video.fps.toFixed(3)} fps; the target is ${targets.fps} fps.` }))
    }
  }
  if (!probe.audio) issues.push(issue({ type: 'audio_stream', severity: 0.9, detail: 'The render has no audio stream.' }))
  else if (targets.audioCodec && probe.audio.codec !== targets.audioCodec) {
    issues.push(issue({ type: 'audio_codec', severity: 0.7, detail: `Audio codec is ${probe.audio.codec}; ${targets.preset || 'the preset'} needs ${targets.audioCodec}.` }))
  }
  return issues
}

// ---------- document checks ----------

// Caption cues against the preset's safe rectangle and for overlaps:
// FILM-2016's checkCaptionSafeArea (captions/style.js), the same layout the
// renderer draws, against the same rectangle. A cue not styled for the
// aspect's safe area fails even where Velorn's default box happens to fit,
// because only a placed cue is guaranteed to stay there. One issue per
// captions clip, naming its cues: one move_caption fixes the clip.
export function captionIssues(project, { timelineId = null, targets } = {}) {
  const issues = []
  const timeline = activeTimeline(project, timelineId)
  const frame = timelineFrame(project, timelineId)
  const width = targets?.width || frame.width
  const height = targets?.height || frame.height
  const aspect = targets?.aspect || frame.aspect || null
  const tracks = trackMap(timeline)
  for (const clip of timeline?.clips || []) {
    if (clip.type !== 'captions' || clip.enabled === false || tracks.get(clip.trackId)?.visible === false) continue
    const offset = (clip.startTime || 0) - (clip.trimStart || 0)
    const cues = (clip.captions?.cues || []).map((cue) => ({ ...cue, start: round3(offset + (cue.start || 0)), end: round3(offset + (cue.end || 0)) }))
    const found = checkCaptionSafeArea({ cues, width, height, aspect })
    const outside = found.filter((entry) => entry.type === 'caption_safe_area')
    if (outside.length) {
      const start = Math.min(...outside.map((entry) => entry.timeRange.start))
      const end = Math.max(...outside.map((entry) => entry.timeRange.end))
      const unplaced = outside.filter((entry) => /not placed/.test(entry.detail)).length
      issues.push(issue({
        type: 'caption_safe_area',
        severity: Math.max(...outside.map((entry) => entry.severity)),
        timeRange: range(start, end),
        scene: sceneOfRange(project, start, end, { timelineId }),
        detail: `${outside.length} of ${cues.length} caption cues on ${clip.id} ${unplaced === outside.length ? 'are not placed for' : 'leave'} the ${aspect || 'frame'} safe area, where the platform draws its own controls (first: ${outside[0].detail}).`,
        repairIntent: 'move_caption',
      }))
    }
    for (const entry of found.filter((item) => item.type === 'caption_overlap')) {
      issues.push(issue({ ...entry, scene: sceneOfRange(project, entry.timeRange.start, entry.timeRange.end, { timelineId }), detail: `${entry.detail} on ${clip.id}; two captions are on screen at once.` }))
    }
  }
  return issues
}

function groupBy(list, key) {
  const map = new Map()
  for (const item of list) {
    const k = key(item)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(item)
  }
  return map
}

// check_media_health over the document: clips whose asset is offline, has no
// file, or is not in the project. `fileExists(absPath)` checks the disk.
export function mediaHealthIssues(project, { timelineId = null, projectDir = null, fileExists = () => true } = {}) {
  const timeline = activeTimeline(project, timelineId)
  const tracks = trackMap(timeline)
  const assets = new Map((project?.assets || []).map((asset) => [asset.id, asset]))
  const byAsset = new Map()
  for (const clip of timeline?.clips || []) {
    if (!clip.assetId || clip.enabled === false || tracks.get(clip.trackId)?.muted) continue
    const asset = assets.get(clip.assetId)
    let reason = null
    if (!asset) reason = 'not in the project'
    else if (asset.offline) reason = `offline (${asset.offline.reason || 'no file'})`
    else if (!asset.path) reason = 'has no file'
    else {
      const file = isAbsolutePath(asset.path) ? asset.path : projectDir ? joinPath(projectDir, asset.path) : null
      if (file && !fileExists(file)) reason = 'missing on disk'
    }
    if (!reason) continue
    if (!byAsset.has(clip.assetId)) byAsset.set(clip.assetId, { asset, reason, clips: [] })
    byAsset.get(clip.assetId).clips.push(clip)
  }
  return [...byAsset.entries()].map(([assetId, { asset, reason, clips }]) => {
    const start = Math.min(...clips.map((c) => c.startTime || 0))
    const end = Math.max(...clips.map((c) => (c.startTime || 0) + (c.duration || 0)))
    const picture = clips.some((c) => c.type === 'video' || c.type === 'image')
    return issue({
      type: 'missing_media',
      severity: picture ? 0.9 : 0.7,
      timeRange: range(start, end),
      scene: clips[0]?.metadata?.semantic?.scene ?? null,
      detail: `${asset?.name || assetId} is ${reason}; ${clips.length} clip${clips.length === 1 ? '' : 's'} (${clips.map((c) => c.id).slice(0, 5).join(', ')}) ${picture ? 'show black' : 'play nothing'} there.`,
      repairIntent: 'replace_missing_media',
    })
  })
}

// Every scene of the screenplay has a picture clip, and every dialogue line
// is on the timeline or was cut in the op log (a removal whose inverse holds
// the line's clip). `pkg` is storybook/package.json; null skips the check.
export function scriptCoverageIssues(project, pkg, opLog = [], { timelineId = null } = {}) {
  if (!pkg) return []
  const issues = []
  const timeline = activeTimeline(project, timelineId)
  const scenesOnTimeline = new Set(pictureClips(timeline).map((clip) => clip.metadata?.semantic?.scene).filter(Number.isInteger))
  for (const scene of pkg.scenes || []) {
    if (!scenesOnTimeline.has(scene.number)) {
      issues.push(issue({ type: 'scene_missing', severity: 0.8, scene: scene.number, detail: `Scene ${scene.number} (${scene.heading || 'untitled'}) has no clip on the timeline.` }))
    }
  }
  const placed = new Set((timeline?.clips || []).map((clip) => clip.metadata?.storybook?.dialogueId).filter(Boolean))
  const cutText = opLog.filter((entry) => entry && entry.inverse).map((entry) => JSON.stringify(entry.inverse)).join('\n')
  const language = timeline?.studio?.language ?? null
  for (const line of pkg.dialogue || []) {
    if (language && line.language && line.language !== language) continue
    if (placed.has(line.id)) continue
    if (cutText.includes(`"dialogueId":"${line.id}"`)) continue
    issues.push(issue({
      type: 'dialogue_missing',
      severity: 0.6,
      scene: line.sceneNumber ?? null,
      detail: `Dialogue line ${line.sequenceNumber ?? ''} (${line.characterName || 'unknown'}: "${String(line.text || '').slice(0, 60)}") is neither on the timeline nor cut in the op log.`.replace('line  (', 'line ('),
    }))
  }
  return issues
}

// ---------- result ----------

export function qaResult(issues) {
  const sorted = [...issues].sort((a, b) => b.severity - a.severity || (a.timeRange?.start ?? -1) - (b.timeRange?.start ?? -1))
  return QaResultSchema.parse({ pass: sorted.every((i) => i.severity < FAIL_SEVERITY), issues: sorted.slice(0, 500) })
}

export const timelineDuration = (project, timelineId = null) => programDuration(activeTimeline(project, timelineId))
