// The renderer side of the capability tools (FILM-2013). The main process
// (electron/studio/mcpCapabilities.js) owns the tools, the per-step previews
// and run_mcp_action_plan; it asks this module, over the mcp:action bridge,
// for what only the renderer has: the live document, the storybook/ files,
// the op log and versions. runMcpAction routes every `studio_*` action here,
// outside the op-log wrapper, because versions log themselves.
//
// Actions: studio_get_context, studio_compile, studio_search_assets,
// studio_readiness_local, studio_create_version, studio_restore_version,
// studio_finish_apply, studio_deliver_summary.
import { useProjectStore } from '../stores/projectStore'
import { buildStudioContext, documentFingerprint, searchAssets, summarizeContext } from './context.js'
import { COMPILER_TOOLS, STUDIO_EDIT_INTENTS, buildDraftReport, buildPlanCards, listIntents, previewIntent, readsFor, validatePlan } from './compile.js'
import { buildExplainWhyReport, formatExplainWhyText, reportPathFor } from './report.js'
import { createStudioVersion, getStudioEditLog, restoreStudioVersion, timelineDocument } from './editLogRuntime.js'
import { snapshotPathFor } from './versions.js'
import { STORYBOOK_FILES } from './projectBuilder.js'
import { RENDER_PRESETS, RENDER_PRESET_NAMES } from './contracts/render-presets.mjs'
import { finishPlan, pictureEnd, shotLabel } from './intents/shared.js'
import { registerExternalIntents } from './externalIntents.js'

// FILM-2016's audio and caption compilers, when this build has them.
export const EXTERNAL_INTENTS = registerExternalIntents(import.meta.glob('./intents/{audio,captions,repair}.js', { eager: true }))
const EXTERNAL_OWNERS = { audio: 'FILM-2016', captions: 'FILM-2016', repair: 'FILM-2014' }

export const STUDIO_RENDERER_ACTIONS = Object.freeze([
  'studio_get_context', 'studio_compile', 'studio_search_assets', 'studio_readiness_local',
  'studio_create_version', 'studio_restore_version', 'studio_finish_apply', 'studio_deliver_summary', 'studio_resync_plan',
  'studio_review_context', 'studio_append_oplog', 'studio_compile_reads',
])
export const RESYNC_PLAN_PATH = 'storybook/resync-plan.json'
export const LAST_QA_PATH = 'edits/qa/latest.json'

export const isStudioRendererAction = (action) => STUDIO_RENDERER_ACTIONS.includes(action)

const studioError = (code, message, details) => Object.assign(new Error(message), { code, details })

// Seams the headless harness and tests replace: how a project file is read,
// how a compile-time read runs, how the snapshot reaches the main process.
const defaults = {
  readProjectFile: async (projectPath, relativePath) => {
    const api = globalThis.window?.electronAPI
    if (!api?.readFile || !api?.pathJoin) return null
    const result = await api.readFile(await api.pathJoin(projectPath, ...relativePath.split('/')), { encoding: 'utf8' })
    return result?.success ? result.data : null
  },
  runRead: null,
  publishSnapshot: null,
}
let seams = { ...defaults }

export function configureStudioRuntime(overrides = {}) {
  seams = { ...seams, ...overrides }
  return () => { seams = { ...defaults } }
}

const projectPathOf = () => {
  const active = getStudioEditLog()
  if (active?.projectPath) return active.projectPath
  const handle = useProjectStore.getState().currentProjectHandle
  return typeof handle === 'string' ? handle : handle?.name || null
}

