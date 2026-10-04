// FILM-2014 V1 (AC2, AC3): every deterministic QA check on a known-bad and a
// known-good fixture made with FFmpeg, thresholds from preset and policy, and
// the output parsed by FILM-2003's QaResultSchema.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { QaResultSchema } from '../../src/studio/contracts/qa-result.schema.mjs'
import { REPAIR_INTENTS } from '../../src/studio/contracts/qa-result.schema.mjs'
import { FFMPEG, FFPROBE, removeDir, tempDir } from './helpers/review-media.mjs'
import { makeRender, miniProject } from './helpers/qa-fixtures.mjs'
import { styleCaptionCues } from '../../src/studio/captions/style.js'

const require = createRequire(import.meta.url)
const { createQa } = require('../../electron/studio/qa.js')
const { createPreviewRenderer } = require('../../electron/studio/previewRender.js')

const qa = createQa({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, fileExists: () => true })
const POLICY = { targetDurationSeconds: 10, loudnessTargetLufs: -14 }
let dir
const files = {}
const types = (result) => result.qa.issues.map((issue) => issue.type)
const only = (result, type) => result.qa.issues.filter((issue) => issue.type === type)

before(async () => {
  dir = await tempDir('qa')
  const make = (name, options) => makeRender(path.join(dir, `${name}.mp4`), options).then((file) => { files[name] = file })
  await Promise.all([
    make('good', {}),
    make('clipped', { clip: [3, 5] }),
    make('black', { black: [4, 6] }),
    make('frozen', { freeze: [2, 6] }),
    make('silent', { silence: [3, 6] }),
    make('quiet', { lufs: -24 }),
    make('long', { duration: 12 }),
    make('wrongFormat', { width: 1280, height: 720, fps: 30, vcodec: 'mpeg4' }),
    make('vertical', { width: 1080, height: 1920 }),
  ])
})
after(() => removeDir(dir))

test('a known-good render passes every render check and the result is a QaResult', async () => {
  const result = await qa.runQa({ file: files.good, preset: 'youtube_16x9', policy: POLICY })
  assert.deepEqual(result.qa, QaResultSchema.parse(result.qa))
  assert.equal(result.qa.pass, true, JSON.stringify(result.qa.issues))
  assert.deepEqual(result.qa.issues, [])
  assert.ok(Math.abs(result.measurement.loudness.integratedLufs - -14) <= 1, `measured ${result.measurement.loudness.integratedLufs} LUFS`)
})

test('ebur128: integrated loudness off the preset target fails with normalize_loudness; Reels holds -16, YouTube -14', async () => {
  const quiet = await qa.runQa({ file: files.quiet, preset: 'youtube_16x9', policy: POLICY })
  const [issue] = only(quiet, 'loudness')
  assert.equal(quiet.qa.pass, false)
  assert.equal(issue.repairIntent, 'normalize_loudness')
  assert.match(issue.detail, /-2[34]\.\d LUFS; the youtube_16x9 target is -14 LUFS/)
  // The same -14 LUFS file is 2 LU hot for Reels' -16 target.
  const reels = await qa.runQa({ file: files.vertical, preset: 'reels_9x16', policy: POLICY })
  assert.match(only(reels, 'loudness')[0].detail, /target is -16 LUFS/)
  const shorts = await qa.runQa({ file: files.vertical, preset: 'shorts_9x16', policy: POLICY })
  assert.deepEqual(only(shorts, 'loudness'), [])
})

test('astats: clipped audio fails with its time range; the clean render has none', async () => {
  const result = await qa.runQa({ file: files.clipped, preset: 'youtube_16x9', policy: POLICY })
  const clips = only(result, 'clipping')
  assert.ok(clips.length >= 1, types(result).join(','))
  assert.ok(clips[0].timeRange.start >= 2.8 && clips[0].timeRange.end <= 5.3, JSON.stringify(clips[0].timeRange))
  assert.equal(clips[0].repairIntent, 'normalize_loudness')
  assert.ok(only(result, 'true_peak').length === 1, 'the overload also breaks the true-peak ceiling')
  assert.equal(result.qa.pass, false)
})

test('blackdetect: 2 s of black fails; a black range under a gap in the cut names re-time', async () => {
  const result = await qa.runQa({ file: files.black, preset: 'youtube_16x9', policy: POLICY })
  const [black] = only(result, 'black_frames')
  assert.ok(Math.abs(black.timeRange.start - 4) < 0.1 && Math.abs(black.timeRange.end - 6) < 0.1, JSON.stringify(black.timeRange))
  assert.equal(black.severity >= 0.5, true)
  assert.equal(black.repairIntent, undefined, 'black footage itself has no mechanical fix')
  const project = miniProject({ shots: [{ start: 0, duration: 4 }, { start: 6, duration: 4 }] })
  const withGap = await qa.runQa({ file: files.black, project, preset: 'youtube_16x9', policy: POLICY, documentChecks: false })
  assert.equal(only(withGap, 'black_frames')[0].repairIntent, 're-time')
})

