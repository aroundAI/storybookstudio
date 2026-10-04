// FILM-2016 AC5, AC6 and the caption test plan: the brand caption style on
// Velorn's live captions, safe-area placement per aspect, emphasis words,
// and the QA caption check. The 9:16 test draws through the real subtitle
// renderer (src/utils/kineticCaptionRenderer.js, bundled with esbuild into
// this process) onto a canvas that records every glyph and box it draws.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { build } from 'esbuild'

import {
  captionOverrides,
  captionPresetFromBrand,
  checkCaptionSafeArea,
  emphasisWordsFrom,
  layoutCue,
  SAFE_AREAS,
  safeRectPx,
  styleCaptionCues,
} from '../../src/studio/captions/style.js'
import { approximateMeasure, blockInsideSafeRect } from '../../src/studio/captions/layout.js'
import { BrandSchema } from '../../src/studio/contracts/brand.schema.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const FRAMES = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] }
const cues = [
  { id: 'c1', start: 0, end: 2, text: 'We have ninety seconds before the doors seal.' },
  { id: 'c2', start: 2, end: 4.5, text: 'Then we run. Now!' },
  { id: 'c3', start: 4.5, end: 8, text: 'Every single person on this deck needs to hear the alarm before the vault closes for good tonight.' },
]
const brand = { colors: { captionText: '#FFEE00', captionBackground: '#101010CC', primary: '#E11D48' }, fonts: { body: 'Montserrat' }, captionStyle: { fontSize: 56, position: 'bottom', maxCharsPerLine: 28, background: 'box', emphasis: 'color' } }

test('the safe rectangles: 16:9 bottom 10 %; 9:16 above the bottom 25 % and clear of the right 15 %; 1:1 bottom 12 %', () => {
  assert.equal(SAFE_AREAS['16:9'].bottom, 0.1)
  assert.equal(SAFE_AREAS['9:16'].bottom, 0.25)
  assert.equal(SAFE_AREAS['9:16'].right, 0.15)
  assert.equal(SAFE_AREAS['1:1'].bottom, 0.12)
  const vertical = safeRectPx(SAFE_AREAS['9:16'], 1080, 1920)
  assert.ok(Math.abs(vertical.y + vertical.height - 1920 * 0.75) < 1e-6)
  assert.ok(Math.abs(vertical.x + vertical.width - 1080 * 0.85) < 1e-6)
})

test('the brand caption style becomes the live captions preset and per-cue overrides', () => {
  const preset = captionPresetFromBrand(brand, {})
  assert.deepEqual(preset, { id: 'kinetic-traditional', fontFamily: 'Montserrat', textColor: '#FFEE00', subtitleColor: '#FFEE00', subtitleTextStyle: 'background' })
  const g = captionOverrides({ brand, aspect: '9:16', emphasisWords: ['now'] })
  assert.equal(g.subtitleColor, '#FFEE00')
  assert.equal(g.backgroundColor, '#101010')
  assert.equal(g.backgroundOpacity, 80, 'the #RRGGBBAA alpha is the box opacity')
  assert.equal(g.textStyle, 'background')
  assert.equal(g.maxCharsPerLine, 28)
  assert.ok(Math.abs(g.sizeScale - 56 / 48.6) < 0.001, '56 px at 1080p')
  assert.deepEqual(g.safeArea, { ...SAFE_AREAS['9:16'] })
  assert.equal(g.emphasisColor, '#E11D48')
  assert.equal(captionOverrides({ brand: { captionStyle: { background: 'outline' } } }).textStyle, 'outline')
  assert.equal(captionOverrides({ brand: { captionStyle: { background: 'none' } } }).textStyle, 'none')
  // policy.captions.style 'plain': the Studio default look, still safe-placed
  assert.deepEqual(captionPresetFromBrand(brand, { captions: { style: 'plain' } }), { id: 'kinetic-traditional' })
  assert.deepEqual(captionOverrides({ brand, policy: { captions: { style: 'plain' } }, aspect: '1:1' }).safeArea, { ...SAFE_AREAS['1:1'] })
})

