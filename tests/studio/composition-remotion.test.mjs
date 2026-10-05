// FILM-2018 AC2/AC3: the real engine. The Counter primitive renders through
// Remotion (the bundle from scripts/build-compositions.mjs, Chrome Headless
// Shell) via compositionRenderer.js to a 4 s alpha WebM that reads the
// brand: the plate is the brand primary, the frame around it transparent,
// and the plate fades in from nothing on frame 0.
//
// Needs the bundle and the browser: built here when missing (about a minute
// the first time; `npm run build:compositions` makes both ahead of time).
// STUDIO_REMOTION_BROWSER=<chrome-headless-shell binary> uses that browser
// instead of Remotion's download (a machine whose network refuses it).
//
// Then every catalogue primitive renders once (FILM-2018 AC3): drawn, inside
// its footprint, transparent everywhere else.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { BUNDLE_DIR, buildCompositions } from '../../scripts/build-compositions.mjs'
import { COMPOSITION_IDS, brandTokensFor, graphicProps } from '../../src/studio/compositions/catalogue.js'
import { footprintFor } from '../../src/studio/compositions/remotion/layout.js'
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

const browserExecutable = process.env.STUDIO_REMOTION_BROWSER || null

async function prepare(t) {
  if (!existsSync(path.join(BUNDLE_DIR, 'index.html'))) await buildCompositions({ browser: !browserExecutable, log: (line) => t.diagnostic(line) })
  else if (!browserExecutable) await ensureBrowser()
}

test('a 4 s Counter renders through Remotion to an alpha WebM in the brand colours', { timeout: 10 * 60 * 1000 }, async (t) => {
  await prepare(t)
  const dir = await tempDir('remotion')
  t.after(() => removeDir(dir))
  await mkdir(path.join(dir, 'storybook'), { recursive: true })
  await writeFile(path.join(dir, 'storybook', 'brand.json'), JSON.stringify({ colors: { primary: '#16A34A', captionText: '#FFFFFF' } }))

  const engine = createRemotionEngine({ serveUrl: BUNDLE_DIR, browserExecutable })
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

// One RGBA frame, decoded with libvpx.
async function frameRgba(file, time, width, height) {
  const { stdout } = await run(FFMPEG, ['-v', 'error', '-c:v', 'libvpx-vp9', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', 'format=rgba', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: width * height * 8 })
  assert.equal(stdout.length, width * height * 4)
  return stdout
}

const TEXTS = { text: 'The night the lab went dark', counter: '87% retention', callout: 'Look here', arrow: 'the door', highlight: 'Suspect', 'lower-third': 'Maya Rao, Lead engineer', chart: 'Q1 12, Q2 18, Q3 30', map: 'Lisbon', timeline: '1990 founded, 2005 IPO, 2020 sold', 'progress-bar': '72% funded' }

test('every primitive renders through Remotion: drawn inside its footprint, transparent outside it, on 16:9 and 9:16', { timeout: 15 * 60 * 1000 }, async (t) => {
  await prepare(t)
  const engine = createRemotionEngine({ serveUrl: BUNDLE_DIR, browserExecutable })
  t.after(() => engine.close())
  const dir = await tempDir('remotion-all')
  t.after(() => removeDir(dir))
  assert.deepEqual(Object.keys(TEXTS).sort(), [...COMPOSITION_IDS].sort())
  for (const [width, height] of [[960, 540], [540, 960]]) {
    for (const id of COMPOSITION_IDS) {
      const props = graphicProps(id, TEXTS[id])
      const outputPath = path.join(dir, `${id}-${width}x${height}.webm`)
      await engine.render({ compositionId: id, props, brand: brandTokensFor(id, {}), durationSeconds: 1.5, width, height, fps: 24, outputPath })
      const box = footprintFor(id, props, { width, height })
      const pixels = await frameRgba(outputPath, 1.4, width, height)
      let drawn = 0
      let outside = 0
      // VP9 blurs alpha a few pixels across an edge.
      const margin = 4
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const alpha = pixels[(y * width + x) * 4 + 3]
          const inBox = x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height
          const nearBox = x >= box.x - margin && x < box.x + box.width + margin && y >= box.y - margin && y < box.y + box.height + margin
          if (inBox && alpha > 200) drawn += 1
          if (!nearBox && alpha > 16) outside += 1
        }
      }
      t.diagnostic(`${id} ${width}x${height}: ${drawn} opaque px in its ${box.width}x${box.height} footprint, ${outside} outside`)
      assert.ok(drawn > box.width * box.height * 0.01, `${id} ${width}x${height} draws in its footprint (${drawn} px)`)
      assert.equal(outside, 0, `${id} ${width}x${height} draws nothing outside its footprint`)
    }
  }
})
