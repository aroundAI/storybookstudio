// FILM-2014 V2 (AC4, AC5): the pacing and audio analysers on the 20-shot
// rough cut, the visual analyser's script fidelity, its 40-frame cap and its
// skip when no vision model is configured.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { analyseAudio } from '../../src/studio/critic/audio.js'
import { analysePacing, similarity, shotWords } from '../../src/studio/critic/pacing.js'
import { analyseVisual, MAX_VISION_FRAMES, parseVisionIssues, selectFrames, VISION_SEVERITY_CAP } from '../../src/studio/critic/visual.js'
import { QaIssueSchema } from '../../src/studio/contracts/qa-result.schema.mjs'
import { buildMediaProject, clone, FFMPEG, FFPROBE, removeDir, tempDir } from './helpers/review-media.mjs'

const require = createRequire(import.meta.url)
const { createPreviewRenderer } = require('../../electron/studio/previewRender.js')
const { createQa } = require('../../electron/studio/qa.js')
const { createVisionClient } = require('../../electron/studio/visionClient.js')

const renderer = createPreviewRenderer({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE })
const qa = createQa({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE })
let dir
let fixture
const count = (issues) => issues.reduce((map, issue) => ({ ...map, [issue.type]: (map[issue.type] || 0) + 1 }), {})
const valid = (issues) => issues.forEach((issue) => QaIssueSchema.parse(issue))

before(async () => {
  dir = await tempDir('critic')
  fixture = await buildMediaProject(dir)
})
after(() => removeDir(dir))

async function levelsFor(project) {
  const mix = await renderer.renderAudioMix({ project, projectDir: dir, stems: true })
  return qa.measureMixLevels({ file: mix.file, stems: mix.stems })
}

test('pacing on the 20-shot cut: shots inside 1.2–6 s, seven lines that end on their cut, alternating setups repeat', () => {
  const issues = analysePacing({ project: fixture.project, policy: fixture.policy })
  valid(issues)
  assert.deepEqual(count(issues), { dialogue_tight_to_cut: 7, repeated_shot: 18 })
  const tight = issues.find((issue) => issue.type === 'dialogue_tight_to_cut')
  assert.match(tight.detail, /ARJUN 2 \(en\) ends 0\.0 s before S1\.1 cuts/)
  // MAYA and ARJUN alternate on one templated setup: S1.3 repeats S1.1, two shots later.
  const repeat = issues.find((issue) => issue.type === 'repeated_shot')
  assert.match(repeat.detail, /S1\.3 repeats S1\.1 \(100% similar setup\) 2 shots later/)
  assert.ok(issues.every((issue) => issue.severity < 0.5), 'pacing judgments on this cut are advice, not failures')
})

test('pacing reads its bounds from the policy: a 5 s maximum flags the six 6 s shots and a scene that averages over it', () => {
  const issues = analysePacing({ project: fixture.project, policy: { ...fixture.policy, maxShotLength: 5 } })
  assert.equal(count(issues).shot_too_long, 6)
  assert.ok(issues.filter((i) => i.type === 'shot_too_long').every((i) => i.repairIntent === 're-time'))
  assert.equal(count(issues).cut_density, 1)
  const off = analysePacing({ project: fixture.project, policy: { ...fixture.policy, visual: { avoidRepeatedShots: false } } })
  assert.equal(count(off).repeated_shot, undefined)
})

test('pacing: a line that runs past its shot is heard over the next one', () => {
  const project = clone(fixture.project)
  const line = project.timelines[0].clips.find((clip) => clip.name === 'ARJUN 2 (en)')
  line.duration += 1
  const [spill] = analysePacing({ project, policy: fixture.policy }).filter((i) => i.type === 'dialogue_over_cut')
  assert.match(spill.detail, /ARJUN 2 \(en\) runs 1\.0 s past the cut out of S1\.1/)
})

