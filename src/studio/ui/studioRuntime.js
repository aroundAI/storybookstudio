// FILM-2015: the renderer glue the five surfaces use, bound to the upstream editor's stores
// and FILM-2012's edit log. Kept apart from the pure models (planCards,
// sceneStrip, review, deliverySummary, pickerModel, sessionGuard) so those run
// under node --test.
import {
  createStudioVersion,
  getStudioEditLog,
  replaceStudioDocument,
  restoreStudioVersion,
  timelineDocument,
} from '../editLogRuntime.js'
import { createElectronEditsSink } from '../editsSink.js'
import { buildExplainWhyReport } from '../report.js'
import { buildReviewModel, mergeAcceptedScenes } from './review.js'
import { PLAN_JOURNAL_PATH, pendingWorkPrompt, recoveryOffer } from './sessionGuard.js'
import { packageBytes } from './pickerModel.js'

const electron = () => globalThis.window?.electronAPI

async function readJsonFile(path) {
  const api = electron()
  if (!api?.readFile || !path) return null
  try {
    const answer = await api.readFile(path, { encoding: 'utf8' })
    return answer?.success ? JSON.parse(answer.data) : null
  } catch {
    return null
  }
}

const joinPath = async (...parts) => (electron()?.pathJoin ? electron().pathJoin(...parts) : parts.join('/'))

const sinkFor = (projectPath) => {
  const api = electron()?.studioEdits
  return api && typeof projectPath === 'string' ? createElectronEditsSink(api, projectPath) : null
}

async function runStep(tool, args) {
  const { runMcpAction } = await import('../../services/mcpActions.js')
  return runMcpAction(tool, args)
}

// The fallback apply path (planActions.applyLocally) until FILM-2013's
// applyPlan lands: versions and op log through FILM-2012, steps through
// the upstream editor's MCP action runner, the journal under edits/.
export function createLocalPlanRunner() {
  return {
    currentVersionId: () => getStudioEditLog()?.versions.current()?.id ?? null,
    createVersion: (name, options) => createStudioVersion(name, options),
    runStep,
    writeJournal: async (entry) => {
      const sink = sinkFor(getStudioEditLog()?.projectPath)
      if (sink) await sink.writeText(PLAN_JOURNAL_PATH, `${JSON.stringify(entry, null, 2)}\n`)
    },
  }
}

// A StoryBook project's side files, for the scene strip, the Deliver screen
// and crash recovery. Returns {} for a plain upstream project.
export async function loadProjectContext(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath) return {}
  const [pkg, link, policy] = await Promise.all([
    readJsonFile(await joinPath(projectPath, 'storybook', 'package.json')),
    readJsonFile(await joinPath(projectPath, 'storybook', 'link.json')),
    readJsonFile(await joinPath(projectPath, 'storybook', 'policy.json')),
  ])
  let recovery = null
  const sink = sinkFor(projectPath)
  if (sink) {
    try {
      const text = await sink.readText(PLAN_JOURNAL_PATH)
      const journal = text ? JSON.parse(text) : null
      // The edit log for this project may still be loading; wait for it briefly.
      let log = getStudioEditLog()
      for (let i = 0; i < 20 && log?.projectPath !== projectPath; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        log = getStudioEditLog()
      }
      recovery = recoveryOffer({ journal, versions: log?.projectPath === projectPath ? log.versions.list() : [] })
    } catch {
      recovery = null
    }
  }
  return {
    pkg,
    link,
    policy,
    sceneHeadings: new Map((pkg?.scenes || []).map((scene) => [scene.number, scene.heading])),
    recovery,
  }
}

export async function clearPlanJournal() {
  const sink = sinkFor(getStudioEditLog()?.projectPath)
  if (sink) await sink.writeText(PLAN_JOURNAL_PATH, `${JSON.stringify({ status: 'done' })}\n`)
}

