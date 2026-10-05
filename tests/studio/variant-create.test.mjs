// FILM-2017 AC2-AC4 end to end in the main process, with no editor window:
// studio_create_variant {kind: short} detects the subject on each clip's
// keyframes (bundled FFmpeg, local detectors), writes the crop path as
// keyframes on a 9:16 variant and flags a clip it cannot frame;
// {kind: hook} builds and exports N openings.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { makePulledProject } from './helpers/delivery.mjs'
import { SAFE_AREAS } from '../../src/studio/captions/layout.js'
import { checkCaptionSafeArea } from '../../src/studio/captions/style.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const { createStudioDeliver } = require('../../electron/studio/deliver.js')
const { createJobRegistry } = require('../../electron/studio/jobs.js')
const { createCapabilityTools } = require('../../electron/studio/mcpCapabilities.js')

test('a short variant follows the subject in each shot and flags the shot it cannot frame', async (t) => {
  const { dir } = makePulledProject(t)
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'project.storybookstudio'), 'utf8'))
  const shots = doc.timelines[0].clips.filter((clip) => clip.type === 'video' && clip.startTime < 12 && clip.startTime + clip.duration > 4)
  assert.ok(shots.length >= 2)
  // First shot in range: a lone bright subject at the right; the rest: flat grey (nothing to follow).
  fs.mkdirSync(path.join(dir, 'assets', 'video'), { recursive: true })
  const subject = path.join(dir, 'assets', 'video', 'subject.mp4')
  const flat = path.join(dir, 'assets', 'video', 'flat.mp4')
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x505050:s=640x360:r=24:d=6', '-vf', 'drawbox=x=470:y=140:w=50:h=50:color=white:t=fill', '-pix_fmt', 'yuv420p', subject])
  execFileSync(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x505050:s=640x360:r=24:d=6', '-pix_fmt', 'yuv420p', flat])
  for (const [index, shot] of shots.entries()) {
    const asset = doc.assets.find((entry) => entry.id === shot.assetId)
    Object.assign(asset, { path: index === 0 ? 'assets/video/subject.mp4' : 'assets/video/flat.mp4', width: 640, height: 360 })
  }
  fs.writeFileSync(path.join(dir, 'project.storybookstudio'), JSON.stringify(doc))

  const deliver = createStudioDeliver({ jobs: createJobRegistry(), getMcpServer: () => ({ lastSnapshot: { project: { path: dir } } }), getFfmpegPath: () => ffmpegPath })
  const preview = await deliver.createVariant({ kind: 'short', source: { range: [4, 12] } })
  assert.equal(preview.previewOnly, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'project.storybookstudio'), 'utf8')).timelines.length, 1, 'a preview writes nothing')

  const result = await deliver.createVariant({ kind: 'short', source: { range: [4, 12] }, previewOnly: false })
  assert.equal(result.expectedDuration, 8)
  assert.equal(result.overMaxDuration, false)
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'project.storybookstudio'), 'utf8'))
  const variant = saved.timelines.find((timeline) => timeline.id === result.timelineId)
  assert.equal(variant.studio.kind, 'variant')
  assert.equal(variant.studio.aspect, '9:16')
  assert.equal(variant.studio.variantOf, saved.timelines[0].id)

  const first = result.reframe.find((entry) => entry.clipId === shots[0].id)
  assert.equal(first.detected, true)
  assert.ok(first.largestStepFraction <= 0.15)
  const clip = variant.clips.find((entry) => entry.id === shots[0].id)
  // Subject at x ≈ 0.77 of the source: the window moves right, so positionX is negative.
  assert.ok(clip.keyframes.positionX.every((frame) => frame.value < -800), JSON.stringify(clip.keyframes.positionX))
  assert.ok(Math.abs(clip.keyframes.scaleX[0].value - 316.049) < 0.01)

  const flatShots = result.reframe.filter((entry) => entry.clipId !== shots[0].id)
  assert.ok(flatShots.length >= 1)
  for (const entry of flatShots) {
    assert.equal(entry.detected, false)
    assert.equal(entry.warning.type, 'reframe_no_subject')
  }
  assert.deepEqual(variant.studio.reframeWarnings.map((w) => w.type), flatShots.map(() => 'reframe_no_subject'))

  // Captions re-placed by FILM-2016's styleCaptionCues for 9:16, and inside that safe area.
  const captions = variant.clips.find((entry) => entry.type === 'captions')
  assert.ok(captions.captions.cues.length > 0)
  for (const cue of captions.captions.cues) {
    assert.equal(cue.globalOverrides.aspect, '9:16')
    assert.deepEqual(cue.globalOverrides.safeArea, { ...SAFE_AREAS['9:16'] })
  }
  assert.deepEqual(checkCaptionSafeArea({ cues: captions.captions.cues, width: 1080, height: 1920, aspect: '9:16' }), [])
})