test('semantic similarity ignores the shot number and tells different setups apart', () => {
  const a = shotWords({ metadata: { semantic: {} } }, { semantic: { prompt: 'MAYA turns to the console (shot 1)', characters: ['MAYA'] } })
  const b = shotWords({ metadata: { semantic: {} } }, { semantic: { prompt: 'MAYA turns to the console (shot 9)', characters: ['MAYA'] } })
  const c = shotWords({ metadata: { semantic: {} } }, { semantic: { prompt: 'Wide exterior of the rooftop at dawn, drone shot', characters: [] } })
  assert.ok(Math.abs(similarity(a, b) - 1) < 1e-9)
  assert.ok(similarity(a, c) < 0.3)
})

test('audio on the 20-shot mix: ducked music clears dialogue; only the hard-cut alarm and music end are flagged', async () => {
  const issues = analyseAudio({ project: fixture.project, levels: await levelsFor(fixture.project), policy: fixture.policy })
  valid(issues)
  assert.deepEqual(count(issues), { hard_audio_edge: 3 })
  assert.ok(issues.every((issue) => issue.repairIntent === 'add_fade'))
  assert.deepEqual(issues.map((issue) => issue.timeRange.start).sort((a, b) => a - b), [2.9, 4.9, 98.9])
})

test('audio: loud music over dialogue is measured from the stems and names duck_music', async () => {
  const project = clone(fixture.project)
  for (const clip of project.timelines[0].clips) if (clip.trackId === 'audio-3') clip.gainDb = 20
  const issues = analyseAudio({ project, levels: await levelsFor(project), policy: fixture.policy })
  const masking = issues.filter((issue) => issue.type === 'music_over_dialogue')
  assert.equal(masking.length, 1)
  assert.equal(masking[0].repairIntent, 'duck_music')
  assert.ok(masking[0].severity >= 0.5)
  const ratio = Number(/sits (-?[\d.]+) dB above/.exec(masking[0].detail)[1])
  assert.ok(ratio < 8, `measured ratio ${ratio}`)
})

test('audio: a level jump away from any dialogue edge is abrupt; one at a line edge is not', () => {
  const project = fixture.project
  const series = (value) => Array.from({ length: 100 }, () => value)
  const mix = series(-30)
  for (let i = 50; i < 100; i += 1) mix[i] = -10
  const levels = { windowSeconds: 0.1, from: 30, mix, buses: {} }
  const issues = analyseAudio({ project, levels, policy: fixture.policy })
  assert.equal(count(issues).abrupt_level_change, 1, JSON.stringify(issues))
  assert.equal(issues[0].repairIntent, 'add_fade')
  // The same jump at 0.4 s, where MAYA's first line starts, is the line.
  const atLine = analyseAudio({ project, levels: { ...levels, from: 0.4 - 5 }, policy: fixture.policy })
  assert.equal(count(atLine).abrupt_level_change, undefined)
})