// Local projects that came from StoryBook: their episode, size and whether a
// re-sync plan is waiting (storybook/resync-plan.json beside a newer package).
export async function readLocalLink(projectPath) {
  const [link, pkg, plan, next] = await Promise.all([
    readJsonFile(await joinPath(projectPath, 'storybook', 'link.json')),
    readJsonFile(await joinPath(projectPath, 'storybook', 'package.json')),
    readJsonFile(await joinPath(projectPath, 'storybook', 'resync-plan.json')),
    readJsonFile(await joinPath(projectPath, 'storybook', 'package.next.json')),
  ])
  if (!link?.episodeId) return null
  return {
    projectPath,
    episodeId: link.episodeId,
    bytes: packageBytes(pkg),
    title: pkg?.episode ? `${pkg.episode.number}. ${pkg.episode.title}` : null,
    updatesAvailable: Boolean(plan && next && plan.etag?.to && plan.etag.to === next.etag),
  }
}

export async function scanLocalLinks(paths) {
  const links = new Map()
  for (const path of [...new Set(paths.filter((value) => typeof value === 'string' && value))]) {
    const link = await readLocalLink(path)
    if (link) links.set(link.episodeId, link)
  }
  return links
}

export async function projectFoldersIn(root) {
  const api = electron()
  if (!api?.listDirectory || !root) return []
  const answer = await api.listDirectory(root)
  return answer?.success ? answer.items.filter((item) => item.isDirectory).map((item) => item.path) : []
}

// The Review screen: before = the snapshot of the plan's version (the
// document before its first step), after = the document now.
export async function loadReview(versionId) {
  const log = getStudioEditLog()
  if (!log) throw new Error('No Studio project is open.')
  const versions = log.versions.list()
  const id = versionId || versions.at(-1)?.id
  if (!id) throw new Error('This project has no versions yet.')
  const before = await log.versions.readSnapshot(id)
  const after = timelineDocument(log.projectStore.getState())
  const entries = log.oplog.entries()
  const report = buildExplainWhyReport({ log: entries, versions, versionId: id, before, after })
  const model = buildReviewModel({ before, after, log: entries, versionId: id })
  const record = versions.find((version) => version.id === id)
  return { versionId: id, version: record, before, after, report, model }
}

export async function acceptScenes({ versionId, before, after, scenes, instruction }) {
  const merged = mergeAcceptedScenes(before, after, scenes)
  const reason = `Accepted scene${scenes.length === 1 ? '' : 's'} ${scenes.join(', ')} of “${instruction || 'the plan'}”; the others are back to the version before it.`
  await replaceStudioDocument(merged, { by: 'user', reason, tool: 'studio_accept_scenes', args: { versionId, scenes } })
  return merged
}

export async function returnToVersion(versionId, reason = 'Return to version before plan') {
  const result = await restoreStudioVersion(versionId, { by: 'user', reason })
  await clearPlanJournal()
  return result
}

// Project close goes through the upstream editor's projectStore.closeProject; wrap it once
// so a waiting plan or a delivery in flight prompts first. Returns unwrap().
export function guardProjectClose(projectStore, studioStore) {
  const original = projectStore.getState().closeProject
  if (typeof original !== 'function' || original.studioGuarded) return () => {}
  const guarded = async (...args) => {
    const state = studioStore.getState()
    const prompt = pendingWorkPrompt({ plans: state.plans, delivery: state.delivery }, 'close')
    if (prompt) {
      const confirmed = await new Promise((resolve) => state.patch({ prompt: { ...prompt, resolve } }))
      studioStore.getState().patch({ prompt: null })
      if (!confirmed) return false
    }
    studioStore.getState().patch({ plans: [], pending: null, review: null, deliverOpen: false, delivery: null, scope: null, recovery: null })
    return original(...args)
  }
  guarded.studioGuarded = true
  projectStore.setState({ closeProject: guarded })
  return () => {
    if (projectStore.getState().closeProject === guarded) projectStore.setState({ closeProject: original })
  }
}