test('the agent profile reaches the tools: studio_create_variant previews, studio_deliver confirm:true without the token is FORBIDDEN', async (t) => {
  const { dir } = makePulledProject(t)
  const deliver = createStudioDeliver({ jobs: createJobRegistry(), getMcpServer: () => ({ lastSnapshot: { project: { path: dir } } }) })
  const capabilities = createCapabilityTools({ callPrimitive: async () => ({}), getDeliver: () => deliver, getSnapshot: () => ({ project: { path: dir } }) })
  const parse = (result) => JSON.parse(result.content[0].text)
  const variant = await capabilities.call('studio_create_variant', { kind: 'short', params: { source: { range: [4, 12] } } })
  assert.equal(variant.isError, undefined, JSON.stringify(variant))
  assert.equal(parse(variant).previewOnly, true)
  assert.equal(parse(variant).expectedDuration, 8)
  const [card] = parse(variant).cards
  assert.deepEqual(Object.keys(card).sort(), ['changes', 'durationAfter', 'durationBefore', 'heading', 'notes', 'scene', 'targetDuration', 'touchesYourEdits'])
  assert.deepEqual(card.changes.map((change) => change.tool), ['studio_insert_timeline', 'set_clip_keyframes', 'update_caption_cues'])
  const language = await capabilities.call('studio_create_variant', { kind: 'language', params: { language: 'hi' } })
  assert.equal(language.isError, true)
  assert.match(parse(language).error.message, /FILM-2019/)
  const summary = parse(await capabilities.call('studio_deliver', { presets: ['youtube_16x9'], destination: 'folder', folder: dir }))
  assert.match(summary.summaryHash, /^[0-9a-f]{64}$/)
  const refused = await capabilities.call('studio_deliver', { presets: ['youtube_16x9'], destination: 'folder', folder: dir, confirm: true })
  assert.equal(refused.isError, true)
  assert.equal(parse(refused).error.code, 'FORBIDDEN')
})

test('hook variants are added to the project and each exported as its own file', async (t) => {
  const { dir } = makePulledProject(t)
  const exported = []
  const deliver = createStudioDeliver({
    jobs: createJobRegistry(),
    getMcpServer: () => ({ lastSnapshot: { project: { path: dir } } }),
    render: async ({ outputPath, timelineId }) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      fs.writeFileSync(outputPath, 'mp4')
      exported.push({ outputPath, timelineId })
      return { outputPath, durationSeconds: 5 }
    },
  })
  const result = await deliver.createVariant({ kind: 'hook', variants: 2, previewOnly: false })
  assert.equal(result.variants.length, 2)
  assert.deepEqual(result.files.map((file) => path.relative(dir, file.file)), ['renders/latest/hooks/hook-1-en.mp4', 'renders/latest/hooks/hook-2-en.mp4'])
  assert.deepEqual(exported.map((entry) => entry.timelineId), ['timeline-hook-1', 'timeline-hook-2'])
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'project.storybookstudio'), 'utf8'))
  assert.deepEqual(saved.timelines.map((timeline) => timeline.studio?.variantKind ?? timeline.studio?.kind), ['master', 'hook', 'hook'])
})