for (const aspect of ['16:9', '9:16', '1:1']) {
  test(`${aspect}: every styled cue, in each position, is laid out inside the safe rectangle`, () => {
    const [width, height] = FRAMES[aspect]
    for (const position of ['bottom', 'center', 'top']) {
      const { cues: styled } = styleCaptionCues({ cues, brand: { ...brand, captionStyle: { ...brand.captionStyle, position } }, aspect })
      for (const cue of styled) {
        const layout = layoutCue(cue, { width, height })
        assert.ok(blockInsideSafeRect(layout), `${aspect} ${position} ${cue.id}: ${JSON.stringify(layout.box)}`)
        for (const line of layout.lines) assert.ok(line.words.map((word) => word.text).join(' ').length <= 28 || line.words.length === 1)
      }
      assert.deepEqual(checkCaptionSafeArea({ cues: styled, width, height }), [], `${aspect} ${position}`)
    }
    // bottom placement sits on the safe rectangle's bottom edge
    const { cues: styled } = styleCaptionCues({ cues, brand, aspect })
    const layout = layoutCue(styled[0], { width, height })
    assert.ok(Math.abs(layout.box.y + layout.box.height - (layout.safeRect.y + layout.safeRect.height)) < 0.5)
  })
}

test('a huge brand size shrinks to fit rather than leaving the safe area', () => {
  const { cues: styled } = styleCaptionCues({ cues, brand: { captionStyle: { fontSize: 200, maxCharsPerLine: 80 } }, aspect: '9:16' })
  for (const cue of styled) assert.ok(blockInsideSafeRect(layoutCue(cue, { width: 1080, height: 1920 })))
})

test('the QA caption check flags a cue placed for 16:9 shown at 9:16, an unplaced cue, and overlaps', () => {
  const { cues: wide } = styleCaptionCues({ cues: cues.slice(0, 1), brand, aspect: '16:9' })
  const issues = checkCaptionSafeArea({ cues: wide, width: 1080, height: 1920 })
  assert.equal(issues.length, 1)
  assert.equal(issues[0].type, 'caption_safe_area')
  assert.equal(issues[0].repairIntent, 'move_caption')
  assert.deepEqual(issues[0].timeRange, { start: 0, end: 2 })
  const bare = checkCaptionSafeArea({ cues: [{ id: 'x', start: 0, end: 1, text: 'hello' }], width: 1080, height: 1920 })
  assert.match(bare[0].detail, /not placed/)
  const overlapping = checkCaptionSafeArea({ cues: styleCaptionCues({ cues: [{ id: 'a', start: 0, end: 2, text: 'a' }, { id: 'b', start: 1.5, end: 3, text: 'b' }], aspect: '16:9' }).cues, width: 1920, height: 1080 })
  assert.deepEqual(overlapping.map((issue) => issue.type), ['caption_overlap'])
})

test('emphasis words from the preset are styled when a cue contains them, case and punctuation aside', () => {
  const words = emphasisWordsFrom({ brand: { captionStyle: { emphasisWords: ['Doors'] } }, style: { emphasisWords: ['now', 'alarm'] } })
  assert.deepEqual(words.sort(), ['Doors', 'alarm', 'now'])
  const { cues: styled, emphasized } = styleCaptionCues({ cues, brand, aspect: '16:9', emphasisWords: words })
  assert.deepEqual(emphasized, [{ cueId: 'c1', words: ['doors'] }, { cueId: 'c2', words: ['Now!'] }, { cueId: 'c3', words: ['alarm'] }])
  const layout = layoutCue(styled[1], { width: 1920, height: 1080 })
  const flags = layout.lines.flatMap((line) => line.words.map((word) => [word.text, word.emphasized]))
  assert.deepEqual(flags, [['Then', false], ['we', false], ['run.', false], ['Now!', true]])
  // scale emphasis draws the word larger; none ignores the words
  const scaled = styleCaptionCues({ cues, brand: { ...brand, captionStyle: { ...brand.captionStyle, emphasis: 'scale' } }, aspect: '16:9', emphasisWords: words }).cues
  const big = layoutCue(scaled[1], { width: 1920, height: 1080 }).lines.flatMap((line) => line.words).find((word) => word.text === 'Now!')
  assert.ok(big.size > layoutCue(scaled[1], { width: 1920, height: 1080 }).fontSize)
  const none = styleCaptionCues({ cues, brand: { ...brand, captionStyle: { ...brand.captionStyle, emphasis: 'none' } }, emphasisWords: words })
  assert.deepEqual(none.emphasized, [])
})

test('BrandSchema defaults style captions too (an empty brand is valid)', () => {
  assert.doesNotThrow(() => BrandSchema.parse({}))
  const { preset, cues: styled } = styleCaptionCues({ cues, aspect: '9:16' })
  assert.equal(preset.subtitleColor, '#FFFFFF')
  assert.ok(Math.abs(styled[0].globalOverrides.sizeScale - 48 / 48.6) < 0.001)
})

// ---- the real renderer ----------------------------------------------------

