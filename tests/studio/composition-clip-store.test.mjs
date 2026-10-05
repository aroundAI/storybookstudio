// FILM-2018 AC1: the timeline store holds a composition clip
// {engine, compositionId, props, propsHash, renderPath, languageDependency};
// a props edit drops the render (the preview goes back to its placeholder),
// and a render of old props never lands on a newer edit. The saved project
// validates against the EditGraph schema.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test, { beforeEach } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildSync } from 'esbuild'

import { validateEditGraphProject } from '../../src/studio/contracts/editgraph.schema.js'
import { compositionRenderReady, compositionRenderUrl } from '../../src/studio/compositions/clip.js'

const require = createRequire(import.meta.url)
const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../../src/stores/timelineStore.js', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'zustand', 'zustand/*'],
}).outputFiles[0].text
const module = { exports: {} }
Function('require', 'module', 'exports', 'localStorage', code)(require, module, module.exports, { getItem: () => null, setItem() {}, removeItem() {} })
const store = module.exports.useTimelineStore
const initial = store.getState()

const HASH = 'a'.repeat(64)
const tracks = [{ id: 'video-1', type: 'video' }, { id: 'video-2', type: 'video' }, { id: 'audio-1', type: 'audio' }]
beforeEach(() => store.setState({ ...initial, clips: [], tracks, transitions: [], markers: [], timelineFps: 30, history: [], historyIndex: -1, clipCounter: 1, duration: 60 }))

const add = (patch = {}, at = 2) => store.getState().addCompositionClip('video-2', { engine: 'remotion', compositionId: 'counter', props: { to: 87, suffix: '%' }, ...patch }, at)
const clipOf = (id) => store.getState().clips.find((clip) => clip.id === id)

test('a composition clip carries its composition, the primitive length and no render yet', () => {
  const clip = add()
  assert.equal(clip.type, 'composition')
  assert.equal(clip.assetId, null)
  assert.equal(clip.name, 'Counter')
  assert.deepEqual([clip.startTime, clip.duration, clip.trackId], [2, 4, 'video-2'])
  assert.deepEqual(clip.composition, {
    engine: 'remotion',
    compositionId: 'counter',
    props: { from: 0, to: 87, decimals: 0, prefix: '', suffix: '%', label: '', anchor: 'center' },
    propsHash: null,
    renderPath: null,
    languageDependency: 'none',
  })
  assert.equal(compositionRenderReady(clip), false, 'the preview shows the placeholder')
  assert.equal(store.getState().history.length, 1, 'adding is an undoable edit')
})

test('bad input is refused and adds nothing', () => {
  assert.throws(() => add({ props: { to: 'many' } }), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(() => add({ compositionId: 'sparkles' }), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(() => add({ engine: '' }), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(() => add({ languageDependency: 'fr' }), (error) => error.code === 'VALIDATION_FAILED')
  assert.equal(store.getState().addCompositionClip('audio-1', { engine: 'remotion', compositionId: 'counter', props: { to: 1 } }), null)
  assert.equal(store.getState().clips.length, 0)
})

test('a render lands on the clip that still has its props, and the preview can play it', () => {
  const clip = add()
  const render = { props: clip.composition.props, propsHash: HASH, renderPath: `compositions/counter-${HASH}.webm`, renderUrl: 'storybookstudio://render' }
  assert.equal(store.getState().setCompositionRender(clip.id, render), true)
  const landed = clipOf(clip.id)
  assert.equal(landed.composition.renderPath, render.renderPath)
  assert.equal(compositionRenderUrl(landed), 'storybookstudio://render')
  assert.equal(store.getState().history.length, 1, 'a render landing is not an edit')
})

test('a props edit drops the render; a render of the old props then cannot land', () => {
  const clip = add()
  const oldProps = clip.composition.props
  store.getState().setCompositionRender(clip.id, { props: oldProps, propsHash: HASH, renderPath: `compositions/counter-${HASH}.webm`, renderUrl: 'u' })
  assert.equal(store.getState().updateCompositionProps(clip.id, { to: 90, suffix: '%' }), true)
  const edited = clipOf(clip.id)
  assert.equal(edited.composition.props.to, 90)
  assert.deepEqual([edited.composition.propsHash, edited.composition.renderPath, edited.composition.renderUrl], [null, null, null])
  assert.equal(compositionRenderReady(edited), false)
  assert.equal(store.getState().setCompositionRender(clip.id, { props: oldProps, propsHash: 'b'.repeat(64), renderPath: `compositions/counter-${'b'.repeat(64)}.webm`, renderUrl: 'stale' }), false)
  assert.equal(clipOf(clip.id).composition.renderPath, null)
  assert.throws(() => store.getState().updateCompositionProps(clip.id, { to: 'x' }), (error) => error.code === 'VALIDATION_FAILED')
})

test('the same props again is no edit and keeps the render', () => {
  const clip = add()
  store.getState().setCompositionRender(clip.id, { props: clip.composition.props, propsHash: HASH, renderPath: `compositions/counter-${HASH}.webm`, renderUrl: 'u' })
  const history = store.getState().history.length
  assert.equal(store.getState().updateCompositionProps(clip.id, { suffix: '%', to: 87, from: 0 }), true)
  assert.equal(clipOf(clip.id).composition.renderPath, `compositions/counter-${HASH}.webm`)
  assert.equal(store.getState().history.length, history)
})

test('clearing a render (a brand change, a failure) goes back to the placeholder', () => {
  const clip = add()
  store.getState().setCompositionRender(clip.id, { props: clip.composition.props, propsHash: HASH, renderPath: `compositions/counter-${HASH}.webm`, renderUrl: 'u' })
  store.getState().clearCompositionRender(clip.id, { error: 'ENGINE_UNAVAILABLE' })
  const cleared = clipOf(clip.id)
  assert.equal(compositionRenderReady(cleared), false)
  assert.equal(cleared.composition.renderError, 'ENGINE_UNAVAILABLE')
})

test('the project with a composition clip validates; a renderPath not named by its key does not', () => {
  const clip = add()
  store.getState().setCompositionRender(clip.id, { props: clip.composition.props, propsHash: HASH, renderPath: `compositions/counter-${HASH}.webm`, renderUrl: 'u' })
  const project = { timelines: [{ id: 't1', clips: store.getState().clips }] }
  assert.equal(validateEditGraphProject(project).success, true, JSON.stringify(validateEditGraphProject(project).error?.issues))
  const unrendered = { timelines: [{ id: 't1', clips: [{ ...clip }] }] }
  assert.equal(validateEditGraphProject(unrendered).success, true)
  const wrong = { timelines: [{ id: 't1', clips: [{ ...clip, composition: { ...clip.composition, propsHash: HASH, renderPath: `compositions/counter-${'c'.repeat(64)}.webm` } }] }] }
  assert.equal(validateEditGraphProject(wrong).success, false)
  const half = { timelines: [{ id: 't1', clips: [{ ...clip, composition: { ...clip.composition, propsHash: HASH } }] }] }
  assert.equal(validateEditGraphProject(half).success, false)
  const bare = { timelines: [{ id: 't1', clips: [{ id: 'x', type: 'composition' }] }] }
  assert.equal(validateEditGraphProject(bare).success, false)
})
