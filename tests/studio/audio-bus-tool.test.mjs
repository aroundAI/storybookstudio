// FILM-2016: the set_audio_buses MCP tool (renderer handler with an injected
// project store), its registration (tool list, plan-writable set, callTool
// route), the set_master_audio route, and the update_caption_cues extension
// that lets one call land styled, safe-area cues on a live captions clip.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { handleSetAudioBuses } from '../../src/studio/audio/busActions.js'
import { defaultAudioBuses } from '../../src/studio/audio/buses.js'
import { extractTools, extractWritable } from '../../scripts/capability-matrix.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const serverSource = fs.readFileSync(path.join(root, 'electron/mcpServer.js'), 'utf8')

const storeWith = (project) => {
  let state = { currentProject: project }
  return {
    getState: () => state,
    setState: (update) => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } },
  }
}

test('preview by default: the change comes back and nothing changes', () => {
  const store = storeWith({ studio: { audioBuses: defaultAudioBuses(null) } })
  const result = handleSetAudioBuses({ buses: { music: { duckDb: -12 } } }, { projectStore: store })
  assert.equal(result.previewOnly, true)
  assert.deepEqual(result.changes, [{ bus: 'music', field: 'duckDb', from: -8, to: -12 }])
  assert.equal(store.getState().currentProject.studio.audioBuses.music.duckDb, -8)
})

test('applied: project.studio.audioBuses changes, the rest of the project is kept', () => {
  const store = storeWith({ name: 'E03', studio: { schema: 'editgraph/1', audioBuses: defaultAudioBuses(null) } })
  const result = handleSetAudioBuses({ buses: { music: { gainDb: -3 }, master: { limiterLufs: -16 } }, previewOnly: false }, { projectStore: store })
  assert.equal(result.success, true)
  const project = store.getState().currentProject
  assert.equal(project.name, 'E03')
  assert.equal(project.studio.schema, 'editgraph/1')
  assert.equal(project.studio.audioBuses.music.gainDb, -3)
  assert.equal(project.studio.audioBuses.master.limiterLufs, -16)
  assert.equal(project.studio.audioBuses.music.duckDb, -8)
})

test('refused: ducking the dialogue bus, an unknown bus, a project without buses', () => {
  const store = storeWith({ studio: { audioBuses: defaultAudioBuses(null) } })
  assert.throws(() => handleSetAudioBuses({ buses: { dialogue: { duckUnder: 'music' } }, previewOnly: false }, { projectStore: store }), /dialogue bus is never ducked/)
  assert.throws(() => handleSetAudioBuses({ buses: { choir: { gainDb: 1 } } }, { projectStore: store }), /unknown bus/)
  assert.throws(() => handleSetAudioBuses({ buses: { music: { gainDb: 1 } } }, { projectStore: storeWith({ name: 'plain velorn' }) }), /no audio buses/)
  assert.equal(store.getState().currentProject.studio.audioBuses.dialogue.duckUnder, undefined)
})

test('registered: in the tool list, plan-writable, routed in callTool with previewOnly by default; set_master_audio routed too', () => {
  const names = extractTools(serverSource).map((tool) => tool.name ?? tool)
  assert.ok(names.includes('set_audio_buses'))
  assert.ok(new Set(extractWritable(serverSource)).has('set_audio_buses'))
  assert.match(serverSource, /case 'set_audio_buses':\s+return this\.runRendererActionTool\('set_audio_buses', args, \{[^}]*defaultPreviewOnly: true/)
  assert.match(serverSource, /case 'set_master_audio':\s+return this\.runRendererActionTool\('set_master_audio'/)
  const actions = fs.readFileSync(path.join(root, 'src/services/mcpActions.js'), 'utf8')
  assert.match(actions, /case 'set_audio_buses':\s+return handleSetAudioBuses\(request\.payload \|\| \{\}, \{ projectStore: useProjectStore \}\)/)
})

async function loadCaptionHandler() {
  globalThis.window ??= { electronAPI: null, addEventListener() {}, removeEventListener() {} }
  // Node 25 has a localStorage global that throws without --localstorage-file.
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {}, removeItem() {} }, configurable: true, writable: true })
  globalThis.document ??= { createElement: () => ({ getContext: () => null, style: {} }), addEventListener() {} }
  const { build } = await import('esbuild')
  const entry = "export { handleUpdateCaptionCues } from './src/services/mcpCaptions.js'\nexport { default as useTimelineStore } from './src/stores/timelineStore'"
  const out = await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'error', loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' } })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

