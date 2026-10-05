// FILM-2019 AC4 unit: the localized graphics refit, and AC3's per-language
// graphic text. The spec's test row "refit algorithm on long German and
// short Japanese strings": a long German title shrinks to the font floor,
// wraps and is lengthened by exactly the 20% cap; one longer still is the QA
// issue localized_text_exceeds_container naming the element; a short
// Japanese one needs nothing. Then the floor and the cap at their edges, the
// measurement model, the components drawing what was measured, the render
// key, and where a graphic's words come from.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { resolveCompositionProps, COMPOSITION_IDS, graphicProps } from '../../src/studio/compositions/catalogue.js'
import { compositionKeyMaterial } from '../../src/studio/compositions/key.js'
import { fitFont, footprintFor, slotFontSize, slotLines, textSlots } from '../../src/studio/compositions/remotion/layout.js'
import {
  BOLD_WIDTH, DURATION_EXTENSION_CAP, LOCALIZED_TEXT_EXCEEDS_CONTAINER, REFIT_FONT_FLOOR, exceedsContainerIssue, measureEm, readingSeconds, refitGraphic, refitSlot, wrapLines,
} from '../../src/studio/localization/refit.js'
import { graphicStrings, planLanguageGraphics, storeGraphicStrings, withLanguageGraphics } from '../../src/studio/localization/graphics.js'
import { compositionPropsForLanguage } from '../../src/studio/localization/selection.js'
import { applyLanguageLane } from '../../src/studio/localization/lanes.js'

const FRAME = { width: 1920, height: 1080, fps: 30 }
const MASTER = resolveCompositionProps('lower-third', { name: 'Maya Rao', title: 'Head of storage research' })
const LONG_DE = 'Leiterin der Forschung für Energiespeicher und Netze'
const MID_DE = 'Chefin der Speicherforschung'
const TOO_LONG_DE = 'Leiterin der Wasserstoffspeicherforschung und Netzintegration'
const SHORT_JA = '貯蔵研究部長'

const refitTitle = (title, extra = {}) => refitGraphic({ compositionId: 'lower-third', props: { ...MASTER, title }, masterProps: MASTER, frame: FRAME, durationSeconds: 4, ...extra })
const titleSlot = (result) => result.slots.find((slot) => slot.key === 'title')

test('a long German title: the font comes down to the floor, then it wraps, then the clip runs exactly 20% longer', () => {
  const result = refitTitle(LONG_DE)
  const title = titleSlot(result)
  assert.equal(title.step, 'wrap')
  assert.equal(title.fontScale, REFIT_FONT_FLOOR, 'shrunk to the floor and no further')
  assert.deepEqual(title.lines, ['Leiterin der Forschung für', 'Energiespeicher und Netze'])
  assert.equal(title.maxLines, 2)
  assert.equal(result.fits, true)
  assert.ok(result.readingRatio > 1 + DURATION_EXTENSION_CAP, `German reads longer than the 20% cap allows (${result.readingRatio})`)
  assert.equal(result.durationSeconds, 4.8, 'lengthened by the cap and no more')
  assert.equal(result.extendedSeconds, 0.8)
  assert.equal(result.durationCapped, true)
  assert.deepEqual(result.fit.slots.title, { fontScale: 0.7, lines: title.lines }, 'the render gets the measured size and lines')
  assert.deepEqual(result.fit.slots.name, { fontScale: 1, lines: ['Maya Rao'] }, 'the name, unchanged, keeps its size')
})

test('a German title a little longer than the English shrinks on one line, above the floor, and is lengthened by its reading time', () => {
  const result = refitTitle(MID_DE)
  const title = titleSlot(result)
  assert.equal(title.step, 'shrink')
  assert.ok(title.fontScale > REFIT_FONT_FLOOR && title.fontScale < 1, String(title.fontScale))
  assert.deepEqual(title.lines, [MID_DE])
  const ratio = readingSeconds(`Maya Rao ${MID_DE}`) / readingSeconds('Maya Rao Head of storage research')
  assert.ok(ratio > 1 && ratio < 1.2)
  assert.equal(result.durationSeconds, Math.round(4 * ratio * 1000) / 1000, 'in proportion, under the cap')
  assert.equal(result.durationCapped, false)
})