async function loadRenderer() {
  const result = await build({
    entryPoints: [path.join(root, 'src/utils/kineticCaptionRenderer.js')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  })
  const source = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

// A 2D context that records what is drawn. measureText uses the same wide
// average glyph as the QA check, so both see the same text widths.
function recordingContext() {
  const drawn = { text: [], boxes: [] }
  let path = []
  let fontSize = 16
  const ctx = {
    font: '',
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    save() {}, restore() {}, clearRect() {},
    beginPath() { path = [] },
    moveTo(x, y) { path.push([x, y]) },
    lineTo(x, y) { path.push([x, y]) },
    quadraticCurveTo(cx, cy, x, y) { path.push([cx, cy], [x, y]) },
    closePath() {},
    fill() {
      const xs = path.map(([x]) => x)
      const ys = path.map(([, y]) => y)
      drawn.boxes.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) })
    },
    measureText(text) { return { width: approximateMeasure(text, fontSize) } },
    fillText(text, x, y) {
      const width = approximateMeasure(text, fontSize)
      const left = ctx.textAlign === 'center' ? x - width / 2 : x
      drawn.text.push({ text, x0: left, x1: left + width, y0: y - fontSize, y1: y + fontSize * 0.3, color: ctx.fillStyle, size: fontSize })
    },
    strokeText() {},
  }
  Object.defineProperty(ctx, 'font', {
    get() { return `${fontSize}px` },
    set(value) { fontSize = Number(String(value).match(/(\d+(?:\.\d+)?)px/)?.[1] || fontSize) },
  })
  return { ctx, drawn }
}

test('9:16 variant through the real subtitle renderer: every glyph and the box stay inside the safe rectangle, emphasis drawn in the brand colour', async () => {
  const { renderKineticCaptionFrame, getKineticStyleById } = await loadRenderer()
  const [width, height] = FRAMES['9:16']
  const { preset, cues: styled } = styleCaptionCues({ cues, brand, aspect: '9:16', emphasisWords: ['now', 'alarm'] })
  const style = { ...getKineticStyleById(preset.id), ...preset }
  const safe = safeRectPx(SAFE_AREAS['9:16'], width, height)
  const inside = (r) => r.x0 >= safe.x - 0.5 && r.y0 >= safe.y - 0.5 && r.x1 <= safe.x + safe.width + 0.5 && r.y1 <= safe.y + safe.height + 0.5
  for (const cue of styled) {
    const { ctx, drawn } = recordingContext()
    renderKineticCaptionFrame({ ctx, width, height, style, cues: styled, time: (cue.start + cue.end) / 2 })
    assert.ok(drawn.text.length > 0, `${cue.id} drew text`)
    assert.equal(drawn.text.map((entry) => entry.text).join(' '), cue.text, `${cue.id} drew every word once`)
    for (const glyphs of drawn.text) assert.ok(inside(glyphs), `${cue.id} "${glyphs.text}" at ${JSON.stringify(glyphs)} leaves ${JSON.stringify(safe)}`)
    for (const box of drawn.boxes) assert.ok(inside(box), `${cue.id} box ${JSON.stringify(box)}`)
    for (const word of drawn.text) {
      const emphasized = ['now', 'alarm'].includes(word.text.toLowerCase().replace(/[^a-z]/g, ''))
      assert.equal(word.color, emphasized ? '#E11D48' : '#FFEE00', `${word.text} colour`)
    }
  }
  // QA agrees.
  assert.deepEqual(checkCaptionSafeArea({ cues: styled, width, height }), [])
})

test('a cue without a safe area still draws the upstream way (stock Velorn captions unchanged)', async () => {
  const { renderKineticCaptionFrame, getKineticStyleById } = await loadRenderer()
  const { ctx, drawn } = recordingContext()
  renderKineticCaptionFrame({ ctx, width: 1080, height: 1920, style: getKineticStyleById('kinetic-traditional'), cues: [{ id: 'a', start: 0, end: 2, text: 'Stock subtitle' }], time: 1 })
  assert.equal(drawn.text.length, 1, 'one centred line')
  assert.equal(drawn.text[0].text, 'Stock subtitle')
})

test('isInsideSafeArea: a box in the bottom 25 % or the right 15 % of a 9:16 frame is outside', async () => {
  const { isInsideSafeArea } = await import('../../src/studio/captions/style.js')
  const frame = { width: 1080, height: 1920 }
  assert.equal(isInsideSafeArea({ x: 100, y: 1200, width: 700, height: 200 }, '9:16', frame), true)
  assert.equal(isInsideSafeArea({ x: 100, y: 1400, width: 700, height: 200 }, '9:16', frame), false)
  assert.equal(isInsideSafeArea({ x: 100, y: 1200, width: 850, height: 200 }, '9:16', frame), false)
  assert.equal(isInsideSafeArea({ x: 100, y: 900, width: 1700, height: 60 }, '16:9', { width: 1920, height: 1080 }), true)
})
