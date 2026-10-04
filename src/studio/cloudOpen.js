// FILM-2011: the renderer half of a pull. Main has downloaded and probed the
// media; this builds the rough cut and opens it, then reports back through
// studio:pullBuilt so the job can finish. The builder is FILM-2012's
// (editLogRuntime.openStudioProjectFromPackage); a build without it opens a
// sequential stock cut instead, and says so in the job's `builder` field.
import * as editLogRuntime from './editLogRuntime.js'
import { buildSequentialRoughCut } from './sequentialRoughCut.js'

async function openSequential({ package: pkg, probedAssets, projectDir }, api) {
  const { default: useProjectStore } = await import('../stores/projectStore')
  const project = buildSequentialRoughCut({ package: pkg, probedAssets })
  const target = await api.pathJoin(projectDir, 'project.storybookstudio')
  const written = await api.writeFile(target, `${JSON.stringify(project, null, 2)}\n`)
  if (!written?.success) throw new Error(`Could not write the project: ${written?.error || 'unknown error'}`)
  const opened = await useProjectStore.getState().openProject(projectDir)
  if (!opened) throw new Error('The project was written but did not open.')
  return { projectPath: projectDir, warnings: ['FILM-2012 builder not in this build: shots placed sequentially.'], builder: 'sequential-fallback' }
}

export async function openPulledEpisode(input, api = globalThis.window?.electronAPI) {
  const builder = editLogRuntime.openStudioProjectFromPackage
  if (typeof builder !== 'function') return openSequential(input, api)
  const result = await builder(input.package, input.probedAssets, { projectPath: input.projectDir, brand: input.package.brand, policy: input.package.editPolicy })
  return {
    projectPath: result?.projectPath ?? input.projectDir,
    warnings: (result?.warnings || []).map((warning) => (typeof warning === 'string' ? warning : JSON.stringify(warning))),
    builder: 'film-2012',
  }
}

// Wires studio:pull-ready to the builder; returns the unsubscribe.
export function startCloudOpenBridge(api = globalThis.window?.electronAPI) {
  if (!api?.studio?.onPullReady) return () => {}
  return api.studio.onPullReady(async (input) => {
    try {
      const result = await openPulledEpisode(input, api)
      await api.studio.pullBuilt({ jobId: input.jobId, ok: true, ...result })
    } catch (error) {
      await api.studio.pullBuilt({ jobId: input.jobId, ok: false, error: error?.message || String(error) })
    }
  })
}
