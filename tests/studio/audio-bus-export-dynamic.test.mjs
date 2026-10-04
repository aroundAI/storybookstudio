// FILM-2016 fix: a mix whose peaks forbid a linear gain to the target (the
// pulled 20-shot project: -19.5 LUFS integrated, -2.1 dBTP peak, target -14)
// makes loudnorm fall back to dynamic mode. FFmpeg then re-initialises the
// filter graph mid-stream, and with no output layout pinned it failed with
// "Cannot select channel layout", which the Studio showed as
// "Audio bus mix failed: :". The mix must land on the target anyway, and a
// failure must name FFmpeg's reason in its first line.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'

import { ffmpegFailureReason, measureLoudness, runStudioBusMix } from '../../electron/studio/audioBusMix.mjs'
import { defaultAudioBuses } from '../../src/studio/audio/buses.js'

const ffmpegPath = createRequire(import.meta.url)('ffmpeg-static')
let work
const ff = (args) => {
  const result = spawnSync(ffmpegPath, ['-v', 'error', '-y', ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

before(() => {
  work = mkdtempSync(path.join(os.tmpdir(), 'film-2016-dynamic-'))
  // A quiet bed with near-full-scale dialogue bursts: integrated loudness
  // far below -14, true peak near 0 dBTP, so +gain to -14 would clip.
  ff(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.02:r=48000:d=20', '-ac', '2', path.join(work, 'bed.wav')])
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.95*sin(2*PI*330*t)*between(mod(t,4),0,0.6)':s=48000:d=20", '-ac', '2', path.join(work, 'dialogue.wav')])
})
after(() => rmSync(work, { recursive: true, force: true }))

const inputs = () => [
  { inputPath: path.join(work, 'dialogue.wav'), filters: ['asetpts=PTS-STARTPTS'], bus: 'dialogue', language: 'en' },
  { inputPath: path.join(work, 'bed.wav'), filters: ['asetpts=PTS-STARTPTS'], bus: 'music' },
]

test('a mix loudnorm cannot raise linearly still lands within ±1 LU of the target, stems and all', async () => {
  const outputPath = path.join(work, 'out', 'mix.wav')
  const result = await runStudioBusMix({
    ffmpegPath, inputs: inputs(), buses: defaultAudioBuses(null), outputPath, totalDuration: 20,
    loudnessTargetLufs: -14, stems: { directory: path.join(work, 'out'), baseName: 'mix' },
  })
  assert.equal(result.success, true, result.error)
  assert.equal(result.loudness.normalizationType, 'dynamic', 'this fixture forces the dynamic path')
  assert.equal(result.stemsSumToMix, false, 'a dynamic normalize is not one gain, and says so')
  const measured = await measureLoudness(ffmpegPath, outputPath)
  assert.ok(Math.abs(measured.integratedLufs - -14) <= 1, `mix at ${measured.integratedLufs}`)
  assert.deepEqual(result.stems.map((stem) => stem.key).sort(), ['dialogue-en', 'music'])
})

test('a failed mix names FFmpeg\'s reason in its first line, never a bare colon', async () => {
  const result = await runStudioBusMix({
    ffmpegPath, inputs: [{ inputPath: path.join(work, 'missing.wav'), filters: ['anull'], bus: 'music' }],
    buses: defaultAudioBuses(null), outputPath: path.join(work, 'x.wav'), totalDuration: 5,
  })
  assert.equal(result.success, false)
  const first = result.error.split('\n')[0]
  assert.match(first, /missing\.wav|No such file/, first)
  assert.ok(first.length > 10)
  const reason = ffmpegFailureReason(':\n  Stream #0:0 -> #0:0 (pcm_f32le (native) -> pcm_f32le (native))\nPress [q] to stop, [?] for help\n[Parsed_aresample_1 @ 0x6000] Cannot select channel layout for the link between filters Parsed_aresample_1 and format_out_0_0.\nError reinitializing filters!\nFailed to inject frame into filter network: Invalid argument\nConversion failed!\n')
  assert.match(reason.split('\n')[0], /^Cannot select channel layout/)
})
