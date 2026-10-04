// The FILM-2013 compilers' input: the FILM-2012 rough cut of a FILM-2001
// fixture package, as the context the renderer would assemble for it.
import { buildProject } from '../../../src/studio/projectBuilder.js'
import { buildStudioContext } from '../../../src/studio/context.js'
import { loadFixture, probesFor } from './rough-cut.mjs'

export function roughCut(shots = 20) {
  const pkg = loadFixture(shots)
  const { project, files } = buildProject({ package: pkg, probedAssets: probesFor(pkg) })
  return { pkg, project, files }
}

export function contextFor({ shots = 20, project: given = null, files: givenFiles = null, mutate = null, log = [], versions = [], currentVersionId = null, audioAnalysis = new Map(), policy = null, brand = null, pkg: pkgOverride = null } = {}) {
  const built = given ? { project: given, files: givenFiles } : roughCut(shots)
  const project = JSON.parse(JSON.stringify(built.project))
  if (mutate) mutate(project)
  const files = built.files
  const document = { currentTimelineId: project.currentTimelineId, timelines: project.timelines, assets: project.assets, folders: project.folders }
  return buildStudioContext({
    project,
    document,
    storybook: {
      package: pkgOverride ?? JSON.parse(files['storybook/package.json']),
      policy: policy ?? JSON.parse(files['storybook/policy.json']),
      brand: brand ?? JSON.parse(files['storybook/brand.json']),
    },
    versions,
    currentVersionId,
    log,
    reads: { audioAnalysis },
  })
}

export const clipByName = (context, prefix) => context.timeline.clips.find((clip) => String(clip.name).startsWith(prefix) && clip.trackId === 'video-1')
