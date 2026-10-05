// FILM-2019: one master timeline, many languages. AC1 the builder's track
// languages and languageDependency; AC2 a render selects its language (the
// lane plays though the editor mutes it); AC3 the language lane from the
// dubbed block (speed-fit with the 0.9 floor, Devanagari captions in the safe
// area, a re-run replaces it); the FILM-2012 hazard: placeLiveCaptions keeps
// another language's captions; AC5 the spoken-language check's verdicts.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

import { buildProject } from '../../src/studio/projectBuilder.js'
import { audioClips, captionCues } from '../../src/studio/review/renderPlan.js'
import { applyDeliveryPresetFilter } from '../../src/studio/delivery/exportFilter.js'
import { selectLanguage } from '../../src/studio/localization/selection.js'
import { DUB_SPEED_FLOOR, dubSlots, fitDubbedLine } from '../../src/studio/localization/fit.js'
import { applyLanguageLane, buildLanguageLane } from '../../src/studio/localization/lanes.js'
import { checkCaptionSafeArea } from '../../src/studio/captions/style.js'
import { normalizeWord } from '../../src/studio/captions/layout.js'
import { loadFixture, probesFor } from './helpers/rough-cut.mjs'

const require = createRequire(import.meta.url)
const { checkSpokenLanguage, createLanguageDetector, parseDetectedLanguage } = require('../../electron/studio/languageCheck.js')
const ffmpegPath = require('ffmpeg-static')

const DEVANAGARI = /[ऀ-ॿ]/
const built = (pkg) => buildProject({ package: pkg, probedAssets: probesFor(pkg) })
// The 60-shot package as pulled before StoryBook dubbed it: English only.
const beforeDub = (pkg) => ({ ...pkg, dubbed: [], captions: pkg.captions.filter((entry) => entry.language === 'en'), episode: { ...pkg.episode, languages: ['en'] } })

test('AC1: dialogue and caption tracks carry their language; every element carries languageDependency', () => {
  const { project } = built(loadFixture(60))
  const [timeline] = project.timelines
  const tracks = new Map(timeline.tracks.map((track) => [track.id, track]))
  assert.deepEqual(timeline.tracks.filter((track) => track.language).map((track) => [track.name, track.language]), [
    ['Captions (en)', 'en'], ['Captions (hi)', 'hi'], ['Dialogue (en)', 'en'], ['Dialogue (hi)', 'hi'],
  ])
  const dependency = new Map()
  for (const clip of timeline.clips) {
    const track = tracks.get(clip.trackId)
    const kind = track.role === 'captions' ? 'captions' : track.bus || 'video'
    dependency.set(kind, new Set([...(dependency.get(kind) || []), clip.metadata.languageDependency]))
  }
  assert.deepEqual(Object.fromEntries([...dependency].map(([kind, values]) => [kind, [...values]])), {
    captions: ['language'], video: ['none'], dialogue: ['language'], shotaudio: ['none'], music: ['none'], sfx: ['none'], ambience: ['none'],
  })
  assert.ok(project.assets.filter((asset) => asset.role === 'dialogue').every((asset) => asset.languageDependency === 'language' && asset.language))
})

test('AC2: a Hindi render hears the Hindi lane the editor mutes, and shows its captions; an English render is unchanged', () => {
  const { project } = built(loadFixture(60))
  const [timeline] = project.timelines
  const hiTrack = timeline.tracks.find((track) => track.bus === 'dialogue' && track.language === 'hi')
  assert.equal(hiTrack.muted, true, 'the editor monitors English')
  const dialogue = (language) => audioClips(project, { language }).filter((clip) => clip.bus === 'dialogue')
  const languagesOf = (clips) => [...new Set(clips.map((clip) => clip.language))]
  assert.deepEqual(languagesOf(dialogue('hi')), ['hi'])
  assert.equal(dialogue('hi').length, 120)
  assert.deepEqual(languagesOf(dialogue('en')), ['en'])
  assert.deepEqual(languagesOf(dialogue(null)), ['en'], 'no language: the tracks as stored')
  // language-independent buses play in every language
  for (const bus of ['shotaudio', 'music', 'sfx', 'ambience']) {
    assert.equal(audioClips(project, { language: 'hi' }).filter((clip) => clip.bus === bus).length, audioClips(project, { language: 'en' }).filter((clip) => clip.bus === bus).length, bus)
  }
  const cues = (language) => captionCues(project, { language })
  assert.ok(cues('hi').length > 0 && cues('hi').every((cue) => cue.language === 'hi' && DEVANAGARI.test(cue.text)))
  assert.ok(cues('en').every((cue) => cue.language === 'en'))

  // The editor's export (export_timeline with a delivery preset) selects the same way.
  const filtered = applyDeliveryPresetFilter({ tracks: timeline.tracks, clips: timeline.clips }, { captionPolicy: 'burn', language: 'hi' })
  const after = new Map(filtered.tracks.map((track) => [track.id, track]))
  assert.equal(after.get(hiTrack.id).muted, false)
  assert.equal(after.get(timeline.tracks.find((track) => track.bus === 'dialogue' && track.language === 'en').id).muted, true)
  assert.equal(after.get(timeline.tracks.find((track) => track.role === 'captions' && track.language === 'hi').id).visible, true)
  assert.ok(filtered.clips.every((clip) => [null, undefined, 'hi'].includes(clip.metadata?.language)))

  // Captions the policy turned off stay off in every language.
  const off = { ...timeline, tracks: timeline.tracks.map((track) => (track.role === 'captions' ? { ...track, visible: false } : track)) }
  assert.ok(selectLanguage(off, 'hi').tracks.filter((track) => track.role === 'captions').every((track) => track.visible === false))
})

