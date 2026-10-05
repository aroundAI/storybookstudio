// FILM-2019 integration, rendered with the bundled FFmpeg through the
// delivery path the app uses (deliveryPath: previewRender + qa.js):
// - the spec's fixture: StoryBook's Hindi dub arrives by re-sync; studio_create_variant
//   {kind: language, language: hi} lays it on the master, places Devanagari
//   captions in the safe area, renders 16:9 and 9:16 in Hindi, and each render
//   passes QA including the spoken-language check (AC3, AC5);
// - a dub that speaks the wrong language fails QA and is not uploaded (AC5);
// - EN, HI and ES in 16:9 and 9:16 from one master pass QA and StoryBook gets
//   a render row per language (AC6);
// - burned Devanagari is shaped (conjuncts, vowel signs in order) and kept in
//   the 9:16 safe area.
// The spoken-language check runs a tone detector here (helpers/languages.mjs);
// with STUDIO_WHISPER_CLI and STUDIO_WHISPER_MODEL set, the last test runs
// whisper.cpp on synthesized Hindi speech.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { makeLanguageProject, toneDetector, TEXTS } from './helpers/languages.mjs'
import { fakePrepare, fakeStoryBook, waitForJob, SESSION_ID } from './helpers/delivery.mjs'
import { checkCaptionSafeArea } from '../../src/studio/captions/style.js'
import { SAFE_AREAS } from '../../src/studio/captions/layout.js'
import { captionAssScript } from '../../src/studio/review/renderGraph.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const { createStudioDeliver } = require('../../electron/studio/deliver.js')
const { createDeliveryPath } = require('../../electron/studio/deliveryPath.js')
const { createPreviewRenderer } = require('../../electron/studio/previewRender.js')
const { createLanguageDetector } = require('../../electron/studio/languageCheck.js')
const { createJobRegistry } = require('../../electron/studio/jobs.js')
const { createStoryBookClient } = require('../../electron/studio/client.js')

const DEVANAGARI = /[ऀ-ॿ]/
const saved = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'project.storybookstudio'), 'utf8'))

function deliverFor(dir, extra = {}) {
  const delivery = createDeliveryPath({ ffmpegPath })
  return createStudioDeliver({
    jobs: createJobRegistry(),
    getMcpServer: () => ({ lastSnapshot: { project: { path: dir } } }),
    getFfmpegPath: () => ffmpegPath,
    render: delivery.render,
    qa: delivery.check,
    detectLanguage: toneDetector,
    ...extra,
  })
}

test('the spec\'s fixture: dubbed Hindi lines become a lane, Devanagari captions sit in the safe area, and each Hindi render passes the language check', async (t) => {
  const { dir, pkg } = makeLanguageProject(t)
  const deliver = deliverFor(dir)
  const preview = await deliver.createVariant({ kind: 'language', language: 'hi', presets: ['youtube_16x9', 'shorts_9x16'] })
  assert.equal(preview.previewOnly, true)
  assert.deepEqual(preview.lines, { dubbed: 3, placed: 3, offline: 0, fitted: 0 })
  assert.deepEqual(preview.cards[0].changes.map((change) => change.tool), ['studio_apply_language_lane', 'studio_apply_language_lane'])
  assert.equal(saved(dir).timelines[0].tracks.some((track) => track.language === 'hi'), false, 'a preview writes nothing')

  const result = await deliver.createVariant({ kind: 'language', language: 'hi', presets: ['youtube_16x9', 'shorts_9x16'], previewOnly: false })
  assert.equal(result.applied, true)
  const master = saved(dir).timelines[0]
  const lane = master.clips.filter((clip) => clip.metadata?.language === 'hi')
  assert.deepEqual(lane.map((clip) => clip.type).sort(), ['audio', 'audio', 'audio', 'captions'])
  const enStarts = master.clips.filter((clip) => clip.metadata?.language === 'en' && clip.type === 'audio').map((clip) => clip.startTime)
  assert.deepEqual(lane.filter((clip) => clip.type === 'audio').map((clip) => clip.startTime), enStarts, 'each dub at its line\'s start')
  const captions = lane.find((clip) => clip.type === 'captions')
  assert.deepEqual(captions.captions.cues.map((cue) => cue.text), TEXTS.hi.slice(0, 3))
  assert.deepEqual(checkCaptionSafeArea({ cues: captions.captions.cues, width: 1920, height: 1080, aspect: '16:9' }), [])
  assert.ok(saved(dir).assets.filter((asset) => asset.language === 'hi').every((asset) => fs.existsSync(path.join(dir, asset.path))))

  assert.deepEqual(result.renders.map((entry) => [entry.preset, entry.language, path.relative(dir, entry.file)]), [
    ['youtube_16x9', 'hi', 'renders/latest/languages/youtube_16x9-hi.mp4'],
    ['shorts_9x16', 'hi', 'renders/latest/languages/shorts_9x16-hi.mp4'],
  ])
  for (const entry of result.renders) {
    assert.equal(entry.qa.pass, true, JSON.stringify(entry.qa.issues))
    assert.equal(entry.languageCheck.state, 'pass')
    assert.equal(entry.languageCheck.detected, 'hi')
  }
  assert.equal(result.renders[0].captionsFile && fs.readFileSync(result.renders[0].captionsFile, 'utf8').split('\n').filter((line) => DEVANAGARI.test(line)).length, 3, 'the 16:9 sidecar carries the Hindi cues')
  assert.equal(result.renders[1].captionCues, 3, 'the 9:16 render burns the Hindi cues')
  assert.equal(pkg.dubbed[0].language, 'hi')
})

