// FILM-2016: what the exporter adds to export:mixAudio. A plain upstream project
// adds nothing (its mix is unchanged); a Studio project sends its resolved
// buses, the loudness target and, when asked, stems beside the render with
// the muted dialogue languages as stem-only tracks.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { studioAudioExportOptions, studioMixRequest } from '../../src/studio/audio/exportOptions.js'
import { defaultAudioBuses } from '../../src/studio/audio/buses.js'

const tracks = [
  { id: 'a1', type: 'audio', bus: 'dialogue', language: 'en', muted: false },
  { id: 'a2', type: 'audio', bus: 'dialogue', language: 'hi', muted: true },
  { id: 'a3', type: 'audio', bus: 'music', muted: false },
  { id: 'a4', type: 'audio', muted: true },
]

test('a plain upstream project sends no studio block', () => {
  assert.equal(studioAudioExportOptions({ name: 'x' }), null)
  assert.deepEqual(studioMixRequest(null, { tracks, outputPath: '/p/renders/a.mp4' }), {})
})

test('a Studio project sends its buses and the master target; a preset overrides the target', () => {
  const project = { studio: { audioBuses: defaultAudioBuses(null) } }
  const options = studioAudioExportOptions(project)
  assert.equal(options.loudnessTargetLufs, -14)
  assert.equal(options.audioBuses.music.duckDb, -8)
  assert.equal(studioAudioExportOptions(project, { preset: 'reels_9x16' }).loudnessTargetLufs, -16)
  const request = studioMixRequest(options, { tracks, outputPath: '/p/renders/a.mp4' })
  assert.deepEqual(request.studio.stems, null)
  assert.deepEqual(request.studio.stemOnlyTrackIds, [])
})

test('with stems: WAVs beside the render, and the muted language a stem-only track', () => {
  const options = studioAudioExportOptions({ studio: { audioBuses: defaultAudioBuses(null) } }, { stems: true })
  const request = studioMixRequest(options, { tracks, outputPath: 'C:\\p\\renders\\ep 3.mp4' })
  assert.deepEqual(request.studio.stems, { directory: 'C:\\p\\renders', baseName: 'ep 3' })
  assert.deepEqual(request.studio.stemOnlyTrackIds, ['a2'])
})
