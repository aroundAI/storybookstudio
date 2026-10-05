// FILM-2014 AC8: the export regression runner's QA pass fails a render with
// black frames, the wrong loudness or the wrong length, and passes a good one.
// (The runner itself, check:export-worker-scheduling with
// STORYBOOKSTUDIO_TEST_NATIVE_ENCODE=1, calls the same function on its MP4.)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { FFMPEG, FFPROBE, removeDir, tempDir } from './helpers/review-media.mjs'
import { makeRender } from './helpers/qa-fixtures.mjs'

const require = createRequire(import.meta.url)
const { runExportRegressionQa } = require('../../electron/studio/exportRegressionQa.js')

let dir
const files = {}
const check = (file, extra = {}) => runExportRegressionQa({ file, durationSeconds: 6, width: 1280, height: 720, fps: 24, loudnessLufs: -14, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, ...extra })

before(async () => {
  dir = await tempDir('export-qa')
  await Promise.all([
    makeRender(path.join(dir, 'good.mp4'), { duration: 6, width: 1280, height: 720 }).then((f) => { files.good = f }),
    makeRender(path.join(dir, 'black.mp4'), { duration: 6, width: 1280, height: 720, black: [2, 4] }).then((f) => { files.black = f }),
    makeRender(path.join(dir, 'loud.mp4'), { duration: 6, width: 1280, height: 720, lufs: -8 }).then((f) => { files.loud = f }),
    makeRender(path.join(dir, 'short.mp4'), { duration: 5, width: 1280, height: 720 }).then((f) => { files.short = f }),
    makeRender(path.join(dir, 'silent-video.mp4'), { duration: 6, width: 1280, height: 720, audio: false }).then((f) => { files.videoOnly = f }),
  ])
})
after(() => removeDir(dir))

test('a good fixture render passes the regression QA', async () => {
  const result = await check(files.good)
  assert.equal(result.pass, true, JSON.stringify(result.blocking))
  assert.ok(Math.abs(result.measured.integratedLufs - -14) <= 1)
})

test('black frames, a loudness regression and a short render each fail it', async () => {
  const black = await check(files.black)
  assert.deepEqual(black.blocking.map((i) => i.type), ['black_frames'])
  const loud = await check(files.loud)
  assert.ok(loud.blocking.some((i) => i.type === 'loudness'), JSON.stringify(loud.blocking))
  const short = await check(files.short)
  assert.ok(short.blocking.some((i) => i.type === 'duration'))
})

test('the video-only scheduling fixture is held to picture and format only', async () => {
  const result = await check(files.videoOnly, { loudnessLufs: null })
  assert.equal(result.pass, true, JSON.stringify(result.blocking))
  assert.equal(result.measured.integratedLufs, null)
})
