// FILM-2018 AC2: electron/studio/compositionRenderer.js renders a
// composition once to compositions/<id>-<propsHash>.webm, finds it again,
// renders again when props or the brand change, and renders one at a time
// in the order asked. The engine here is the test card (helpers/), so the
// file is a real alpha WebM without a browser.
import assert from 'node:assert/strict'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import { createTestcardEngine } from './helpers/testcard-engine.mjs'
import { tempDir } from './helpers/review-media.mjs'

const require = createRequire(import.meta.url)
const { createCompositionRenderer } = require('../../electron/studio/compositionRenderer.js')

const ask = (projectDir, patch = {}) => ({
  projectDir,
  engine: 'testcard',
  compositionId: 'counter',
  props: { to: 87 },
  durationSeconds: 1,
  width: 320,
  height: 180,
  fps: 24,
  ...patch,
})

async function project(t, brand = null) {
  const dir = await tempDir('compositions')
  t.after(() => rm(dir, { recursive: true, force: true }))
  if (brand) await writeBrand(dir, brand)
  return dir
}

async function writeBrand(dir, brand) {
  await mkdir(path.join(dir, 'storybook'), { recursive: true })
  await writeFile(path.join(dir, 'storybook', 'brand.json'), JSON.stringify(brand))
}

test('a miss renders to compositions/<id>-<propsHash>.webm; the same ask again is a hit with no render', async (t) => {
  const dir = await project(t)
  const engine = createTestcardEngine()
  const renderer = createCompositionRenderer({ engines: { testcard: engine } })
  const before = await renderer.resolve(ask(dir))
  assert.equal(before.cached, false)
  const first = await renderer.render(ask(dir))
  assert.equal(first.cached, false)
  assert.equal(first.renderPath, `compositions/counter-${first.propsHash}.webm`)
  assert.equal(first.propsHash, before.propsHash)
  assert.ok((await stat(path.join(dir, first.renderPath))).size > 0)
  const second = await renderer.render(ask(dir, { props: { from: 0, to: 87 } }))
  assert.deepEqual([second.cached, second.renderPath], [true, first.renderPath])
  assert.equal(engine.calls.length, 1)
  // A new renderer (an app restart) finds the file on disk.
  const again = createCompositionRenderer({ engines: { testcard: createTestcardEngine() } })
  assert.equal((await again.resolve(ask(dir))).cached, true)
  // Only the finished file is left: no partial render beside it.
  assert.deepEqual(await readdir(path.join(dir, 'compositions')), [path.basename(first.renderPath)])
})

test('new props are a new key and a new render; the old render stays for undo', async (t) => {
  const dir = await project(t)
  const engine = createTestcardEngine()
  const renderer = createCompositionRenderer({ engines: { testcard: engine } })
  const a = await renderer.render(ask(dir))
  const b = await renderer.render(ask(dir, { props: { to: 88 } }))
  assert.notEqual(a.propsHash, b.propsHash)
  assert.equal(b.cached, false)
  assert.equal(engine.calls.length, 2)
  assert.equal((await renderer.render(ask(dir))).cached, true)
})

test('a brand change the primitive reads invalidates its render; one it does not read does not', async (t) => {
  const dir = await project(t, { colors: { primary: '#2563EB' } })
  const engine = createTestcardEngine()
  const renderer = createCompositionRenderer({ engines: { testcard: engine } })
  const blue = await renderer.render(ask(dir))
  await writeBrand(dir, { colors: { primary: '#2563EB', background: '#111111' } })
  assert.equal((await renderer.render(ask(dir))).cached, true, 'background is not a counter token')
  await writeBrand(dir, { colors: { primary: '#DC2626' } })
  const red = await renderer.resolve(ask(dir))
  assert.notEqual(red.propsHash, blue.propsHash)
  assert.equal(red.cached, false)
  const rendered = await renderer.render(ask(dir))
  assert.equal(rendered.cached, false)
  assert.equal(engine.calls.at(-1).brand['colors.primary'], '#DC2626')
})

test('renders run one at a time, in the order asked; two asks for one key share a render', async (t) => {
  const dir = await project(t)
  const events = []
  let running = 0
  let most = 0
  const engine = createTestcardEngine({
    delayMs: 60,
    onStart: (job) => { running += 1; most = Math.max(most, running); events.push(`start ${job.props.to}`) },
    onEnd: (job) => { running -= 1; events.push(`end ${job.props.to}`) },
  })
  // The earlier asks read the brand slowest: their place in the queue must
  // not depend on when that read finishes (it once did, and failed under load).
  const delays = [90, 45, 0, 0]
  const readBrand = async () => { await new Promise((resolve) => setTimeout(resolve, delays.shift() ?? 0)); return {} }
  const renderer = createCompositionRenderer({ engines: { testcard: engine }, readBrand })
  const asks = [1, 2, 3].map((to) => renderer.render(ask(dir, { props: { to } })))
  const duplicate = renderer.render(ask(dir, { props: { to: 2 } }))
  await new Promise((resolve) => setImmediate(resolve))
  const results = await Promise.all([...asks, duplicate])
  assert.equal(most, 1, 'never two renders at once')
  assert.deepEqual(events, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3'])
  assert.equal(engine.calls.length, 3, 'the duplicate ask rendered nothing')
  assert.equal(results[3].renderPath, results[1].renderPath)
  assert.equal(renderer.pending(), 0)
})

test('a failed render leaves no file, reports its error, and the queue carries on', async (t) => {
  const dir = await project(t)
  const engine = createTestcardEngine({ fail: (job) => job.props.to === 13 })
  const renderer = createCompositionRenderer({ engines: { testcard: engine } })
  const failing = renderer.render(ask(dir, { props: { to: 13 } }))
  const next = renderer.render(ask(dir, { props: { to: 14 } }))
  await assert.rejects(failing, (error) => error.code === 'RENDER_FAILED')
  assert.equal((await next).cached, false)
  assert.equal((await renderer.resolve(ask(dir, { props: { to: 13 } }))).cached, false)
  assert.equal((await readdir(path.join(dir, 'compositions'))).length, 1)
})

test('an unknown engine, composition or bad props is refused before anything renders', async (t) => {
  const dir = await project(t)
  const renderer = createCompositionRenderer({ engines: { testcard: createTestcardEngine() } })
  await assert.rejects(renderer.render(ask(dir, { engine: 'remotion' })), (error) => error.code === 'ENGINE_UNAVAILABLE')
  await assert.rejects(renderer.render(ask(dir, { compositionId: 'sparkles' })), (error) => error.code === 'VALIDATION_FAILED')
  await assert.rejects(renderer.render(ask(dir, { props: {} })), (error) => error.code === 'VALIDATION_FAILED')
  await assert.rejects(renderer.render(ask('relative/dir')), (error) => error.code === 'VALIDATION_FAILED')
})
