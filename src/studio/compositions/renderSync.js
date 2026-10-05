// FILM-2018: keeps every composition clip's render current. For each clip it
// asks the main process for the render key (compositionRenderer.resolve):
//
//   key unchanged, file on disk  -> attach the file's URL (after a project
//                                   opens, the saved URL is not trusted)
//   key changed (the brand did)  -> drop the old render (placeholder), render
//   no render yet                -> render, then attach
//
// and a failure leaves the placeholder with the error. It runs when the
// composition clips change and when a project opens, one pass at a time; a
// change during a pass runs another after it. Dependencies are passed in, so
// it runs in tests without Electron.
import { isCompositionClip, sameProps } from './clip.js'

const unwrap = (result) => {
  if (result?.success === false) throw Object.assign(new Error(result.error || 'Composition render failed.'), { code: result.code || 'RENDER_FAILED' })
  return result
}

const signatureOf = (clips) => JSON.stringify(clips.filter(isCompositionClip).map((clip) => [
  clip.id, clip.composition.engine, clip.composition.compositionId, clip.composition.props, clip.sourceDuration ?? clip.duration, clip.composition.renderPath,
]))

export function createCompositionRenderSync({ store, api, getProjectPath, getFrame, getFileUrl, schedule = (fn) => setTimeout(fn, 150) }) {
  // clip id -> renderPath whose URL was resolved in this session
  const resolved = new Map()
  let running = null
  let again = false
  let projectSeen = null

  function requestFor(clip, projectDir, frame) {
    return {
      projectDir,
      engine: clip.composition.engine,
      compositionId: clip.composition.compositionId,
      props: clip.composition.props,
      durationSeconds: Number(clip.sourceDuration ?? clip.duration),
      width: frame.width,
      height: frame.height,
      fps: frame.fps,
    }
  }

  async function syncClip(clip, projectDir, frame) {
    const { composition } = clip
    const stillSame = () => getProjectPath() === projectDir && sameProps(store.getState().clips.find((c) => c.id === clip.id)?.composition?.props, composition.props)
    try {
      const request = requestFor(clip, projectDir, frame)
      const key = unwrap(await api.compositionResolve(request))
      if (composition.propsHash === key.propsHash && key.cached && composition.renderUrl && resolved.get(clip.id) === composition.renderPath) return
      if (composition.propsHash && composition.propsHash !== key.propsHash && stillSame()) store.getState().clearCompositionRender(clip.id)
      const result = key.cached ? key : unwrap(await api.compositionRender(request))
      const renderUrl = await getFileUrl(projectDir, result.renderPath)
      if (!stillSame()) return
      if (store.getState().setCompositionRender(clip.id, { props: composition.props, propsHash: result.propsHash, renderPath: result.renderPath, renderUrl })) {
        resolved.set(clip.id, result.renderPath)
      }
    } catch (error) {
      if (stillSame()) store.getState().clearCompositionRender(clip.id, { error: error?.code || 'RENDER_FAILED' })
    }
  }

  async function pass() {
    const projectDir = getProjectPath()
    if (projectDir !== projectSeen) {
      resolved.clear()
      projectSeen = projectDir
    }
    if (!projectDir) return
    const frame = getFrame()
    for (const clip of store.getState().clips.filter(isCompositionClip)) {
      await syncClip(clip, projectDir, frame)
    }
  }

  function sync() {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        await pass()
      } while (again)
    })().finally(() => { running = null })
    return running
  }

  let last = signatureOf(store.getState().clips)
  let lastProject = getProjectPath()
  let pending = false
  const unsubscribe = store.subscribe((state) => {
    const signature = signatureOf(state.clips)
    const project = getProjectPath()
    if (signature === last && project === lastProject) return
    last = signature
    lastProject = project
    if (pending) return
    pending = true
    schedule(() => { pending = false; sync() })
  })

  return { sync, stop: unsubscribe }
}

// The app's sync: the timeline and project stores, the preload bridge.
export function startCompositionRenderSync({ timelineStore, projectStore, getProjectFileUrl, api = globalThis.window?.electronAPI?.studio }) {
  if (!api?.compositionResolve || !api?.compositionRender) return () => {}
  const getProjectPath = () => {
    const handle = projectStore.getState().currentProjectHandle
    return typeof handle === 'string' ? handle : null
  }
  const sync = createCompositionRenderSync({
    store: timelineStore,
    api,
    getProjectPath,
    getFrame: () => {
      const settings = projectStore.getState().getCurrentTimelineSettings?.() || {}
      return { width: Number(settings.width) || 1920, height: Number(settings.height) || 1080, fps: Number(settings.fps) || 24 }
    },
    getFileUrl: getProjectFileUrl,
  })
  const unsubscribeProject = projectStore.subscribe((state, previous) => {
    if (state.currentProjectHandle !== previous?.currentProjectHandle) sync.sync()
  })
  sync.sync()
  return () => {
    sync.stop()
    unsubscribeProject()
  }
}