test('a dub that speaks another language fails the language check and is not uploaded', async (t) => {
  const { dir } = makeLanguageProject(t, { languages: ['hi'], dubTones: { hi: 880 } })
  const deliver = deliverFor(dir)
  const result = await deliver.createVariant({ kind: 'language', language: 'hi', presets: ['youtube_16x9'], previewOnly: false })
  const [render] = result.renders
  assert.equal(render.qa.pass, false)
  assert.deepEqual(render.qa.issues.filter((issue) => issue.severity >= 0.5).map((issue) => issue.type), ['language_mismatch'])
  assert.match(render.qa.issues.find((issue) => issue.type === 'language_mismatch').detail, /The hi render speaks es/)

  // Through Deliver to StoryBook: QA_FAILED, nothing requested for upload.
  const storybook = await fakeStoryBook(t)
  const client = createStoryBookClient({ apiOrigin: storybook.origin, auth: { getAccessToken: async () => 'token', refresh: async () => ({ ok: false }), onSignInRequired() {} } })
  t.after(() => client.close())
  const jobs = createJobRegistry()
  const signedIn = deliverFor(dir, { jobs, getOpenProject: () => ({ projectDir: dir, apiOrigin: storybook.origin, sessionId: SESSION_ID }), getClient: () => client, prepare: fakePrepare({ dir }) })
  const args = { presets: ['youtube_16x9'], languages: ['hi'] }
  const { summaryHash } = await signedIn.studioDeliver(args)
  const { jobId } = await signedIn.studioDeliver({ ...args, confirm: true, confirmationToken: signedIn.issueConfirmationToken(summaryHash).token })
  const job = await waitForJob(jobs, jobId, 120000)
  assert.equal(job.status, 'failed')
  assert.equal(job.failure.code, 'QA_FAILED')
  assert.equal(storybook.calls.filter((call) => call.name === 'request_render_upload').length, 0)
})

