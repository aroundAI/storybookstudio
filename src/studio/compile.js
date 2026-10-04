// Intent compilers → previewable, explainable action plans (FILM-2013,
// contract A1-A3). The model picks an intent and a scope; the compiler picks
// the primitives. compileIntent validates the plan (reasons aligned with
// steps, at most 50 steps, every tool plan-writable); buildPlanCards turns it
// into the per-scene cards the AI panel shows; buildDraftReport into the
// explain-why report it would produce. Pure module: no Electron, no stores.
import { simulatePlan, simulateStep } from './simulate.js'
import { buildExplainWhyReport, formatExplainWhyText } from './report.js'
import { diffDocuments } from './documentDiff.js'
import { CREATE_VERSION_TOOL } from './oplog.js'
import { resolveScope } from './context.js'
import { MAX_PLAN_STEPS, pictureEnd, sceneDuration, shotLabel } from './intents/shared.js'
import * as hitDuration from './intents/hit_duration.js'
import * as tightenPacing from './intents/tighten_pacing.js'
import * as removeDeadAir from './intents/remove_dead_air.js'
import * as openWithStrongestLine from './intents/open_with_strongest_line.js'
import * as keepMusicUnderDialogue from './intents/keep_music_under_dialogue.js'
import * as addBroll from './intents/add_broll.js'
import * as emphasize from './intents/emphasize.js'
import * as addCta from './intents/add_cta.js'
import * as matchBrand from './intents/match_brand.js'
import * as reorderScenes from './intents/reorder_scenes.js'
import * as recutAroundDrops from './intents/recut_around_drops.js'

const BUILT_IN = [hitDuration, tightenPacing, removeDeadAir, openWithStrongestLine, keepMusicUnderDialogue, addBroll, emphasize, addCta, matchBrand, reorderScenes, recutAroundDrops]

const compilers = new Map(BUILT_IN.map((module) => [module.INTENT, { reads: module.reads, compile: module.compile, owner: 'FILM-2013' }]))

export const STUDIO_EDIT_INTENTS = Object.freeze(BUILT_IN.map((module) => module.INTENT))

// Another spec's compiler (FILM-2016's audio and caption intents, FILM-2014's
// repairs) registers here: {reads?, compile} with the same signature.
export function registerIntentCompiler(intent, { reads = () => [], compile, owner = 'external' }) {
  if (typeof compile !== 'function') throw new Error(`registerIntentCompiler(${intent}) needs compile()`)
  compilers.set(intent, { reads, compile, owner })
}
export const hasIntent = (intent) => compilers.has(intent)
export const listIntents = () => [...compilers.keys()]

// Every primitive a compiler may emit. Each is in electron/mcpServer.js
// MCP_ACTION_PLAN_WRITABLE_TOOLS (tests/studio/compile.test.mjs checks it).
export const COMPILER_TOOLS = Object.freeze([
  'extract_range', 'trim_clips', 'delete_clips', 'move_clips', 'split_clip', 'set_clip_speed', 'set_clip_audio',
  'update_transition', 'add_transition', 'remove_transitions', 'add_dip_to_black', 'set_clip_keyframes',
  'update_caption_cues', 'set_timeline_marker_properties', 'add_track', 'add_text_clip', 'add_asset_to_timeline',
])

export class CompileError extends Error {
  constructor(message, code = 'VALIDATION_FAILED', details = undefined) {
    super(message)
    this.code = code
    this.details = details
  }
}

const fail = (message, details) => { throw new CompileError(message, 'VALIDATION_FAILED', details) }

// The reads to run before compile (contract A2): get_audio_analysis and the like.
export function readsFor(intent, context, scope = {}, params = {}) {
  const entry = compilers.get(intent)
  if (!entry) fail(`Unknown intent "${intent}". Intents: ${listIntents().join(', ')}.`)
  return entry.reads ? entry.reads(context, scope, params) : []
}

