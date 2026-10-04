// Renderer wiring for the Studio op log and versions (FILM-2012). It binds the
// pure modules (oplog.js, versions.js) to Velorn's stores and to the preload
// bridge (window.electronAPI.studioEdits). It imports the stores, so it is not
// a pure module; tests load it through Vite's SSR loader
// (tests/studio/edit-log-runtime.test.mjs).
//
// projectStore starts it when an Electron project opens and stops it on close;
// runMcpAction (src/services/mcpActions.js) routes every action through
// runMcpActionWithEditLog. FILM-2013 reads getStudioEditLog() for the log and
// versions, and calls createStudioVersion / restoreStudioVersion.
import { useAssetsStore } from '../stores/assetsStore'
import { useTimelineStore } from '../stores/timelineStore'
import { createElectronEditsSink } from './editsSink.js'
import { attachUserEditLogger, createOpLog, wrapMcpActionRunner } from './oplog.js'
import { createVersionStore } from './versions.js'
import { createElectronProjectFs, openFromPackage } from './openFromPackage.js'

// Store actions that are a person editing the timeline. Selection, playback,
// zoom, caches, previews and project loading are not edits and are absent.
export const TIMELINE_HAND_EDIT_MUTATORS = Object.freeze([
  'placeLiveCaptions', 'setClipBypass', 'undo', 'redo',
  'applyRollEdit', 'applySlipEdit', 'applySlideEdit', 'applyRippleTrim', 'applyUncompound', 'applyCreateCompound',
  'renameCompound', 'applySmartReplace', 'applySourceEdit',
  'addClip', 'addTextClip', 'addShapeClip', 'addAdjustmentClip', 'updateTextProperties', 'updateShapeProperties',
  'removeClip', 'removeSelectedClips', 'unlockSyncLockedClips', 'lockSyncClips', 'rippleDeleteClipIds',
  'rippleDeleteSelectedClips', 'rippleDeleteSelectedGap', 'applyPasteAttributes', 'pasteClipsAtPlayhead',
  'removeAudioClipsForAsset', 'linkSelectedClips', 'unlinkSelectedClips',
  'moveClip', 'setSelectedClipsStartTimes', 'setSelectedClipPositions', 'moveSelectedClips', 'duplicateClipsForDrag',
  'removeDragDuplicates', 'resizeClip', 'trimClipStart', 'trimClipEnd', 'updateClipTrim', 'updateClipsTrim',
  'updateClipSpeed', 'updateClipFrameSampling', 'updateClipReverse',
  'updateAudioVolumeEnvelope', 'updateAudioEq', 'updateAudioClipProperties', 'applyMultiClipInspectorEdit',
  'updateClipTransform', 'updateClipCompositeMode', 'updateClipTrackMatte', 'updateClipAdjustments',
  'updateClipShapeMask', 'resetClipTransform',
  'setKeyframe', 'removeKeyframe', 'moveKeyframeTime', 'moveKeyframesAtTime', 'pasteKeyframesFromClipboard',
  'toggleKeyframe', 'updateKeyframeEasing', 'clearPropertyKeyframes', 'clearAllKeyframes',
  'applyTextAnimationPreset', 'clearTextAnimationPreset',
  'applyMultiClipEffectsEdit', 'addEffect', 'removeEffect', 'updateEffect', 'toggleEffect', 'reorderEffect', 'addMaskEffect',
  'addTransition', 'addEdgeTransition', 'removeTransition', 'updateTransition', 'setTransitionAlignment',
  'toggleTrackMute', 'toggleTrackSolo', 'setTrackVolume', 'setTrackPan', 'setTrackInserts', 'toggleTrackLock',
  'toggleTrackVisibility', 'setMasterAudioVolume', 'setMasterAudioInserts',
  'setClipsEnabled', 'setClipLabelColor', 'addTrack', 'removeTrack', 'renameTrack', 'reorderTrack',
  'addMarkersBatch', 'addMarker', 'removeMarker', 'clearMarkers',
])

export const ASSET_HAND_EDIT_MUTATORS = Object.freeze([
  'addAsset', 'removeAsset', 'renameAsset', 'setAssetAudioEnabled', 'moveAssetToFolder', 'moveAssetsToFolder',
  'setFolderColor', 'setAssetColor', 'addFolder', 'removeFolder', 'renameFolder', 'addMaskAsset',
])

// Same fields assetsStore.getProjectData() saves, cached per asset object so
// an unchanged asset keeps one reference and the diff skips it.
const savedAssetCache = new WeakMap()
const savedAsset = (asset) => {
  let saved = savedAssetCache.get(asset)
  if (!saved) {
    saved = { ...asset, url: asset.isImported ? null : asset.url, playbackCacheUrl: undefined, proxyUrl: undefined }
    savedAssetCache.set(asset, saved)
  }
  return saved
}