test('a German title that still does not fit at the floor on the lines it has is the QA issue, naming the element', () => {
  const result = refitTitle(TOO_LONG_DE)
  const title = titleSlot(result)
  assert.equal(result.fits, false)
  assert.equal(title.fontScale, REFIT_FONT_FLOOR)
  assert.equal(title.lines.length, 3)
  assert.equal(title.maxLines, 2)
  const issue = exceedsContainerIssue({ clipId: 'clip-12', compositionId: 'lower-third', language: 'de', result, timeRange: { start: 2, end: 6.8 } })
  assert.equal(issue.type, LOCALIZED_TEXT_EXCEEDS_CONTAINER)
  assert.equal(issue.type, 'localized_text_exceeds_container')
  assert.ok(issue.severity >= 0.5, 'it fails the render')
  assert.match(issue.detail, /^localized text exceeds container: graphic clip-12 \(lower-third\) in de: title "Leiterin der Wasserstoffspeicherforschung und Netzintegration" needs 3 lines at the 70% font floor and holds 2/)
})

test('a short Japanese title needs nothing: full size, one line, the clip\'s own length', () => {
  const result = refitTitle(SHORT_JA)
  assert.equal(result.fits, true)
  assert.deepEqual(result.slots.map((slot) => [slot.key, slot.step, slot.fontScale, slot.lines]), [['name', 'none', 1, ['Maya Rao']], ['title', 'none', 1, [SHORT_JA]]])
  assert.ok(result.readingRatio < 1)
  assert.equal(result.durationSeconds, 4)
  assert.equal(result.extendedSeconds, 0)
})

test('the floor at its edge: text that just fits on one line at 70% shrinks; a little more wraps at exactly 70%, never smaller', () => {
  // 700 px at most 100 px: at the floor (70 px) a line holds 10 em. A digit is 0.64 em, a space 0.32 (regular weight).
  const slot = (text) => ({ key: 'label', text, weight: 400, width: 700, maxFont: 100, height: 2 * 70 * 1.15 })
  const fits = refitSlot(slot('00000000 0000000')) // 9.92 em
  assert.equal(fits.step, 'shrink')
  assert.equal(fits.fontScale, Math.floor((700 / 9.92 / 100) * 1000) / 1000)
  assert.ok(fits.fontScale >= REFIT_FONT_FLOOR)
  assert.ok(measureEm(fits.text) * fits.fontScale * 100 <= 700, 'drawn at that size it is inside the line')
  const wraps = refitSlot(slot('00000000 00000000')) // 10.56 em
  assert.equal(wraps.step, 'wrap')
  assert.equal(wraps.fontScale, 0.7)
  assert.deepEqual(wraps.lines, ['00000000', '00000000'])
  assert.equal(wraps.fits, true)
  const third = refitSlot(slot('00000000 00000000 00000000'))
  assert.equal(third.fits, false, 'a third line does not fit two lines of room')
  const word = refitSlot(slot('0000000000000000')) // 10.24 em
  assert.equal(word.fits, false, 'a word wider than the line is never broken')
  assert.equal(word.overlong, true)
})

test('the 20% cap at its edge, and a graphic is never lengthened past the program\'s end or shortened', () => {
  assert.equal(refitTitle(LONG_DE, { maxDurationSeconds: 100 }).durationSeconds, 4 * (1 + DURATION_EXTENSION_CAP))
  assert.equal(refitTitle(LONG_DE, { maxDurationSeconds: 4.3 }).durationSeconds, 4.3)
  assert.equal(refitTitle(LONG_DE, { maxDurationSeconds: 3 }).durationSeconds, 4)
  assert.equal(refitTitle(LONG_DE, { cap: 0 }).durationSeconds, 4)
})