test('visual: with no hosted model the vision part is skipped and says so; script fidelity still runs', async () => {
  const client = createVisionClient({ env: {} })
  assert.equal(client.configured, false)
  const reordered = clone(fixture.project)
  for (const clip of reordered.timelines[0].clips) if (clip.metadata?.semantic?.scene === 1 && clip.trackId === 'video-1') clip.startTime += 200
  const result = await analyseVisual({ project: reordered, pkg: fixture.pkg, frames: [{ time: 1, file: 'x.jpg', scene: 1 }], client })
  assert.equal(result.skipped, true)
  assert.match(result.reason, /No hosted vision model is configured/)
  assert.equal(result.framesSent, 0)
  assert.equal(result.usage, null)
  assert.deepEqual(result.issues.map((issue) => issue.type), ['script_order'])
  assert.match(result.issues[0].detail, /order 2, 3, 4, 5, 1; the screenplay's order is 1, 2, 3, 4, 5/)
})

test('visual: the screenplay character a scene never shows is a script_characters issue', async () => {
  const project = clone(fixture.project)
  for (const asset of project.assets) if (asset.semantic?.scene === 2) asset.semantic.characters = ['MAYA']
  const result = await analyseVisual({ project, pkg: fixture.pkg, frames: [], client: null })
  assert.deepEqual(result.issues.map((issue) => [issue.type, issue.scene]), [['script_characters', 2]])
  assert.match(result.issues[0].detail, /puts ARJUN in scene 2/)
})

test('visual: a configured model sees at most 40 keyframes, cuts first; its findings are capped judgments; token cost is returned', async () => {
  const kf = await renderer.renderKeyframes({ project: fixture.project, projectDir: dir })
  const frames = [...kf.frames, ...kf.frames.map((f) => ({ ...f, time: f.time + 0.5, reason: 'interval' }))]
  assert.ok(frames.length > MAX_VISION_FRAMES)
  const calls = []
  const client = {
    configured: true,
    name: 'fake',
    model: 'fake-vision',
    describe: async (request) => {
      calls.push(request)
      return { text: 'Here you go: [{"frame": 2, "type": "framing", "severity": 0.9, "detail": "MAYA is cut off at the left edge."}, {"frame": 999, "type": "framing", "severity": 1, "detail": "no such frame"}, {"frame": 3, "type": "vibes", "severity": 1, "detail": "unknown type"}]', usage: { inputTokens: 51234, outputTokens: 210, costUsd: 0.21 } }
    },
  }
  const result = await analyseVisual({ project: fixture.project, pkg: fixture.pkg, frames, client })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].images.length, MAX_VISION_FRAMES)
  assert.equal(result.framesSent, MAX_VISION_FRAMES)
  const cutsSent = selectFrames(frames).filter((f) => f.reason === 'cut' || f.reason === 'start').length
  assert.equal(cutsSent, frames.filter((f) => f.reason === 'cut' || f.reason === 'start').length, 'every cut frame goes before interval frames')
  assert.deepEqual(result.issues.map((issue) => issue.type), ['framing'])
  assert.equal(result.issues[0].severity, VISION_SEVERITY_CAP)
  assert.match(result.issues[0].detail, /model judgment/)
  assert.deepEqual(result.usage, { provider: 'fake', model: 'fake-vision', inputTokens: 51234, outputTokens: 210, costUsd: 0.21 })
  assert.deepEqual(parseVisionIssues('not json', frames), [])
})

test('vision client: configured only with a provider and a key; the key never appears in the client', async () => {
  assert.equal(createVisionClient({ env: { STUDIO_VISION_PROVIDER: 'anthropic' } }).configured, false)
  assert.match(createVisionClient({ env: { STUDIO_VISION_PROVIDER: 'other' } }).reason, /no adapter/)
  const requests = []
  const fake = () => ({
    messages: { create: async (body) => { requests.push(body); return { model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '[]' }], usage: { input_tokens: 1000, output_tokens: 10 } } } },
    beta: { messages: { create: async (body) => { requests.push(body); return { model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '[]' }], usage: { input_tokens: 1000000, output_tokens: 1000 } } } } },
  })
  const client = createVisionClient({ env: { STUDIO_VISION_PROVIDER: 'anthropic' }, getSecret: (key) => (key === 'vision.anthropic.apiKey' ? 'sk-test-secret' : null), createAnthropic: fake })
  assert.equal(client.configured, true)
  assert.equal(client.model, 'claude-opus-5-5')
  assert.ok(!JSON.stringify(client).includes('sk-test-secret'))
  const kf = path.join(dir, 'cache', 'kf')
  const { readdirSync } = await import('node:fs')
  const image = path.join(kf, readdirSync(kf).find((name) => name.endsWith('.jpg')))
  const reply = await client.describe({ system: 's', text: 't', images: [image] })
  assert.equal(requests[0].messages[0].content[0].source.media_type, 'image/jpeg')
  assert.equal(requests[0].fallbacks, 'default')
  assert.deepEqual(reply.usage, { model: 'claude-opus-5-5', inputTokens: 1000000, outputTokens: 1000, costUsd: 4.02 })
  const other = createVisionClient({ env: { STUDIO_VISION_PROVIDER: 'anthropic', STUDIO_VISION_MODEL: 'some-future-model', ANTHROPIC_API_KEY: 'k' }, createAnthropic: fake })
  const unpriced = await other.describe({ system: 's', text: 't', images: [] })
  assert.equal(unpriced.usage.costUsd, null, 'an unknown model records tokens, not a guessed price')
  assert.equal(requests.at(-1).fallbacks, undefined)
})