test('update_caption_cues (the real handler): styled cues and a clip preset land in one call; a later call without style keeps it', async () => {
  const { handleUpdateCaptionCues, useTimelineStore } = await loadCaptionHandler()
  const old = { subtitlePosition: 'action-safe' }
  useTimelineStore.setState({
    clips: [{ id: 'cap-1', type: 'captions', trackId: 'video-2', startTime: 0, duration: 4, sourceDuration: 4, trimStart: 0, trimEnd: 4,
      captions: { preset: { id: 'kinetic-traditional' }, cues: [{ id: 'c1', start: 0, end: 2, text: 'one', globalOverrides: old }, { id: 'c2', start: 2, end: 4, text: 'two', globalOverrides: old }] } }],
    duration: 60,
  })
  const styled = { safeArea: { left: 0.05, right: 0.15, top: 0.08, bottom: 0.25 }, emphasisWords: ['two'], emphasisStyle: 'color' }
  const preview = handleUpdateCaptionCues({ clipId: 'cap-1', cues: [{ id: 'c1', start: 0, end: 2, text: 'one', globalOverrides: styled }, { id: 'c2', start: 2, end: 4, text: 'two', globalOverrides: styled }], preset: { fontFamily: 'Montserrat' }, previewOnly: true })
  assert.equal(preview.previewOnly, true)
  assert.equal(preview.preset.fontFamily, 'Montserrat')
  assert.deepEqual(useTimelineStore.getState().clips[0].captions.cues[0].globalOverrides, old, 'preview changes nothing')

  const applied = handleUpdateCaptionCues({ clipId: 'cap-1', cues: [{ id: 'c1', start: 0, end: 2, text: 'one', globalOverrides: styled }, { id: 'c2', start: 2, end: 4, text: 'two', globalOverrides: styled }], preset: { fontFamily: 'Montserrat' } })
  assert.equal(applied.success, true)
  let clip = useTimelineStore.getState().clips[0]
  assert.deepEqual(clip.captions.cues.map((cue) => cue.globalOverrides), [styled, styled])
  assert.deepEqual(clip.captions.preset, { id: 'kinetic-traditional', fontFamily: 'Montserrat' })

  // second submission: a text fix with no style keeps the brand style
  handleUpdateCaptionCues({ clipId: 'cap-1', edits: [{ id: 'c2', text: 'two!' }] })
  clip = useTimelineStore.getState().clips[0]
  assert.equal(clip.captions.cues[1].text, 'two!')
  assert.deepEqual(clip.captions.cues[1].globalOverrides, styled)
  assert.deepEqual(clip.captions.preset, { id: 'kinetic-traditional', fontFamily: 'Montserrat' })
  const tool = extractTools(serverSource).find((entry) => entry.name === 'update_caption_cues')
  assert.equal(tool.inputSchema.properties.cues.items.properties.globalOverrides.type, 'object')
  assert.equal(tool.inputSchema.properties.preset.type, 'object')
  const buses = extractTools(serverSource).find((entry) => entry.name === 'set_audio_buses')
  assert.deepEqual(buses.inputSchema.required, ['buses'])
})

test('update_caption_cues (the real handler) on one language leaves the other language clip as it was', async () => {
  const { handleUpdateCaptionCues, useTimelineStore } = await loadCaptionHandler()
  const cue = (id, text) => ({ id, start: 0, end: 2, text, globalOverrides: { subtitlePosition: 'action-safe' } })
  const hi = { id: 'cap-hi', type: 'captions', trackId: 'video-3', startTime: 0, duration: 2, sourceDuration: 2, trimStart: 0, trimEnd: 2, captions: { preset: { id: 'kinetic-traditional' }, cues: [cue('h1', 'नमस्ते')] } }
  const en = { id: 'cap-en', type: 'captions', trackId: 'video-2', startTime: 0, duration: 2, sourceDuration: 2, trimStart: 0, trimEnd: 2, captions: { preset: { id: 'kinetic-traditional' }, cues: [cue('e1', 'hello')] } }
  useTimelineStore.setState({ clips: [en, hi], duration: 60 })
  const before = JSON.stringify(useTimelineStore.getState().clips.find((clip) => clip.id === 'cap-en'))
  handleUpdateCaptionCues({ clipId: 'cap-hi', cues: [{ id: 'h1', start: 0, end: 2, text: 'नमस्ते', globalOverrides: { safeArea: { left: 0.05, right: 0.15, top: 0.08, bottom: 0.25 } } }], preset: { fontFamily: 'Noto Sans Devanagari' } })
  const clips = useTimelineStore.getState().clips
  assert.equal(clips.length, 2, 'both captions clips remain')
  assert.equal(JSON.stringify(clips.find((clip) => clip.id === 'cap-en')), before)
  assert.equal(clips.find((clip) => clip.id === 'cap-hi').captions.preset.fontFamily, 'Noto Sans Devanagari')
})