test('speed-fit with the 0.9 floor: a dub is never slower than 0.9, is sped up to fit its slot up to 1.25, and is never trimmed', () => {
  assert.equal(DUB_SPEED_FLOOR, 0.9)
  assert.deepEqual(fitDubbedLine({ sourceSeconds: 1.8, timingAdjustment: 1, slotSeconds: 2 }), { speed: 1, playedSeconds: 1.8, overrunSeconds: 0, fitted: false, floored: false })
  assert.equal(fitDubbedLine({ sourceSeconds: 1.2, timingAdjustment: 0.7, slotSeconds: 2 }).speed, 0.9)
  assert.equal(fitDubbedLine({ sourceSeconds: 1.2, timingAdjustment: 0.7, slotSeconds: 2 }).floored, true)
  const tight = fitDubbedLine({ sourceSeconds: 2.2, timingAdjustment: 1, slotSeconds: 2 })
  assert.deepEqual([tight.speed, tight.overrunSeconds, tight.fitted], [1.1, 0, true])
  const over = fitDubbedLine({ sourceSeconds: 3, timingAdjustment: 1, slotSeconds: 2 })
  assert.deepEqual([over.speed, over.playedSeconds, over.overrunSeconds], [1.25, 2.4, 0.4])
  assert.equal(fitDubbedLine({ sourceSeconds: 3, timingAdjustment: 1.4, slotSeconds: 2 }).speed, 1.4, 'StoryBook\'s own faster fit is the ceiling')
  assert.deepEqual([...dubSlots([{ id: 'b', start: 2.4 }, { id: 'a', start: 0.4 }], 5)], [['a', 2], ['b', 2.6]])

  // In the builder: the Hindi lines of the fixture, one fitted at 0.7 and one far too long.
  const pkg = loadFixture(60)
  const [hi] = pkg.dubbed
  const lines = hi.lines.map((line, index) => (index === 0 ? { ...line, timingAdjustment: 0.7 } : index === 1 ? { ...line, durationSeconds: 4 } : line))
  const dubbed = { ...pkg, dubbed: [{ ...hi, lines }] }
  const probes = probesFor(dubbed)
  const { project, warnings } = buildProject({ package: dubbed, probedAssets: probes })
  const clipOf = (line) => project.timelines[0].clips.find((clip) => clip.assetId === `sb-dub-hi-${line.id}`)
  assert.equal(clipOf(lines[0]).speed, 0.9)
  assert.equal(clipOf(lines[1]).speed, 1.25)
  // placed whole: the file's 4 s, to the last whole frame (24 fps at 1.25x)
  assert.ok(clipOf(lines[1]).trimEnd > 4 - 1.25 / 24, `trimEnd ${clipOf(lines[1]).trimEnd}`)
  assert.deepEqual(warnings.filter((warning) => warning.code === 'dub_overruns_slot').map((warning) => [warning.ref, warning.speed, warning.overrunSeconds]), [[lines[1].id, 1.25, 1.2]])
})

