// FILM-2018: the real preview, Timeline and export compositor with a
// composition clip. The runner (scripts/check-composition-clips.cjs) injects
// a grey shot and a real Remotion render of the Counter; the main process is
// replaced by an in-memory render bridge whose render lands when the runner
// says so. No project files, no production main.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import Timeline from '../../src/components/Timeline'
import CanvasPreviewRenderer from '../../src/components/CanvasPreviewRenderer'
import useTimelineStore from '../../src/stores/timelineStore'
import useAssetsStore from '../../src/stores/assetsStore'
import useProjectStore from '../../src/stores/projectStore'
import { I18nProvider } from '../../src/i18n/I18nContext'
import { getPreviewFrameSnapshot } from '../../src/services/previewFrameTap'
import { exportTimeline } from '../../src/services/exporter'
import { createCompositionRenderSync } from '../../src/studio/compositions/renderSync'

const ROOT = '/__composition_memory__'
const W = 960
const H = 540
const media = { grey: null, render: null }
let pendingRender = null
const renderCalls = []
const blobUrl = (base64, type) => URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type }))
const track = (id, name, type = 'video') => ({ id, name, type, locked: false, muted: false, visible: true, volume: 100, channels: 'stereo' })

function reset() {
  useAssetsStore.setState({ assets: [{ id: 'grey', name: 'Grey shot', type: 'video', url: media.grey, path: 'media/grey.webm', duration: 8, hasAudio: false, settings: { width: W, height: H, fps: 30, duration: 8, hasAudio: false } }], folders: [], selectedAssetIds: [] })
  useTimelineStore.setState((state) => ({
    timelineSessionId: (Number(state.timelineSessionId) || 0) + 1,
    clips: [{ id: 'shot', name: 'Grey shot', type: 'video', trackId: 'video-1', assetId: 'grey', url: media.grey, startTime: 0, duration: 8, trimStart: 0, trimEnd: 8, sourceDuration: 8, sourceFps: 30, timelineFps: 30, sourceTimeScale: 1, speed: 1, reverse: false, frameSampling: 'frame', enabled: true, transform: { positionX: 0, positionY: 0, scaleX: 100, scaleY: 100, rotation: 0, opacity: 100 } }],
    tracks: [track('video-2', 'Graphics'), track('video-1', 'Video 1'), track('audio-1', 'Audio 1', 'audio')],
    selectedClipIds: [], activeTrackId: 'video-1', history: [], historyIndex: -1, playheadPosition: 3.5, timelineFps: 30, duration: 12, zoom: 120,
    clipCounter: 10, transitions: [], markers: [], isPlaying: false,
  }))
}

// The main process's two calls, in memory: the key follows the props, and a
// render resolves only when the runner calls landRender(), so the
// placeholder can be seen first.
const rendered = new Set()
const keyOf = (request) => {
  const propsHash = Number(request.props.to).toString(16).padStart(64, '0')
  return { propsHash, renderPath: `compositions/${request.compositionId}-${propsHash}.webm` }
}
const api = {
  compositionResolve: async (request) => ({ success: true, ...keyOf(request), cached: rendered.has(keyOf(request).propsHash) }),
  compositionRender: (request) => {
    renderCalls.push(request)
    return new Promise((resolve) => {
      pendingRender = { resolve: () => { rendered.add(keyOf(request).propsHash); resolve({ success: true, ...keyOf(request), cached: false }) } }
    })
  },
}
const sync = createCompositionRenderSync({
  store: useTimelineStore, api,
  getProjectPath: () => ROOT,
  getFrame: () => ({ width: W, height: H, fps: 30 }),
  getFileUrl: async () => media.render,
  schedule: (fn) => setTimeout(fn, 0),
})

function addCounter() {
  return useTimelineStore.getState().addCompositionClip('video-2', { engine: 'remotion', compositionId: 'counter', props: { to: 87, suffix: '%', label: 'retention' } }, 2)
}

