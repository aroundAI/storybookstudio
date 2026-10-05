// FILM-2018 AC3: the ten graphics primitives. Per primitive: the schema
// fills its defaults, refuses bad and unknown props, declares text props that
// exist, reads only the brand tokens it declares, and has its Remotion
// component; studio_add_graphic's `text` becomes valid props; and every
// footprint sits inside the safe area of every aspect at every anchor.
// Then the compiler's own choices: the pop, the tracks, the refusals.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { SAFE_AREAS } from '../../src/studio/captions/layout.js'
import {
  COMPOSITION_ANCHORS, COMPOSITION_IDS, GRAPHIC_KINDS, brandTokensFor, getComposition, graphicProps, languageDependencyOf, listCompositions, primitiveForKind, resolveCompositionProps,
} from '../../src/studio/compositions/catalogue.js'
import { insideSafeArea } from '../../src/studio/compositions/placement.js'
import { footprintFor } from '../../src/studio/compositions/remotion/layout.js'
import { compileIntent } from '../../src/studio/compile.js'
import { compile as compileGraphic, libraryPop } from '../../src/studio/intents/add_graphic.js'
import { popWavBytes } from '../../src/studio/compositions/sfx.js'
import { buildStudioContext } from '../../src/studio/context.js'

// The least each primitive needs, a prop it must refuse, and a `text` to read.
const CASES = {
  text: { minimal: { text: 'Hello' }, bad: { text: '' }, text: 'The night the lab went dark' },
  counter: { minimal: { to: 87 }, bad: { to: 87, decimals: 4 }, text: '87% retention' },
  callout: { minimal: { text: 'Look' }, bad: { text: 'Look', pointer: 'sideways' }, text: 'Look here' },
  arrow: { minimal: {}, bad: { direction: 'north' }, text: 'the door' },
  highlight: { minimal: {}, bad: { x: 1.5 }, text: 'Suspect' },
  'lower-third': { minimal: { name: 'Maya' }, bad: { name: 'x'.repeat(61) }, text: 'Maya Rao, Lead engineer' },
  chart: { minimal: { items: [{ label: 'Q1', value: 12 }] }, bad: { items: [{ label: 'Q1', value: -3 }] }, text: 'Q1 12, Q2 18, Q3 30' },
  map: { minimal: { place: 'Lisbon' }, bad: { place: '' }, text: 'Lisbon' },
  timeline: { minimal: { points: [{ date: '1990' }, { date: '2020' }] }, bad: { points: [{ date: '1990' }] }, text: '1990 founded, 2005 IPO, 2020 sold' },
  'progress-bar': { minimal: { value: 72 }, bad: { value: 101 }, text: '72% funded' },
}

