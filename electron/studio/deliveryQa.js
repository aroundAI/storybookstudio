// FILM-2017: the QA a delivered file gets before it is uploaded, in the
// contract's QaResult shape ({pass, issues[]}, contracts/qa-result.schema.mjs).
//
// Inline checks, used until FILM-2014's qa.js lands (deliver.js takes `qa`
// as an argument): ffprobe for codec, frame and duration; FFmpeg's ebur128
// for integrated loudness and true peak against the preset's target; the
// file size against StoryBook's 500 MB limit; plus the reframe warnings the
// variant timeline carries. A file passes when no issue reaches severity 0.5.
const fs = require('fs')
const { runFfmpeg } = require('./deliveryRender')
const { createProbe } = require('./probe')

const LOUDNESS_TOLERANCE_LU = 1
const TRUE_PEAK_MAX_DBTP = -1
const DURATION_TOLERANCE = 0.05
const MAX_RENDER_BYTES = 500 * 1024 * 1024
const FAIL_SEVERITY = 0.5

async function measureLoudness(file, ffmpegPath) {
  const { stderr } = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'info', '-i', file, '-map', '0:a:0', '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'])
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'))
  const integrated = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary)?.[1]
  const peak = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary)?.[1]
  const value = (text) => (text == null || text === '-inf' ? null : Number(text))
  return { integratedLufs: value(integrated), truePeakDbtp: value(peak) }
}

const issue = (type, severity, detail, extra = {}) => ({ type, severity, timeRange: null, scene: null, detail: String(detail).slice(0, 2000), ...extra })

// preset: the resolved preset (width, height, audioLufs, maxDuration, name).
// expectedDuration: the timeline's program length. warnings: QaIssue-shaped
// entries carried by the timeline (reframe).
async function checkDeliveredFile({ file, preset, expectedDuration = null, warnings = [], ffmpegPath, ffprobePath }) {
  const issues = []
  const bytes = fs.statSync(file).size
  const probed = await createProbe(ffprobePath)(file)
  const loudness = probed.hasAudio ? await measureLoudness(file, ffmpegPath) : { integratedLufs: null, truePeakDbtp: null }
  const probe = { durationSeconds: probed.duration, videoCodec: probed.videoCodec, audioCodec: probed.audioCodec, width: probed.width, height: probed.height, fps: probed.fps, bytes, ...loudness }

  if (probed.videoCodec !== preset.codec) issues.push(issue('codec', 1, `Video is ${probed.videoCodec || 'missing'}, the preset needs ${preset.codec}.`))
  if (!probed.hasAudio) issues.push(issue('audio_missing', 1, 'The file has no audio stream.'))
  else if (probed.audioCodec !== preset.audioCodec) issues.push(issue('codec', 1, `Audio is ${probed.audioCodec}, the preset needs ${preset.audioCodec}.`))
  if (probed.width !== preset.width || probed.height !== preset.height) issues.push(issue('resolution', 1, `Frame is ${probed.width}x${probed.height}, the preset is ${preset.width}x${preset.height}.`))
  if (Number.isFinite(expectedDuration) && probed.duration != null) {
    const off = Math.abs(probed.duration - expectedDuration)
    if (off > Math.max(0.5, expectedDuration * DURATION_TOLERANCE)) issues.push(issue('duration', 0.8, `File runs ${probed.duration.toFixed(2)} s; the timeline is ${expectedDuration.toFixed(2)} s.`))
  }
  if (preset.maxDuration != null && probed.duration > preset.maxDuration) issues.push(issue('max_duration', 0.8, `${probed.duration.toFixed(1)} s is over ${preset.name}'s ${preset.maxDuration} s limit.`, { repairIntent: 're-time' }))
  if (bytes > MAX_RENDER_BYTES) issues.push(issue('file_size', 1, `${(bytes / 1048576).toFixed(0)} MB is over StoryBook's 500 MB render limit.`))
  if (probed.hasAudio) {
    if (loudness.integratedLufs == null) {
      issues.push(issue('loudness', 0.6, 'The audio is silent.', { repairIntent: 'normalize_loudness' }))
    } else if (Math.abs(loudness.integratedLufs - preset.audioLufs) > LOUDNESS_TOLERANCE_LU) {
      issues.push(issue('loudness', 0.6, `Integrated loudness ${loudness.integratedLufs} LUFS; ${preset.name} targets ${preset.audioLufs} ±${LOUDNESS_TOLERANCE_LU} LU.`, { repairIntent: 'normalize_loudness' }))
    }
    if (loudness.truePeakDbtp != null && loudness.truePeakDbtp > TRUE_PEAK_MAX_DBTP) {
      issues.push(issue('true_peak', 0.4, `True peak ${loudness.truePeakDbtp} dBTP is above ${TRUE_PEAK_MAX_DBTP} dBTP; platforms may clip it.`, { repairIntent: 'normalize_loudness' }))
    }
  }
  for (const warning of warnings) issues.push({ ...warning })
  return { qa: { pass: issues.every((entry) => entry.severity < FAIL_SEVERITY), issues }, probe, checker: 'inline (FILM-2017; FILM-2014 qa.js pending)' }
}

// One QaResult for a whole delivery: pass when every file passes.
const combineQa = (results) => ({ pass: results.every((result) => result.pass), issues: results.flatMap((result) => result.issues).slice(0, 500) })

module.exports = { checkDeliveredFile, measureLoudness, combineQa, LOUDNESS_TOLERANCE_LU, FAIL_SEVERITY }
