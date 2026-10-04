// FILM-2016 AC3, AC7 and the integration test plan: the export mix on buses,
// with the bundled FFmpeg. The timeline is the 20-shot rough cut the builder
// makes from FILM-2001's fixture (dialogue, shot audio, music, SFX and
// ambience on their buses, music and shot audio ducked under dialogue);
// every audio asset in range is a short FFmpeg-generated file.
//   - ebur128: the music stem under each dialogue line sits duckDb (±1 dB)
//     below the same timeline mixed without ducking;
//   - the dialogue stem is identical with and without ducking (never ducked);
//   - after normalize the mix is within ±1 LU of the target;
//   - the stems, written beside the render, sum to the mix.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { createRequire } from 'node:module'

import { buildBusMixGraph, measureLoudness, runStudioBusMix, sidechainFilters } from '../../electron/studio/audioBusMix.mjs'
import { applyBusPatch, busForTrack, resolveAudioBuses } from '../../src/studio/audio/buses.js'
import { buildProject } from '../../src/studio/projectBuilder.js'
import { loadFixture, probesFor } from './helpers/rough-cut.mjs'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const RANGE_END = 24
const SAMPLE_RATE = 48000

let work
let timeline
let project
let mediaByAsset

const ff = (args) => {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

// A source per bus that is steady enough to measure: tones for speech,
// noise beds for music, shot audio and ambience.
const sourceFor = (role, index, seconds) => {
  const d = seconds.toFixed(3)
  switch (role) {
    case 'dialogue': return `sine=f=${220 + (index % 5) * 40}:r=${SAMPLE_RATE}:d=${d},volume=2`
    case 'music': return `anoisesrc=color=pink:amplitude=0.3:r=${SAMPLE_RATE}:d=${d}`
    case 'shotaudio': return `anoisesrc=color=brown:amplitude=0.2:r=${SAMPLE_RATE}:d=${d}`
    case 'sfx': return `sine=f=1000:r=${SAMPLE_RATE}:d=${d}`
    default: return `anoisesrc=color=white:amplitude=0.05:r=${SAMPLE_RATE}:d=${d}`
  }
}

// export:mixAudio's per-clip chain, reduced to what this timeline uses
// (no speed, EQ, envelope or pan): trim, clip gain, delay to its start.
const chainFor = (clip) => {
  const visibleEnd = Math.min(RANGE_END, clip.startTime + clip.duration)
  const filters = [
    `atrim=start=${(clip.trimStart || 0).toFixed(6)}:duration=${(visibleEnd - clip.startTime).toFixed(6)}`,
    'asetpts=PTS-STARTPTS',
  ]
  if (clip.gainDb) filters.push(`volume=${clip.gainDb}dB`)
  if (clip.startTime > 0) filters.push(`adelay=${Math.round(clip.startTime * 1000)}:all=1`)
  return filters
}

const inputsFor = () => {
  const tracks = new Map(timeline.tracks.map((track) => [track.id, track]))
  return timeline.clips
    .filter((clip) => clip.type === 'audio' && clip.startTime < RANGE_END && tracks.get(clip.trackId)?.type === 'audio' && !tracks.get(clip.trackId).muted)
    .map((clip) => {
      const track = tracks.get(clip.trackId)
      return { inputPath: mediaByAsset.get(clip.assetId), filters: chainFor(clip), bus: busForTrack(track), language: track.language ?? null }
    })
}

const dialogueWindows = () => {
  const dialogueTracks = new Set(timeline.tracks.filter((track) => track.bus === 'dialogue' && !track.muted).map((track) => track.id))
  return timeline.clips
    .filter((clip) => dialogueTracks.has(clip.trackId) && clip.startTime + clip.duration < RANGE_END)
    // the steady middle of the line: past the 120 ms attack, before the end
    .map((clip) => ({ start: clip.startTime + 0.35, duration: clip.duration - 0.5 }))
    .filter((window) => window.duration >= 0.4)
}

const mix = async (name, { buses, target = null, stems = false }) => {
  const outputPath = path.join(work, name, 'render.wav')
  const result = await runStudioBusMix({
    ffmpegPath,
    inputs: inputsFor(),
    buses,
    outputPath,
    totalDuration: RANGE_END,
    sampleRate: SAMPLE_RATE,
    channels: 2,
    loudnessTargetLufs: target,
    stems: stems ? { directory: path.join(work, name), baseName: 'render' } : null,
  })
  assert.equal(result.success, true, result.error)
  return { ...result, outputPath }
}

before(() => {
  work = mkdtempSync(path.join(os.tmpdir(), 'film-2016-export-'))
  const pkg = loadFixture(20)
  ;({ project } = buildProject({ package: pkg, probedAssets: probesFor(pkg) }))
  timeline = project.timelines[0]
  mediaByAsset = new Map()
  const tracks = new Map(timeline.tracks.map((track) => [track.id, track]))
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]))
  mkdirSync(path.join(work, 'media'))
  let index = 0
  for (const clip of timeline.clips) {
    const track = tracks.get(clip.trackId)
    if (clip.type !== 'audio' || clip.startTime >= RANGE_END || mediaByAsset.has(clip.assetId)) continue
    const asset = assets.get(clip.assetId)
    const seconds = Math.min(RANGE_END + 2, Math.max(clip.trimStart + clip.duration, asset?.duration || clip.duration) + 0.5)
    const file = path.join(work, 'media', `${index}.wav`)
    ff(['-f', 'lavfi', '-i', sourceFor(track.bus, index, seconds), '-ac', '2', file])
    mediaByAsset.set(clip.assetId, file)
    index += 1
  }
})