// The export compositor with every native call in memory (as smart-replace.jsx does).
async function exportFrameInMemory(time, points) {
  const previousApi = window.electronAPI
  const flags = ['storybookstudio-export-webcodecs', 'storybookstudio-export-gpu']
  const previousFlags = flags.map((key) => localStorage.getItem(key))
  const frames = []
  let size = null
  const validate = (path) => { if (typeof path !== 'string' || !path.startsWith(`${ROOT}/`)) throw new Error(`Non-memory export path refused: ${path}`); return path }
  window.electronAPI = {
    isElectron: true,
    pathJoin: async (...parts) => validate(parts.join('/').replace(/\/+/g, '/')),
    exists: async (path) => { validate(path); return true },
    createDirectory: async (path) => { validate(path); return { success: true } },
    deleteDirectory: async (path) => { validate(path); return { success: true } },
    getFileUrlDirect: async (path) => {
      validate(path)
      if (path.startsWith(`${ROOT}/compositions/`)) return media.render
      if (path === `${ROOT}/media/grey.webm`) return media.grey
      throw new Error(`Unknown in-memory source: ${path}`)
    },
    startFramePipe: async (options) => { validate(options.outputPath); size = { width: options.width, height: options.height }; return { success: true, sessionId: 'memory-only', encoderUsed: 'memory-test-only' } },
    writeFrameToPipe: async (_session, data) => { frames.push(Uint8Array.from(new Uint8Array(data))); return { success: true } },
    finishFramePipe: async () => ({ success: true, encoderUsed: 'memory-test-only' }),
    abortFramePipe: async () => ({ success: true }),
  }
  useProjectStore.setState({ currentProjectHandle: ROOT })
  flags.forEach((key) => localStorage.setItem(key, '0'))
  try {
    await exportTimeline({ width: W, height: H, fps: 30, rangeStart: time, rangeEnd: time + 1 / 30, format: 'mp4', outputPath: `${ROOT}/output.mp4`, includeAudio: false, useCachedRenders: true, useProxyMedia: false, fastSeek: false, sampleAtFrameCenter: false, sourceTimelineWidth: W, sourceTimelineHeight: H })
    const data = frames[0]
    return Object.fromEntries(Object.entries(points).map(([name, [x, y]]) => {
      const at = (y * size.width + x) * 4
      return [name, [...data.slice(at, at + 4)]]
    }))
  } finally {
    window.electronAPI = previousApi
    useProjectStore.setState({ currentProjectHandle: null })
    flags.forEach((key, index) => (previousFlags[index] === null ? localStorage.removeItem(key) : localStorage.setItem(key, previousFlags[index])))
  }
}

function previewPixels(points) {
  const { canvas } = getPreviewFrameSnapshot() || {}
  if (!canvas?.width) return null
  const ctx = canvas.getContext('2d')
  return Object.fromEntries(Object.entries(points).map(([name, [x, y]]) => [name, [...ctx.getImageData(Math.round(x * canvas.width / W), Math.round(y * canvas.height / H), 1, 1).data]]))
}

useProjectStore.setState({ currentProject: { name: 'Composition clips verification', settings: { fps: 30, width: W, height: H }, timelines: [] }, currentProjectHandle: null, currentTimelineId: null })
window.compositionTest = {
  timeline: useTimelineStore,
  initializeMedia({ grey, render }) {
    media.grey = blobUrl(grey, 'video/webm')
    media.render = blobUrl(render, 'video/webm')
    reset()
  },
  reset, addCounter, sync: () => sync.sync(),
  landRender: () => pendingRender?.resolve(),
  renderCalls: () => renderCalls.map((request) => ({ ...request })),
  previewPixels, exportFrameInMemory,
}

function Harness() {
  return (
    <div className="h-screen flex flex-col bg-sf-dark-950 text-sf-text-primary">
      <main className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 p-5">
        <div className="relative w-full max-w-[960px]" style={{ aspectRatio: '16 / 9' }} data-testid="composition-preview">
          <CanvasPreviewRenderer timelineWidth={W} timelineHeight={H} timelineFps={30} />
        </div>
      </main>
      <div className="h-[300px] shrink-0"><Timeline /></div>
    </div>
  )
}
createRoot(document.getElementById('root')).render(<I18nProvider><Harness /></I18nProvider>)
