// FILM-2016 AC6: studio_add_captions {language, style?} compiles to
// transcribe_captions (whisper.cpp), then update_caption_cues with the
// styled, safe-area-placed cues on the language's live captions clip, then
// the QA caption check; emphasis words styled where a cue has them. Also:
// the ASR mixdown of a bussed project hears dialogue and shot audio only.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'

import { captionsClipFor, compileCaptionsAfterTranscription, compileCaptionsIntent, whisperLanguage } from '../../src/studio/intents/captions.js'
import { checkCaptionSafeArea, layoutCue, SAFE_AREAS } from '../../src/studio/captions/style.js'
import { blockInsideSafeRect } from '../../src/studio/captions/layout.js'
import { buildProject } from '../../src/studio/projectBuilder.js'
import { loadFixture, probesFor } from './helpers/rough-cut.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const brand = { fonts: { body: 'Montserrat' }, colors: { captionText: '#FFFFFF', primary: '#E11D48' }, captionStyle: { fontSize: 52, position: 'bottom', background: 'box', emphasis: 'color', emphasisWords: ['vault'] } }
const draft = [
  { id: 'cue-1', start: 0.4, end: 2.0, text: 'Line 1: MAYA says what the scene needs.' },
  { id: 'cue-2', start: 2.4, end: 4.0, text: 'The vault closes in ninety seconds!' },
  { id: 'cue-3', start: 4.4, end: 6.0, text: 'Then we run, now.' },
]

const roughCut = (shots = 20) => {
  const pkg = loadFixture(shots)
  const { project } = buildProject({ package: pkg, probedAssets: probesFor(pkg) })
  return { project, timeline: project.timelines[0] }
}
// A 9:16 variant of the master (FILM-2017 makes these; here: same clips, vertical frame).
const vertical = (timeline) => ({ ...timeline, width: 1080, height: 1920, studio: { ...timeline.studio, kind: 'variant', variantOf: timeline.id, aspect: '9:16' } })

test('phase 1: transcribe_captions over the timeline with the whisper language hint, and a continuation', () => {
  const { timeline } = roughCut()
  const plan = compileCaptionsIntent({ params: { language: 'hi' }, context: { timeline }, brand })
  assert.deepEqual(plan.steps.map((entry) => entry.tool), ['transcribe_captions'])
  assert.equal(plan.steps[0].arguments.language, 'Hindi')
  assert.equal(plan.steps[0].arguments.scope, 'timeline')
  assert.match(plan.steps[0].arguments.studioMeta.reason, /whisper/)
  assert.equal(plan.continueWith, 'captions.afterTranscription')
  assert.equal(whisperLanguage('pt-BR'), 'Portuguese')
  assert.equal(whisperLanguage('xx'), 'Auto')
  assert.equal(compileCaptionsIntent({ params: {}, context: { timeline } }).refused.code, 'VALIDATION_FAILED')
  assert.match(compileCaptionsIntent({ params: { language: 'en', style: { fontSize: 5000 } }, context: { timeline } }).refused.reason, /fontSize/)
})

test('phase 2: update_caption_cues on the language clip with styled cues and the brand preset; QA hook named', () => {
  const { timeline } = roughCut()
  const clip = captionsClipFor({ timeline }, 'en')
  assert.ok(clip, 'the rough cut has an en captions clip')
  const plan = compileCaptionsAfterTranscription({ cues: draft, params: { language: 'en', style: { emphasisWords: ['now'] } }, context: { timeline }, brand })
  assert.deepEqual(plan.steps.map((entry) => entry.tool), ['update_caption_cues'])
  const args = plan.steps[0].arguments
  assert.equal(args.clipId, clip.id)
  assert.deepEqual(args.preset, { id: 'kinetic-traditional', fontFamily: 'Montserrat', textColor: '#FFFFFF', subtitleColor: '#FFFFFF', subtitleTextStyle: 'background' })
  for (const cue of args.cues) assert.deepEqual(cue.globalOverrides.safeArea, { ...SAFE_AREAS['16:9'] })
  // emphasis words from the brand preset and the call, where a cue has them
  assert.deepEqual(plan.expected.emphasized, [{ cueId: 'cue-2', words: ['vault'] }, { cueId: 'cue-3', words: ['now.'] }])
  assert.deepEqual(plan.qa, [{ check: 'caption_safe_area', language: 'en', clipId: clip.id, aspect: '16:9' }])
  assert.deepEqual(plan.expected.safeAreaIssues, [])
  assert.match(args.studioMeta.reason, /brand caption style/)
})