test('freezedetect: 4 s without a picture change fails; the moving render does not', async () => {
  const result = await qa.runQa({ file: files.frozen, preset: 'youtube_16x9', policy: POLICY })
  const [frozen] = only(result, 'frozen_frames')
  assert.ok(frozen, types(result).join(','))
  assert.ok(Math.abs(frozen.timeRange.start - 2) < 0.2 && frozen.timeRange.end - frozen.timeRange.start >= 3.5)
  const good = await qa.runQa({ file: files.good, preset: 'youtube_16x9', policy: POLICY })
  assert.deepEqual(only(good, 'frozen_frames'), [])
})

test('silencedetect: silence longer than the policy limit fails with trim_silence; a longer limit passes it', async () => {
  const result = await qa.runQa({ file: files.silent, preset: 'youtube_16x9', policy: POLICY })
  const [silence] = only(result, 'silence')
  assert.equal(silence.repairIntent, 'trim_silence')
  // The encoder's priming delay shifts the file by a few frames.
  assert.ok(Math.abs(silence.timeRange.start - 3) < 0.15 && Math.abs(silence.timeRange.end - 6) < 0.15, JSON.stringify(silence.timeRange))
  const relaxed = await qa.runQa({ file: files.silent, preset: 'youtube_16x9', policy: { ...POLICY, maxSilenceSeconds: 4 } })
  assert.deepEqual(only(relaxed, 'silence'), [])
})

test('ffprobe: duration within ±5% of policy.targetDurationSeconds passes, 20% over fails with re-time', async () => {
  const long = await qa.runQa({ file: files.long, preset: 'youtube_16x9', policy: POLICY })
  const [duration] = only(long, 'duration')
  assert.equal(duration.repairIntent, 're-time')
  assert.match(duration.detail, /12\.0 s; the policy target is 10\.0 s \(±5%\), 20% long/)
  const fine = await qa.runQa({ file: files.long, preset: 'youtube_16x9', policy: { ...POLICY, targetDurationSeconds: 12.4 } })
  assert.deepEqual(only(fine, 'duration'), [])
})

test('ffprobe: codec, frame rate and resolution are held to the preset', async () => {
  const project = miniProject({ shots: [{ start: 0, duration: 10 }] })
  const result = await qa.runQa({ file: files.wrongFormat, project, preset: 'youtube_16x9', policy: POLICY, documentChecks: false })
  assert.deepEqual(types(result).filter((t) => ['video_codec', 'resolution', 'frame_rate'].includes(t)).sort(), ['frame_rate', 'resolution', 'video_codec'])
  assert.match(only(result, 'resolution')[0].detail, /1280x720; youtube_16x9 needs 1920x1080/)
  const vertical = await qa.runQa({ file: files.good, preset: 'shorts_9x16', policy: POLICY })
  assert.match(only(vertical, 'resolution')[0].detail, /1920x1080; shorts_9x16 needs 1080x1920/)
})

test('captions: cues not placed for the 9:16 safe rectangle fail with move_caption, on a burned-in render; styled by FILM-2016 they pass', async () => {
  const cues = [
    { id: 'c1', start: 0.5, end: 3, text: 'A caption that sits where the platform draws its buttons' },
    { id: 'c2', start: 3.5, end: 6, text: 'And a second line of the same' },
  ]
  const shot = { start: 0, duration: 8, path: files.vertical }
  // The upstream editor's default subtitle box: bottom 6% of the frame, 88% wide.
  const bad = miniProject({ aspect: '9:16', shots: [shot], captions: { duration: 8, cues } })
  const render = await createPreviewRenderer({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE }).renderVideo({ project: bad, projectDir: dir, fullSize: true, output: path.join(dir, 'captions-bad.mp4') })
  const result = await qa.runQa({ file: render.file, project: bad, projectDir: dir, preset: 'shorts_9x16', policy: { ...POLICY, targetDurationSeconds: null } })
  const [safe] = only(result, 'caption_safe_area')
  assert.ok(safe, types(result).join(','))
  assert.equal(safe.repairIntent, 'move_caption')
  assert.match(safe.detail, /2 of 2 caption cues on clip-captions are not placed for the 9:16 safe area/)
  assert.equal(result.qa.pass, false)
  // Styled for the aspect (FILM-2016 captions/style.js), the same cues pass on 9:16 and 16:9.
  const styled = styleCaptionCues({ cues, aspect: '9:16' }).cues
  const fixed = await qa.runQa({ project: miniProject({ aspect: '9:16', shots: [shot], captions: { duration: 8, cues: styled } }), preset: 'shorts_9x16' })
  assert.deepEqual(only(fixed, 'caption_safe_area'), [])
  const wide = await qa.runQa({ project: miniProject({ shots: [shot], captions: { duration: 8, cues: styleCaptionCues({ cues, aspect: '16:9' }).cues } }), preset: 'youtube_16x9' })
  assert.deepEqual(only(wide, 'caption_safe_area'), [])
  // Cues placed for 16:9 but delivered as 9:16 leave the vertical safe area.
  const wrong = await qa.runQa({ project: miniProject({ aspect: '9:16', shots: [shot], captions: { duration: 8, cues: styleCaptionCues({ cues, aspect: '16:9' }).cues } }), preset: 'shorts_9x16' })
  assert.match(only(wrong, 'caption_safe_area')[0].detail, /leave the 9:16 safe area/)
})