after(() => {
  if (work && process.env.KEEP_FILM_2016_RENDERS !== '1') rmSync(work, { recursive: true, force: true })
})

test('the 20-shot rough cut has dialogue under ducked music and shot audio in range', () => {
  const buses = new Set(inputsFor().map((input) => input.bus))
  for (const bus of ['dialogue', 'music', 'shotaudio', 'sfx', 'ambience']) assert.ok(buses.has(bus), bus)
  assert.ok(dialogueWindows().length >= 6)
  assert.equal(project.studio.audioBuses.music.duckDb, -8)
})

test('ebur128: under every dialogue line the music stem sits duckDb ±1 dB below the same mix without ducking; the dialogue stem is untouched', async () => {
  const buses = resolveAudioBuses(project.studio.audioBuses)
  const unducked = applyBusPatch(buses, { music: { duckUnder: null }, shotaudio: { duckUnder: null } })
  const ducked = await mix('ducked', { buses, stems: true })
  const flat = await mix('flat', { buses: unducked, stems: true })
  const stem = (result, key) => result.stems.find((entry) => entry.key === key).path

  const rows = []
  for (const window of dialogueWindows()) {
    const under = await measureLoudness(ffmpegPath, stem(ducked, 'music'), window)
    const free = await measureLoudness(ffmpegPath, stem(flat, 'music'), window)
    const dialogueDucked = await measureLoudness(ffmpegPath, stem(ducked, 'dialogue-en'), window)
    const dialogueFlat = await measureLoudness(ffmpegPath, stem(flat, 'dialogue-en'), window)
    rows.push({ at: window.start.toFixed(2), drop: +(under.integratedLufs - free.integratedLufs).toFixed(2), dialogue: +(dialogueDucked.integratedLufs - dialogueFlat.integratedLufs).toFixed(2) })
  }
  if (process.env.FILM_2016_VERBOSE) console.log(JSON.stringify(rows))
  for (const row of rows) {
    assert.ok(Math.abs(row.drop - -8) <= 1, `music under dialogue at ${row.at}s dropped ${row.drop} dB, expected -8 ±1`)
    assert.ok(Math.abs(row.dialogue) <= 0.05, `dialogue at ${row.at}s changed by ${row.dialogue} dB; the dialogue bus is never ducked`)
  }
  // Shot audio ducks too (its own bus, same parameters).
  const shot = await measureLoudness(ffmpegPath, stem(ducked, 'shotaudio'), dialogueWindows()[2])
  const shotFree = await measureLoudness(ffmpegPath, stem(flat, 'shotaudio'), dialogueWindows()[2])
  assert.ok(Math.abs(shot.integratedLufs - shotFree.integratedLufs - -8) <= 1, `shot audio dropped ${shot.integratedLufs - shotFree.integratedLufs}`)
})

test('a deeper policy duck (-14 dB) moves the music by -14 ±1 dB', async () => {
  const buses = applyBusPatch(resolveAudioBuses(project.studio.audioBuses), { music: { duckDb: -14 } })
  const unducked = applyBusPatch(buses, { music: { duckUnder: null } })
  const ducked = await mix('deep', { buses, stems: true })
  const flat = await mix('deep-flat', { buses: unducked, stems: true })
  const window = dialogueWindows()[3]
  const under = await measureLoudness(ffmpegPath, ducked.stems.find((entry) => entry.key === 'music').path, window)
  const free = await measureLoudness(ffmpegPath, flat.stems.find((entry) => entry.key === 'music').path, window)
  assert.ok(Math.abs(under.integratedLufs - free.integratedLufs - -14) <= 1, `dropped ${under.integratedLufs - free.integratedLufs}`)
})

