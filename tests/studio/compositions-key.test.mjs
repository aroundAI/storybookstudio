// FILM-2018: the composition catalogue and the render key. The key is what
// makes a render reusable: equal inputs must hash equal on every run and
// every machine, and any input that changes the picture must change it.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { COMPOSITION_IDS, brandTokensFor, getComposition, listCompositions, resolveCompositionProps } from '../../src/studio/compositions/catalogue.js'
import { canonicalJson, compositionKeyMaterial, compositionPropsHash, compositionRenderPath } from '../../src/studio/compositions/key.js'

const request = (patch = {}) => ({
  engine: 'remotion',
  compositionId: 'counter',
  props: { to: 87, suffix: '%', label: 'retention' },
  brand: {},
  durationSeconds: 4,
  width: 1920,
  height: 1080,
  fps: 30,
  ...patch,
})

test('canonical JSON sorts keys at every depth and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}')
  assert.throws(() => canonicalJson({ a: Number.NaN }), /finite/)
})

test('the props hash is stable: key order and filled defaults do not change it, and it is pinned', async () => {
  const a = await compositionPropsHash(request())
  const b = await compositionPropsHash(request({ props: { label: 'retention', suffix: '%', to: 87, from: 0, decimals: 0, anchor: 'center' }, brand: { colors: { primary: '#2563EB' } } }))
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)
  // Pinned: a change to the key's makeup must bump COMPOSITION_KEY_VERSION
  // (every cached render is re-rendered), never change it silently.
  assert.equal(a, 'f0ab2da41ced037efaeecdeb821c868e4d6be8495ba8a96d5374cfd4743fca8c')
  assert.equal(compositionRenderPath('counter', a), `compositions/counter-${a}.webm`)
  // The main process hashes with node:crypto (Electron 28 is Node 18, no Web Crypto); the digests agree.
  assert.equal(createHash('sha256').update(compositionKeyMaterial(request())).digest('hex'), a)
})

test('every input that changes the picture changes the hash', async () => {
  const base = await compositionPropsHash(request())
  const variants = {
    props: request({ props: { to: 88, suffix: '%', label: 'retention' } }),
    'a brand token the counter reads': request({ brand: { colors: { primary: '#FF0000' } } }),
    'the heading font': request({ brand: { fonts: { heading: 'Lora' } } }),
    engine: request({ engine: 'other-engine' }),
    duration: request({ durationSeconds: 5 }),
    'frame size': request({ width: 1080, height: 1920 }),
    fps: request({ fps: 24 }),
  }
  for (const [name, changed] of Object.entries(variants)) {
    assert.notEqual(await compositionPropsHash(changed), base, `${name} must change the hash`)
  }
})

test('a brand token the primitive does not read leaves the hash alone', async () => {
  const base = await compositionPropsHash(request())
  assert.equal(await compositionPropsHash(request({ brand: { colors: { background: '#123456' }, musicStyle: ['lo-fi'] } })), base)
})

test('props are checked against the primitive schema, with defaults filled', () => {
  assert.deepEqual(resolveCompositionProps('counter', { to: 5 }), { from: 0, to: 5, decimals: 0, prefix: '', suffix: '', label: '', anchor: 'center' })
  assert.throws(() => resolveCompositionProps('counter', {}), (error) => error.code === 'VALIDATION_FAILED' && /to/.test(error.message))
  assert.throws(() => resolveCompositionProps('counter', { to: 5, colour: 'red' }), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(() => resolveCompositionProps('counter', { to: 5, anchor: 'middle' }), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(() => resolveCompositionProps('sparkles', {}), (error) => error.code === 'VALIDATION_FAILED' && /Known: .*\bcounter\b/.test(error.message))
  assert.throws(() => compositionKeyMaterial(request({ width: 0 })), (error) => error.code === 'VALIDATION_FAILED')
})

test('brand tokens are read by path from a brand with its defaults', () => {
  assert.deepEqual(brandTokensFor('counter', {}), { 'colors.primary': '#2563EB', 'colors.captionText': '#FFFFFF', 'fonts.heading': 'Inter' })
  assert.equal(brandTokensFor('counter', { colors: { primary: '#ff0000' } })['colors.primary'], '#ff0000')
})

test('the catalogue describes each primitive for the agent, and the Remotion root draws every id', () => {
  const catalogue = listCompositions()
  assert.deepEqual(catalogue.map((entry) => entry.id), COMPOSITION_IDS)
  const counter = catalogue.find((entry) => entry.id === 'counter')
  assert.equal(counter.props.to, 'number, required')
  assert.equal(counter.props.anchor, 'anchor, default "center"')
  assert.equal(counter.props.decimals, 'number 0..3, default 0')
  assert.deepEqual(counter.textProps, ['prefix', 'suffix', 'label'])
  assert.equal(getComposition('counter').defaultDurationSeconds, 4)
  const root = readFileSync(new URL('../../src/studio/compositions/remotion/Root.jsx', import.meta.url), 'utf8')
  const components = root.match(/COMPONENTS = \{([^}]*)\}/)[1]
  for (const id of COMPOSITION_IDS) assert.match(components, new RegExp(`(^|[\\s,'"])${id}['"]?:`), `Root.jsx draws ${id}`)
})