test('the measurement model: full-width scripts 1 em a character, combining marks nothing, words break only between words or full-width characters', () => {
  assert.equal(measureEm('東京'), 2)
  assert.equal(measureEm('ｶﾀｶﾅ') > 0, true)
  assert.equal(measureEm('한국어'), 3)
  // Devanagari: the virama takes no room; a consonant 0.72 em.
  assert.equal(measureEm('क्ष'), 1.44)
  assert.ok(Math.abs(measureEm('Maya') - (0.96 + 0.62 * 3)) < 1e-9, 'M is wide, a and y average')
  assert.ok(Math.abs(measureEm('Maya', { weight: 800 }) - measureEm('Maya') * BOLD_WIDTH) < 1e-9, 'bold is wider')
  assert.equal(measureEm('Maya', { weight: 500 }), measureEm('Maya'))
  assert.deepEqual(wrapLines('東京都庁舎', 2).lines, ['東京', '都庁', '舎'], 'Japanese breaks between characters')
  assert.deepEqual(wrapLines('one two three', 4.2).lines, ['one two', 'three'])
  assert.deepEqual(wrapLines('one two three', 3).lines, ['one', 'two', 'three'])
  assert.equal(readingSeconds('東京'), 2 / 8)
  assert.equal(readingSeconds('Tokyo'), 5 / 17)
})