test('AC6: EN, HI and ES in 16:9 and 9:16 from one master pass QA, and StoryBook gets a render row per language', async (t) => {
  const { dir } = makeLanguageProject(t)
  for (const language of ['hi', 'es']) await deliverFor(dir).createVariant({ kind: 'language', language, previewOnly: false, exportFiles: false })
  const master = saved(dir).timelines[0]
  assert.deepEqual(master.tracks.filter((track) => track.language).map((track) => track.name), ['Captions (en)', 'Captions (es)', 'Captions (hi)', 'Dialogue (en)', 'Dialogue (es)', 'Dialogue (hi)'].sort((a, b) => master.tracks.findIndex((track) => track.name === a) - master.tracks.findIndex((track) => track.name === b)))
  assert.equal(master.tracks.filter((track) => track.role === 'captions').length, 3, 'one captions track per language, none dropped')

  const storybook = await fakeStoryBook(t)
  const client = createStoryBookClient({ apiOrigin: storybook.origin, auth: { getAccessToken: async () => 'token', refresh: async () => ({ ok: false }), onSignInRequired() {} } })
  t.after(() => client.close())
  const jobs = createJobRegistry()
  const deliver = deliverFor(dir, { jobs, getOpenProject: () => ({ projectDir: dir, apiOrigin: storybook.origin, sessionId: SESSION_ID }), getClient: () => client, prepare: fakePrepare({ dir }) })
  const args = { presets: ['youtube_16x9', 'shorts_9x16'], languages: ['en', 'hi', 'es'] }
  const { summaryHash, summary } = await deliver.studioDeliver(args)
  assert.equal(summary.renders.length, 6)
  const { jobId } = await deliver.studioDeliver({ ...args, confirm: true, confirmationToken: deliver.issueConfirmationToken(summaryHash).token })
  const job = await waitForJob(jobs, jobId, 300000)
  assert.equal(job.status, 'done', JSON.stringify(job.failure || job.error))

  const uploads = storybook.calls.filter((call) => call.name === 'request_render_upload').map(({ input }) => `${input.preset}-${input.language}-${input.aspect}`)
  assert.deepEqual(uploads, ['youtube_16x9-en-16:9', 'youtube_16x9-hi-16:9', 'youtube_16x9-es-16:9', 'shorts_9x16-en-9:16', 'shorts_9x16-hi-9:16', 'shorts_9x16-es-9:16'])
  for (const call of storybook.calls.filter((entry) => entry.name === 'finalize_render')) assert.equal(call.input.qa.pass, true, JSON.stringify(call.input.qa))
  assert.deepEqual(storybook.delivered.renders.map((render) => render.language), ['en', 'hi', 'es', 'en', 'hi', 'es'])
  assert.equal(storybook.delivered.qa.pass, true)
  // Each file speaks its own language.
  for (const language of ['en', 'hi', 'es']) {
    for (const preset of ['youtube_16x9', 'shorts_9x16']) {
      const file = path.join(dir, 'renders', 'v2', `${preset}-${language}.mp4`)
      assert.ok(fs.existsSync(file), file)
    }
  }
  assert.deepEqual(job.result.renders.map((render) => render.qa.pass), [true, true, true, true, true, true])
})

// Burned Devanagari: one frame of a 9:16 delivery-size render of a cue placed
// for the 16:9 master, through previewRender (the delivery path's picture).
const frameOf = (file, at, out) => {
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-ss', String(at), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', out])
  return fs.readFileSync(out)
}

