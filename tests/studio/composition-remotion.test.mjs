// FILM-2018 AC2/AC3: the real engine. The Counter primitive renders through
// Remotion (the bundle from scripts/build-compositions.mjs, Chrome Headless
// Shell) via compositionRenderer.js to a 4 s alpha WebM that reads the
// brand: the plate is the brand primary, the frame around it transparent,
// and the plate fades in from nothing on frame 0.
//
// Needs the bundle and the browser: built here when missing (about a minute
// the first time; `npm run build:compositions` makes both ahead of time).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { BUNDLE_DIR, buildCompositions } from '../../scripts/build-compositions.mjs'
import { FFMPEG, FFPROBE, removeDir, tempDir } from './helpers/review-media.mjs'

const require = createRequire(import.meta.url)
const { createCompositionRenderer } = require('../../electron/studio/compositionRenderer.js')
const { createRemotionEngine } = require('../../electron/studio/compositionEngines/remotion.js')
const { ensureBrowser } = require('@remotion/renderer')
const run = promisify(execFile)

const W = 1920
const H = 1080

// RGBA of one pixel, decoded with libvpx (FFmpeg's own VP9 decoder drops alpha).
async function rgba(file, time, x, y) {
  const { stdout } = await run(FFMPEG, ['-v', 'error', '-c:v', 'libvpx-vp9', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},format=rgba`, '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })
  return [...stdout.subarray(0, 4)]
}

test('a 4 s Counter renders through Remotion to an alpha WebM in the brand colours', { timeout: 10 * 60 * 1000 }, async (t) => {
  if (!existsSync(path.join(BUNDLE_DIR, 'index.html'))) await buildCompositions({ log: (line) => t.diagnostic(line) })
  else await ensureBrowser()
  const dir = await tempDir('remotion')
  t.after(() => removeDir(dir))
  await mkdir(path.join(dir, 'storybook'), { recursive: true })
  await writeFile(path.join(dir, 'storybook', 'brand.json'), JSON.stringify({ colors: { primary: '#16A34A', captionText: '#FFFFFF' } }))

  const engine = createRemotionEngine({ serveUrl: BUNDLE_DIR })
  t.after(() => engine.close())
  const renderer = createCompositionRenderer({ engines: { remotion: engine } })
  const ask = { projectDir: dir, engine: 'remotion', compositionId: 'counter', props: { to: 87, suffix: '%', label: 'retention' }, durationSeconds: 4, width: W, height: H, fps: 30 }
  const started = Date.now()
  const result = await renderer.render(ask)
  const ms = Date.now() - started
  t.diagnostic(`4 s 1080p30 counter, cold browser: ${ms} ms`)
  assert.equal(result.cached, false)
  assert.match(result.renderPath, /^compositions\/counter-[0-9a-f]{64}\.webm$/)

  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:stream_tags=alpha_mode:format=duration', '-of', 'json', result.file])
  const probe = JSON.parse(stdout)
  assert.equal(probe.streams[0].codec_name, 'vp9')
  assert.deepEqual([probe.streams[0].width, probe.streams[0].height], [W, H])
  assert.equal(probe.streams[0].tags?.alpha_mode ?? probe.streams[0].tags?.ALPHA_MODE, '1')
  assert.ok(Math.abs(Number(probe.format.duration) - 4) < 0.1, `duration ${probe.format.duration}`)

  // The plate's left inner edge (no digits there) at 3.5 s: brand primary, opaque.
  const plate = await rgba(result.file, 3.5, 760, 540)
  assert.ok(Math.abs(plate[0] - 0x16) < 24 && Math.abs(plate[1] - 0xa3) < 24 && Math.abs(plate[2] - 0x4a) < 24, `plate ${plate}`)
  assert.ok(plate[3] > 230, `plate alpha ${plate[3]}`)
  assert.ok((await rgba(result.file, 3.5, 100, 100))[3] < 10, 'the corner is transparent')
  assert.ok((await rgba(result.file, 0, 760, 540))[3] < 40, 'frame 0: the plate has not faded in')

  // The same ask again is the file on disk.
  const again = await renderer.render(ask)
  assert.deepEqual([again.cached, again.renderPath], [true, result.renderPath])
})