export function validatePlan(plan, { writable = COMPILER_TOOLS } = {}) {
  const allowed = new Set(writable)
  const problems = []
  if (plan.reasons.length !== plan.steps.length) problems.push(`reasons (${plan.reasons.length}) do not align with steps (${plan.steps.length})`)
  if (plan.steps.length > MAX_PLAN_STEPS) problems.push(`${plan.steps.length} steps, over the ${MAX_PLAN_STEPS}-step limit`)
  plan.steps.forEach((step, index) => {
    if (!allowed.has(step.tool)) problems.push(`step ${index + 1}: ${step.tool} is not a plan-writable tool`)
    if (!plan.reasons[index]) problems.push(`step ${index + 1}: no reason`)
    if (step.arguments?.previewOnly !== undefined) problems.push(`step ${index + 1}: previewOnly belongs to the runner, not the plan`)
  })
  return problems
}

export function compileIntent({ intent, context, scope = {}, params = {}, writable = COMPILER_TOOLS }) {
  const entry = compilers.get(intent)
  if (!entry) fail(`Unknown intent "${intent}". Intents: ${listIntents().join(', ')}.`)
  resolveScope(context, scope) // throws VALIDATION_FAILED for an unknown scene
  let plan
  try {
    plan = entry.compile(context, scope || {}, params || {}, context.policy)
  } catch (error) {
    if (error.code) throw new CompileError(error.message, error.code, error.details)
    throw error
  }
  const problems = validatePlan(plan, { writable })
  if (problems.length) fail(`The ${intent} compiler produced an invalid plan: ${problems.join('; ')}`, { problems })
  return { ...plan, scope: scope || {}, params: params || {} }
}

// Plan cards (contract A3): one per scene the plan changes or comments on,
// [{scene, heading, durationBefore, durationAfter, targetDuration, changes:
// [{text, reason, tool, step}], touchesYourEdits, notes}], the whole-timeline
// card (scene null) last. Durations come from simulating the plan; nothing in
// a card depends on the clock, so the same document and instruction give the
// same cards from every client.
export function buildPlanCards(plan, context) {
  const after = simulatePlan(context.timeline, plan.steps, { fps: context.fps, assets: context.assets }).timeline
  const clips = new Map((context.timeline?.clips || []).map((clip) => [clip.id, clip]))
  const scenes = new Set([...plan.scenes, ...plan.notes.map((note) => note.scene)])
  const ordered = [...scenes].filter((scene) => scene !== null).sort((a, b) => a - b)
  if (scenes.has(null)) ordered.push(null)
  const touches = (sceneFilter) => plan.touchesUserEdits
    .map((id) => clips.get(id))
    .filter((clip) => clip && (sceneFilter === null ? clip.metadata?.semantic?.scene == null || !ordered.includes(clip.metadata.semantic.scene) : clip.metadata?.semantic?.scene === sceneFilter))
    .map((clip) => ({ clipId: clip.id, label: shotLabel(clip) }))
  return ordered.map((scene) => {
    const map = context.sceneMap.find((entry) => entry.scene === scene)
    return {
      scene,
      heading: scene === null ? 'Whole timeline' : map?.heading ?? `Scene ${scene}`,
      durationBefore: scene === null ? pictureEnd(context.timeline) : sceneDuration(context.timeline, scene),
      durationAfter: scene === null ? pictureEnd(after) : sceneDuration(after, scene),
      targetDuration: cardTarget(plan, context, scene, map),
      changes: plan.steps.map((step, index) => ({ step: index + 1, tool: step.tool, text: plan.changes[index], reason: plan.reasons[index], scene: plan.scenes[index] }))
        .filter((change) => change.scene === scene)
        .map(({ step, tool, text, reason }) => ({ text, reason, tool, step })),
      touchesYourEdits: touches(scene),
      notes: plan.notes.filter((note) => note.scene === scene).map((note) => note.text),
    }
  })
}

