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
// its footprint, transparent everywhere else. And a language render's refit
// (FILM-2019 AC4) is what Remotion draws: the German title on the two lines
// the refit measured, inside the width it measured.
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
import { footprintFor, lowerThirdNameHeight, textSlots } from '../../src/studio/compositions/remotion/layout.js'
import { measureEm, refitGraphic } from '../../src/studio/localization/refit.js'
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

test('a refit German lower third is drawn as measured: on the two lines the refit broke it into, inside the slot\'s width', { timeout: 10 * 60 * 1000 }, async (t) => {
  await prepare(t)
  const engine = createRemotionEngine({ serveUrl: BUNDLE_DIR, browserExecutable })
  t.after(() => engine.close())
  const dir = await tempDir('remotion-refit')
  t.after(() => removeDir(dir))
  const master = graphicProps('lower-third', 'Maya Rao, Head of storage research')
  const props = { ...master, title: 'Leiterin der Forschung für Energiespeicher und Netze' }
  const frame = { width: W, height: H }
  const refit = refitGraphic({ compositionId: 'lower-third', props, masterProps: master, frame, durationSeconds: 1.5 })
  assert.equal(refit.fit.slots.title.lines.length, 2)
  const box = footprintFor('lower-third', props, frame)
  const slot = textSlots('lower-third', props, box).find((entry) => entry.key === 'title')
  const accent = Math.round(box.height * 0.08)
  const textLeft = box.x + accent + Math.round(box.height * 0.12)
  const stripTop = box.y + lowerThirdNameHeight(box, props)

  // The title strip's white text, as rows of ink (bands) and its right edge.
  const ink = async (fit) => {
    const outputPath = path.join(dir, `lower-third-${fit ? 'fit' : 'master'}.webm`)
    await engine.render({ compositionId: 'lower-third', props, brand: brandTokensFor('lower-third', {}), durationSeconds: 1.5, width: W, height: H, fps: 24, fit, outputPath })
    const pixels = await frameRgba(outputPath, 1.4, W, H)
    // Each band: its rows' rightmost ink.
    const bands = []
    for (let y = stripTop; y < box.y + box.height; y += 1) {
      let right = -1
      for (let x = box.x + accent; x < box.x + box.width; x += 1) {
        const at = (y * W + x) * 4
        if (pixels[at] > 200 && pixels[at + 1] > 200 && pixels[at + 2] > 200 && pixels[at + 3] > 200) right = x
      }
      if (right < 0) continue
      const last = bands.at(-1)
      if (last && y - last.bottom <= 2) Object.assign(last, { bottom: y, right: Math.max(last.right, right) })
      else bands.push({ top: y, bottom: y, right })
    }
    return bands.map((band) => band.right - textLeft + 1)
  }
  const fitted = await ink(refit.fit)
  const unfitted = await ink(null)
  const fontSize = slot.maxFont * refit.fit.slots.title.fontScale
  const measured = refit.fit.slots.title.lines.map((line) => Math.round(measureEm(line, { weight: slot.weight }) * fontSize))
  t.diagnostic(`refit lines drawn ${fitted.join(', ')} px wide, measured ${measured.join(', ')} px, of a ${Math.round(slot.width)} px line; without the refit: ${unfitted.length} line`)
  assert.equal(fitted.length, 2, 'the refit\'s two lines')
  assert.equal(unfitted.length, 1, 'the master\'s one-line fit, without the refit')
  fitted.forEach((width, index) => {
    assert.ok(width <= slot.width, `line ${index + 1} is inside its slot (${width} of ${slot.width} px)`)
    // The model measures a little wide, so what it says fits is not clipped, and not by much.
    // How much depends on the platform's system-ui: Linux's fallback draws 2-13% under the
    // model, macOS's San Francisco about 15% under (CI: 448 of 529 px, 469 of 550 px).
    assert.ok(width <= measured[index] && width >= measured[index] * 0.8, `line ${index + 1}: drawn ${width} px, measured ${measured[index]} px`)
  })
})
