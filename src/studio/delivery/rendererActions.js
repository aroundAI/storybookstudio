// FILM-2017: the two renderer actions delivery needs, reached through the
// mcp:action bridge (src/services/mcpActions.js registers them), so the op
// log and undo see them like any other MCP write:
// - studio_insert_timeline: adds a variant timeline built by the main process
//   (src/studio/intents/variants.js) to the open project; undoable as one
//   timeline-structure change, and optionally switches to it so the reframe's
//   set_clip_keyframes calls land on it;
// - studio_prepare_delivery: saves the project, creates the "Delivered"
//   version and returns the explain-why report and the version_created data.
import { useProjectStore } from '../../stores/projectStore'
import { createStudioVersion, getStudioEditLog, timelineDocument } from '../editLogRuntime.js'
import { buildDeliveryReport, versionCreatedData } from './deliveryReport.js'

const invalid = (message) => Object.assign(new Error(message), { code: 'VALIDATION_FAILED' })

export async function insertStudioTimeline(payload = {}) {
  const timeline = payload.timeline
  if (!timeline || typeof timeline !== 'object' || !timeline.id || !Array.isArray(timeline.clips)) throw invalid('Provide timeline with id and clips.')
  if (timeline.studio?.kind !== 'variant') throw invalid('Only Studio variant timelines are inserted this way.')
  const state = useProjectStore.getState()
  if (!state.currentProject) throw invalid('Open a project first.')
  if ((state.currentProject.timelines || []).some((entry) => entry.id === timeline.id)) throw invalid(`Timeline ${timeline.id} already exists.`)
  if (payload.previewOnly !== false) {
    return { previewOnly: true, action: 'studio_insert_timeline', timeline: { id: timeline.id, name: timeline.name, clipCount: timeline.clips.length, studio: timeline.studio } }
  }
  state.saveTimelineStructureToHistory?.()
  useProjectStore.setState((current) => ({
    currentProject: { ...current.currentProject, timelines: [...(current.currentProject.timelines || []), timeline] },
  }))
  const switched = payload.activate === true ? await useProjectStore.getState().switchTimeline(timeline.id) : false
  return { inserted: true, switched: Boolean(switched), timelineId: timeline.id }
}

export async function prepareStudioDelivery(payload = {}) {
  const log = getStudioEditLog()
  if (!log) throw invalid('This project has no Studio edit log; open the pulled episode first.')
  const state = useProjectStore.getState()
  // The timeline being delivered is the master; render variants keep their own.
  const masterId = (state.currentProject?.timelines || []).find((timeline) => timeline.studio?.kind === 'master')?.id
  if (masterId && state.currentTimelineId !== masterId) await state.switchTimeline(masterId)
  const saved = await useProjectStore.getState().saveProject()
  if (!saved) throw new Error('The project could not be saved before delivery.')
  const name = String(payload.versionName || 'Delivered').slice(0, 200)
  const version = await createStudioVersion(name, { by: 'user', prompt: payload.prompt ?? null })
  const versions = log.versions.list()
  const entries = log.oplog.entries()
  const after = timelineDocument(useProjectStore.getState())
  const before = versions.length ? await log.versions.readSnapshot(versions[0].id) : after
  const report = buildDeliveryReport({
    log: entries,
    versions,
    deliveredVersionId: version.id,
    before,
    after,
    qa: payload.qa ?? null,
    target: payload.targetDuration ?? null,
    hookType: payload.hookType ?? null,
  })
  return {
    prepared: true,
    versionId: version.id,
    report,
    versionCreated: versionCreatedData({ version, versions, log: entries, document: after, durationSeconds: report.finalDuration }),
  }
}