test('AC3: the Hindi lane on a master pulled before the dub: lines at their starts, Devanagari captions in the 16:9 safe area, a re-run replaces it', () => {
  const pkg = loadFixture(60)
  const { project } = built(beforeDub(pkg))
  const master = project.timelines[0]
  assert.equal(master.tracks.some((track) => track.language === 'hi'), false)

  const lane = buildLanguageLane({ document: project, pkg, language: 'hi', probes: probesFor(pkg) })
  assert.deepEqual(lane.tracks.map((track) => [track.name, track.type, track.language, track.role ?? track.bus]), [
    ['Dialogue (hi)', 'audio', 'hi', 'dialogue'], ['Captions (hi)', 'video', 'hi', 'captions'],
  ])
  assert.equal(lane.lines.placed, 120)
  const timeline = applyLanguageLane(master, lane)
  assert.equal(new Set(timeline.clips.map((clip) => clip.id)).size, timeline.clips.length, 'clip ids stay unique')
  assert.equal(new Set(timeline.tracks.map((track) => track.id)).size, timeline.tracks.length, 'track ids stay unique')
  assert.deepEqual(timeline.tracks.map((track) => track.name), ['Captions (en)', 'Captions (hi)', 'Shots', 'Dialogue (en)', 'Dialogue (hi)', 'Shot audio', 'Music', 'SFX', 'Ambience'])

  // Each dub where its line starts, the same frame as the English line.
  const enStart = new Map(timeline.clips.filter((clip) => clip.metadata?.language === 'en' && clip.type === 'audio').map((clip) => [clip.metadata.storybook.dialogueId, clip.startTime]))
  const hiClips = timeline.clips.filter((clip) => clip.metadata?.language === 'hi' && clip.type === 'audio')
  assert.equal(hiClips.length, 120)
  for (const clip of hiClips) assert.equal(clip.startTime, enStart.get(clip.metadata.storybook.dialogueId))

  // Captions from the dubbed text, Devanagari, every cue inside the 16:9 safe area and none overlapping.
  const captions = timeline.clips.find((clip) => clip.type === 'captions' && clip.metadata.language === 'hi')
  assert.equal(captions.captions.cues.length, 120)
  assert.ok(captions.captions.cues.every((cue) => DEVANAGARI.test(cue.text)))
  assert.deepEqual(checkCaptionSafeArea({ cues: captions.captions.cues, width: 1920, height: 1080, aspect: '16:9' }), [])

  // A Hindi render of the new master hears and shows the lane.
  const document = { ...project, timelines: [timeline], assets: [...project.assets, ...lane.assets] }
  assert.equal(audioClips(document, { language: 'hi' }).filter((clip) => clip.bus === 'dialogue' && clip.language === 'hi').length, 120)
  assert.equal(captionCues(document, { language: 'hi' }).length, 120)

  // Re-run: the same lane, in place of the old one.
  const again = buildLanguageLane({ document, pkg, language: 'hi', probes: probesFor(pkg) })
  const rerun = applyLanguageLane(timeline, again)
  assert.deepEqual(rerun.tracks.map((track) => track.id), timeline.tracks.map((track) => track.id))
  assert.equal(rerun.clips.length, timeline.clips.length)
})

test('AC3 refusals: no dub for the language says where one comes from; the episode language is the master\'s own', () => {
  const pkg = loadFixture(60)
  const { project } = built(beforeDub(pkg))
  assert.throws(() => buildLanguageLane({ document: project, pkg, language: 'es' }), (error) => error.code === 'NOT_FOUND' && /localize_episode/.test(error.message) && error.details.availableLanguages.includes('hi'))
  assert.throws(() => buildLanguageLane({ document: project, pkg, language: 'en' }), (error) => error.code === 'NOT_FOUND' || error.code === 'VALIDATION_FAILED')
  assert.throws(() => buildLanguageLane({ document: project, pkg, language: 'Hindi' }), (error) => error.code === 'VALIDATION_FAILED')
})

test('Devanagari emphasis words keep their vowel signs', () => {
  assert.equal(normalizeWord('हमें,'), 'हमें')
  assert.notEqual(normalizeWord('हमें'), normalizeWord('हम'))
})

// The FILM-2012 hazard: regenerating one language's captions removed every other captions clip.
const timelineStore = () => {
  const code = buildSync({ entryPoints: [fileURLToPath(new URL('../../src/stores/timelineStore.js', import.meta.url))], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'zustand', 'zustand/*'], logLevel: 'silent' }).outputFiles[0].text
  const module = { exports: {} }
  Function('require', 'module', 'exports', 'localStorage', code)(require, module, module.exports, { getItem: () => null, setItem() {}, removeItem() {} })
  return module.exports.useTimelineStore
}