for (const target of [-14, -16]) {
  test(`normalize: the master lands within ±1 LU of ${target} LUFS and the stems beside the render sum to it`, async () => {
    const buses = resolveAudioBuses(project.studio.audioBuses)
    const result = await mix(`norm${target}`, { buses, target, stems: true })
    const measured = await measureLoudness(ffmpegPath, result.outputPath)
    assert.ok(Math.abs(measured.integratedLufs - target) <= 1, `mix at ${measured.integratedLufs} LUFS`)
    assert.equal(result.loudness.normalizationType, 'linear')
    assert.equal(result.stemsSumToMix, true)

    const keys = result.stems.map((entry) => entry.key).sort()
    assert.deepEqual(keys, ['ambience', 'dialogue-en', 'music', 'sfx', 'shotaudio'])
    for (const entry of result.stems) {
      assert.equal(path.dirname(entry.path), path.dirname(result.outputPath), 'stems sit beside the render')
      assert.ok(existsSync(entry.path))
    }
    // Residual of (sum of stems − mix), against the mix: inaudible.
    const inputs = result.stems.flatMap((entry) => ['-i', entry.path])
    const n = result.stems.length
    const graph = `${result.stems.map((_, i) => `[${i}:a]`).join('')}amix=inputs=${n}:normalize=0[sum];[${n}:a]volume=-1[neg];[sum][neg]amix=inputs=2:normalize=0,astats=metadata=0[out]`
    const residual = spawnSync(ffmpegPath, ['-hide_banner', '-nostats', ...inputs, '-i', result.outputPath, '-filter_complex', graph, '-map', '[out]', '-f', 'null', '-'], { encoding: 'utf8' })
    const residualDb = Number(residual.stderr.match(/Overall[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/)?.[1] ?? NaN)
    const mixRms = spawnSync(ffmpegPath, ['-hide_banner', '-nostats', '-i', result.outputPath, '-af', 'astats=metadata=0', '-f', 'null', '-'], { encoding: 'utf8' })
    const mixDb = Number(mixRms.stderr.match(/Overall[\s\S]*?RMS level dB:\s*(-?[\d.]+)/)?.[1])
    if (process.env.FILM_2016_VERBOSE) console.log({ target, measured, residualDb, mixDb })
    assert.ok(Number.isNaN(residualDb) || mixDb - residualDb >= 40, `stems differ from the mix by ${residualDb} dB RMS against a ${mixDb} dB mix`)
  })
}

test('dialogue stems are per language: a muted language is written as a stem but stays out of the mix and the sidechain key', () => {
  const buses = resolveAudioBuses(project.studio.audioBuses)
  const inputs = [
    { filters: ['anull'], bus: 'dialogue', language: 'en' },
    { filters: ['anull'], bus: 'dialogue', language: 'hi', stemOnly: true },
    { filters: ['anull'], bus: 'music' },
  ]
  const graph = buildBusMixGraph({ inputs, buses, totalDuration: 5, withStems: true })
  assert.deepEqual(graph.stems.map((entry) => entry.key).sort(), ['dialogue-en', 'dialogue-hi', 'music'])
  assert.match(graph.filterComplex, /\[s_dialogue_hi\]/)
  // the hi stem is an output only: nothing else consumes it
  assert.equal((graph.filterComplex.match(/\[s_dialogue_hi\]/g) || []).length, 1)
  assert.match(graph.filterComplex, /sidechaincompress/)
  const withoutStems = buildBusMixGraph({ inputs, buses, totalDuration: 5 })
  assert.deepEqual(withoutStems.stems, [])
})

test('the sidechain parameters come from the bus: attack, release and the duck depth', () => {
  const { compress, key } = sidechainFilters({ duckDb: -8, attackMs: 120, releaseMs: 400 })
  assert.match(compress, /attack=120:release=400/)
  assert.match(compress, /ratio=20/)
  assert.match(key, /agate=threshold=0\.005623/)
  const deeper = sidechainFilters({ duckDb: -20, attackMs: 50, releaseMs: 900 })
  assert.match(deeper.compress, /attack=50:release=900/)
  const t = (text) => Number(text.match(/threshold=([\d.]+):ratio/)[1])
  assert.ok(t(deeper.compress) < t(compress))
})
