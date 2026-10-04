// FILM-2014 V1: deterministic QA of a render (and of the document behind it).
//
//   one FFmpeg pass   ebur128 (integrated loudness, true peak), per-window
//                     astats (clipping), silencedetect, blackdetect, freezedetect
//   ffprobe           duration against policy.targetDurationSeconds (±5%),
//                     codec, frame rate and resolution against the preset
//   the document      caption cues against the preset's safe rectangle and for
//                     overlaps, check_media_health (offline/missing media), and
//                     script coverage (every scene has a clip; every dialogue
//                     line is placed or was cut in the op log)
//
// Output is FILM-2003's QaResultSchema; every fixable issue names its
// studio_repair intent. Imports nothing from Electron; runs under `node --test`.
const fs = require('fs')
const { resolveBinaries, runFfmpeg, probe } = require('./ffmpegTools')

const loadChecks = () => import('../../src/studio/review/qaChecks.js')
const loadTargets = () => import('../../src/studio/review/presetTargets.js')
const loadPlan = () => import('../../src/studio/review/renderPlan.js')

// The FFmpeg arguments of the analysis pass. Audio and video run as two
// branches of one graph so the file is decoded once.
function analysisArgs(file, { hasVideo, hasAudio, thresholds }) {
  const chains = []
  const maps = []
  if (hasAudio) {
    chains.push(`[0:a]aresample=${thresholds.sampleRate},ebur128=peak=true:framelog=quiet,silencedetect=n=${thresholds.silenceNoiseDb}dB:d=${Math.min(0.5, thresholds.maxSilenceSeconds)},asetnsamples=n=${thresholds.clipWindowSamples},astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level+Flat_factor+Peak_count,ametadata=mode=print:file=-[aout]`)
    maps.push('-map', '[aout]')
  }
  if (hasVideo) {
    chains.push(`[0:v]blackdetect=d=${thresholds.blackMinSeconds}:pix_th=${thresholds.blackPixelThreshold},freezedetect=n=${thresholds.freezeNoiseDb}dB:d=${thresholds.freezeMinSeconds}[vout]`)
    maps.push('-map', '[vout]')
  }
  return ['-nostats', '-i', file, '-filter_complex', chains.join(';'), ...maps, '-f', 'null', '-']
}