test('captions on a 9:16 variant stay inside the safe rectangle (QA check passes); the 16:9 placement on it fails', () => {
  const { timeline } = roughCut()
  const variant = vertical(timeline)
  const plan = compileCaptionsAfterTranscription({ cues: draft, params: { language: 'en' }, context: { timeline: variant }, brand })
  const cues = plan.steps.at(-1).arguments.cues
  assert.equal(plan.qa[0].aspect, '9:16')
  for (const cue of cues) {
    assert.deepEqual(cue.globalOverrides.safeArea, { ...SAFE_AREAS['9:16'] })
    const layout = layoutCue(cue, { width: 1080, height: 1920 })
    assert.ok(blockInsideSafeRect(layout), cue.id)
    assert.ok(layout.box.y + layout.box.height <= 1920 * 0.75 + 0.5, 'above the bottom 25 %')
    assert.ok(layout.box.x + layout.box.width <= 1080 * 0.85 + 0.5, 'clear of the right 15 %')
  }
  assert.deepEqual(checkCaptionSafeArea({ cues, width: 1080, height: 1920 }), [])
  const wide = compileCaptionsAfterTranscription({ cues: draft, params: { language: 'en' }, context: { timeline }, brand }).steps.at(-1).arguments.cues
  assert.ok(checkCaptionSafeArea({ cues: wide, width: 1080, height: 1920 }).every((issue) => issue.type === 'caption_safe_area'))
  assert.equal(checkCaptionSafeArea({ cues: wide, width: 1080, height: 1920 }).length, 3)
})

test('no clip for the language: generate_captions places one, then the cues are styled; another language present is refused', () => {
  const { timeline } = roughCut()
  const bare = { ...timeline, tracks: timeline.tracks.filter((track) => track.role !== 'captions'), clips: timeline.clips.filter((clip) => clip.type !== 'captions') }
  const plan = compileCaptionsAfterTranscription({ cues: draft, params: { language: 'en' }, context: { timeline: bare }, brand })
  assert.deepEqual(plan.steps.map((entry) => entry.tool), ['generate_captions', 'update_caption_cues'])
  assert.equal(plan.steps[0].arguments.presetId, 'kinetic-traditional')
  assert.equal(plan.steps[1].arguments.target, 'clip')
  const refused = compileCaptionsAfterTranscription({ cues: draft, params: { language: 'fr' }, context: { timeline }, brand })
  assert.match(refused.refused.reason, /no captions clip for fr/)
  assert.equal(compileCaptionsAfterTranscription({ cues: [], params: { language: 'en' }, context: { timeline } }).refused.code, 'VALIDATION_FAILED')
})

test('the 60-shot package: the Hindi captions clip is found by language', () => {
  const { timeline } = roughCut(60)
  const hi = captionsClipFor({ timeline }, 'hi')
  assert.ok(hi)
  const plan = compileCaptionsAfterTranscription({ cues: draft, params: { language: 'hi' }, context: { timeline }, brand })
  assert.equal(plan.steps[0].arguments.clipId, hi.id)
})