const liveTimelines = (projectState) => {
  const live = useTimelineStore.getState().getProjectData()
  return (projectState?.currentProject?.timelines || []).map((timeline) => (
    timeline.id === projectState.currentTimelineId ? { ...timeline, ...live } : timeline
  ))
}

// What versions snapshot and restore: the project's timelines.
export const timelineDocument = (projectState) => ({
  currentTimelineId: projectState?.currentTimelineId ?? null,
  timelines: liveTimelines(projectState),
})

// What the op log diffs: the timelines plus the asset library.
export const projectDocument = (projectState) => ({
  ...timelineDocument(projectState),
  assets: (useAssetsStore.getState().assets || []).map(savedAsset),
  folders: useAssetsStore.getState().folders || [],
})

// Mirrors projectStore.undoTimelineStructureChange: load the target timeline
// into the timeline store and put the timelines array back on the project.
const loadTimelineDocument = (projectStore, document) => {
  const state = projectStore.getState()
  const timelines = JSON.parse(JSON.stringify(document.timelines || []))
  const currentTimelineId = document.currentTimelineId || timelines[0]?.id || null
  const timeline = timelines.find((candidate) => candidate.id === currentTimelineId) || timelines[0] || null
  if (timeline) {
    const fps = timeline.fps || state.currentProject?.settings?.fps || 24
    useTimelineStore.getState().loadFromProject(timeline, useAssetsStore.getState().getProjectData(), fps)
  }
  projectStore.setState((current) => ({
    currentProject: current.currentProject ? { ...current.currentProject, timelines, currentTimelineId } : null,
    currentTimelineId,
  }))
}

let active = null
let generation = 0

export const getStudioEditLog = () => active

export async function stopStudioEditLog() {
  generation += 1
  const current = active
  active = null
  if (!current) return
  current.detach()
  try {
    await current.oplog.sync()
  } catch (error) {
    console.warn('Studio op log could not be synced on close:', error)
  }
}

export async function startStudioEditLog({ projectPath, projectStore, api = globalThis.window?.electronAPI?.studioEdits, timers } = {}) {
  await stopStudioEditLog()
  if (typeof projectPath !== 'string' || !projectPath || !api || !projectStore) return null
  const mine = generation
  const sink = createElectronEditsSink(api, projectPath)
  const oplog = createOpLog({ sink })
  await oplog.load()
  const versions = createVersionStore({
    sink,
    oplog,
    getDocument: () => timelineDocument(projectStore.getState()),
    setDocument: (document) => loadTimelineDocument(projectStore, document),
  })
  await versions.load()
  if (mine !== generation) return null // another project opened meanwhile
  const getDocument = () => projectDocument(projectStore.getState())
  const detach = attachUserEditLogger({
    stores: [
      { store: useTimelineStore, mutators: TIMELINE_HAND_EDIT_MUTATORS, label: 'timeline' },
      { store: useAssetsStore, mutators: ASSET_HAND_EDIT_MUTATORS, label: 'assets' },
    ],
    oplog,
    getDocument,
    ...(timers ? { timers } : {}),
  })
  active = { projectPath, projectStore, oplog, versions, getDocument, detach }
  return active
}

export function runMcpActionWithEditLog(action, payload, run) {
  const runner = wrapMcpActionRunner(run, { oplog: active?.oplog ?? null, getDocument: active?.getDocument ?? null })
  return runner(action, payload)
}

const recordCurrentVersion = (projectStore, versionId) => {
  projectStore.setState((state) => (state.currentProject?.studio
    ? { currentProject: { ...state.currentProject, studio: { ...state.currentProject.studio, currentVersion: versionId } } }
    : {}))
}

export async function createStudioVersion(name, options) {
  if (!active) throw new Error('No Studio project is open.')
  const version = await active.versions.createVersion(name, options)
  recordCurrentVersion(active.projectStore, version.id)
  return version
}

export async function restoreStudioVersion(versionId, options) {
  if (!active) throw new Error('No Studio project is open.')
  return active.versions.restoreVersion(versionId, options)
}

// studio:buildProject, the entry FILM-2011's pull job calls once the media is
// on disk: writes the rough cut into projectPath, opens it, and saves the
// 'Rough cut' version. projectStore imports this module, hence the dynamic import.
export async function openStudioProjectFromPackage(pkg, probedAssets, { projectPath, brand, policy, options, api = globalThis.window?.electronAPI } = {}) {
  const { useProjectStore } = await import('../stores/projectStore')
  return openFromPackage({
    package: pkg,
    probedAssets,
    brand,
    policy,
    options,
    projectPath,
    fs: createElectronProjectFs(api),
    openProject: (path) => useProjectStore.getState().openProject(path),
    createVersion: (name, versionOptions) => createStudioVersion(name, versionOptions),
  })
}
