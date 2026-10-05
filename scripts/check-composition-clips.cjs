// FILM-2018: a composition clip in the real preview, Timeline and export
// compositor (tests/fixtures/composition-clips.jsx), with a real Remotion
// render of the Counter. Checks, by pixel:
//   1. added, not rendered: the preview shows the placeholder; an export refuses
//   2. render lands: the preview shows the graphic over the shot
//   3. the export composites it over the shot, only while the clip plays
//   4. a props edit: back to the placeholder, and a second render is asked
// Screenshots of each state go to EVIDENCE_DIR when set.
//
//   npx vite --port 5184 --strictPort &   # serves the fixture
//   CHROME_PATH=<Chromium> PLAYWRIGHT_MODULE_PATH=<playwright> node scripts/check-composition-clips.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const { createCompositionRenderer } = require('../electron/studio/compositionRenderer.js')
const { createRemotionEngine } = require('../electron/studio/compositionEngines/remotion.js')

const W = 960
const H = 540
// plate: inside the Counter's plate (no digits); box: inside the placeholder, clear of its label.
const POINTS = { plate: [380, 270], box: [318, 232], corner: [50, 50] }
const BLUE = [0x25, 0x63, 0xeb]
const near = (actual, expected, tolerance = 30) => actual.slice(0, 3).every((v, i) => Math.abs(v - expected[i]) <= tolerance)
const isGrey = (rgb) => Math.abs(rgb[0] - rgb[2]) < 16 && rgb[0] > 90 && rgb[0] < 170
const isPlaceholder = (rgb) => Math.max(...rgb.slice(0, 3)) < 90 && rgb[2] - rgb[0] < 40

function greyShot() {
  const result = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x808080:s=${W}x${H}:r=30:d=8`,
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '0', '-crf', '30', '-f', 'webm', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 })
  assert.equal(result.status, 0, String(result.stderr))
  return result.stdout.toString('base64')
}

async function counterRender() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'composition-check-'))
  const engine = createRemotionEngine({ serveUrl: path.join(__dirname, '..', 'dist-compositions') })
  try {
    const renderer = createCompositionRenderer({ engines: { remotion: engine } })
    const result = await renderer.render({ projectDir: dir, engine: 'remotion', compositionId: 'counter', props: { to: 87, suffix: '%', label: 'retention' }, durationSeconds: 4, width: W, height: H, fps: 30 })
    return fs.readFileSync(result.file).toString('base64')
  } finally {
    await engine.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  const evidence = process.env.EVIDENCE_DIR || null
  if (evidence) fs.mkdirSync(evidence, { recursive: true })
  const media = { grey: greyShot(), render: await counterRender() }
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true })
  const rows = []
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
    page.setDefaultTimeout(20000)
    page.on('pageerror', (error) => console.error('Renderer:', error.message))
    await page.goto(`${process.env.STORYBOOKSTUDIO_TEST_URL || 'http://127.0.0.1:5184'}/tests/fixtures/composition-clips.html`)
    await page.waitForFunction(() => Boolean(window.compositionTest))
    await page.evaluate((m) => window.compositionTest.initializeMedia(m), media)
    const preview = () => page.evaluate((points) => window.compositionTest.previewPixels(points), POINTS)
    const waitPreview = async (label, test) => {
      const deadline = Date.now() + 20000
      let last = null
      while (Date.now() < deadline) {
        last = await preview()
        if (last && test(last)) return last
        await page.waitForTimeout(100)
      }
      throw new Error(`${label}: preview pixels ${JSON.stringify(last)}`)
    }
    const shot = async (name) => { if (evidence) await page.screenshot({ path: path.join(evidence, name) }) }

    await waitPreview('the shot alone', (p) => isGrey(p.plate) && isGrey(p.corner))

    // 1. Added, not rendered.
    const clip = await page.evaluate(() => window.compositionTest.addCounter().id)
    await page.waitForFunction(() => window.compositionTest.renderCalls().length === 1)
    const placeholder = await waitPreview('placeholder', (p) => isPlaceholder(p.box) && isGrey(p.corner))
    rows.push({ state: '1 added, not rendered', where: 'preview', plate: `placeholder ${placeholder.box.slice(0, 3).join(',')}`, corner: placeholder.corner.slice(0, 3).join(',') })
    await shot('01-placeholder-before-render.png')
    const refused = await page.evaluate(() => window.compositionTest.exportFrameInMemory(3.5, {}).then(() => null, (error) => error.message))
    assert.match(refused || '', /has not rendered yet/, 'an export refuses a graphic with no render')
    rows.push({ state: '1 added, not rendered', where: 'export', plate: `refused: ${refused}`, corner: '' })

    // 2. The render lands.
    await page.evaluate(() => window.compositionTest.landRender())
    const landed = await waitPreview('render landed', (p) => near(p.plate, BLUE) && isGrey(p.corner) && isGrey(p.box))
    rows.push({ state: '2 render landed', where: 'preview', plate: landed.plate.slice(0, 3).join(','), corner: landed.corner.slice(0, 3).join(',') })
    await shot('02-render-landed.png')

    // 3. Export.
    const during = await page.evaluate((points) => window.compositionTest.exportFrameInMemory(3.5, points), POINTS)
    assert.ok(near(during.plate, BLUE), `export at 3.5 s: plate ${during.plate}`)
    assert.ok(isGrey(during.corner), `export at 3.5 s: corner ${during.corner}`)
    const before = await page.evaluate((points) => window.compositionTest.exportFrameInMemory(1.0, points), POINTS)
    assert.ok(isGrey(before.plate), `export at 1.0 s (before the clip): plate ${before.plate}`)
    rows.push({ state: '3 export at 3.5 s', where: 'export frame', plate: during.plate.slice(0, 3).join(','), corner: during.corner.slice(0, 3).join(',') })
    rows.push({ state: '3 export at 1.0 s', where: 'export frame', plate: before.plate.slice(0, 3).join(','), corner: before.corner.slice(0, 3).join(',') })

    // 4. A props edit drops the render and asks for a new one.
    await page.evaluate((id) => window.compositionTest.timeline.getState().updateCompositionProps(id, { to: 42, suffix: '%', label: 'retention' }), clip)
    await page.waitForFunction(() => window.compositionTest.renderCalls().length === 2)
    const edited = await waitPreview('after props edit', (p) => isPlaceholder(p.box))
    rows.push({ state: '4 props edited', where: 'preview', plate: `placeholder ${edited.box.slice(0, 3).join(',')}`, corner: edited.corner.slice(0, 3).join(',') })
    await shot('03-after-props-edit.png')
    const calls = await page.evaluate(() => window.compositionTest.renderCalls())
    assert.deepEqual(calls.map((call) => call.props.to), [87, 42])
    assert.deepEqual([calls[0].width, calls[0].height, calls[0].fps, calls[0].durationSeconds], [W, H, 30, 4])
  } finally {
    await browser.close()
  }
  console.table(rows)
  console.log('PASS: placeholder before the render, the render in the preview and the export, placeholder again after a props edit')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
