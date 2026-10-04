// FILM-2014 AC8: the QA pass of the upstream editor's export regression runner
// (scripts/check-export-worker-scheduling.cjs → tests/fixtures/
// export-scheduler-electron.cjs). After a fixture render is encoded and
// decoded, the same deterministic QA as studio_review runs on it, so a
// regression that renders black frames, the wrong length or format, or (when
// the fixture carries audio) the wrong loudness or clipping fails CI.
//
// `allow` lists issue types the fixture produces on purpose (the scheduling
// fixture's picture is one still colour, so it is frozen by design).
const { createQa } = require('./qa')

async function runExportRegressionQa({ file, durationSeconds, width, height, fps, loudnessLufs = null, allow = [], ffmpegPath, ffprobePath } = {}) {
  const qa = createQa({ ffmpegPath, ffprobePath })
  const preset = { name: 'export-regression', width, height, fps, videoCodec: 'h264', audioCodec: 'aac', ...(Number.isFinite(loudnessLufs) ? { audioLufs: loudnessLufs } : {}) }
  const { qa: result, measurement } = await qa.runQa({ file, preset, policy: { targetDurationSeconds: durationSeconds }, documentChecks: false })
  // A video-only fixture has no audio to hold to a target.
  const expectsAudio = Number.isFinite(loudnessLufs)
  const blocking = result.issues.filter((issue) => !allow.includes(issue.type) && (expectsAudio || issue.type !== 'audio_stream') && issue.severity >= 0.5)
  return {
    pass: blocking.length === 0,
    blocking,
    issues: result.issues,
    measured: {
      durationSeconds: measurement.probe.duration,
      video: measurement.probe.video,
      integratedLufs: measurement.loudness?.integratedLufs ?? null,
      truePeakDbtp: measurement.loudness?.truePeakDbtp ?? null,
      black: measurement.black,
      clipped: measurement.clipped,
    },
  }
}

module.exports = { runExportRegressionQa }