test('captions: two cues on screen at once fail with re-time', async () => {
  const cues = [{ id: 'a', start: 0, end: 3, text: 'one' }, { id: 'b', start: 2.5, end: 4, text: 'two' }]
  const result = await qa.runQa({ project: miniProject({ shots: [{ start: 0, duration: 4 }], captions: { duration: 4, cues } }), preset: 'youtube_16x9' })
  const [overlap] = only(result, 'caption_overlap')
  assert.deepEqual(overlap.timeRange, { start: 2.5, end: 3 })
  assert.equal(overlap.repairIntent, 're-time')
  const apart = await qa.runQa({ project: miniProject({ shots: [{ start: 0, duration: 4 }], captions: { duration: 4, cues: [cues[0], { ...cues[1], start: 3 }] } }), preset: 'youtube_16x9' })
  assert.deepEqual(only(apart, 'caption_overlap'), [])
})

test('check_media_health: an offline asset and a file missing on disk fail with replace_missing_media', async () => {
  const project = miniProject({ shots: [{ start: 0, duration: 4 }, { start: 4, duration: 4, offline: true }, { start: 8, duration: 2, path: 'assets/video/gone.mp4' }] })
  const checker = createQa({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, fileExists: (file) => !file.endsWith('gone.mp4') })
  const result = await checker.runQa({ project, projectDir: dir })
  const missing = only(result, 'missing_media')
  assert.equal(missing.length, 2)
  assert.match(missing[0].detail, /offline \(not_generated\)|missing on disk/)
  assert.ok(missing.every((issue) => issue.repairIntent === 'replace_missing_media' && issue.severity >= 0.5))
  const healthy = await qa.runQa({ project: miniProject({ shots: [{ start: 0, duration: 4 }] }), projectDir: dir })
  assert.deepEqual(only(healthy, 'missing_media'), [])
})

test('script coverage: a scene with no clip and an unplaced line fail; a line cut in the op log does not', async () => {
  const pkg = {
    episode: { targetDurationSeconds: 8 },
    scenes: [{ number: 1, heading: 'INT. LAB' }, { number: 2, heading: 'EXT. ROOF' }],
    dialogue: [
      { id: 'line-1', sceneNumber: 1, sequenceNumber: 1, characterName: 'MAYA', text: 'On the timeline', language: 'en' },
      { id: 'line-2', sceneNumber: 1, sequenceNumber: 2, characterName: 'ARJUN', text: 'Cut by the editor', language: 'en' },
      { id: 'line-3', sceneNumber: 2, sequenceNumber: 3, characterName: 'MAYA', text: 'Never placed', language: 'en' },
    ],
  }
  const project = miniProject({ shots: [{ start: 0, duration: 4, scene: 1, dialogueId: 'line-1' }] })
  const cutLog = [{ op: 4, by: 'user', tool: 'delete_clips', args: { clipIds: ['clip-9'] }, inverse: { tool: 'studio_apply_patch', args: { patch: { item: { id: 'clip-9', metadata: { storybook: { dialogueId: 'line-2' } } } } } } }]
  const result = await qa.runQa({ project, pkg, opLog: cutLog })
  assert.deepEqual(only(result, 'scene_missing').map((i) => i.scene), [2])
  assert.deepEqual(only(result, 'dialogue_missing').map((i) => i.detail.match(/line (\d+)/)[1]), ['3'])
  const withoutLog = await qa.runQa({ project, pkg, opLog: [] })
  assert.deepEqual(only(withoutLog, 'dialogue_missing').map((i) => i.detail.match(/line (\d+)/)[1]), ['2', '3'])
})

test('every repairIntent QA emits is one of the contract REPAIR_INTENTS', async () => {
  const results = await Promise.all(['clipped', 'black', 'frozen', 'silent', 'quiet', 'long'].map((name) => qa.runQa({ file: files[name], preset: 'youtube_16x9', policy: POLICY })))
  const intents = new Set(results.flatMap((r) => r.qa.issues.map((i) => i.repairIntent).filter(Boolean)))
  assert.ok(intents.size >= 3)
  for (const intent of intents) assert.ok(REPAIR_INTENTS.includes(intent), intent)
})