const readJson = async (projectPath, relativePath) => {
  if (!projectPath) return null
  try {
    const text = await seams.readProjectFile(projectPath, relativePath)
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

async function loadStoryBookFiles(projectPath) {
  const [pkg, policy, brand, link] = await Promise.all([
    readJson(projectPath, STORYBOOK_FILES.package),
    readJson(projectPath, STORYBOOK_FILES.policy),
    readJson(projectPath, STORYBOOK_FILES.brand),
    readJson(projectPath, STORYBOOK_FILES.link),
  ])
  return { package: pkg, policy, brand, link }
}

async function lastQaResult() {
  try {
    const text = await readEdits(LAST_QA_PATH)
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

const readEdits = async (path) => {
  const api = globalThis.window?.electronAPI?.studioEdits
  const projectPath = projectPathOf()
  if (!api || !projectPath) return null
  const result = await api.read(projectPath, path)
  return result?.success ? result.data ?? null : null
}

// The live document plus everything beside it, assembled on every call.
export async function loadStudioContext({ reads = {} } = {}) {
  const projectState = useProjectStore.getState()
  const project = projectState.currentProject
  if (!project) throw studioError('NOT_FOUND', 'No project is open.')
  const active = getStudioEditLog()
  const document = active?.getDocument ? active.getDocument() : { ...timelineDocument(projectState), assets: [] }
  const projectPath = projectPathOf()
  return {
    projectPath,
    document,
    context: buildStudioContext({
      project,
      document,
      storybook: await loadStoryBookFiles(projectPath),
      versions: active?.versions?.list() ?? [],
      currentVersionId: active?.versions?.current()?.id ?? project.studio?.currentVersion ?? null,
      log: active?.oplog?.entries() ?? [],
      lastQa: await lastQaResult(),
      reads,
    }),
  }
}

async function runCompileReads(intent, context, scope, params) {
  const requested = readsFor(intent, context, scope, params)
  const audioAnalysis = new Map()
  const failures = []
  for (const read of requested) {
    if (read.tool !== 'get_audio_analysis') continue
    try {
      const run = seams.runRead || (async (tool, args) => (await import('../services/mcpActions.js')).runMcpAction(tool, args))
      const result = await run(read.tool, read.arguments)
      if (result?.success === false) failures.push({ clipId: read.arguments.clipId, warning: result.warning || 'analysis failed' })
      else audioAnalysis.set(read.arguments.clipId, result)
    } catch (error) {
      failures.push({ clipId: read.arguments.clipId, warning: error?.message || String(error) })
    }
  }
  return { audioAnalysis, requested: requested.length, failures }
}

const isAbsolutePath = (value) => /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(String(value || ''))
const joinPath = (base, relative) => `${String(base).replace(/[\\/]+$/, '')}/${String(relative).replace(/^[\\/]+/, '')}`

// The compile-time audio reads an intent needs, as files and timings, for the
// main process to run with ffmpeg (electron/studio/audioReads.js). The same
// clip timing get_audio_analysis uses, so its timeline mapping is identical.
async function compileReadsAction(payload = {}) {
  const { intent, scope = {}, params = {} } = payload
  if (!listIntents().includes(intent)) return { items: [] }
  const { context, projectPath } = await loadStudioContext()
  const clips = new Map((context.timeline?.clips || []).map((clip) => [clip.id, clip]))
  const assets = new Map((context.assets || []).map((asset) => [asset.id, asset]))
  const items = []
  for (const read of readsFor(intent, context, scope, params)) {
    if (read.tool !== 'get_audio_analysis' || !read.arguments?.clipId) continue
    const clip = clips.get(read.arguments.clipId)
    const asset = clip ? assets.get(clip.assetId) : null
    const stored = asset?.absolutePath || asset?.path || null
    const file = stored && !isAbsolutePath(stored) && projectPath ? joinPath(projectPath, stored) : stored
    const baseScale = clip?.sourceTimeScale || (clip?.timelineFps && clip?.sourceFps ? clip.timelineFps / clip.sourceFps : 1)
    const speed = Number(clip?.speed) > 0 ? Number(clip.speed) : 1
    const timeScale = baseScale * speed
    const trimStart = Number(clip?.trimStart) || 0
    items.push({
      clipId: read.arguments.clipId,
      file: asset?.offline ? null : file,
      trimStart,
      trimEnd: Number.isFinite(Number(clip?.trimEnd)) ? Number(clip.trimEnd) : trimStart + (Number(clip?.duration) || 0) * timeScale,
      startTime: Number(clip?.startTime) || 0,
      timeScale,
      reverse: Boolean(clip?.reverse),
      hasSpeedRamp: (clip?.keyframes?.speed?.length || 0) > 0,
      silenceThresholdDb: read.arguments.silenceThresholdDb,
      minSilenceSeconds: read.arguments.minSilenceSeconds,
      loudness: read.arguments.loudness === true || /^audio:(balance|normalize)$/.test(intent),
    })
  }
  return { items }
}

// Reads the main process ran: { requested, results: {clipId: result}, failures }.
const suppliedReads = (reads) => {
  const audioAnalysis = new Map()
  const failures = [...(reads.failures || [])]
  for (const [clipId, result] of Object.entries(reads.results || {})) {
    if (result?.success === false) failures.push({ clipId, warning: result.warning || 'analysis failed' })
    else audioAnalysis.set(clipId, result)
  }
  return { audioAnalysis, requested: Number(reads.requested) || audioAnalysis.size + failures.length, failures }
}

async function compileAction(payload = {}) {
  const { intent, scope = {}, params = {}, writable } = payload
  const family = String(intent || '').split(':')[0]
  if (EXTERNAL_OWNERS[family] && !listIntents().includes(intent)) {
    throw studioError('VALIDATION_FAILED', `${intent} is not available yet: ${EXTERNAL_OWNERS[family]} builds it (its compilers are not in this build).`, { availableAfter: EXTERNAL_OWNERS[family] })
  }
  if (!STUDIO_EDIT_INTENTS.includes(intent) && !listIntents().includes(intent)) {
    throw studioError('VALIDATION_FAILED', `Unknown intent "${intent}". Intents: ${listIntents().join(', ')}.`)
  }
  const base = await loadStudioContext()
  // The main process runs the audio reads with ffmpeg and passes them in; the
  // renderer's own get_audio_analysis (Web Audio) is the fallback without it.
  const reads = payload.reads ? suppliedReads(payload.reads) : await runCompileReads(intent, base.context, scope, params)
  const { context, document } = await loadStudioContext({ reads: { audioAnalysis: reads.audioAnalysis } })
  const fingerprint = documentFingerprint(document)
  if (fingerprint !== documentFingerprint(base.document)) {
    throw studioError('TARGET_CHANGED', 'The timeline changed while the plan was being compiled; try again.')
  }
  try {
    const preview = previewIntent({ intent, context, scope, params, writable: writable || COMPILER_TOOLS })
    return {
      ...preview,
      fingerprint,
      currentVersionId: context.currentVersionId,
      reads: { requested: reads.requested, failed: reads.failures },
    }
  } catch (error) {
    if (error.code) throw studioError(error.code, error.message, error.details)
    throw error
  }
}

// FILM-2011's re-sync proposal (storybook/resync-plan.json) as a plan in
// the compile shape: its steps and reasons as proposed, cards, a draft report.
async function resyncPlan({ writable } = {}) {
  const { context, document, projectPath } = await loadStudioContext()
  const proposal = await readJson(projectPath, RESYNC_PLAN_PATH)
  if (!proposal?.steps) throw studioError('NOT_FOUND', 'No StoryBook update to apply: studio_check_updates proposes one when the episode changed.')
  // The plan is for the package parked in package.next.json; a newer poll
  // replaced it, so the plan is stale (FILM-2011 rewrites it on its next poll).
  const next = await readJson(projectPath, 'storybook/package.next.json')
  if (proposal.etag?.to && next?.etag && next.etag !== proposal.etag.to) {
    throw studioError('TARGET_CHANGED', `StoryBook changed again since this update was proposed (${proposal.etag.to} -> ${next.etag}); check for updates again.`, { proposed: proposal.etag.to, current: next.etag })
  }
  const clips = new Map((context.timeline?.clips || []).map((clip) => [clip.id, clip]))
  const userEdited = new Set(context.userEditedClipIds)
  const imported = new Map()
  const previewAfter = []
  const entries = proposal.steps.map((raw, index) => {
    const { previewOnly, studioMeta, ...args } = raw.arguments || {}
    const targets = [...(args.clipIds || []), ...(args.clipId ? [args.clipId] : [])]
    if (raw.tool === 'import_asset_from_path') imported.set(String(args.path || '').split(/[\\/]/).pop(), index)
    if (args.assetName && imported.has(args.assetName)) previewAfter[index] = imported.get(args.assetName)
    const text = raw.tool === 'import_asset_from_path' ? `Imported ${String(args.path || '').split(/[\\/]/).pop()}`
      : raw.tool === 'replace_clip_with_asset' ? `Replaced ${shotLabel(clips.get(args.clipId))} with ${args.assetName}`
        : raw.tool === 'delete_clips' ? `Removed ${targets.map((id) => shotLabel(clips.get(id))).join(', ')}`
          : `${raw.tool}`
    return { step: { tool: raw.tool, arguments: args }, reason: raw.reason || studioMeta?.reason || 'StoryBook changed', scene: studioMeta?.scene ?? null, text, touches: targets.filter((id) => userEdited.has(id)) }
  })
  // Velorn will not replace an audio clip with a video asset, so a regenerated
  // shot's own sound comes back unresolved: the old take is removed rather than
  // left playing under the new picture.
  for (const item of proposal.unresolved || []) {
    if (item.kind !== 'shot_audio' || !Array.isArray(item.clipIds) || item.clipIds.length === 0) continue
    const present = item.clipIds.filter((id) => clips.has(id))
    if (!present.length) continue
    const scene = clips.get(present[0])?.metadata?.semantic?.scene ?? null
    entries.push({
      step: { tool: 'delete_clips', arguments: { clipIds: present } },
      reason: 'The shot was regenerated in StoryBook; its old sound would play under the new picture',
      scene,
      text: `Removed the old take's sound (${present.map((id) => shotLabel(clips.get(id))).join(', ')})`,
      touches: present.filter((id) => userEdited.has(id)),
    })
  }
  const notes = [
    ...(proposal.unresolved || []).filter((item) => item.kind !== 'shot_audio').map((item) => ({ scene: null, text: `Not in the plan: ${item.kind} ${item.id}: ${item.reason}` })),
    ...(proposal.unresolved || []).filter((item) => item.kind === 'shot_audio').map((item) => ({ scene: null, text: `The new take of ${item.id} has its own sound in the video; re-add it from the asset if you want it (no primitive places only a video's audio)` })),
    ...(proposal.failedDownloads || []).map((item) => ({ scene: null, text: `Not downloaded: ${item.key} (${item.reason})` })),
  ]
  const plan = { ...finishPlan(context, { intent: 'apply_updates', entries, notes }), previewAfter, scope: {}, params: {} }
  const problems = validatePlan(plan, { writable: writable || COMPILER_TOOLS })
  if (problems.length) throw studioError('VALIDATION_FAILED', `The update plan cannot run: ${problems.join('; ')}`)
  const prompt = `Sync from StoryBook (${proposal.summary ? JSON.stringify(proposal.summary) : proposal.planId})`
  const { report, text } = buildDraftReport(plan, context, { prompt })
  return { plan, cards: buildPlanCards(plan, context), report, reportText: text, prompt, fingerprint: documentFingerprint(document), planKey: proposal.planId ?? null, currentVersionId: context.currentVersionId }
}

async function finishApply({ versionId, hookType = null } = {}) {
  const active = getStudioEditLog()
  if (!active) throw studioError('NOT_FOUND', 'No Studio project is open.')
  await active.oplog.flushPending()
  await active.oplog.idle()
  const versions = active.versions.list()
  const record = versions.find((version) => version.id === versionId)
  if (!record) throw studioError('NOT_FOUND', `Unknown version ${versionId}`)
  const before = await active.versions.readSnapshot(versionId)
  const after = timelineDocument(useProjectStore.getState())
  const { context } = await loadStudioContext()
  const report = buildExplainWhyReport({ log: active.oplog.entries(), versions, versionId, before, after, qa: context.lastQa, target: context.target.seconds })
  if (hookType && report.style) report.style.hookType = hookType
  const text = formatExplainWhyText(report)
  const api = globalThis.window?.electronAPI?.studioEdits
  const reportPath = reportPathFor(versionId)
  if (api && active.projectPath) await api.write(active.projectPath, reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const ops = active.oplog.entries().filter((entry) => entry.versionId === versionId)
  return { version: record, report, reportText: text, reportPath, ops }
}

async function readinessLocal() {
  const { context, projectPath } = await loadStudioContext()
  const issues = []
  const files = await loadStoryBookFiles(projectPath)
  const offline = context.assets.filter((asset) => asset.offline)
  if (!files.package) issues.push({ check: 'package', severity: 'warning', detail: 'No storybook/package.json beside the project: this is not a StoryBook episode, so the script, scene map and policy come from defaults.' })
  if (!files.policy) issues.push({ check: 'policy', severity: 'warning', detail: 'No storybook/policy.json: compilers use the default edit policy.' })
  if (context.target.seconds == null) issues.push({ check: 'target_duration', severity: 'warning', detail: 'No target duration in the policy or the episode; hit_duration needs targetSeconds.' })
  if (offline.length) issues.push({ check: 'media', severity: 'error', detail: `${offline.length} asset${offline.length === 1 ? ' is' : 's are'} offline (not downloaded or not generated): ${offline.slice(0, 5).map((asset) => asset.name).join(', ')}${offline.length > 5 ? ', ...' : ''}` })
  const unprobed = context.assets.filter((asset) => !asset.offline && ['video', 'audio'].includes(asset.type) && !(Number(asset.duration) > 0))
  if (unprobed.length) issues.push({ check: 'probe', severity: 'error', detail: `${unprobed.length} media asset${unprobed.length === 1 ? ' has' : 's have'} no probed duration` })
  const noCodec = context.assets.filter((asset) => asset.type === 'video' && !asset.offline && !asset.settings?.codecs)
  if (noCodec.length) issues.push({ check: 'codecs', severity: 'warning', detail: `${noCodec.length} video asset${noCodec.length === 1 ? ' has' : 's have'} no recorded codec` })
  const captionTracks = (context.timeline?.tracks || []).filter((track) => track.role === 'captions')
  if (context.policy.captions.enabled && captionTracks.length === 0) issues.push({ check: 'captions', severity: 'warning', detail: 'The policy wants captions and the timeline has no captions track.' })
  const empty = context.sceneMap.filter((entry) => entry.actualDuration === 0)
  if (empty.length) issues.push({ check: 'coverage', severity: 'warning', detail: `Scene${empty.length === 1 ? '' : 's'} ${empty.map((entry) => entry.scene).join(', ')} ${empty.length === 1 ? 'has' : 'have'} no shot on the timeline.` })
  return {
    checks: {
      packagePresent: Boolean(files.package),
      policyLoaded: Boolean(files.policy),
      targetKnown: context.target.seconds != null,
      captionsAvailable: captionTracks.length > 0,
      mediaOffline: offline.length,
      mediaUnprobed: unprobed.length,
    },
    issues,
  }
}

async function deliverSummary({ presets = [], languages = [] } = {}) {
  const { context } = await loadStudioContext()
  const unknown = presets.filter((preset) => !RENDER_PRESET_NAMES.includes(preset))
  if (unknown.length) throw studioError('VALIDATION_FAILED', `Unknown preset ${unknown.join(', ')}. Presets: ${RENDER_PRESET_NAMES.join(', ')}.`)
  const duration = pictureEnd(context.timeline)
  const wanted = languages.length ? languages : [context.project.language].filter(Boolean)
  return {
    episode: { id: context.project.episodeId, title: context.project.episodeTitle },
    destination: context.project.episodeId ? 'StoryBook episode renders (request_render_upload → finalize_render → deliver_edit)' : 'local files only (not a StoryBook episode)',
    renders: presets.flatMap((preset) => wanted.map((language) => ({
      preset,
      aspect: RENDER_PRESETS[preset].aspect ?? context.project.aspect,
      language,
      durationSeconds: duration,
      estimatedBytes: null,
      estimatedBytesReason: 'FILM-2017 sets the encoder bitrates; no estimate until then',
    }))),
    lastQa: context.lastQa ? { pass: context.lastQa.pass, issues: context.lastQa.issues?.length ?? 0 } : { pass: null, reason: 'QA has not run (FILM-2014)' },
  }
}

export async function handleStudioAction(action, payload = {}) {
  switch (action) {
    case 'studio_get_context': {
      const { context } = await loadStudioContext()
      return { ...summarizeContext(context, payload.scope || null), intents: listIntents() }
    }
    case 'studio_compile':
      return compileAction(payload)
    case 'studio_compile_reads':
      return compileReadsAction(payload)
    case 'studio_search_assets': {
      const { context } = await loadStudioContext()
      return { results: searchAssets(context, payload) }
    }
    case 'studio_readiness_local':
      return readinessLocal()
    case 'studio_create_version': {
      const name = String(payload.name || '').trim()
      if (!name) throw studioError('VALIDATION_FAILED', 'Provide a version name.')
      const version = await createStudioVersion(name.slice(0, 120), { prompt: payload.prompt ?? null, by: payload.by === 'ai' ? 'ai' : 'user' })
      return { version }
    }
    case 'studio_restore_version': {
      const result = await restoreStudioVersion(String(payload.versionId || ''), { by: payload.by === 'ai' ? 'ai' : 'user', reason: payload.reason ?? null })
      await publishSnapshotNow()
      return { version: result.version, op: result.op }
    }
    case 'studio_finish_apply':
      return finishApply(payload)
    case 'studio_deliver_summary':
      return deliverSummary(payload)
    case 'studio_resync_plan':
      return resyncPlan(payload)
    // FILM-2014's review reads the whole project and the log, and records the
    // vision cost as an ai op-log line.
    case 'studio_review_context': {
      const active = getStudioEditLog()
      const projectState = useProjectStore.getState()
      const projectPath = projectPathOf()
      const files = await loadStoryBookFiles(projectPath)
      let document = active?.getDocument ? active.getDocument() : timelineDocument(projectState)
      // FILM-2014: studio_review {versionId} reviews that version's snapshot
      // (its timelines and buses; the asset library is the live one).
      const { versionId = null } = payload
      if (versionId && versionId !== (active?.versions?.current()?.id ?? null)) {
        const text = await readEdits(snapshotPathFor(versionId))
        const snapshot = text ? JSON.parse(text) : null
        if (!snapshot?.timelines) throw studioError('NOT_FOUND', `No snapshot for version ${versionId}.`)
        document = { ...document, timelines: snapshot.timelines, currentTimelineId: snapshot.currentTimelineId ?? document.currentTimelineId, ...(snapshot.audioBuses ? { audioBuses: snapshot.audioBuses } : {}) }
      }
      const project = { ...(projectState.currentProject || {}), ...document }
      if (document.audioBuses) project.studio = { ...(project.studio || {}), audioBuses: document.audioBuses }
      return {
        project,
        projectPath,
        timelineId: document.currentTimelineId ?? projectState.currentTimelineId ?? null,
        policy: (await loadStudioContext()).context.policy,
        pkg: files.package,
        opLog: active?.oplog?.entries() ?? [],
      }
    }
    case 'studio_append_oplog': {
      const active = getStudioEditLog()
      if (!active) throw studioError('NOT_FOUND', 'No Studio project is open.')
      const tool = String(payload.tool || '')
      if (!/^studio_[a-z_]+$/.test(tool)) throw studioError('VALIDATION_FAILED', 'studio_append_oplog records studio_* tools only.')
      const entry = await active.oplog.append({ by: 'ai', tool, args: payload.args ?? {}, inverse: null, reason: payload.reason ?? null, scene: Number.isInteger(payload.scene) ? payload.scene : null })
      return { entry }
    }
    default:
      throw studioError('VALIDATION_FAILED', `Unknown Studio action ${action}`)
  }
}

// A plan step (one carrying studioMeta) pushes the snapshot before it
// returns, so the main process previews and runs the next step against the
// document this one produced rather than the 350 ms debounced copy.
export async function publishSnapshotNow() {
  if (seams.publishSnapshot) return seams.publishSnapshot()
  const api = globalThis.window?.electronAPI?.mcp
  if (!api?.updateSnapshot) return null
  const { buildMcpSnapshot } = await import('../services/mcpSnapshot.js')
  return api.updateSnapshot(buildMcpSnapshot())
}