const scopedScenes = (plan) => [...(Array.isArray(plan.scope?.scenes) ? plan.scope.scenes : []), ...(plan.scope?.scene != null ? [plan.scope.scene] : [])].map(Number)

// A card's target: the caller's targetSeconds when it scoped exactly that
// scene (or nothing, for the whole-timeline card), else the scene map's share.
function cardTarget(plan, context, scene, map) {
  const asked = plan.params?.targetSeconds ?? plan.params?.target
  const scoped = scopedScenes(plan)
  if (asked != null && scene === null && scoped.length === 0) return Number(asked)
  if (asked != null && scoped.length === 1 && scoped[0] === scene) return Number(asked)
  return scene === null ? context.target.seconds : map?.targetDuration ?? null
}

const timelineDocumentOf = (context, timeline) => ({ currentTimelineId: timeline.id ?? context.timeline?.id ?? null, timelines: [timeline] })

// The explain-why report the plan would produce (FILM-2012 report.js), over
// a simulated version 'draft' whose op range holds one line per step.
export function buildDraftReport(plan, context, { prompt = null, createdAt = '1970-01-01T00:00:00.000Z' } = {}) {
  const fps = context.fps
  const working = JSON.parse(JSON.stringify(context.timeline))
  const before = timelineDocumentOf(context, JSON.parse(JSON.stringify(working)))
  const counter = { n: 0 }
  const log = [{ op: 1, ts: createdAt, by: 'ai', session: 'draft', tool: CREATE_VERSION_TOOL, args: { versionId: 'draft', name: 'Draft', prompt }, inverse: null, reason: prompt, scene: null, versionId: 'draft' }]
  plan.steps.forEach((step, index) => {
    const was = timelineDocumentOf(context, JSON.parse(JSON.stringify(working)))
    simulateStep(working, step, { fps, counter, assets: context.assets })
    const now = timelineDocumentOf(context, JSON.parse(JSON.stringify(working)))
    const patch = diffDocuments(now, was)
    log.push({ op: index + 2, ts: createdAt, by: 'ai', session: 'draft', tool: step.tool, args: step.arguments, inverse: patch ? { tool: 'studio_apply_patch', args: { patch } } : null, reason: plan.reasons[index], scene: plan.scenes[index], versionId: 'draft' })
  })
  const parent = context.versions.find((version) => version.id === context.currentVersionId) || null
  const versions = [
    ...(parent ? [{ ...parent, opRange: [...(parent.opRange || [0, 0])] }] : []),
    { id: 'draft', name: `Draft: ${plan.intent}`, parent: parent?.id ?? null, opRange: [1, null], createdBy: 'ai', createdAt, prompt },
  ]
  const after = timelineDocumentOf(context, working)
  const report = buildExplainWhyReport({ log, versions, versionId: 'draft', before, after, qa: null, target: context.target.seconds })
  if (plan.hookType && report.style) report.style.hookType = plan.hookType
  return { report, text: formatExplainWhyText(report) }
}

export function describeInstruction(intent, scope = {}, params = {}) {
  const where = scope?.scene != null ? `scene ${scope.scene}` : Array.isArray(scope?.scenes) && scope.scenes.length ? `scenes ${scope.scenes.join(', ')}` : 'the episode'
  const target = params?.targetSeconds != null ? ` to ${params.targetSeconds} s` : ''
  return params?.instruction ? String(params.instruction) : `${intent.replace(/[_:]/g, ' ')} in ${where}${target}`
}

// compile + cards + draft report: what studio_edit returns on preview.
export function previewIntent({ intent, context, scope = {}, params = {}, writable }) {
  const plan = compileIntent({ intent, context, scope, params, writable })
  const prompt = describeInstruction(intent, scope, params)
  const { report, text } = buildDraftReport(plan, context, { prompt })
  return { plan, cards: buildPlanCards(plan, context), report, reportText: text, prompt }
}
