// FILM-2015 renderer integration: the real AI panel, scene strip and send
// confirmation, bundled with esbuild and rendered to markup with a plan
// delivered over the bridge. The upstream editor's stores and the Electron runtime are
// replaced by small stand-ins; the studio store, models and components are
// the shipped ones. Clicks and focus are covered by the packaged-app e2e.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const outDir = path.join(root, 'node_modules', '.cache', 'studio-ui-tests')
const fixture = JSON.parse(readFileSync(new URL('../fixtures/ui/plan-90s.json', import.meta.url), 'utf8'))
const snapshot = JSON.parse(readFileSync(new URL('../fixtures/rough-cut/20-shots.snapshot.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(readFileSync(new URL('../fixtures/edit-package/20-shots.json', import.meta.url), 'utf8'))

const STUBS = {
  // Server-rendered with its live state (see getServerState below).
  'stores/timelineStore': `import { createStore, useStore } from 'zustand'; const api = createStore(() => ({ clips: [], tracks: [], markers: [] })); api.getServerState = () => api.getState(); const hook = (selector) => useStore(api, selector); Object.assign(hook, api); export default hook`,
  'stores/projectStore': `import { create } from 'zustand'; export default create(() => ({ recentProjects: [], openProject: async () => true, openRecentProject: async () => true }))`,
  'studio/ui/studioRuntime': `export const createLocalPlanRunner = () => ({}); export const loadReview = async () => ({}); export const returnToVersion = async () => ({}); export const clearPlanJournal = async () => {}; export const readLocalLink = async () => null; export const scanLocalLinks = async () => new Map(); export const projectFoldersIn = async () => [];`,
  'i18n/I18nContext': `import { translate } from './core.js'; import en from '../../public/lang/lang_en.json'; const t = (key, vars, fallback) => translate({ en }, 'en', key, vars, fallback); export const useI18n = () => ({ t, language: 'en' }); export const I18nProvider = ({ children }) => children;`,
}

const entry = `
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement as h } from 'react'
import AIPanel from './src/components/studio/AIPanel.jsx'
import SceneStrip from './src/components/studio/SceneStrip.jsx'
import { studioUiStore } from './src/studio/ui/studioStore.js'
import { startStudioUiBridge } from './src/studio/ui/studioBridge.js'
import useTimelineStore from './src/stores/timelineStore.js'
export { studioUiStore, startStudioUiBridge, useTimelineStore }
export const render = (component) => renderToStaticMarkup(h(component === 'strip' ? SceneStrip : AIPanel))
`

async function bundle() {
  mkdirSync(outDir, { recursive: true })
  const outfile = path.join(outDir, 'components.mjs')
  await build({
    stdin: { contents: entry, resolveDir: root, loader: 'jsx' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    outfile,
    logLevel: 'silent',
    loader: { '.js': 'jsx', '.json': 'json' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'zustand', 'lucide-react', 'zod'],
    define: { 'import.meta.env.BASE_URL': '"./"' },
    plugins: [{
      name: 'studio-stubs',
      setup(builder) {
        builder.onResolve({ filter: /(stores\/(timelineStore|projectStore)|studio\/ui\/studioRuntime|i18n\/I18nContext)(\.jsx?)?$/ }, (args) => {
          const key = Object.keys(STUBS).find((name) => args.path.includes(name))
          return { path: key, namespace: 'stub' }
        })
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: STUBS[args.path], loader: 'js', resolveDir: path.join(root, 'src', 'i18n') }))
      },
    }],
  })
  writeFileSync(path.join(outDir, 'package.json'), '{"type":"module"}')
  return import(pathToFileURL(outfile).href)
}

const mod = await bundle()
// renderToStaticMarkup reads a zustand store's server snapshot, which is its
// initial state; point it at the live state so the render shows what the bridge stored.
mod.studioUiStore.getServerState = mod.studioUiStore.getState

function fakeStudioApi() {
  const listeners = new Map()
  const on = (channel) => (callback) => { listeners.set(channel, callback); return () => listeners.delete(channel) }
  return {
    emit: (channel, payload) => listeners.get(channel)?.(payload),
    api: { studio: {
      authStatus: async () => ({ success: true, status: { signedIn: true } }),
      rendererReady: async () => ({ success: true }),
      onAuthChanged: on('auth'), onJobProgress: on('job'), onPullReady: on('pull'), onOpenRequest: on('open'), onPlanProposed: on('plan'),
    } },
  }
}

test('a plan proposed over the bridge renders as cards in the AI panel, announced, with approve and reject', () => {
  const { api, emit } = fakeStudioApi()
  mod.studioUiStore.getState().reset()
  const stop = mod.startStudioUiBridge({ api, store: mod.studioUiStore, target: null })
  emit('plan', fixture)
  const html = mod.render('panel')
  stop()
  assert.match(html, /data-test="studio-ai-panel"/)
  assert.equal((html.match(/data-test="studio-plan-card"/g) || []).length, 2)
  assert.match(html, /Scene 1 · INT\. RESEARCH LAB - NIGHT \(1\)/)
  assert.match(html, /19\.0 s → 15\.0 s/)
  assert.match(html, /Second reaction to the same alarm/)
  assert.match(html, /data-test="studio-touches-edits"/)
  assert.match(html, /You trimmed S2\.4 by hand; this plan removes it\./)
  assert.match(html, /data-test="studio-approve-all"/)
  assert.equal((html.match(/data-test="studio-approve-scene"/g) || []).length, 2)
  assert.match(html, /data-test="studio-reject"/)
  // aria-live carries the arrival announcement.
  assert.match(html, /aria-live="polite" data-test="studio-ai-live">Plan ready for “make it 90 seconds”/)
  // Strings come from the locale, not their keys.
  assert.doesNotMatch(html, /panel\.(approveAll|reject|title)/)
  assert.match(html, />Approve all</)
})

test('the scene strip renders one segment per scene and marks a scene over its target', () => {
  mod.studioUiStore.getState().reset()
  mod.studioUiStore.getState().patch({ pkg })
  const timeline = JSON.parse(JSON.stringify(snapshot.project.timelines[0]))
  // Scene 3's last shot grows 3 s and everything after it ripples right.
  for (const clip of timeline.clips) if (clip.startTime >= 60) clip.startTime += 3
  timeline.clips.find((clip) => clip.id === 'clip-12').duration += 3
  mod.useTimelineStore.setState({ clips: timeline.clips, tracks: timeline.tracks, markers: timeline.markers })
  const html = mod.render('strip')
  assert.equal((html.match(/data-test="studio-scene-segment"/g) || []).length, 5)
  assert.equal((html.match(/data-over="true"/g) || []).length, 1)
  assert.match(html, /aria-label="Scene 3 · 24\.0 s of 21\.0 s, 3\.0 s over, INT\. RESEARCH LAB - NIGHT \(3\)"/)
  assert.match(html, /data-test="studio-strip-total">102\.0 s of 99\.0 s</)
})

test('a plain upstream project has no scene strip', () => {
  mod.studioUiStore.getState().reset()
  mod.useTimelineStore.setState({ clips: [{ id: 'c1', trackId: 't1', startTime: 0, duration: 5 }], tracks: [{ id: 't1', type: 'video' }], markers: [] })
  assert.equal(mod.render('strip'), '')
})

test('a no-change "ask" plan shows no Approve all; the drop group is the primary action (task #45)', () => {
  const { api, emit } = fakeStudioApi()
  mod.studioUiStore.getState().reset()
  const stop = mod.startStudioUiBridge({ api, store: mod.studioUiStore, target: null })
  emit('plan', {
    phase: 'proposed', planId: 'ask-1', source: 'in-app', tool: 'studio_edit', intent: 'hit_duration', scope: {}, params: { targetSeconds: 60 },
    instruction: 'make it 60 seconds', cards: [{ scene: null, durationBefore: 99, durationAfter: 99, changes: [] }],
    proposals: [{ kind: 'dialogue_drops', title: 'Needs your OK: drops 6 lines', durationAfter: 60.4, lines: [{ lineId: 'l1', sequenceNumber: 3, scene: 1, character: 'MAYA', text: 'Did you hear that?', reason: 'Repeats line 2', seconds: 1.6 }], approveWith: { tool: 'studio_edit', arguments: { previewOnly: true } } }],
  })
  let html = mod.render('panel')
  assert.doesNotMatch(html, /data-test="studio-approve-all"/)
  assert.doesNotMatch(html, /data-test="studio-approve-scene"/)
  assert.match(html, /data-test="studio-reject"/)
  assert.match(html, /<button[^>]*bg-sf-accent[^>]*data-test="studio-ask-with-drops"/)

  emit('plan', { phase: 'proposed', planId: 'ask-2', source: 'in-app', tool: 'studio_edit', intent: 'hit_duration', scope: {}, params: {}, instruction: 'make it 98 seconds', cards: [{ scene: null, changes: [] }], proposals: [] })
  html = mod.render('panel')
  stop()
  assert.match(html, /data-test="studio-nothing-to-change"/)
  assert.equal((html.match(/data-test="studio-approve-all"/g) || []).length, 0)
})
