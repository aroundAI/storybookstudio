// Opens a StoryBook edit package as a rough cut (FILM-2012). FILM-2011's
// pull job downloads and probes the media, then calls openFromPackage: the
// builder's project and side files are written into the project folder, the
// project opens through Velorn's own openProject, and the result is saved as
// the first version, 'Rough cut', by the AI.
//
// Pure module: the file writer, the opener and the version maker are passed
// in. editLogRuntime.openStudioProjectFromPackage binds them to the
// renderer (window.electronAPI, projectStore.openProject, createStudioVersion).
import { buildProject } from './projectBuilder.js'

export const PROJECT_FILENAME = 'project.comfystudio'
export const ROUGH_CUT_VERSION_NAME = 'Rough cut'

const safeRelativePath = (relativePath) => {
  const parts = String(relativePath).split('/')
  if (!relativePath || relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath) || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`Refusing to write outside the project folder: ${relativePath}`)
  }
  return parts
}

// fs.writeText(projectPath, relativePath, text) over the preload bridge.
export const createElectronProjectFs = (api) => {
  if (!api?.writeFile || !api?.pathJoin || !api?.pathDirname || !api?.createDirectory) {
    throw new Error('The desktop file bridge is not available.')
  }
  return {
    async writeText(projectPath, relativePath, text) {
      const target = await api.pathJoin(projectPath, ...safeRelativePath(relativePath))
      const made = await api.createDirectory(await api.pathDirname(target), { recursive: true })
      if (made && made.success === false) throw new Error(`Could not create the folder for ${relativePath}: ${made.error}`)
      const written = await api.writeFile(target, text)
      if (!written?.success) throw new Error(`Could not write ${relativePath}: ${written?.error || 'unknown error'}`)
    },
  }
}

// Builds and writes; the side files first, so a project file on disk always
// has its storybook/ files beside it.
export async function writeRoughCutProject({ package: pkg, probedAssets, brand, policy, options, projectPath, fs }) {
  if (typeof projectPath !== 'string' || !projectPath) throw new Error('A project folder path is required.')
  if (typeof fs?.writeText !== 'function') throw new Error('A file writer is required.')
  const { project, files, warnings } = buildProject({ package: pkg, probedAssets, brand, policy, options })
  const written = []
  for (const [relativePath, text] of Object.entries(files)) {
    safeRelativePath(relativePath)
    await fs.writeText(projectPath, relativePath, text)
    written.push(relativePath)
  }
  await fs.writeText(projectPath, PROJECT_FILENAME, `${JSON.stringify(project, null, 2)}\n`)
  written.push(PROJECT_FILENAME)
  return { project, warnings, written }
}

export async function openFromPackage({ package: pkg, probedAssets, brand, policy, options, projectPath, fs, openProject, createVersion }) {
  if (typeof openProject !== 'function' || typeof createVersion !== 'function') {
    throw new Error('openProject and createVersion are required.')
  }
  const { project, warnings, written } = await writeRoughCutProject({ package: pkg, probedAssets, brand, policy, options, projectPath, fs })
  const opened = await openProject(projectPath)
  if (!opened) throw new Error(`The rough cut was written to ${projectPath} but did not open.`)
  const version = await createVersion(ROUGH_CUT_VERSION_NAME, { by: 'ai', prompt: null })
  return { projectPath, project, version, warnings, written }
}
