// FILM-2017 AC1: the six delivery presets and the table's agreement with
// StoryBook's contract copy (contracts/render-presets.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { RENDER_PRESET_NAMES, RENDER_PRESETS } from '../../src/studio/contracts/render-presets.mjs'
import {
  DELIVERY_PRESETS,
  DELIVERY_PRESET_NAMES,
  VERTICAL_PRESET_NAMES,
  aspectOf,
  deliveryRelPath,
  estimateBytes,
  exportSettingsForPreset,
  presetFor,
  presetTableProblems,
  resolvePreset,
} from '../../src/studio/delivery/presets.js'
import { applyDeliveryPresetFilter } from '../../src/studio/delivery/exportFilter.js'
import { PRESET_LOUDNESS_LUFS } from '../../src/studio/audio/buses.js'
import { SAFE_AREAS } from '../../src/studio/captions/layout.js'
import { VERTICAL_CAPTION_SAFE_AREA } from '../../src/studio/intents/variants.js'

const FIELDS = ['name', 'width', 'height', 'fps', 'codec', 'bitrate', 'audioCodec', 'audioLufs', 'maxDuration', 'captionPolicy']

test('the table has exactly StoryBook\'s six presets, each with every field', () => {
  assert.deepEqual([...DELIVERY_PRESET_NAMES].sort(), [...RENDER_PRESET_NAMES].sort())
  assert.equal(DELIVERY_PRESET_NAMES.length, 6)
  for (const name of DELIVERY_PRESET_NAMES) {
    for (const field of FIELDS) assert.ok(field in DELIVERY_PRESETS[name], `${name}.${field}`)
    assert.equal(DELIVERY_PRESETS[name].name, name)
  }
  assert.deepEqual(presetTableProblems(), [])
})

test('every fixed frame has the aspect StoryBook\'s contract gives the preset', () => {
  for (const name of DELIVERY_PRESET_NAMES) {
    const { width, height } = DELIVERY_PRESETS[name]
    const expected = RENDER_PRESETS[name].aspect
    if (expected === null) assert.equal(width, null, 'master keeps the timeline frame')
    else assert.equal(aspectOf(width, height), expected, name)
  }
  assert.deepEqual([...VERTICAL_PRESET_NAMES].sort(), ['reels_9x16', 'shorts_9x16', 'tiktok_9x16'])
})

test('caption policy is the lead default: burn on the vertical and square feeds, sidecar on youtube and master', () => {
  const policy = Object.fromEntries(DELIVERY_PRESET_NAMES.map((name) => [name, DELIVERY_PRESETS[name].captionPolicy]))
  assert.deepEqual(policy, { youtube_16x9: 'sidecar', shorts_9x16: 'burn', tiktok_9x16: 'burn', reels_9x16: 'burn', square_1x1: 'burn', master: 'sidecar' })
})

test('loudness agrees with FILM-2016 (-14, reels -16) and master follows the policy', () => {
  assert.deepEqual(Object.fromEntries(DELIVERY_PRESET_NAMES.map((name) => [name, DELIVERY_PRESETS[name].audioLufs])), {
    youtube_16x9: -14, shorts_9x16: -14, tiktok_9x16: -14, reels_9x16: -16, square_1x1: -14, master: null,
  })
  // FILM-2016's bus mixer keeps its own copy for a preset passed by name: the two agree.
  for (const [name, lufs] of Object.entries(PRESET_LOUDNESS_LUFS)) assert.equal(DELIVERY_PRESETS[name].audioLufs, lufs, name)
  assert.deepEqual({ ...VERTICAL_CAPTION_SAFE_AREA }, { ...SAFE_AREAS['9:16'] }, 'the fallback 9:16 safe area is FILM-2016\'s')
  assert.equal(resolvePreset('master', { timeline: { width: 1920, height: 1080, fps: 24 } }).audioLufs, -14)
  assert.equal(resolvePreset('master', { timeline: { width: 1920, height: 1080, fps: 24 }, policy: { loudnessTargetLufs: -16 } }).audioLufs, -16)
})

test('master and youtube keep the timeline\'s fps and master its frame', () => {
  const timeline = { width: 1280, height: 720, fps: 25 }
  assert.deepEqual((({ width, height, fps, aspect }) => ({ width, height, fps, aspect }))(resolvePreset('master', { timeline })), { width: 1280, height: 720, fps: 25, aspect: '16:9' })
  assert.equal(resolvePreset('youtube_16x9', { timeline }).fps, 25)
  assert.equal(resolvePreset('shorts_9x16', { timeline }).fps, 30)
})

test('files go to renders/<version>/<preset>-<lang>.mp4', () => {
  assert.equal(deliveryRelPath('v3', 'shorts_9x16', 'hi'), 'renders/v3/shorts_9x16-hi.mp4')
  assert.equal(deliveryRelPath('v3', 'youtube_16x9'), 'renders/v3/youtube_16x9-en.mp4')
  assert.equal(deliveryRelPath('../x', 'master', 'en'), 'renders/.._x/master-en.mp4')
})

test('an unknown preset is VALIDATION_FAILED, and sizes scale with bitrate and duration', () => {
  assert.throws(() => presetFor('youtube_4k'), (error) => error.code === 'VALIDATION_FAILED')
  const sixty = estimateBytes('youtube_16x9', 60)
  assert.equal(sixty, Math.round(((12000 + 192) * 1000 * 60) / 8 * 1.01))
  assert.equal(estimateBytes('youtube_16x9', 120), sixty * 2)
})

test('export settings carry the preset into the upstream editor\'s export_timeline', () => {
  const settings = exportSettingsForPreset('reels_9x16', { timeline: { width: 1920, height: 1080, fps: 24 }, language: 'hi' })
  assert.deepEqual(settings, {
    width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', qualityMode: 'bitrate', bitrateKbps: 8000, audioBitrateKbps: 192,
    audioSampleRate: 48000, normalizeAudio: true, loudnessTarget: -16, deliveryFraming: 'fill', captionPolicy: 'burn', language: 'hi', deliveryPreset: 'reels_9x16',
  })
  assert.equal(exportSettingsForPreset('youtube_16x9', { timeline: { width: 1920, height: 1080 } }).deliveryFraming, 'fit')
})

test('a preset export leaves out captions it does not burn and other languages', () => {
  const state = {
    tracks: [{ id: 'v1', type: 'video' }, { id: 'c-en', type: 'video', language: 'en' }, { id: 'c-hi', type: 'video', language: 'hi' }, { id: 'd-hi', type: 'audio', language: 'hi' }, { id: 'm', type: 'audio' }],
    clips: [
      { id: 'shot', trackId: 'v1', type: 'video' },
      { id: 'cap-en', trackId: 'c-en', type: 'captions' },
      { id: 'cap-hi', trackId: 'c-hi', type: 'captions' },
      { id: 'line-hi', trackId: 'd-hi', type: 'audio' },
      { id: 'music', trackId: 'm', type: 'audio' },
    ],
  }
  const ids = (result) => result.clips.map((clip) => clip.id)
  assert.equal(applyDeliveryPresetFilter(state, {}), state)
  assert.deepEqual(ids(applyDeliveryPresetFilter(state, { captionPolicy: 'burn', language: 'en' })), ['shot', 'cap-en', 'music'])
  assert.deepEqual(ids(applyDeliveryPresetFilter(state, { captionPolicy: 'sidecar', language: 'hi' })), ['shot', 'line-hi', 'music'])
})
