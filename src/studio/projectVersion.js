// Project format versions (FILM-2012 AC9). 1.0 is Velorn's single-timeline
// file, 1.1 its multi-timeline file, 1.2 a 1.1 file carrying EditGraph v1
// fields. Stock Velorn never reads `version`, so writing 1.2 is safe for it.
// Pure module: no Electron, no stores.
import { EDITGRAPH_SCHEMA } from './contracts/editgraph.schema.js'

export const ACCEPTED_PROJECT_VERSIONS = Object.freeze(['1.0', '1.1', '1.2'])
export const PROJECT_VERSION_BASE = '1.1'
export const PROJECT_VERSION_STUDIO = '1.2'

const ASSET_STUDIO_KEYS = ['role', 'semantic', 'analysis', 'languageDependency']

const timelinesOf = (project) => [
  ...(Array.isArray(project?.timelines) ? project.timelines : []),
  ...(project?.timeline ? [project.timeline] : []),
]

const clipHasStudioFields = (clip) => Boolean(clip?.metadata?.semantic || clip?.metadata?.origin)

export const hasStudioFields = (project) => {
  if (!project || typeof project !== 'object') return false
  if (project.studio) return true
  if (timelinesOf(project).some((timeline) => timeline?.studio || (timeline?.clips || []).some(clipHasStudioFields))) {
    return true
  }
  return (project.assets || []).some((asset) => ASSET_STUDIO_KEYS.some((key) => asset?.[key] !== undefined))
}

export const stampProjectVersionForSave = (project) => {
  if (!hasStudioFields(project)) {
    return { ...project, version: PROJECT_VERSION_BASE }
  }
  return {
    ...project,
    version: PROJECT_VERSION_STUDIO,
    studio: { ...(project.studio || {}), schema: EDITGRAPH_SCHEMA },
  }
}

// Stock Velorn rewrites `version` on every save (it wrote '1.0' for years), so
// a Studio project it saved says 1.0 while keeping its studio block: the block
// is the stronger signal.
export const resolveOpenedProjectVersion = (project) => {
  if (project?.studio?.schema === EDITGRAPH_SCHEMA) {
    return { version: PROJECT_VERSION_STUDIO, accepted: true }
  }
  const declared = typeof project?.version === 'string' && project.version ? project.version : '1.0'
  return { version: declared, accepted: ACCEPTED_PROJECT_VERSIONS.includes(declared) }
}