test('burned Devanagari is shaped by libass (conjuncts and vowel signs in order) and sits in the 9:16 safe area', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-devanagari-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const width = 540
  const height = 960
  const text = 'यह क्षत्रिय की तलवार है।'
  // A cue placed for 16:9 by the lane (globalOverrides.safeArea of 16:9).
  const cue = { id: 'c1', start: 0, end: 2, text, globalOverrides: { aspect: '16:9', safeArea: { ...SAFE_AREAS['16:9'] }, subtitlePosition: 'bottom', sizeScale: 1, maxCharsPerLine: 32 } }
  const project = {
    timelines: [{
      id: 'tl', width: 1920, height: 1080, fps: 24, studio: { kind: 'master', aspect: '16:9', language: 'en' },
      tracks: [{ id: 'video-2', type: 'video', role: 'captions', language: 'hi', visible: true }, { id: 'video-1', type: 'video', visible: true }],
      clips: [
        { id: 'pic', trackId: 'video-1', type: 'image', assetId: 'grey', startTime: 0, duration: 2, trimStart: 0 },
        { id: 'cap', trackId: 'video-2', type: 'captions', startTime: 0, duration: 2, trimStart: 0, metadata: { language: 'hi' }, captions: { preset: { id: 'kinetic-traditional' }, cues: [cue] } },
      ],
    }],
    currentTimelineId: 'tl',
    assets: [{ id: 'grey', type: 'image', path: 'grey.png', width: 1920, height: 1080 }],
  }
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=1920x1080', '-frames:v', '1', path.join(dir, 'grey.png')])
  const renderer = createPreviewRenderer({ ffmpegPath })
  const out = path.join(dir, 'hi-9x16.mp4')
  const rendered = await renderer.renderVideo({ project, projectDir: dir, timelineId: 'tl', output: out, size: { width, height }, fps: 24, encoder: 'libx264', fullSize: true, captions: true, captionsSafeArea: '9:16', language: 'hi', audio: false })
  assert.equal(rendered.captionCues, 1)
  const frame = frameOf(out, 1, path.join(dir, 'frame.gray'))
  const bare = path.join(dir, 'bare.mp4')
  await renderer.renderVideo({ project, projectDir: dir, timelineId: 'tl', output: bare, size: { width, height }, fps: 24, encoder: 'libx264', fullSize: true, captions: false, audio: false })
  const background = frameOf(bare, 1, path.join(dir, 'bare.gray'))

  // Where the caption is drawn: every pixel the captions changed (the master is boxed, so bars are black).
  let [minX, minY, maxX, maxY] = [width, height, -1, -1]
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (Math.abs(frame[y * width + x] - background[y * width + x]) > 24) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      }
    }
  }
  assert.ok(maxX > 0, 'the caption is drawn')
  const safe = SAFE_AREAS['9:16']
  assert.ok(maxY <= height * (1 - safe.bottom), `caption bottom ${maxY} is above the 9:16 safe line ${height * (1 - safe.bottom)}`)
  assert.ok(minX >= width * safe.left - 1 && maxX <= width * (1 - safe.right) + 1, `caption x ${minX}-${maxX} inside ${width * safe.left}-${width * (1 - safe.right)}`)

  // Shaped: the same script through libass with complex shaping draws these
  // pixels; with simple shaping (what the subtitles filter and drawtext did)
  // the conjunct and the i-sign come out differently.
  const placed = { ...cue, globalOverrides: { ...cue.globalOverrides, aspect: '9:16', safeArea: { ...safe } } }
  const script = path.join(dir, 'ref.ass')
  fs.writeFileSync(script, captionAssScript([{ start: 0, end: 2, text, cue: placed, clip: project.timelines[0].clips[1] }], { width, height }))
  const reference = (shaping) => {
    const file = path.join(dir, `ref-${shaping}.gray`)
    execFileSync(ffmpegPath, ['-v', 'error', '-y', '-i', bare, '-ss', '1', '-vf', `ass='${script}':shaping=${shaping}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', file])
    return fs.readFileSync(file)
  }
  const differs = (a, b) => {
    let count = 0
    for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > 48) count += 1
    return count
  }
  assert.ok(differs(frame, reference('complex')) < 200, `the render matches complex shaping (${differs(frame, reference('complex'))} pixels differ)`)
  assert.ok(differs(frame, reference('simple')) > 400, `and not simple shaping (${differs(frame, reference('simple'))} pixels differ)`)
})

const whisper = { binaryPath: process.env.STUDIO_WHISPER_CLI, modelPath: process.env.STUDIO_WHISPER_MODEL }
const sayHas = (voice) => process.platform === 'darwin' && spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout?.includes(voice)
test('whisper.cpp hears Hindi in the Hindi render and English in the English one', { skip: !(whisper.binaryPath && whisper.modelPath && sayHas('Lekha')) && 'set STUDIO_WHISPER_CLI and STUDIO_WHISPER_MODEL (macOS, the Lekha voice)' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-whisper-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const detect = createLanguageDetector({ getEngine: () => whisper, getFfmpegPath: () => ffmpegPath })
  const speak = (voice, words, name) => {
    const aiff = path.join(dir, `${name}.aiff`)
    execFileSync('say', ['-v', voice, '-o', aiff, words])
    const mp4 = path.join(dir, `${name}.mp4`)
    execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24', '-i', aiff, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', mp4])
    return mp4
  }
  const hindi = await detect(speak('Lekha', TEXTS.hi.join(' '), 'hi'))
  assert.equal(hindi.language, 'hi', JSON.stringify(hindi))
  const english = await detect(speak('Samantha', 'We have to go now. Did you hear that sound? Close the door, quickly.', 'en'))
  assert.equal(english.language, 'en', JSON.stringify(english))
})
