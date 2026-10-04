// FILM-2014: what QA holds a render to, per delivery preset. The preset names
// and aspects are FILM-2003's contract (contracts/render-presets.mjs); the
// loudness per preset is FILM-2016's (-14 LUFS YouTube/Shorts/TikTok, -16
// Reels, `master` follows the policy). A preset object from FILM-2017 that
// carries any of these fields wins over the defaults here.
import { RENDER_PRESETS } from '../contracts/render-presets.mjs'
import { loudnessTargetFor } from '../audio/buses.js'
import { safeAreaFor } from '../captions/layout.js'

// Loudness per preset and the caption safe areas have one source each,
// FILM-2016's: audio/buses.js (PRESET_LOUDNESS_LUFS, loudnessTargetFor) and
// captions/layout.js (SAFE_AREAS, margins kept clear on each side).
export { loudnessTargetFor }
// Integrated loudness may sit this far from target before QA flags it (the
// export's loudnorm pass lands within ±1 LU, FILM-2016).
export const LOUDNESS_TOLERANCE_LU = 1
// Platforms re-encode; a true peak above this clips after their AAC pass
// (the export mix stops lower, audioBusMix.mjs LOUDNORM_TRUE_PEAK_DB -2 dBTP,
// so the AAC encode's overshoot stays under this ceiling).
export const TRUE_PEAK_MAX_DBTP = -1
export const DURATION_TOLERANCE = 0.05

export const FRAME_FOR_ASPECT = Object.freeze({
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

export function aspectOf(width, height) {
  if (!width || !height) return null
  const r = width / height
  if (Math.abs(r - 16 / 9) < 0.02) return '16:9'
  if (Math.abs(r - 9 / 16) < 0.02) return '9:16'
  if (Math.abs(r - 1) < 0.02) return '1:1'
  return null
}

// The targets one render is checked against. `preset` is a preset name or a
// FILM-2017 preset object ({name, width, height, fps, videoCodec, audioCodec,
// audioLufs}); `frame` is the timeline's {width, height, fps, aspect}, used for
// `master` and for anything the preset leaves out.
export function targetsFor({ preset = null, policy = null, frame = null } = {}) {
  const name = typeof preset === 'string' ? preset : preset?.name ?? null
  const object = preset && typeof preset === 'object' ? preset : {}
  const aspect = (name && RENDER_PRESETS[name]?.aspect) || frame?.aspect || aspectOf(frame?.width, frame?.height) || '16:9'
  const size = finite(object.width) && finite(object.height)
    ? { width: object.width, height: object.height }
    : name && name !== 'master' ? FRAME_FOR_ASPECT[aspect] : { width: frame?.width ?? FRAME_FOR_ASPECT[aspect].width, height: frame?.height ?? FRAME_FOR_ASPECT[aspect].height }
  return {
    preset: name,
    aspect,
    width: size.width,
    height: size.height,
    fps: finite(object.fps) ? object.fps : frame?.fps ?? null,
    videoCodec: object.videoCodec || 'h264',
    audioCodec: object.audioCodec || 'aac',
    loudnessLufs: loudnessTargetFor({ preset, policy }),
    loudnessToleranceLu: finite(object.loudnessToleranceLu) ? object.loudnessToleranceLu : LOUDNESS_TOLERANCE_LU,
    truePeakMaxDbtp: finite(object.truePeakMaxDbtp) ? object.truePeakMaxDbtp : TRUE_PEAK_MAX_DBTP,
    targetDurationSeconds: finite(policy?.targetDurationSeconds) ? policy.targetDurationSeconds : null,
    durationTolerance: DURATION_TOLERANCE,
    // FILM-2016's margins kept clear on each side (captions/layout.js).
    safeArea: safeAreaFor(aspect),
  }
}