test('placeLiveCaptions regenerates one language and leaves the other language\'s captions clip alone', () => {
  const store = timelineStore()
  const { project } = built(loadFixture(60))
  const [timeline] = project.timelines
  store.setState({ tracks: timeline.tracks, clips: timeline.clips, clipCounter: timeline.clipCounter, history: [], historyIndex: -1 })
  const captionsOf = (language) => store.getState().clips.filter((clip) => clip.type === 'captions' && (clip.metadata?.language ?? store.getState().tracks.find((track) => track.id === clip.trackId)?.language) === language)
  const enBefore = captionsOf('en')[0]
  const cues = [{ id: 'c1', start: 0.5, end: 2, text: 'हमें अभी चलना होगा।' }]

  const placed = store.getState().placeLiveCaptions({ cues, preset: { id: 'kinetic-traditional' }, duration: 2, language: 'hi' })
  assert.deepEqual(captionsOf('en').map((clip) => [clip.id, clip.captions.cues.length]), [[enBefore.id, enBefore.captions.cues.length]], 'English captions untouched')
  assert.deepEqual(captionsOf('hi').map((clip) => [clip.id, clip.captions.cues[0].text]), [[placed.id, cues[0].text]])

  // A language with no captions track gets its own.
  const es = store.getState().placeLiveCaptions({ cues: [{ id: 'e1', start: 0.5, end: 2, text: 'Tenemos que irnos.' }], duration: 2, language: 'es' })
  const esTrack = store.getState().tracks.find((track) => track.id === es.trackId)
  assert.deepEqual([esTrack.role, esTrack.language, es.metadata.language], ['captions', 'es', 'es'])
  assert.equal(captionsOf('en').length, 1)
  assert.equal(captionsOf('hi').length, 1)

  // No language (the caption workspace): the first captions track, as before; Hindi and Spanish stay.
  store.getState().placeLiveCaptions({ cues: [{ id: 'n1', start: 0, end: 1, text: 'Hello' }], duration: 1 })
  assert.equal(captionsOf('hi').length, 1)
  assert.equal(captionsOf('es').length, 1)
})

test('AC5 verdicts: a mismatch fails QA, a match passes, no engine is "unchecked" and never a pass', async () => {
  assert.deepEqual(parseDetectedLanguage('whisper_full_with_state: auto-detected language: hi (p = 0.981234)'), { language: 'hi', probability: 0.981 })
  assert.equal(parseDetectedLanguage('no language here'), null)
  const hears = (language) => async () => ({ available: true, language, probability: 0.9, model: 'ggml-base.bin' })
  const mismatch = await checkSpokenLanguage({ file: 'x.mp4', language: 'hi', detect: hears('en'), offsetSeconds: 1 })
  assert.equal(mismatch.issue.type, 'language_mismatch')
  assert.equal(mismatch.issue.severity, 1)
  assert.equal(mismatch.check.state, 'fail')
  const match = await checkSpokenLanguage({ file: 'x.mp4', language: 'pt-BR', detect: hears('pt'), offsetSeconds: 1 })
  assert.deepEqual([match.issue, match.check.state, match.check.detected], [null, 'pass', 'pt'])
  const unchecked = await checkSpokenLanguage({ file: 'x.mp4', language: 'hi', detect: async () => ({ available: false, reason: 'not installed' }), offsetSeconds: 0 })
  assert.equal(unchecked.check.state, 'unchecked')
  assert.equal(unchecked.issue.type, 'language_unchecked')
  assert.ok(unchecked.issue.severity < 0.5)
})

test('AC5 detector: runs whisper-cli on 16 kHz mono audio from the lane\'s first line and reads the detected language', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-detect-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // A stand-in whisper-cli: records its argv and the wav it was given, answers like the real one.
  const cli = path.join(dir, 'whisper-cli')
  fs.writeFileSync(cli, `#!/bin/sh\necho "$@" > "${dir}/argv"\nwhile [ $# -gt 0 ]; do if [ "$1" = "-f" ]; then cp "$2" "${dir}/seen.wav"; fi; shift; done\necho "whisper_full_with_state: auto-detected language: hi (p = 0.962000)" 1>&2\n`)
  fs.chmodSync(cli, 0o755)
  const model = path.join(dir, 'ggml-base.bin')
  fs.writeFileSync(model, '')
  const media = path.join(dir, 'render.mp4')
  require('node:child_process').execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:a', 'aac', '-y', media])
  const detect = createLanguageDetector({ getEngine: () => ({ binaryPath: cli, modelPath: model }), getFfmpegPath: () => ffmpegPath, seconds: 2 })
  const result = await detect(media, { offsetSeconds: 3 })
  assert.deepEqual(result, { available: true, language: 'hi', probability: 0.962, model: 'ggml-base.bin' })
  const argv = fs.readFileSync(path.join(dir, 'argv'), 'utf8')
  assert.match(argv, /-l auto --detect-language/)
  const probe = require('node:child_process').execFileSync(require('../../electron/studio/ffmpegTools.js').resolveBinaries({}).ffprobePath, ['-v', 'error', '-show_entries', 'stream=sample_rate,channels:format=duration', '-of', 'json', path.join(dir, 'seen.wav')])
  const info = JSON.parse(probe)
  assert.deepEqual([info.streams[0].sample_rate, info.streams[0].channels, Math.round(Number(info.format.duration))], ['16000', 1, 2])
  assert.deepEqual(await createLanguageDetector({ getEngine: () => null })(media), { available: false, reason: 'The local caption engine (whisper) is not installed: install it from Captions to check the spoken language.' })
})