test('policy captions.style plain keeps the Studio look but still places cues in the safe area', () => {
  const { timeline } = roughCut()
  const plan = compileCaptionsAfterTranscription({ cues: draft, params: { language: 'en' }, context: { timeline: vertical(timeline) }, brand, policy: { captions: { style: 'plain' } } })
  const args = plan.steps.at(-1).arguments
  assert.deepEqual(args.preset, { id: 'kinetic-traditional' })
  assert.deepEqual(args.cues[0].globalOverrides.safeArea, { ...SAFE_AREAS['9:16'] })
  assert.deepEqual(plan.expected.emphasized, [])
})

// ---- the ASR mixdown (src/services/timelineAudioMix.js, bundled) -------------

test('transcription of a bussed project hears dialogue and shot audio; music, sfx and ambience are muted for the ASR mix', async () => {
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {}, removeItem() {} }, configurable: true, writable: true })
  globalThis.document ??= { createElement: () => ({ getContext: () => null, style: {} }), addEventListener() {} }
  let sent = null
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    electronAPI: {
      mixTimelineAudioForCaptions: async (payload) => { sent = payload; return { success: true, outputPath: '/tmp/x.wav' } },
      readFileAsBuffer: async () => ({ success: true, data: new Uint8Array(44) }),
    },
  }
  const entry = "export { mixTimelineAudioToWav } from './src/services/timelineAudioMix.js'\nexport { default as useTimelineStore } from './src/stores/timelineStore'\nexport { default as useAssetsStore } from './src/stores/assetsStore'"
  const out = await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error', loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' } })
  const { mixTimelineAudioToWav, useTimelineStore, useAssetsStore } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
  const tracks = [
    { id: 'a1', type: 'audio', bus: 'dialogue', language: 'en', muted: false, visible: true },
    { id: 'a2', type: 'audio', bus: 'shotaudio', muted: false, visible: true },
    { id: 'a3', type: 'audio', bus: 'music', muted: false, visible: true },
    { id: 'a4', type: 'audio', bus: 'ambience', muted: false, visible: true },
    { id: 'a5', type: 'audio', muted: false, visible: true },
  ]
  useTimelineStore.setState({ tracks, clips: tracks.map((track, index) => ({ id: `c${index}`, type: 'audio', trackId: track.id, assetId: `s${index}`, startTime: 0, duration: 4, trimStart: 0, enabled: true })) })
  useAssetsStore.setState({ assets: tracks.map((_, index) => ({ id: `s${index}`, type: 'audio', path: `s${index}.wav`, hasAudio: true })) })
  await mixTimelineAudioToWav({})
  assert.deepEqual(Object.fromEntries(sent.tracks.map((track) => [track.id, track.muted])), { a1: false, a2: false, a3: true, a4: true, a5: false })
})

test('two caption languages: styling one never touches the other (no generate_captions, which drops other captions clips)', async () => {
  const { compileCaptions, compileCaptionsPlacement } = await import('../../src/studio/intents/captions.js')
  const { timeline } = roughCut(60)
  const en = captionsClipFor({ timeline }, 'en')
  const hi = captionsClipFor({ timeline }, 'hi')
  assert.ok(en && hi && en.id !== hi.id)
  for (const [language, clip] of [['en', en], ['hi', hi]]) {
    const plan = compileCaptionsPlacement({ timeline, brand }, draft, { language })
    assert.deepEqual(plan.steps.map((entry) => entry.tool), ['update_caption_cues'], language)
    assert.equal(plan.steps[0].arguments.clipId, clip.id, `${language} targets its own clip by id`)
    assert.equal(plan.steps.some((entry) => entry.arguments.target === 'clip'), false, 'never "the first captions clip"')
  }
  // a third language with no clip is refused rather than placed over the others
  assert.match(compileCaptionsPlacement({ timeline, brand }, draft, { language: 'fr' }).refused.reason, /no captions clip for fr/)
  assert.equal(compileCaptions({ timeline, brand }, 'episode', { language: 'hi' }).steps[0].arguments.language, 'Hindi')
})