function createQa(options = {}) {
  const { ffmpegPath, ffprobePath } = resolveBinaries(options)
  const fileExists = options.fileExists || ((file) => { try { return fs.statSync(file).isFile() } catch { return false } })

  // Measures a file: ffprobe plus the analysis pass, parsed. No verdicts.
  async function measure(file, { policy = null, signal } = {}) {
    const checks = await loadChecks()
    const info = await probe(ffprobePath, file, { signal })
    const thresholds = { ...checks.QA_DEFAULTS, maxSilenceSeconds: checks.maxSilenceFor(policy) }
    const started = Date.now()
    const result = await runFfmpeg(ffmpegPath, analysisArgs(file, { hasVideo: Boolean(info.video), hasAudio: Boolean(info.audio), thresholds }), { signal })
    if (result.code !== 0) {
      throw Object.assign(new Error(`QA analysis failed: ${result.stderr.trim().split('\n').slice(-3).join(' ')}`), { code: 'QA_FAILED' })
    }
    const log = result.stderr
    return {
      probe: info,
      thresholds,
      loudness: info.audio ? checks.parseEbur128(log) : null,
      clipped: info.audio ? checks.clippedRanges(checks.parseAstatsWindows(result.stdout), { windowSeconds: thresholds.clipWindowSamples / thresholds.sampleRate }) : [],
      silences: info.audio ? checks.parseSilences(log, info.duration) : [],
      black: info.video ? checks.parseBlack(log) : [],
      freezes: info.video ? checks.parseFreezes(log, info.duration) : [],
      ms: Date.now() - started,
    }
  }

  // Full QA. `file` is a render of the timeline (or of [timeOffset, …] of it);
  // without `file` only the document checks run. `preset` is a preset name or
  // FILM-2017 preset object; `pkg` is storybook/package.json; `opLog` the
  // parsed edits/oplog.jsonl.
  async function runQa({ file = null, project = null, projectDir = null, timelineId = null, policy = null, preset = null, pkg = null, opLog = [], timeOffset = 0, expectedDuration = null, documentChecks = true, formatChecks = true, signal } = {}) {
    const [checks, targetsModule, plan] = await Promise.all([loadChecks(), loadTargets(), loadPlan()])
    const frame = project ? plan.timelineFrame(project, timelineId) : null
    // policy.targetDurationSeconds null = the episode's own target (FILM-2004);
    // a render of part of the timeline is not held to the whole cut's length.
    const fullLength = project ? plan.programDuration(plan.activeTimeline(project, timelineId)) : null
    const partial = timeOffset > 0 || (Number.isFinite(expectedDuration) && Number.isFinite(fullLength) && expectedDuration < fullLength - 0.5)
    const targetDurationSeconds = partial ? null : policy?.targetDurationSeconds ?? pkg?.episode?.targetDurationSeconds ?? null
    const targets = targetsModule.targetsFor({ preset, policy: { ...(policy || {}), targetDurationSeconds }, frame })
    const ctx = checks.makeContext({ project, timelineId, timeOffset, projectDir })
    const issues = []
    let measurement = null
    if (file) {
      measurement = await measure(file, { policy, signal })
      issues.push(
        // A preview is checked for content, not delivery format: its size and
        // codec are the preview tier's, not the preset's.
        ...checks.probeIssues(measurement.probe, formatChecks ? targets : { ...targets, videoCodec: null, audioCodec: null, width: null, height: null, fps: null }, { expectedDuration }),
        ...(measurement.probe.audio ? checks.loudnessIssues(measurement.loudness, targets) : []),
        ...checks.clippingIssues(measurement.clipped, ctx),
        ...checks.silenceIssues(measurement.silences, ctx, { maxSeconds: measurement.thresholds.maxSilenceSeconds }),
        ...checks.blackIssues(measurement.black, ctx, { minSeconds: measurement.thresholds.blackMinSeconds }),
        ...checks.freezeIssues(measurement.freezes, measurement.black, ctx, { minSeconds: measurement.thresholds.freezeMinSeconds }),
      )
    }
    if (project && documentChecks) {
      issues.push(
        ...checks.captionIssues(project, { timelineId, targets }),
        ...checks.mediaHealthIssues(project, { timelineId, projectDir, fileExists }),
        ...checks.scriptCoverageIssues(project, pkg, opLog, { timelineId }),
      )
    }
    return { qa: checks.qaResult(issues), targets, measurement }
  }

  // Short-window RMS levels (dBFS) of one audio file, for the audio critic.
  async function measureLevels(file, { windowSeconds = 0.1, signal } = {}) {
    const samples = Math.round(48000 * windowSeconds)
    const result = await runFfmpeg(ffmpegPath, ['-nostats', '-i', file, '-vn', '-af', `aresample=48000,asetnsamples=n=${samples}:p=1,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=mode=print:file=-`, '-f', 'null', '-'], { signal })
    if (result.code !== 0) throw Object.assign(new Error(`Level measurement failed for ${file}.`), { code: 'QA_FAILED' })
    const levels = []
    for (const match of result.stdout.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?inf|-?[\d.]+)/g)) {
      levels.push(match[1] === '-inf' ? -Infinity : Number(match[1]))
    }
    return levels
  }

  // Levels of a mix and its stems as the audio critic reads them.
  async function measureMixLevels({ file, stems = {}, from = 0, windowSeconds = 0.1, signal } = {}) {
    const entries = await Promise.all(Object.entries(stems).map(async ([bus, stem]) => [bus, await measureLevels(stem, { windowSeconds, signal })]))
    return { windowSeconds, from, mix: file ? await measureLevels(file, { windowSeconds, signal }) : null, buses: Object.fromEntries(entries) }
  }

  return { runQa, measure, measureLevels, measureMixLevels, ffmpegPath, ffprobePath }
}

module.exports = { createQa, analysisArgs }