test('the components draw what was measured: every text slot\'s size and lines come from the refit; without one, the master\'s one-line fit', () => {
  for (const id of COMPOSITION_IDS) {
    const props = graphicProps(id, { text: 'Hello there', counter: '87% retention', callout: 'Look here', arrow: 'the door', highlight: 'Suspect', 'lower-third': 'Maya Rao, Lead engineer', chart: 'Q1 12, Q2 18', map: 'Lisbon', timeline: '1990 founded, 2020 sold', 'progress-bar': '72% funded' }[id])
    const box = footprintFor(id, props, FRAME)
    for (const slot of textSlots(id, props, box)) {
      assert.equal(slotFontSize(slot), fitFont(slot.text, slot.width, slot.maxFont), `${id}.${slot.key} without a refit is the master's size`)
      const fit = { slots: { [slot.key]: { fontScale: 0.7, lines: ['a', 'b'] } } }
      assert.equal(slotFontSize(slot, fit), slot.maxFont * 0.7)
      assert.deepEqual(slotLines(slot, fit), ['a', 'b'])
    }
  }
  // Each component sizes its words from its slots, not from its own formula.
  const SOURCES = ['Text', 'Counter', 'Callout', 'Arrow', 'Highlight', 'LowerThird', 'Chart', 'MapMarker', 'Timeline', 'ProgressBar']
  for (const name of SOURCES) {
    const source = readFileSync(new URL(`../../src/studio/compositions/remotion/${name}.jsx`, import.meta.url), 'utf8')
    assert.match(source, /slotFontSize\(slots/, `${name} sizes text from its slots`)
    assert.match(source, /\{ props, brand, fit \}/, `${name} takes the refit`)
    // fitFont is left only for words no language changes: a chart's values, a timeline's dates.
    assert.deepEqual([...source.matchAll(/fitFont\(([^,]+),/g)].map((match) => match[1]).filter((arg) => !['formatValue(item.value', 'point.date'].includes(arg.trim())), [], `${name}: no text prop sized outside its slot`)
  }
})

test('the render key: a language\'s words and refit are a key of their own; the master\'s key is unchanged without a refit', () => {
  const base = { engine: 'remotion', compositionId: 'lower-third', brand: {}, durationSeconds: 4, width: 1920, height: 1080, fps: 30 }
  const master = compositionKeyMaterial({ ...base, props: MASTER })
  assert.equal(compositionKeyMaterial({ ...base, props: MASTER, fit: null }), master)
  assert.doesNotMatch(master, /"fit"/)
  const de = refitTitle(LONG_DE)
  const german = compositionKeyMaterial({ ...base, props: { ...MASTER, title: LONG_DE }, fit: de.fit, durationSeconds: de.durationSeconds })
  assert.notEqual(german, master)
  assert.notEqual(compositionKeyMaterial({ ...base, props: { ...MASTER, title: LONG_DE }, durationSeconds: de.durationSeconds }), german, 'the refit is in the key')
  assert.equal(compositionKeyMaterial({ ...base, props: { ...MASTER, title: LONG_DE }, fit: de.fit, durationSeconds: de.durationSeconds }), german, 'the same words and refit find the same file')
  assert.throws(() => compositionKeyMaterial({ ...base, props: MASTER, fit: { slots: { title: { fontScale: 1.5, lines: ['x'] } } } }), (error) => error.code === 'VALIDATION_FAILED')
})

// A master with three graphics: a lower third, a chart (a list prop) and a
// callout quoting a dialogue line word for word.
const graphic = (id, compositionId, props, start = 1, duration = 4) => ({
  id, trackId: 'video-9', type: 'composition', startTime: start, duration, sourceDuration: duration, trimStart: 0, trimEnd: duration, enabled: true,
  composition: { engine: 'remotion', compositionId, props: resolveCompositionProps(compositionId, props), propsHash: null, renderPath: null, languageDependency: 'language' },
})
const master = () => ({
  id: 'timeline-1',
  clips: [
    graphic('clip-1', 'lower-third', { name: 'Maya Rao', title: 'Head of storage research' }),
    graphic('clip-2', 'chart', { items: [{ label: 'Q1', value: 12 }, { label: 'Q2', value: 18 }], title: 'Revenue' }, 2, 3),
    graphic('clip-3', 'callout', { text: 'We have to go now.' }, 6, 2),
    { id: 'clip-4', trackId: 'video-1', type: 'video', startTime: 0, duration: 10, enabled: true },
  ],
})
const PKG = { dialogue: [{ id: 'd1', text: 'We have to  go now.' }], dubbed: [{ language: 'de', lines: [{ dialogueId: 'd1', translatedText: 'Wir müssen jetzt gehen.' }] }] }

test('where a graphic\'s words come from: the agent\'s graphics, else what an earlier variant kept, else the dub of a line it quotes; the rest stay the master\'s and are named', () => {
  const strings = graphicStrings({ timeline: master(), pkg: PKG, language: 'de', graphics: { 'clip-1': { title: LONG_DE } } })
  assert.deepEqual(strings.map(({ clipId, localized, untranslated }) => [clipId, localized, untranslated]), [
    ['clip-1', { text: { title: LONG_DE }, sources: { title: 'agent' } }, ['name']],
    ['clip-2', null, ['title', 'items.label']],
    ['clip-3', { text: { text: 'Wir müssen jetzt gehen.' }, sources: { text: 'dub' } }, []],
  ])
  // Stored, then re-run without graphics: the kept words stay; given ones win.
  const stored = storeGraphicStrings(master(), 'de', strings)
  assert.equal(master().clips[0].composition.localized, undefined, 'storing copies; nothing is mutated')
  const again = graphicStrings({ timeline: stored, pkg: PKG, language: 'de', graphics: { 'clip-2': { 'items.label': ['Q1', 'Q2'], title: 'Umsatz' } } })
  assert.deepEqual(again[0].localized, { text: { title: LONG_DE }, sources: { title: 'agent' } }, 'kept from the earlier run')
  assert.deepEqual(again[1].localized, { text: { title: 'Umsatz', 'items.label': ['Q1', 'Q2'] }, sources: { title: 'agent', 'items.label': 'agent' } })
})

test('a graphics argument naming no such graphic, prop or list length is refused before anything changes', () => {
  const refused = (graphics, pattern) => assert.throws(() => graphicStrings({ timeline: master(), pkg: PKG, language: 'de', graphics }), (error) => error.code === 'VALIDATION_FAILED' && pattern.test(error.message))
  refused({ 'clip-99': { title: 'x' } }, /clip-99, which is not a graphic/)
  refused({ 'clip-1': { colour: 'x' } }, /colour is not a text prop of the Lower third clip-1; its text props are name, title/)
  refused({ 'clip-2': { 'items.label': ['nur eins'] } }, /list of 2 texts, one per item/)
  refused({ 'clip-1': { title: 7 } }, /is a text/)
  refused(['clip-1'], /graphics is/)
})

test('a render of the language draws each graphic in its words, refit and lengthened, from a copy; the master clip keeps its props', () => {
  const stored = storeGraphicStrings(master(), 'de', graphicStrings({ timeline: master(), pkg: PKG, language: 'de', graphics: { 'clip-1': { title: LONG_DE } } }))
  const before = JSON.stringify(stored)
  const selected = compositionPropsForLanguage(stored.clips[0], 'de')
  assert.equal(selected.props.title, LONG_DE)
  assert.deepEqual(selected.translated, ['title'])
  assert.equal(compositionPropsForLanguage(stored.clips[0], 'hi').props.title, 'Head of storage research', 'another language has the master\'s words')
  assert.equal(compositionPropsForLanguage(stored.clips[3], 'de'), null, 'not a graphic')

  const { graphics, issues } = planLanguageGraphics({ timeline: stored, language: 'de', frame: FRAME })
  assert.equal(JSON.stringify(stored), before, 'planning changes nothing')
  assert.deepEqual(graphics.map((entry) => [entry.clipId, entry.translated, entry.fits, entry.durationSeconds]), [['clip-1', true, true, 4.8], ['clip-2', false, true, 3], ['clip-3', true, true, 2.4]])
  assert.equal(graphics[1].request.fit, undefined, 'the untranslated chart renders as the master draws it')
  assert.deepEqual(graphics[1].props, stored.clips[1].composition.props)
  assert.deepEqual(graphics[0].request, { engine: 'remotion', compositionId: 'lower-third', props: { ...MASTER, title: LONG_DE }, fit: graphics[0].fit, durationSeconds: 4.8, width: 1920, height: 1080, fps: 30 })
  // Words left in the master's are named per clip, even a name: the agent passes it as it is to say so.
  assert.deepEqual(issues.map((issue) => [issue.type, issue.severity, issue.detail.match(/graphic (clip-\d)/)[1]]), [['graphic_text_untranslated', 0.3, 'clip-1'], ['graphic_text_untranslated', 0.3, 'clip-2']])
  assert.match(issues[1].detail, /in the master's words \(title, items\.label\)/)
  const played = withLanguageGraphics(stored, graphics, { 'clip-1': { propsHash: 'a'.repeat(64), renderPath: `compositions/lower-third-${'a'.repeat(64)}.webm` } })
  assert.equal(played.clips[0].duration, 4.8)
  assert.equal(played.clips[0].composition.props.title, LONG_DE)
  assert.equal(played.clips[0].composition.renderPath, `compositions/lower-third-${'a'.repeat(64)}.webm`)
  assert.equal(played.clips[2], stored.clips[2], 'a graphic with no render this time is as it was')
  assert.equal(stored.clips[0].composition.props.title, 'Head of storage research')
})

test('a German string that does not fit, or is longer than the primitive allows, is localized_text_exceeds_container on that graphic', () => {
  const stored = storeGraphicStrings(master(), 'de', graphicStrings({ timeline: master(), language: 'de', graphics: { 'clip-1': { title: TOO_LONG_DE }, 'clip-3': { text: 'x'.repeat(81) } } }))
  const { graphics, issues } = planLanguageGraphics({ timeline: stored, language: 'de', frame: FRAME })
  const exceeds = issues.filter((issue) => issue.type === 'localized_text_exceeds_container')
  assert.deepEqual(exceeds.map((issue) => issue.detail.match(/graphic (clip-\d)/)[1]), ['clip-1', 'clip-3'])
  assert.match(exceeds[1].detail, /longer than the Callout allows \(text String must contain at most 80 character\(s\)\); the master's words play/)
  assert.deepEqual(graphics.map((entry) => [entry.clipId, entry.translated, entry.fits]), [['clip-1', true, false], ['clip-2', false, true], ['clip-3', false, false]], 'the overlong title still renders at the floor; the callout too long to draw plays the master\'s words; QA fails both')
  assert.equal(graphics[2].props.text, 'We have to go now.')
})

test('the lane stores each graphic\'s words for its language on the master clip, one undo step with the lane', () => {
  const timeline = { ...master(), tracks: [], clipCounter: 5 }
  const lane = { language: 'de', removeTrackIds: [], removeClipIds: [], tracks: [], clips: [], clipCounter: 5, graphics: [{ clipId: 'clip-1', localized: { text: { title: LONG_DE }, sources: { title: 'agent' } } }] }
  const applied = applyLanguageLane(timeline, lane)
  assert.deepEqual(applied.clips[0].composition.localized, { de: { text: { title: LONG_DE }, sources: { title: 'agent' } } })
  assert.equal(applied.clips[0].composition.props.title, 'Head of storage research')
  assert.equal(applyLanguageLane(applied, { ...lane, language: 'es', graphics: [{ clipId: 'clip-1', localized: { text: { title: 'Jefa' }, sources: { title: 'agent' } } }] }).clips[0].composition.localized.de.text.title, LONG_DE, 'another language leaves it')
})
