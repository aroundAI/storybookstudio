// FILM-2018 AC1: the preview shows a placeholder until a composition's
// render lands. renderSync asks the main process for the key and the render
// and attaches the file to the clip; until then (and after a props or brand
// change, or a failure) the clip is not ready and the preview draws the
// placeholder frame.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test, { beforeEach } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildSync } from 'esbuild'

import { compositionRenderReady, drawCompositionPlaceholder } from '../../src/studio/compositions/clip.js'
import { createCompositionRenderSync } from '../../src/studio/compositions/renderSync.js'

const require = createRequire(import.meta.url)
const code = buildSync({
  entryPoints: [fileURLToPath(new URL('../../src/stores/timelineStore.js', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'zustand', 'zustand/*'],
}).outputFiles[0].text
const module = { exports: {} }
Function('require', 'module', 'exports', 'localStorage', code)(require, module, module.exports, { getItem: () => null, setItem() {}, removeItem() {} })
const store = module.exports.useTimelineStore
const initial = store.getState()
beforeEach(() => store.setState({ ...initial, clips: [], tracks: [{ id: 'video-1', type: 'video' }], transitions: [], timelineFps: 30, history: [], historyIndex: -1, clipCounter: 1 }))

const hex = (n) => n.toString(16).padStart(64, '0')
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// The main process in memory: the key is (brand version, props.to); renders resolve on demand.
function fakeMain() {
  const state = { brand: 1, rendered: new Set(), pending: [], resolves: 0 }
  const keyOf = (request) => {
    const propsHash = hex(state.brand * 1000 + request.props.to)
    return { propsHash, renderPath: `compositions/${request.compositionId}-${propsHash}.webm` }
  }
  return {
    state,
    api: {
      compositionResolve: async (request) => { state.resolves += 1; return { success: true, ...keyOf(request), cached: state.rendered.has(keyOf(request).propsHash) } },
      compositionRender: (request) => {
        const job = deferred()
        state.pending.push({ request, ...job, land: () => { state.rendered.add(keyOf(request).propsHash); job.resolve({ success: true, ...keyOf(request), cached: false }) } })
        return job.promise
      },
    },
  }
}

const startSync = (main) => createCompositionRenderSync({
  store, api: main.api,
  getProjectPath: () => '/project',
  getFrame: () => ({ width: 1920, height: 1080, fps: 30 }),
  getFileUrl: async (dir, renderPath) => `file://${dir}/${renderPath}`,
  schedule: (fn) => fn(),
})
const clipOf = (id) => store.getState().clips.find((clip) => clip.id === id)
const until = async (predicate) => {
  for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(predicate(), 'condition never held')
}

test('the placeholder shows until the render lands; then the clip plays the render', async () => {
  const main = fakeMain()
  const sync = startSync(main)
  const clip = store.getState().addCompositionClip('video-1', { engine: 'remotion', compositionId: 'counter', props: { to: 87 } }, 0)
  const running = sync.sync()
  await until(() => main.state.pending.length === 1)
  assert.equal(compositionRenderReady(clipOf(clip.id)), false, 'rendering: placeholder')
  assert.deepEqual(main.state.pending[0].request, { projectDir: '/project', engine: 'remotion', compositionId: 'counter', props: clipOf(clip.id).composition.props, durationSeconds: 4, width: 1920, height: 1080, fps: 30 })
  main.state.pending[0].land()
  await running
  const landed = clipOf(clip.id)
  assert.equal(compositionRenderReady(landed), true)
  assert.equal(landed.composition.renderPath, `compositions/counter-${hex(1087)}.webm`)
  assert.equal(landed.composition.renderUrl, `file:///project/compositions/counter-${hex(1087)}.webm`)
  sync.stop()
})

test('a brand change drops the render to the placeholder and renders again', async () => {
  const main = fakeMain()
  const sync = startSync(main)
  const clip = store.getState().addCompositionClip('video-1', { engine: 'remotion', compositionId: 'counter', props: { to: 87 } }, 0)
  const first = sync.sync()
  await until(() => main.state.pending.length === 1)
  main.state.pending[0].land()
  await first
  main.state.brand = 2
  const second = sync.sync()
  await until(() => main.state.pending.length === 2)
  assert.equal(compositionRenderReady(clipOf(clip.id)), false, 'the old render no longer matches the brand')
  main.state.pending[1].land()
  await second
  assert.equal(clipOf(clip.id).composition.propsHash, hex(2087))
  sync.stop()
})

test('an unchanged clip is not rendered twice, and a render of edited props does not land on the edit', async () => {
  const main = fakeMain()
  const sync = startSync(main)
  const clip = store.getState().addCompositionClip('video-1', { engine: 'remotion', compositionId: 'counter', props: { to: 87 } }, 0)
  const running = sync.sync()
  await until(() => main.state.pending.length === 1)
  store.getState().updateCompositionProps(clip.id, { to: 90 })
  main.state.pending[0].land()
  // The pass that was running rendered 87; the clip now says 90, so 87 does
  // not land, and the follow-up pass (part of the same run) asks for 90.
  await until(() => main.state.pending.length === 2)
  assert.equal(clipOf(clip.id).composition.renderPath, null)
  assert.equal(main.state.pending[1].request.props.to, 90)
  main.state.pending[1].land()
  await running
  assert.equal(compositionRenderReady(clipOf(clip.id)), true)
  await sync.sync()
  assert.equal(main.state.pending.length, 2, 'a ready clip renders nothing more')
  sync.stop()
})

test('a failed render leaves the placeholder with the error', async () => {
  const main = fakeMain()
  main.api.compositionRender = async () => ({ success: false, code: 'ENGINE_UNAVAILABLE', error: 'No composition engine "remotion" is installed.' })
  const sync = startSync(main)
  const clip = store.getState().addCompositionClip('video-1', { engine: 'remotion', compositionId: 'counter', props: { to: 87 } }, 0)
  await sync.sync()
  assert.equal(compositionRenderReady(clipOf(clip.id)), false)
  assert.equal(clipOf(clip.id).composition.renderError, 'ENGINE_UNAVAILABLE')
  sync.stop()
})

test('the placeholder frame is a labelled box in the middle of the frame', () => {
  const calls = []
  const ctx = new Proxy({}, {
    get: (target, name) => (name in target ? target[name] : (...args) => calls.push([name, ...args])),
    set: (target, name, value) => { target[name] = value; calls.push([`set ${name}`, value]); return true },
  })
  const box = drawCompositionPlaceholder(ctx, { width: 1920, height: 1080 }, { type: 'composition', composition: { compositionId: 'counter' } })
  assert.deepEqual(box, { x: 615, y: 443, width: 691, height: 194 })
  assert.deepEqual(calls.find((call) => call[0] === 'fillText').slice(1), ['Counter: rendering…', 960, 540])
  assert.ok(calls.some((call) => call[0] === 'strokeRect'))
  const failed = []
  const failedCtx = new Proxy({}, { get: (t, n) => (n in t ? t[n] : (...a) => failed.push([n, ...a])), set: (t, n, v) => { t[n] = v; return true } })
  drawCompositionPlaceholder(failedCtx, { width: 1080, height: 1920 }, { type: 'composition', composition: { compositionId: 'counter', renderError: 'RENDER_FAILED' } })
  assert.equal(failed.find((call) => call[0] === 'fillText')[1], 'Counter: render failed')
})