const SPEC_PRIMITIVES = ['Text', 'Counter', 'Callout', 'Arrow', 'Highlight', 'LowerThird', 'Chart', 'Map', 'Timeline', 'ProgressBar']
const ROOT = readFileSync(new URL('../../src/studio/compositions/remotion/Root.jsx', import.meta.url), 'utf8')
const rootComponents = () => Object.fromEntries([...ROOT.match(/COMPONENTS = \{([^}]*)\}/)[1].matchAll(/['"]?([a-z][a-z0-9-]*)['"]?:\s*(\w+)/g)].map(([, id, name]) => [id, name]))
const componentFile = (name) => readFileSync(new URL(`../../src/studio/compositions/remotion/${name}.jsx`, import.meta.url), 'utf8')

test('the catalogue has the spec\'s ten primitives, and Root.jsx draws exactly those ids', () => {
  assert.equal(COMPOSITION_IDS.length, 10)
  assert.deepEqual(Object.keys(CASES).sort(), [...COMPOSITION_IDS].sort())
  assert.deepEqual(Object.keys(rootComponents()).sort(), [...COMPOSITION_IDS].sort(), 'catalogue and Root agree')
  assert.deepEqual(COMPOSITION_IDS.map((id) => getComposition(id).title.replace(/\s/g, '').toLowerCase()), SPEC_PRIMITIVES.map((name) => name.toLowerCase()))
})

for (const id of Object.keys(CASES)) {
  test(`${id}: defaults fill, bad and unknown props are refused, text props exist, brand tokens are declared`, () => {
    const { minimal, bad, text } = CASES[id]
    const primitive = getComposition(id)
    const described = listCompositions().find((entry) => entry.id === id)
    const parsed = resolveCompositionProps(id, minimal)
    for (const [key, schema] of Object.entries(primitive.propsSchema.shape)) {
      if (schema._def.typeName !== 'ZodDefault') continue
      assert.deepEqual(parsed[key], schema._def.defaultValue(), `${id}.${key} defaults`)
      assert.match(described.props[key], new RegExp(`default ${JSON.stringify(schema._def.defaultValue()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), `the catalogue says ${id}.${key}'s default`)
    }
    assert.throws(() => resolveCompositionProps(id, bad), (error) => error.code === 'VALIDATION_FAILED', `${id} refuses ${JSON.stringify(bad)}`)
    assert.throws(() => resolveCompositionProps(id, { ...minimal, colour: 'red' }), (error) => error.code === 'VALIDATION_FAILED' && /colour|Unrecognized/.test(error.message))
    for (const path of primitive.textProps) {
      const [head, tail] = path.split('.')
      assert.ok(described.props[head], `${id} declares text prop ${path}`)
      if (tail) assert.match(described.props[head], new RegExp(`[{;] ?${tail}: text`), `${id} declares text prop ${path}`)
      else assert.match(described.props[head], /^text/, `${id}'s text prop ${path} holds text`)
    }
    assert.ok(primitive.defaultDurationSeconds > 0 && primitive.defaultDurationSeconds <= 10)
    const tokens = brandTokensFor(id, {})
    assert.ok(primitive.brandTokens.every((token) => tokens[token] != null), `${id} reads tokens the brand has`)
    // What the component reads is what the render key hashes.
    const read = [...new Set([...componentFile(rootComponents()[id]).matchAll(/brand\['([^']+)'\]/g)].map((match) => match[1]))]
    assert.deepEqual(read.sort(), [...primitive.brandTokens].sort(), `${id}'s component reads exactly its brandTokens`)
    assert.doesNotMatch(componentFile(rootComponents()[id]), /https?:|fetch\(|<img|staticFile/, `${id} draws without the network`)
    const fromText = graphicProps(id, text)
    assert.deepEqual(resolveCompositionProps(id, fromText), fromText, `${id}: text "${text}" gives valid props`)
  })
}

test('text is read into each primitive\'s main props, and `props` wins over it', () => {
  assert.deepEqual(graphicProps('counter', '$1.2M raised'), { from: 0, to: 1.2, decimals: 1, prefix: '$', suffix: 'M', label: 'raised', anchor: 'center' })
  assert.deepEqual(graphicProps('counter', '87', { from: 50, anchor: 'top-left' }).from, 50)
  assert.deepEqual(graphicProps('chart', 'Q1 12%, Q2 18%').items, [{ label: 'Q1', value: 12 }, { label: 'Q2', value: 18 }])
  assert.equal(graphicProps('chart', 'Q1 12%, Q2 18%').unit, '%')
  assert.deepEqual(graphicProps('lower-third', 'Maya Rao | Lead engineer'), { name: 'Maya Rao', title: 'Lead engineer', anchor: 'bottom-left' })
  assert.deepEqual(graphicProps('timeline', '1990 founded, 2020 sold').points, [{ date: '1990', label: 'founded' }, { date: '2020', label: 'sold' }])
  assert.equal(graphicProps('progress-bar', '72% funded').value, 72)
  assert.equal(languageDependencyOf('counter', graphicProps('counter', '87')), 'none', 'a bare number has no words')
  assert.equal(languageDependencyOf('counter', graphicProps('counter', '87 users')), 'language')
  assert.equal(languageDependencyOf('chart', graphicProps('chart', 'Q1 12')), 'language')
})

test('one table maps every kind, including studio_choose_visual_representation\'s, to a catalogue id', () => {
  assert.ok(Object.values(GRAPHIC_KINDS).every((id) => COMPOSITION_IDS.includes(id)))
  assert.ok(COMPOSITION_IDS.every((id) => GRAPHIC_KINDS[id] === id), 'every id is its own kind')
  assert.deepEqual(['text_graphic', 'chart', 'map', 'timeline', 'counter', 'text', 'lower_third', 'progress'].map(primitiveForKind), ['text', 'chart', 'map', 'timeline', 'counter', 'text', 'lower-third', 'progress-bar'])
  assert.throws(() => primitiveForKind('diagram'), /No graphic primitive for kind "diagram"/)
  const visual = readFileSync(new URL('../../src/studio/visualRepresentation.js', import.meta.url), 'utf8')
  for (const [, kind] of visual.matchAll(/graphic\((?:GRAPHIC_KIND\.)?'?([a-z_]+)'?,/g)) assert.ok(GRAPHIC_KINDS[kind], `visualRepresentation hands off kind ${kind}`)
})

test('every footprint, at every anchor, sits inside the safe area of 16:9, 9:16 and 1:1', () => {
  const frames = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] }
  for (const [aspect, [width, height]] of Object.entries(frames)) {
    for (const id of COMPOSITION_IDS) {
      const anchors = id === 'highlight' ? [null] : COMPOSITION_ANCHORS
      for (const anchor of anchors) {
        const props = graphicProps(id, CASES[id].text, anchor ? { anchor } : {})
        const box = footprintFor(id, props, { width, height })
        assert.ok(insideSafeArea(box, { width, height }), `${id} ${anchor} on ${aspect}: ${JSON.stringify(box)}`)
        assert.ok(box.width > 0 && box.height > 0)
      }
    }
  }
  // 9:16 keeps the bottom 25 % clear: a bottom anchor stops above it.
  const lower = footprintFor('lower-third', graphicProps('lower-third', 'Maya'), { width: 1080, height: 1920 })
  assert.ok(lower.y + lower.height <= 1920 * (1 - SAFE_AREAS['9:16'].bottom) + 0.5)
  // A highlight asked to cover the frame's edge is cut to the safe area.
  const edge = footprintFor('highlight', { x: 0, y: 0.8, width: 1, height: 0.2 }, { width: 1080, height: 1920 })
  assert.ok(insideSafeArea(edge, { width: 1080, height: 1920 }))
})

// A small document for the compiler: one shot, an SFX track with a sound at 2 s.
function contextWith({ assets = [], sfxBusy = false } = {}) {
  const timeline = {
    id: 'tl', fps: 24, width: 1920, height: 1080,
    tracks: [{ id: 'video-1', type: 'video', name: 'Shots' }, { id: 'audio-1', type: 'audio', name: 'SFX', bus: 'sfx' }],
    clips: [
      { id: 'shot', trackId: 'video-1', type: 'video', startTime: 0, duration: 10, metadata: { semantic: { scene: 1, role: 'generated_video' } } },
      ...(sfxBusy ? [{ id: 'alarm', trackId: 'audio-1', type: 'audio', startTime: 1.5, duration: 2 }] : []),
    ],
    transitions: [],
    markers: [],
  }
  return buildStudioContext({ project: { name: 'p' }, document: { currentTimelineId: 'tl', timelines: [timeline], assets } })
}

test('the pop: the project\'s own pop SFX when the library has one, else the built-in; on a free SFX track, else a new one', () => {
  const builtIn = compileGraphic(contextWith(), {}, { kind: 'counter', text: '87', at: 2, duration: 2 })
  assert.deepEqual(builtIn.steps.map((step) => step.tool), ['add_track', 'add_composition_clip', 'add_sfx_clip'])
  assert.equal(builtIn.steps[2].arguments.trackId, 'audio-1', 'the SFX track is free at 2 s')
  assert.deepEqual(builtIn.previewAfter, [undefined, 0, undefined], 'the clip previews once its track exists')

  const library = [{ id: 'a-pop', type: 'audio', name: 'UI pop 2', role: 'sfx', duration: 0.2 }, { id: 'a-whoosh', type: 'audio', name: 'Whoosh', role: 'sfx' }]
  assert.equal(libraryPop(contextWith({ assets: library })).id, 'a-pop')
  const own = compileGraphic(contextWith({ assets: library, sfxBusy: true }), {}, { kind: 'callout', text: 'Look', at: 2, duration: 2 })
  assert.deepEqual(own.steps.map((step) => step.tool), ['add_track', 'add_composition_clip', 'add_track', 'add_asset_to_timeline'])
  assert.deepEqual([own.steps[2].arguments.type, own.steps[3].arguments.assetId, own.steps[3].arguments.trackId], ['audio', 'a-pop', 'audio-2'], 'the busy SFX track is left alone')
  assert.deepEqual(own.previewAfter, [undefined, 0, undefined, 2])
  assert.match(own.reasons[3], /project's own pop SFX "UI pop 2"/)

  const quiet = compileGraphic(contextWith(), {}, { kind: 'map', text: 'Lisbon', at: 2, duration: 2 })
  assert.ok(!quiet.steps.some((step) => /sfx|asset/.test(step.tool)), 'only counters and callouts pop')
})

test('the compiler refuses what it cannot place, and its plan is valid for the runner', () => {
  const context = contextWith()
  for (const [params, pattern] of [
    [{ kind: 'counter', text: '87', at: 12, duration: 2 }, /past the end of the picture/],
    [{ kind: 'counter', text: '87', at: -1, duration: 2 }, /at is the start/],
    [{ kind: 'counter', text: '87', at: 1, duration: 61 }, /at most 60/],
    [{ kind: 'highlight', text: 'x', at: 1, duration: 2, anchor: 'top' }, /not at an anchor/],
  ]) assert.throws(() => compileGraphic(context, {}, params), pattern, JSON.stringify(params))
  const plan = compileIntent({ intent: 'graphic:add_graphic', context, params: { kind: 'text', text: 'Hello', at: 8, duration: 5 } })
  assert.equal(plan.steps[1].arguments.durationSeconds, 2, 'cut at the end of the picture')
  assert.match(plan.notes[0].text, /Shortened to 2.0 s/)
})

test('the built-in pop is a 0.3 s 48 kHz mono WAV, the same bytes every time', () => {
  const bytes = popWavBytes()
  const view = new DataView(bytes.buffer)
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF')
  assert.deepEqual([view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)], [1, 48000, 16])
  assert.equal(view.getUint32(40, true), 0.3 * 48000 * 2)
  assert.deepEqual(popWavBytes(), bytes)
})
