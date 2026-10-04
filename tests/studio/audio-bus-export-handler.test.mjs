// FILM-2016 AC3 through the real export:mixAudio handler (electron/main.js,
// loaded the way tests/audioEqNative.test.mjs loads it) and the exporter's
// real track serializer: a Studio project's request mixes on buses, ducks the
// music under dialogue, lands on the loudness target and writes stems beside
// the render, the muted language included as a stem only. A plain request
// (no `studio`) takes the flat path it always took.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { test } from 'node:test'

import { buildAudioEqFilters } from '../../electron/audioEq.mjs'
import { buildAudioVolumeEnvelopeFilter } from '../../electron/audioVolumeEnvelope.mjs'
import * as eligibility from '../../electron/audioMixEligibility.mjs'
import * as busMix from '../../electron/studio/audioBusMix.mjs'
import { defaultAudioBuses } from '../../src/studio/audio/buses.js'
import { studioAudioExportOptions, studioMixRequest } from '../../src/studio/audio/exportOptions.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const root = path.resolve(import.meta.dirname, '..', '..')
const ff = (args) => {
  const result = spawnSync(ffmpegPath, ['-v', 'error', '-y', ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

function loadNativeMixHandler() {
  const main = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8')
  const helpers = main.slice(main.indexOf('const formatFilterNumber ='), main.indexOf('// Ask the running export worker'))
  let handler = main.slice(main.indexOf("ipcMain.handle('export:mixAudio'"), main.indexOf('// Encode a mixed WAV'))
  handler = handler.replace("await import('./audioMixEligibility.mjs')", 'dependencies.eligibility')
    .replace("await import('./audioVolumeEnvelope.mjs')", 'dependencies.envelope')
    .replace("await import('./audioEq.mjs')", 'dependencies.eq')
    .replace("await import('./studio/audioBusMix.mjs')", 'dependencies.busMix')
  let callback
  vm.runInNewContext(helpers + handler, {
    ipcMain: { handle(name, fn) { assert.equal(name, 'export:mixAudio'); callback = fn } },
    dependencies: { eligibility, envelope: { buildAudioVolumeEnvelopeFilter }, eq: { buildAudioEqFilters }, busMix },
    getFfmpegUnavailableError: () => null, fs: fsp, fsSync: fs, path, spawn, ffmpegPath, setTimeout, clearTimeout,
    resolveMediaInputPath: (value) => value, probeAudioDurationSeconds: async () => null,
  })
  return callback
}

function loadTrackSerializer() {
  const source = fs.readFileSync(path.join(root, 'src/services/exporter.js'), 'utf8')
  const snippet = source.slice(source.indexOf('const serializeAudioTracksForMix'), source.indexOf('// FILM-2016: a Studio project'))
  return vm.runInNewContext(`${snippet}\nserializeAudioTracksForMix`, {})
}

const tracks = [
  { id: 'a1', type: 'audio', bus: 'dialogue', language: 'en', muted: false, volume: 100 },
  { id: 'a2', type: 'audio', bus: 'dialogue', language: 'hi', muted: true, volume: 100 },
  { id: 'a3', type: 'audio', bus: 'music', muted: false, volume: 100 },
]
const clips = [
  { id: 'd1', type: 'audio', trackId: 'a1', assetId: 'en', startTime: 2, duration: 3, trimStart: 0 },
  { id: 'd2', type: 'audio', trackId: 'a2', assetId: 'hi', startTime: 2, duration: 3, trimStart: 0 },
  { id: 'm1', type: 'audio', trackId: 'a3', assetId: 'bed', startTime: 0, duration: 8, trimStart: 0 },
]
const assets = [{ id: 'en', path: 'en.wav' }, { id: 'hi', path: 'hi.wav' }, { id: 'bed', path: 'bed.wav' }]

const setup = async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'film-2016-handler-'))
  ff(['-f', 'lavfi', '-i', 'sine=f=330:r=48000:d=3,volume=2', '-ac', '2', path.join(temp, 'en.wav')])
  ff(['-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3,volume=2', '-ac', '2', path.join(temp, 'hi.wav')])
  ff(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.3:r=48000:d=8', '-ac', '2', path.join(temp, 'bed.wav')])
  return temp
}

test('a Studio request mixes on buses through the real handler: duck, loudness target, stems beside the render', async () => {
  const temp = await setup()
  try {
    const project = { studio: { audioBuses: defaultAudioBuses(null) } }
    const outputPath = path.join(temp, 'renders', 'episode.wav')
    const serialized = loadTrackSerializer()(tracks)
    assert.deepEqual(serialized.map((track) => [track.bus, track.language ?? null]), [['dialogue', 'en'], ['dialogue', 'hi'], ['music', null]])
    const request = studioMixRequest(studioAudioExportOptions(project, { stems: true }), { tracks, outputPath })
    const handler = loadNativeMixHandler()
    const options = { projectPath: temp, outputPath, sampleRate: 48000, channels: 2, rangeStart: 0, rangeEnd: 8, clips, tracks: serialized, assets, ...request }

    const dry = await handler({}, { ...options, validateOnly: true })
    assert.equal(dry.clipCount, 2, 'the stem-only language is not counted as a mixed clip')
    const result = await handler({}, options)
    assert.equal(result.success, true, result.error)
    assert.equal(result.clipCount, 2)
    assert.deepEqual(result.stems.map((stem) => stem.key).sort(), ['dialogue-en', 'dialogue-hi', 'music'])
    for (const stem of result.stems) assert.equal(path.dirname(stem.path), path.dirname(outputPath))
    assert.equal(result.stemsSumToMix, true)

    const mix = await busMix.measureLoudness(ffmpegPath, outputPath)
    assert.ok(Math.abs(mix.integratedLufs - -14) <= 1, `mix at ${mix.integratedLufs}`)
    const music = result.stems.find((stem) => stem.key === 'music').path
    const under = await busMix.measureLoudness(ffmpegPath, music, { start: 2.5, duration: 2.3 })
    const free = await busMix.measureLoudness(ffmpegPath, music, { start: 6.2, duration: 1.6 })
    assert.ok(Math.abs(under.integratedLufs - free.integratedLufs - -8) <= 1, `music dropped ${under.integratedLufs - free.integratedLufs} dB`)
    // The Hindi line is in its stem and nowhere in the mix: the mix's
    // dialogue window carries only the English tone's level.
    const hi = await busMix.measureLoudness(ffmpegPath, result.stems.find((stem) => stem.key === 'dialogue-hi').path, { start: 2.5, duration: 2 })
    assert.ok(hi.integratedLufs > -40, 'the Hindi stem has its line')
  } finally {
    await fsp.rm(temp, { recursive: true, force: true })
  }
})

test('a plain request (no studio block) refuses the muted track and mixes flat as before', async () => {
  const temp = await setup()
  try {
    const handler = loadNativeMixHandler()
    const outputPath = path.join(temp, 'flat.wav')
    const result = await handler({}, { projectPath: temp, outputPath, sampleRate: 48000, channels: 2, rangeStart: 0, rangeEnd: 8, clips, tracks, assets })
    assert.equal(result.success, true, result.error)
    assert.equal(result.clipCount, 2)
    assert.equal(result.stems, undefined)
    assert.ok(result.skipped.some((entry) => entry.clipId === 'd2' && entry.reason === 'track-not-audible'))
    const music = await busMix.measureLoudness(ffmpegPath, outputPath, { start: 6.2, duration: 1.6 })
    assert.ok(Number.isFinite(music.integratedLufs))
  } finally {
    await fsp.rm(temp, { recursive: true, force: true })
  }
})
