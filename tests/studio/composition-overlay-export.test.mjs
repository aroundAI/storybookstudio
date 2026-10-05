// FILM-2018 AC1: an export composites a composition clip's render as an
// alpha overlay. A grey shot plays 0-4 s on the lower track; a counter sits
// 1-3 s on the track above. The render (the test-card engine: a red box on a
// transparent frame) is made by compositionRenderer.js and the export by the
// Studio's render path (previewRender.renderVideo, which delivery uses). The
// frames say: grey before and after the graphic; inside it, red in the box
// and still grey around it (the alpha held).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createTestcardEngine, BOX } from './helpers/testcard-engine.mjs'
import { FFMPEG, FFPROBE, ff, removeDir, tempDir } from './helpers/review-media.mjs'

const require = createRequire(import.meta.url)
const { createCompositionRenderer } = require('../../electron/studio/compositionRenderer.js')
const { createPreviewRenderer } = require('../../electron/studio/previewRender.js')
const run = promisify(execFile)

const W = 320
const H = 180
const RED = [0xdc, 0x26, 0x26]
const GREY = [0x80, 0x80, 0x80]

async function pixel(file, time, x, y) {
  const { stdout } = await run(FFMPEG, ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x - (x % 2)}:${y - (y % 2)},format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' })
  return [...stdout.subarray(0, 3)]
}

const near = (actual, expected, label, tolerance = 24) => {
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance), `${label}: expected ~${expected}, got ${actual}`)
}

async function fixture(t) {
  const dir = await tempDir('composition-export')
  t.after(() => removeDir(dir))
  await mkdir(path.join(dir, 'media'), { recursive: true })
  await mkdir(path.join(dir, 'storybook'), { recursive: true })
  await writeFile(path.join(dir, 'storybook', 'brand.json'), JSON.stringify({ colors: { primary: '#DC2626' } }))
  await ff(['-f', 'lavfi', '-i', `color=c=0x808080:s=${W}x${H}:r=24:d=4`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'media', 'grey.mp4')])
  const composition = { engine: 'testcard', compositionId: 'counter', props: { from: 0, to: 87, decimals: 0, prefix: '', suffix: '%', label: '', anchor: 'center' }, propsHash: null, renderPath: null, languageDependency: 'none' }
  const project = {
    settings: { width: W, height: H, fps: 24 },
    currentTimelineId: 't1',
    assets: [{ id: 'grey', type: 'video', path: 'media/grey.mp4', settings: { width: W, height: H } }],
    timelines: [{
      id: 't1', width: W, height: H, fps: 24,
      tracks: [{ id: 'video-2', type: 'video', visible: true }, { id: 'video-1', type: 'video', visible: true }],
      clips: [
        { id: 'shot', type: 'video', trackId: 'video-1', assetId: 'grey', startTime: 0, duration: 4, trimStart: 0, speed: 1 },
        { id: 'counter', type: 'composition', name: 'Counter', trackId: 'video-2', assetId: null, startTime: 1, duration: 2, sourceDuration: 2, trimStart: 0, composition },
      ],
    }],
  }
  return { dir, project, counter: project.timelines[0].clips[1] }
}

async function renderComposition(dir, clip, engine = createTestcardEngine()) {
  const renderer = createCompositionRenderer({ engines: { testcard: engine } })
  const result = await renderer.render({ projectDir: dir, engine: 'testcard', compositionId: 'counter', props: clip.composition.props, durationSeconds: clip.sourceDuration, width: W, height: H, fps: 24 })
  Object.assign(clip.composition, { propsHash: result.propsHash, renderPath: result.renderPath })
  return result
}

test('the render is an alpha WebM: VP9 with alpha_mode 1', async (t) => {
  const { dir, counter } = await fixture(t)
  const { file } = await renderComposition(dir, counter)
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name:stream_tags=alpha_mode', '-of', 'json', file])
  const stream = JSON.parse(stdout).streams[0]
  assert.equal(stream.codec_name, 'vp9')
  assert.equal(stream.tags?.alpha_mode ?? stream.tags?.ALPHA_MODE, '1')
})

test('an export composites the render over the shot below, only while the clip plays', async (t) => {
  const { dir, project, counter } = await fixture(t)
  await renderComposition(dir, counter)
  const out = path.join(dir, 'out.mp4')
  const result = await createPreviewRenderer({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE }).renderVideo({ project, projectDir: dir, fullSize: true, fps: 24, audio: false, captions: false, output: out })
  assert.equal(result.compositions, 1)
  const centre = [W / 2, H / 2]
  const outside = [Math.round(W * BOX.x) - 20, Math.round(H * BOX.y) - 20]
  near(await pixel(out, 0.5, ...centre), GREY, 'before the clip, the centre shows the shot')
  near(await pixel(out, 2.0, ...centre), RED, 'inside the clip, the box is the brand primary')
  near(await pixel(out, 2.0, ...outside), GREY, 'inside the clip, transparent pixels show the shot')
  near(await pixel(out, 3.5, ...centre), GREY, 'after the clip, the shot again')
})

test('a trimmed composition clip starts into its render; opacity is kept', async (t) => {
  const { dir, project, counter } = await fixture(t)
  // The render shows its box from 1 s; the clip is trimmed by 1 s, so the
  // box is on screen from the clip's first frame (timeline 1 s).
  counter.sourceDuration = 3
  await renderComposition(dir, counter, createTestcardEngine({ boxFrom: 1 }))
  Object.assign(counter, { trimStart: 1, duration: 2, transform: { opacity: 50 } })
  const out = path.join(dir, 'out.mp4')
  await createPreviewRenderer({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE }).renderVideo({ project, projectDir: dir, fullSize: true, fps: 24, audio: false, captions: false, output: out })
  const half = RED.map((value, i) => Math.round((value + GREY[i]) / 2))
  near(await pixel(out, 1.25, W / 2, H / 2), half, 'trimmed: the box is up at the clip start, at half opacity')
})

test('an export refuses a graphic with no render; a scene preview shows the shot through the gap', async (t) => {
  const { dir, project } = await fixture(t)
  const renderer = createPreviewRenderer({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE })
  await assert.rejects(
    renderer.renderVideo({ project, projectDir: dir, fullSize: true, fps: 24, audio: false, captions: false, output: path.join(dir, 'out.mp4') }),
    (error) => error.code === 'COMPOSITION_NOT_RENDERED' && error.details.clipId === 'counter',
  )
  const preview = await renderer.renderScenePreview({ project, projectDir: dir, range: [0, 4], audio: false, captions: false, output: path.join(dir, 'preview.mp4') })
  assert.equal(preview.compositions, 0)
})
