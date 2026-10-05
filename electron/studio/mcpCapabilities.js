// The agent profile (FILM-2013): the capability tools the model sees instead
// of the upstream editor's primitives (133 at 438fdb9; scripts/capability-matrix.mjs counts them). The server in electron/mcpServer.js serves them
// at /mcp?profile=agent (the default); ?profile=expert serves the upstream editor's tools
// plus the lifecycle tools marked `expert` below. Both need the FILM-2010
// bearer.
//
// studio_edit: the renderer compiles the intent on the live document
// (src/studio/compile.js), this module runs every step through the
// primitive's own previewOnly path (callPrimitive), stores the plan under a
// planId and emits the cards (studio:plan-proposed). Apply re-compiles on the
// current document, refuses with TARGET_CHANGED if it moved since the
// preview, creates a version, and runs the steps through run_mcp_action_plan
// with createCheckpointFirst; each step carries studioMeta {reason, scene,
// session}, which the op log records (FILM-2012).
//
// Tools another spec builds answer VALIDATION_FAILED "not available yet"
// (contract S4); the cloud tools answer it until FILM-2011's client is passed
// in. No Electron import: tests run this module under node --test.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { createJobRegistry } = require('./jobs')

const STUDIO_EDIT_INTENTS = Object.freeze([
  'hit_duration', 'tighten_pacing', 'remove_dead_air', 'open_with_strongest_line', 'keep_music_under_dialogue',
  'add_broll', 'emphasize', 'add_cta', 'match_brand', 'reorder_scenes', 'recut_around_drops',
  // FILM-2018's semantic effects.
  'punch_in', 'ken_burns', 'speed_ramp', 'freeze_frame', 'color_grade',
])
const AUDIO_INTENTS = Object.freeze(['balance', 'duck', 'normalize', 'fade'])
// src/studio/compositions/catalogue.js COMPOSITION_ANCHORS (tests/studio/graphic-integration.test.mjs keeps them equal).
const COMPOSITION_ANCHORS = Object.freeze(['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'])
const VARIANT_KINDS = Object.freeze(['short', 'language', 'hook'])
const MAX_REPAIR_ROUNDS = 3
// An autoRepair job's phases, at most: apply; per QA round qa, keyframes,
// qa, critic; a repair between rounds; finish. `done` counts the phases
// entered and reaches `total` when the job ends, early or not.
const JOB_PHASES_MAX = 1 + 4 * MAX_REPAIR_ROUNDS + (MAX_REPAIR_ROUNDS - 1) + 1
const REVIEW_PHASE_TEXT = Object.freeze({ keyframes: 'rendering keyframes, the preview and the mix', qa: 'checks', critic: 'critic' })
const PLAN_TTL_MS = 30 * 60 * 1000
const MAX_STORED_PLANS = 50

const ERROR_CODES = Object.freeze(['VALIDATION_FAILED', 'TARGET_CHANGED', 'NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'])

const scopeSchema = {
  type: 'object',
  description: 'What to act on. Empty means the whole active timeline. {scene: 3} or {scenes: [1, 2]}, {range: [startSeconds, endSeconds]}, {clipIds: [...]}, {timelineId}.',
  properties: {
    scene: { type: 'integer', minimum: 1 },
    scenes: { type: 'array', items: { type: 'integer', minimum: 1 } },
    range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    clipIds: { type: 'array', items: { type: 'string' } },
    timelineId: { type: 'string' },
  },
  additionalProperties: false,
}
const previewOnlySchema = { type: 'boolean', default: true, description: 'Defaults to true: returns plan cards and changes nothing. Apply with previewOnly false and the planId the preview returned.' }

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }

// `owner` is the spec that implements the tool; `available` false means it
// answers VALIDATION_FAILED "not available yet" until that spec lands.
const CAPABILITY_TOOLS = Object.freeze([
  {
    name: 'studio_get_context',
    profiles: ['agent'],
    owner: 'FILM-2013',
    available: true,
    annotations: read,
    description: 'Call this first. Returns the screenplay with dialogue text, the scene map (scene -> clip ids, planned, actual and target duration; every scene appears, even with no clip), the edit policy, the brand, a timeline summary, versions, clips you edited by hand since the last AI plan, and the last QA result.',
    inputSchema: { type: 'object', properties: { scope: scopeSchema }, additionalProperties: false },
  },
  {
    name: 'studio_search_assets',
    profiles: ['agent'],
    owner: 'FILM-2013',
    available: true,
    annotations: read,
    description: 'Rank project assets by their semantic fields (purpose, prompt, characters, camera, tags) and transcript. Returns asset ids to use in edits, never names.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        role: { type: 'string', description: 'An EditGraph role such as broll, dialogue, music, generated_video.' },
        scene: { type: 'integer', minimum: 1 },
        durationRange: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'studio_edit',
    profiles: ['agent'],
    owner: 'FILM-2013',
    available: true,
    annotations: write,
    description: `Plan an edit from an intent, show it as per-scene cards, apply it into a new version on approval. Intents: ${STUDIO_EDIT_INTENTS.join(', ')}. Always preview first (previewOnly defaults to true); show the cards to the user; then call again with previewOnly false and the returned planId. Apply refuses with TARGET_CHANGED if the timeline changed since the preview. Every applied step is logged with its reason; studio_restore_version undoes the whole plan.`,
    inputSchema: {
      type: 'object',
      required: ['intent'],
      properties: {
        intent: { type: 'string', enum: [...STUDIO_EDIT_INTENTS] },
        scope: scopeSchema,
        params: {
          type: 'object',
          description: 'Intent parameters: targetSeconds (hit_duration, tighten_pacing), minSilenceSeconds, keepPauseSeconds, allowJumpCuts, includeUserEdits (touch clips you edited by hand; the card lists them), order (reorder_scenes), lineId or sequenceNumber (open_with_strongest_line, emphasize), clipId, zoomPercent, text (emphasize, add_cta), query, perScene, durationSeconds (add_broll), atSeconds, holdSeconds (punch_in, speed_ramp, freeze_frame: the moment, else the strongest line in scope), direction in|out and pan left|right|up|down|none (ken_burns), speed 0.05-0.99, rampSeconds, resync (speed_ramp), look kodak2395|agfa1978|polaroid|bw and blend (color_grade), instruction (the user\'s words, used as the version prompt), versionName.',
        },
        previewOnly: previewOnlySchema,
        planId: { type: 'string', description: 'From the preview. Required to apply.' },
        autoRepair: { type: 'boolean', default: false, description: 'After apply, run QA and repair up to 3 rounds inside the same version. The call answers at once with {jobId, versionId}: follow it with studio_get_job_status, whose finished job carries the final cards and report.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'studio_edit_audio',
    profiles: ['agent'],
    owner: 'FILM-2016',
    available: true,
    annotations: write,
    description: `Audio intents over the buses: ${AUDIO_INTENTS.join(', ')}. Preview first, as studio_edit: cards and a planId, then previewOnly false with the planId. Compiled by FILM-2016's audio compiler; a build without it answers not available yet.`,
    inputSchema: {
      type: 'object',
      required: ['intent'],
      properties: { intent: { type: 'string', enum: [...AUDIO_INTENTS] }, scope: scopeSchema, params: { type: 'object' }, previewOnly: previewOnlySchema, planId: { type: 'string' }, autoRepair: { type: 'boolean', default: false } },
      additionalProperties: false,
    },
  },
  {
    name: 'studio_add_captions',
    profiles: ['agent'],
    owner: 'FILM-2016',
    available: true,
    annotations: write,
    description: 'Style a language\'s captions with the brand preset and place them inside the safe area of the timeline\'s aspect (FILM-2016\'s compiler). The cues come from the captions clip (a StoryBook rough cut has them); with none, transcribe first. Preview first, then previewOnly false with the planId.',
    inputSchema: {
      type: 'object',
      required: ['language'],
      properties: { language: { type: 'string' }, style: { type: 'string' }, previewOnly: previewOnlySchema, planId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'studio_choose_visual_representation',
    profiles: ['agent'],
    owner: 'FILM-2018',
    available: true,
    annotations: read,
    description: 'For a scene or a point in the script, ranks how to show it: generated_video, stock_video, archival_image, chart, map, diagram, timeline, text_graphic, with a one-line reason each and the tool to act with (studio_add_graphic for a drawn graphic, studio_edit add_broll for library footage). It reads the words (numbers, places, years, process words) and the project (the scene\'s shots, the library); it changes nothing and decides nothing: you pick.',
    inputSchema: {
      type: 'object',
      required: ['sceneOrPoint'],
      properties: {
        sceneOrPoint: {
          type: 'object',
          description: 'One of {scene}, {lineId}, {sequenceNumber}, {atSeconds}, or {text} (the point in your words, optionally with its scene).',
          properties: { scene: { type: 'integer', minimum: 1 }, lineId: { type: 'string' }, sequenceNumber: { type: 'integer' }, atSeconds: { type: 'number', minimum: 0 }, text: { type: 'string' } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'studio_add_graphic',
    profiles: ['agent'],
    owner: 'FILM-2018',
    available: true,
    annotations: write,
    description: 'Places a brand graphic: a composition clip drawn from the catalogue (studio_get_context compositions: text, counter, callout, arrow, highlight, lower-third, chart, map, timeline, progress-bar, each with its props schema) at `at` for `duration` seconds, inside the aspect\'s safe area and clear of the captions on screen with it unless you give an anchor. `text` fills the primitive\'s main props (a counter reads "87%" as to 87, suffix %; a chart "Q1 12, Q2 18"; a lower third "Name, Title"); `props` sets or overrides the rest and is checked against the schema. A counter or callout lands with a pop SFX (the project\'s own pop, else the built-in one). Preview first, as studio_edit: cards and a planId, then previewOnly false with the planId. The graphic renders in the background; a placeholder shows until it lands.',
    inputSchema: {
      type: 'object',
      required: ['kind', 'text', 'at', 'duration'],
      properties: {
        kind: { type: 'string', description: 'A catalogue id or a name for one: text (text_graphic, title), counter, callout, arrow, highlight, lower-third (lower_third), chart, map, timeline, progress-bar (progress).' },
        text: { type: 'string', description: 'The words or numbers the graphic shows; read into the primitive\'s main props.' },
        at: { type: 'number', minimum: 0, description: 'Start on the timeline, in seconds.' },
        duration: { type: 'number', description: 'Seconds on screen, more than 0 and at most 60.' },
        anchor: { type: 'string', enum: COMPOSITION_ANCHORS, description: 'Where in the safe area. Omit to use the primitive\'s own anchor, moved clear of captions.' },
        props: { type: 'object', description: 'Primitive props over what `text` gives, e.g. {"from": 50} for a counter or {"x": 0.6, "y": 0.2, "width": 0.3, "height": 0.4} for a highlight. Unknown props are refused.' },
        previewOnly: previewOnlySchema,
        planId: { type: 'string', description: 'With previewOnly false: the planId the preview returned.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'studio_create_variant',
    profiles: ['agent'],
    owner: 'FILM-2017',
    available: true,
    annotations: write,
    description: 'A variant timeline beside the master (timeline.studio {kind: variant, variantOf, aspect}). kind short: a 9:16 cut of a range, params {source: {candidateId} | {hook: true} | {range: [start, end]}, preset?: shorts_9x16 | tiktok_9x16 | reels_9x16, language?}; the subject is followed with a smoothed crop (faces, else the primary subject; a clip with neither is centred and flagged), captions are re-placed in the 9:16 safe area, and the duration is checked against the preset\'s limit. kind hook: params {variants: 1-5}, alternative first-five-second openings from the strongest lines, each exported to renders/<version>/hooks/. kind language (FILM-2019): params {language, presets?, graphics?}, the dubbed lines StoryBook produced (pulled by re-sync) become a Dialogue (<language>) lane and Captions (<language>) track on the master, placed at each line\'s start and speed-fitted (0.9 to 1.25, never trimmed); graphics {<clipId>: {<text prop>: text}} gives each graphic\'s words in the language (a list prop such as items.label takes one text per item; StoryBook\'s package carries no graphic text, so a graphic quoting a dialogue line takes its dub, and one with no words given keeps the master\'s and is reported); applied, each preset is rendered in that language, its graphics re-rendered and refit (font down to 70%, then wrapped, then up to 20% longer; text that still does not fit fails QA as localized_text_exceeds_container), and QA-checked, including whisper\'s spoken-language check. Preview first (previewOnly defaults to true).',
    inputSchema: {
      type: 'object',
      required: ['kind'],
      properties: { kind: { type: 'string', enum: [...VARIANT_KINDS] }, params: { type: 'object' }, previewOnly: previewOnlySchema },
      additionalProperties: false,
    },
  },
  {
    name: 'studio_review',
    profiles: ['agent'],
    owner: 'FILM-2014',
    available: true,
    annotations: read,
    description: 'Renders the scope (keyframes, a 720p preview, the bus mix with stems), runs deterministic QA (loudness, true peak, clipping, black, frozen, silence, duration, captions in the safe area, missing media, script coverage), then the critic (pacing, audio, visual). Returns {pass, issues, qa, critic, skipped}; every fixable issue names its repairIntent for studio_repair. The visual critic is skipped, and says so, when no vision model is configured. Writes only preview files under cache/ and the last QA (edits/qa/latest.json).',
    inputSchema: { type: 'object', properties: { scope: scopeSchema, versionId: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'studio_repair',
    profiles: ['agent'],
    owner: 'FILM-2014',
    available: true,
    annotations: write,
    description: 'One plan that fixes the given QA issues by their repairIntent, previewed and applied like studio_edit (planId). Compiled by FILM-2014\'s repair compiler; a build without it answers not available yet.',
    inputSchema: { type: 'object', required: ['issues'], properties: { issues: { type: 'array', items: { type: 'object' } }, previewOnly: previewOnlySchema, planId: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'studio_render_preview',
    profiles: ['agent'],
    owner: 'FILM-2014',
    available: true,
    annotations: { ...read, readOnlyHint: false },
    description: 'Render a preview of the scope and run QA on it. quality keyframes (default; one 640 px JPEG per cut and per 2 s), scene (720p, the default with a scene scope), audio (the bus mix as WAV) or full (the whole timeline at 720p). Returns the file, the keyframe paths and the QA result. Previews never wait behind an export.',
    inputSchema: {
      type: 'object',
      properties: { scope: scopeSchema, range: { type: 'array', items: { type: 'number' } }, timeline: { type: 'string' }, quality: { type: 'string', enum: ['keyframes', 'scene', 'audio', 'full'] } },
      additionalProperties: false,
    },
  },
  {
    name: 'studio_check_updates',
    profiles: ['agent'],
    owner: 'FILM-2011',
    available: true,
    annotations: { ...read, openWorldHint: true },
    description: 'Ask StoryBook whether the episode changed since the pull; lists changed shots and dialogue and the replacement plan.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'studio_apply_updates',
    profiles: ['agent'],
    owner: 'FILM-2013',
    available: true,
    annotations: write,
    description: 'Apply the replacement plan studio_check_updates proposed (import the changed media, replace_clip_with_asset, remove deleted shots) into a new version "Sync from StoryBook". Preview first: cards and a planId; apply with previewOnly false and the planId.',
    inputSchema: { type: 'object', properties: { previewOnly: previewOnlySchema, planId: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'studio_open_episode',
    profiles: ['agent', 'expert'],
    owner: 'FILM-2011',
    available: true,
    annotations: { ...write, openWorldHint: true },
    description: 'Start pulling a StoryBook episode (edit package and media) in the main process; returns a jobId for studio_get_job_status. The project opens when the job completes.',
    inputSchema: { type: 'object', required: ['episodeId'], properties: { episodeId: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'studio_get_job_status',
    profiles: ['agent', 'expert'],
    owner: 'FILM-2011',
    available: true,
    annotations: read,
    description: 'Status of a pull, render, deliver or autoRepair edit job: {status, phase, done, total, bytes, error?}. An edit job also names its round and versionId, and when done carries the final cards and report in result.',
    inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'studio_check_readiness',
    profiles: ['agent', 'expert'],
    owner: 'FILM-2013',
    available: true,
    annotations: read,
    description: 'Before editing or delivery: media present and probed, codecs, durations, captions available, policy loaded, target duration known, media health and export readiness. Returns pass or the issues.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'studio_create_version',
    profiles: ['agent', 'expert'],
    owner: 'FILM-2013',
    available: true,
    annotations: write,
    description: 'Save the timeline as a named version (a snapshot plus the op range since the last one).',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, prompt: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'studio_restore_version',
    profiles: ['agent', 'expert'],
    owner: 'FILM-2013',
    available: true,
    annotations: { ...write, destructiveHint: true },
    description: 'Restore a version: the timeline goes back to its snapshot and the restore is logged (and can itself be restored away).',
    inputSchema: { type: 'object', required: ['versionId'], properties: { versionId: { type: 'string' }, reason: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'studio_deliver',
    profiles: ['agent', 'expert'],
    owner: 'FILM-2017',
    available: true,
    annotations: { ...write, openWorldHint: true },
    description: 'With confirm false (the default): a summary per render (preset, language, timeline, frame, estimated size and duration, caption policy, last QA) and the destination, with no side effects, plus its summaryHash. confirm true renders, QA-checks, uploads and calls deliver_edit, and is accepted only with confirmationToken: the one-time token the Deliver screen issues when the user confirms that exact summary. An MCP client cannot obtain one. destination folder (Export to file) writes the files and a QA report to a folder with no sign-in. Returns a jobId; follow it with studio_get_job_status.',
    inputSchema: {
      type: 'object',
      required: ['presets'],
      properties: {
        presets: { type: 'array', items: { type: 'string' }, minItems: 1 },
        languages: { type: 'array', items: { type: 'string' } },
        destination: { type: 'string', enum: ['storybook', 'folder'] },
        folder: { type: 'string' },
        confirm: { type: 'boolean', default: false },
        confirmationToken: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
])

const BY_NAME = new Map(CAPABILITY_TOOLS.map((tool) => [tool.name, tool]))
const LIFECYCLE_TOOL_NAMES = Object.freeze(CAPABILITY_TOOLS.filter((tool) => tool.profiles.includes('expert')).map((tool) => tool.name))

// Every studio_* write tool but studio_deliver may be a run_mcp_action_plan
// step (contract S3).
const PLAN_WRITABLE_CAPABILITY_TOOLS = Object.freeze(CAPABILITY_TOOLS
  .filter((tool) => tool.annotations.readOnlyHint === false && tool.name !== 'studio_deliver' && tool.name !== 'studio_render_preview' && tool.name !== 'studio_open_episode')
  .map((tool) => tool.name))

function definitionsFor(profile) {
  return CAPABILITY_TOOLS.filter((tool) => tool.profiles.includes(profile)).map((tool) => ({
    name: tool.name,
    description: tool.available ? tool.description : `${tool.description} (Answers "not available yet" until ${tool.owner}.)`,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }))
}

const textContent = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const ok = (value) => textContent(value)
const failure = (code, message, details) => ({
  ...textContent({ error: { code: ERROR_CODES.includes(code) ? code : 'VALIDATION_FAILED', message, ...(details === undefined ? {} : { details }) } }),
  isError: true,
})
const notAvailable = (tool, extra = '') => failure('VALIDATION_FAILED', `${tool.name} is not available yet: ${tool.owner} builds it.${extra}`, { availableAfter: tool.owner })

function parseResult(result) {
  try {
    return JSON.parse(result?.content?.[0]?.text ?? 'null')
  } catch {
    return null
  }
}

// One-level argument check against a tool's JSON schema: required keys,
// unknown keys, primitive types and enums. Deeper shapes the compiler checks.
function checkArguments(tool, args) {
  const schema = tool.inputSchema
  const problems = []
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ['arguments must be an object']
  for (const key of schema.required || []) if (args[key] === undefined) problems.push(`${key} is required`)
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties?.[key]
    if (!property) {
      if (schema.additionalProperties === false) problems.push(`unknown argument ${key}`)
      continue
    }
    const type = property.type
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    const matches = type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' : type ? actual === type : true
    if (!matches) problems.push(`${key} must be ${type}`)
    if (property.enum && !property.enum.includes(value)) problems.push(`${key} must be one of ${property.enum.join(', ')}`)
  }
  return problems
}

// After a re-sync plan applies, the newer package FILM-2011 parked in
// storybook/package.next.json becomes the one the project is built from.
function promoteResyncPackage(projectDir) {
  if (typeof projectDir !== 'string' || !projectDir) return false
  const next = path.join(projectDir, 'storybook', 'package.next.json')
  if (!fs.existsSync(next)) return false
  fs.renameSync(next, path.join(projectDir, 'storybook', 'package.json'))
  const plan = path.join(projectDir, 'storybook', 'resync-plan.json')
  if (fs.existsSync(plan)) fs.renameSync(plan, path.join(projectDir, 'storybook', 'resync-plan.applied.json'))
  return true
}

// studio_add_graphic's arguments as the compiler's params (no previewOnly or planId).
const graphicParams = ({ kind, text, at, duration, anchor, props }) => ({ kind, text, at, duration, ...(anchor === undefined ? {} : { anchor }), ...(props === undefined ? {} : { props }) })

function createCapabilityTools({
  performAction = null,
  callPrimitive,
  getCloud = () => null,
  emitPlanProposed = () => {},
  writableTools = null,
  getProjectPath = () => null,
  // FILM-2017: studioMain.deliver (electron/studio/deliver.js).
  getDeliver = () => null,
  getSnapshot = () => null,
  analyzeAudio = null,
  review = null,
  repair = null,
  reviewTools = null,
  clock = () => Date.now(),
  newId = () => crypto.randomUUID(),
  // autoRepair edit jobs; studio_get_job_status reads them before FILM-2011's pull and deliver jobs.
  jobs = createJobRegistry(),
} = {}) {
  const plans = new Map()
  // The autoRepair loop's review: the one passed in, else FILM-2014's studio_review handler.
  const reviewRound = review || (reviewTools ? (args, options) => reviewTools.review(args, options) : null)
  // The autoRepair loop's repair: the one passed in, else FILM-2014's compiler in the renderer.
  const repairPlan = repair || (async ({ issues }) => {
    const compiled = await compileWithReads({ intent: 'repair', scope: {}, params: { issues }, writable: writable() })
    return compiled?.studioError ? null : compiled
  })

  const renderer = async (action, payload = {}) => {
    if (typeof performAction !== 'function') {
      return { studioError: { code: 'VALIDATION_FAILED', message: 'The StorybookStudio window is not connected (the renderer bridge is not available).' } }
    }
    try {
      return await performAction(action, payload)
    } catch (error) {
      return { studioError: { code: 'VALIDATION_FAILED', message: error?.message || String(error) } }
    }
  }
  const fromRenderer = (result) => (result?.studioError ? failure(result.studioError.code, result.studioError.message, result.studioError.details) : null)

  const rememberPlan = (entry) => {
    const now = clock()
    for (const [id, stored] of plans) if (now - stored.createdAt > PLAN_TTL_MS) plans.delete(id)
    while (plans.size >= MAX_STORED_PLANS) plans.delete(plans.keys().next().value)
    plans.set(entry.planId, entry)
  }

  const writable = () => (writableTools ? [...writableTools] : undefined)

  // Compile-time audio reads run here (ffmpeg, electron/studio/audioReads.js)
  // when the server has an analyser, never as Web Audio in the renderer.
  async function compileWithReads(payload) {
    if (typeof analyzeAudio !== 'function') return renderer('studio_compile', payload)
    const planned = await renderer('studio_compile_reads', payload)
    if (planned?.studioError) return planned
    const items = planned?.items || []
    const results = {}
    const failures = []
    for (const item of items) {
      try {
        results[item.clipId] = await analyzeAudio(item)
      } catch (error) {
        failures.push({ clipId: item.clipId, warning: error?.message || String(error) })
      }
    }
    return renderer('studio_compile', { ...payload, reads: { requested: items.length, results, failures } })
  }

  // previewAfter[i] = j: step i targets what step j creates (a re-sync's
  // replace_clip_with_asset names the asset its import step adds), so its own
  // preview can only run once step j has; it is checked when the plan runs.
  async function previewSteps(steps, previewAfter = []) {
    const previews = []
    for (const [index, step] of steps.entries()) {
      if (Number.isInteger(previewAfter[index])) {
        previews.push({ step: index + 1, tool: step.tool, ok: true, message: `previewed when step ${previewAfter[index] + 1} has run (it creates what this step targets)` })
        continue
      }
      const response = await callPrimitive(step.tool, { ...step.arguments, previewOnly: true })
      const parsed = parseResult(response)
      const refused = response?.isError || parsed?.success === false || parsed?.result?.success === false
      previews.push({
        step: index + 1,
        tool: step.tool,
        ok: !refused,
        message: refused
          ? (response?.content?.[0]?.text || parsed?.message || 'refused').slice(0, 400)
          : parsed?.message || parsed?.result?.message || 'preview ok',
      })
    }
    return previews
  }

  async function runSteps(compiled, { label, session }) {
    const steps = compiled.plan.steps.map((step, index) => ({
      tool: step.tool,
      arguments: { ...step.arguments, studioMeta: { reason: compiled.plan.reasons[index], scene: compiled.plan.scenes[index], session } },
    }))
    const response = await callPrimitive('run_mcp_action_plan', { label, steps, previewOnly: false, createCheckpointFirst: true, stopOnError: true })
    const parsed = parseResult(response) || {}
    const results = (parsed.results || []).map((result) => ({ step: result.index + 1, tool: result.tool, success: result.success }))
    const failed = results.find((result) => result.step > 0 && !result.success) || null
    return { response, parsed, results, failed }
  }

  // The two plan kinds: an intent compiled by studio_edit, and the
  // replacement plan FILM-2011's re-sync proposed (studio_apply_updates).
  const PLAN_KINDS = {
    edit: {
      tool: 'studio_edit',
      compile: (args) => compileWithReads({ intent: args.intent, scope: args.scope || {}, params: args.params || {}, writable: writable() }),
      key: (args) => ({ intent: args.intent, scope: args.scope || {}, params: args.params || {} }),
      versionName: (compiled, args) => String(args.params?.versionName || `AI: ${compiled.prompt}`).slice(0, 120),
    },
    audio: {
      tool: 'studio_edit_audio',
      compile: (args) => compileWithReads({ intent: `audio:${args.intent}`, scope: args.scope || {}, params: args.params || {}, writable: writable() }),
      key: (args) => ({ intent: `audio:${args.intent}`, scope: args.scope || {}, params: args.params || {} }),
      applyArgs: (args) => ({ intent: args.intent, scope: args.scope || {}, params: args.params || {} }),
      versionName: (compiled) => `AI: ${compiled.prompt}`.slice(0, 120),
    },
    captions: {
      tool: 'studio_add_captions',
      compile: (args) => compileWithReads({ intent: 'captions:add_captions', scope: {}, params: { language: args.language, ...(args.style ? { style: args.style } : {}) }, writable: writable() }),
      key: (args) => ({ intent: 'captions:add_captions', scope: {}, params: { language: args.language, ...(args.style ? { style: args.style } : {}) } }),
      applyArgs: (args) => ({ language: args.language, ...(args.style ? { style: args.style } : {}) }),
      versionName: (compiled, args) => `AI: captions (${args.language})`,
    },
    graphic: {
      tool: 'studio_add_graphic',
      compile: (args) => compileWithReads({ intent: 'graphic:add_graphic', scope: {}, params: graphicParams(args), writable: writable() }),
      key: (args) => ({ intent: 'graphic:add_graphic', scope: {}, params: graphicParams(args) }),
      applyArgs: (args) => graphicParams(args),
      versionName: (compiled) => `AI: ${compiled.prompt}`.slice(0, 120),
    },
    repair: {
      tool: 'studio_repair',
      compile: (args) => compileWithReads({ intent: 'repair', scope: {}, params: { issues: args.issues || [] }, writable: writable() }),
      key: (args) => ({ intent: 'repair', scope: {}, params: { issues: args.issues || [] } }),
      applyArgs: (args) => ({ issues: args.issues || [] }),
      versionName: () => 'AI: repair',
    },
    resync: {
      tool: 'studio_apply_updates',
      compile: () => renderer('studio_resync_plan', { writable: writable() }),
      key: () => ({ intent: 'apply_updates', scope: {}, params: {} }),
      versionName: () => 'Sync from StoryBook',
    },
  }

  async function previewPlan(kind, args, { source }) {
    const flow = PLAN_KINDS[kind]
    const compiled = await flow.compile(args)
    const refused = fromRenderer(compiled)
    if (refused) return refused
    const stepPreviews = await previewSteps(compiled.plan.steps, compiled.plan.previewAfter || [])
    const blocked = stepPreviews.filter((preview) => !preview.ok)
    if (blocked.length) {
      return failure('VALIDATION_FAILED', `${blocked.length} step${blocked.length === 1 ? '' : 's'} of the plan failed their own preview; nothing was applied.`, { stepPreviews, plan: compiled.plan })
    }
    const planId = newId()
    const key = flow.key(args)
    rememberPlan({ planId, kind, ...key, fingerprint: compiled.fingerprint, planKey: compiled.planKey ?? null, createdAt: clock(), source })
    // touchesUserEdits: clip ids (the cards carry {clipId, label} per scene).
    // A second tier a compiler only proposes (hit_duration's dialogue drops):
    // shown apart, never applied with this plan; approving it is a new preview.
    const proposals = (compiled.plan.proposals || []).map((entry) => ({
      ...entry,
      approveWith: { tool: flow.tool, arguments: { ...(flow.applyArgs ? flow.applyArgs(args) : key), ...(entry.approveWith?.params ? { params: entry.approveWith.params } : {}), previewOnly: true } },
    }))
    const proposal = { phase: 'proposed', planId, source, tool: flow.tool, proposals, intent: key.intent, scope: key.scope, params: key.params, instruction: compiled.prompt, expected: compiled.plan.expected, cards: compiled.cards, touchesUserEdits: compiled.plan.touchesUserEdits, reportText: compiled.reportText }
    try { emitPlanProposed(proposal) } catch { /* the panel is optional */ }
    return ok({
      previewOnly: true,
      planId,
      intent: key.intent,
      scope: key.scope,
      instruction: compiled.prompt,
      cards: compiled.cards,
      expected: compiled.plan.expected,
      touchesUserEdits: compiled.plan.touchesUserEdits,
      notes: compiled.plan.notes,
      proposals,
      dialogueCuts: compiled.plan.dialogueCuts ?? null,
      plan: { steps: compiled.plan.steps, reasons: compiled.plan.reasons, scenes: compiled.plan.scenes },
      stepPreviews,
      report: compiled.report,
      reportText: compiled.reportText,
      reads: compiled.reads,
      applyWith: compiled.plan.steps.length ? { tool: flow.tool, arguments: { ...(flow.applyArgs ? flow.applyArgs(args) : kind === 'edit' ? key : {}), previewOnly: false, planId } } : null,
    })
  }

  async function applyPlan(kind, args, { source, onProgress = null }) {
    const flow = PLAN_KINDS[kind]
    const stored = args.planId ? plans.get(args.planId) : null
    if (!stored || stored.kind !== kind) return failure('VALIDATION_FAILED', `Preview first (previewOnly true) and apply with the planId it returns; plans are kept 30 minutes.`)
    const key = flow.key(args)
    if (stored.intent !== key.intent || JSON.stringify(stored.scope) !== JSON.stringify(key.scope) || JSON.stringify(stored.params) !== JSON.stringify(key.params)) {
      return failure('VALIDATION_FAILED', 'The intent, scope or params differ from the previewed plan; preview again.')
    }
    const compiled = await flow.compile(args)
    const refused = fromRenderer(compiled)
    if (refused) return refused
    if (compiled.fingerprint !== stored.fingerprint || (compiled.planKey ?? null) !== stored.planKey) {
      return failure('TARGET_CHANGED', 'The timeline (or the proposed update) changed since the preview; preview again so the cards match what will be applied.', { previewed: stored.fingerprint, current: compiled.fingerprint })
    }
    if (compiled.plan.steps.length === 0) return failure('VALIDATION_FAILED', 'The plan has no steps to apply.', { notes: compiled.plan.notes })
    plans.delete(args.planId)

    const versionName = flow.versionName(compiled, args)
    const created = await renderer('studio_create_version', { name: versionName, prompt: compiled.prompt, by: 'ai' })
    const versionRefused = fromRenderer(created)
    if (versionRefused) return versionRefused
    const version = created.version
    const context = { kind, args, source, key, compiled, versionName, version }
    // autoRepair renders and reviews up to three times: minutes, past an MCP
    // client's 60 s request timeout. It runs as a job; inside a
    // run_mcp_action_plan step it stays synchronous, so the next step sees it.
    if (args.autoRepair !== true || source === 'plan') return runApply(context)
    const job = jobs.create('edit', { planId: args.planId, versionId: version.id, intent: key.intent, round: 0, message: 'Applying the plan', total: JOB_PHASES_MAX })
    let done = 0
    const report = (patch) => {
      job.update({ ...patch, done: Math.min(done, JOB_PHASES_MAX - 1) })
      done += 1
      if (onProgress) try { onProgress(job.record) } catch { /* the stream may have closed */ }
    }
    const finished = runApply({ ...context, report }).then(
      (result) => {
        const parsed = parseResult(result)
        if (result?.isError) {
          job.update({ message: `Failed: ${parsed?.error?.message || 'the apply failed'}` })
          job.fail(Object.assign(new Error(parsed?.error?.message || 'The apply failed.'), { code: parsed?.error?.code }))
        } else {
          job.update({ done: JOB_PHASES_MAX, message: `Done: ${parsed?.autoRepair?.stoppedBecause || 'applied'}` })
          job.complete(parsed)
        }
        return result
      },
      (error) => {
        job.update({ message: `Failed: ${error?.message || error}` })
        job.fail(error)
        return failure(ERROR_CODES.includes(error?.code) ? error.code : 'VALIDATION_FAILED', error?.message || String(error))
      },
    ).then((result) => {
      if (onProgress) try { onProgress(job.record) } catch { /* closed */ }
      return result
    })
    const started = { previewOnly: false, jobId: job.id, status: 'running', planId: args.planId, versionId: version.id, version, followWith: { tool: 'studio_get_job_status', arguments: { jobId: job.id } } }
    // A caller following progress (an MCP request with a progressToken) gets
    // the finished result on the same request; the job id rides every update.
    if (onProgress) {
      const result = await finished
      return result.isError ? result : ok({ jobId: job.id, ...parseResult(result) })
    }
    return ok(started)
  }

  async function runApply({ kind, args, source, key, compiled, versionName, version, report = () => {} }) {
    const session = `studio-plan-${args.planId}`
    report({ phase: 'apply', round: 0, message: 'Applying the plan' })
    const run = await runSteps(compiled, { label: versionName, session })

    const rounds = [{ round: 1, kind: 'plan', steps: compiled.plan.steps.length, failed: run.failed }]
    let qa = null
    let stoppedBecause = null
    let round = 0
    if (args.autoRepair === true && !run.failed) {
      for (round = 1; round <= MAX_REPAIR_ROUNDS; round += 1) {
        if (typeof reviewRound !== 'function' || typeof repairPlan !== 'function') {
          stoppedBecause = 'QA and repair are not available yet (FILM-2014: studio_render_preview, studio_review, studio_repair); one round ran'
          break
        }
        const qaRound = round
        report({ phase: 'qa', round: qaRound, message: `QA round ${qaRound}` })
        qa = await reviewRound({ versionId: version.id }, { onPhase: (phase) => report({ phase, round: qaRound, message: `QA round ${qaRound}: ${REVIEW_PHASE_TEXT[phase] || phase}` }) })
        if (qa?.pass || !qa?.issues?.length) {
          stoppedBecause = qa?.pass ? 'QA passed' : 'QA found nothing to repair'
          break
        }
        if (round === MAX_REPAIR_ROUNDS) {
          stoppedBecause = `QA still has ${qa.issues.length} issue${qa.issues.length === 1 ? '' : 's'} after ${MAX_REPAIR_ROUNDS} rounds; they are left as cards`
          break
        }
        report({ phase: 'repair', round, message: `Repair round ${round}: ${qa.issues.length} issue${qa.issues.length === 1 ? '' : 's'}` })
        const fix = await repairPlan({ issues: qa.issues, versionId: version.id })
        if (!fix?.plan?.steps?.length) {
          stoppedBecause = 'No repair plan for the remaining issues; they are left as cards'
          break
        }
        const repaired = await runSteps(fix, { label: `${versionName} (repair ${round})`, session })
        rounds.push({ round: round + 1, kind: 'repair', steps: fix.plan.steps.length, failed: repaired.failed })
        if (repaired.failed) {
          stoppedBecause = `Repair round ${round} failed at step ${repaired.failed.step}`
          break
        }
      }
    }

    report({ phase: 'finish', round: Math.min(round, MAX_REPAIR_ROUNDS), message: 'Writing the report' })
    const packagePromoted = kind === 'resync' && !run.failed ? promoteResyncPackage(getProjectPath()) : undefined
    const finished = await renderer('studio_finish_apply', { versionId: version.id, hookType: compiled.plan.hookType ?? null })
    const finishRefused = fromRenderer(finished)
    if (finishRefused) return finishRefused
    try { emitPlanProposed({ phase: 'applied', planId: args.planId, source, intent: key.intent, versionId: version.id, cards: compiled.cards, reportText: finished.reportText }) } catch { /* optional */ }

    return ok({
      previewOnly: false,
      applied: run.failed ? 'partial' : true,
      success: !run.failed,
      planId: args.planId,
      version,
      checkpoint: run.parsed.checkpoint?.result?.checkpoint?.id ?? run.parsed.checkpoint?.checkpoint?.id ?? null,
      cards: compiled.cards,
      steps: run.results,
      failedStep: run.failed,
      opLog: finished.ops.filter((entry) => entry.tool !== 'studio_create_version').map((entry) => ({ op: entry.op, by: entry.by, tool: entry.tool, scene: entry.scene, reason: entry.reason, session: entry.session })),
      report: finished.report,
      reportText: finished.reportText,
      reportPath: finished.reportPath,
      ...(packagePromoted === undefined ? {} : { packagePromoted }),
      autoRepair: args.autoRepair === true ? { rounds, maxRounds: MAX_REPAIR_ROUNDS, qa, stoppedBecause } : undefined,
      // The version's snapshot is the timeline before the plan: restoring it undoes the plan.
      restoreWith: { tool: 'studio_restore_version', arguments: { versionId: version.id } },
    })
  }

  const studioEdit = (args, options) => (args.previewOnly !== false ? previewPlan('edit', args, options) : applyPlan('edit', args, options))
  const applyUpdates = (args, options) => (args.previewOnly !== false ? previewPlan('resync', args, options) : applyPlan('resync', args, options))
  const planTool = (kind) => (args, options) => (args.previewOnly !== false ? previewPlan(kind, args, options) : applyPlan(kind, args, options))

  async function readiness() {
    const local = await renderer('studio_readiness_local')
    const refused = fromRenderer(local)
    if (refused) return refused
    const health = parseResult(await callPrimitive('check_media_health', {})) || {}
    const exportReady = parseResult(await callPrimitive('check_export_readiness', {})) || {}
    const issues = [
      ...local.issues,
      ...(health.blockers || []).map((detail) => ({ check: 'media_health', severity: 'error', detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })),
      ...(exportReady.blockers || []).map((detail) => ({ check: 'export', severity: 'error', detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })),
      ...(exportReady.warnings || []).map((detail) => ({ check: 'export', severity: 'warning', detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })),
    ]
    return ok({ pass: !issues.some((issue) => issue.severity === 'error'), checks: { ...local.checks, mediaHealth: health.counts ?? null, export: exportReady.counts ?? null }, issues })
  }

  // FILM-2011's client (studioMain.cloud): openEpisode({episodeId}) -> {jobId},
  // getJobStatus(jobId) -> job | null, checkUpdates() -> the re-sync answer.
  async function cloudCall(tool, method, args) {
    const cloud = getCloud()
    if (!cloud || typeof cloud[method] !== 'function') return notAvailable(tool, ' (the FILM-2011 cloud client is not in this build)')
    try {
      const result = await cloud[method](args)
      if (result == null && method === 'getJobStatus') return failure('NOT_FOUND', `No job ${args}.`)
      return ok(result)
    } catch (error) {
      return failure(error?.code || 'VALIDATION_FAILED', error?.message || String(error))
    }
  }

  async function call(name, args = {}, { source = 'mcp', onProgress = null } = {}) {
    const tool = BY_NAME.get(name)
    if (!tool) return failure('NOT_FOUND', `Unknown capability tool ${name}.`)
    const problems = checkArguments(tool, args || {})
    if (problems.length) return failure('VALIDATION_FAILED', `Invalid arguments for ${name}: ${problems.join('; ')}.`, { problems })
    switch (name) {
      case 'studio_get_context': {
        const result = await renderer('studio_get_context', { scope: args.scope || null })
        return fromRenderer(result) || ok(result)
      }
      case 'studio_search_assets': {
        const result = await renderer('studio_search_assets', args)
        return fromRenderer(result) || ok(result)
      }
      case 'studio_choose_visual_representation': {
        const result = await renderer('studio_choose_visual', { sceneOrPoint: args.sceneOrPoint })
        return fromRenderer(result) || ok(result)
      }
      case 'studio_edit':
        return studioEdit(args, { source, onProgress })
      case 'studio_check_readiness':
        return readiness()
      case 'studio_create_version': {
        const result = await renderer('studio_create_version', { name: args.name, prompt: args.prompt ?? null, by: 'ai' })
        return fromRenderer(result) || ok(result)
      }
      case 'studio_restore_version': {
        const result = await renderer('studio_restore_version', { versionId: args.versionId, reason: args.reason ?? null, by: 'ai' })
        return fromRenderer(result) || ok(result)
      }
      case 'studio_deliver': {
        const deliver = getDeliver()
        if (!deliver) {
          if (args.confirm === true) return notAvailable(tool, ' Rendering and sending need the Deliver screen\'s one-time confirmation; an MCP client cannot upload on its own.')
          const result = await renderer('studio_deliver_summary', { presets: args.presets, languages: args.languages || [] })
          return fromRenderer(result) || ok({ confirm: false, sideEffects: 'none', ...result })
        }
        try {
          return ok(await deliver.studioDeliver(args, { snapshot: getSnapshot() }))
        } catch (error) {
          return failure(error?.code || 'VALIDATION_FAILED', error?.message || String(error), error?.details)
        }
      }
      case 'studio_create_variant': {
        const deliver = getDeliver()
        if (!deliver) return notAvailable(tool)
        try {
          return ok(await deliver.createVariant({ ...(args.params || {}), kind: args.kind, previewOnly: args.previewOnly }, { snapshot: getSnapshot() }))
        } catch (error) {
          return failure(error?.code || 'VALIDATION_FAILED', error?.message || String(error), error?.details)
        }
      }
      case 'studio_repair':
        return planTool('repair')(args, { source, onProgress })
      case 'studio_review':
      case 'studio_render_preview': {
        if (!reviewTools) return failure('VALIDATION_FAILED', `${name} is not available yet: FILM-2014's preview renderer was not passed to this server (main.js passes reviewTools).`, { availableAfter: 'FILM-2014' })
        try {
          return ok(name === 'studio_review' ? await reviewTools.review(args) : await reviewTools.renderPreview(args))
        } catch (error) {
          return failure(error?.code && ERROR_CODES.includes(error.code) ? error.code : 'VALIDATION_FAILED', error?.message || String(error))
        }
      }
      case 'studio_open_episode':
        return cloudCall(tool, 'openEpisode', { episodeId: args.episodeId })
      case 'studio_get_job_status': {
        const job = jobs.get(args.jobId)
        if (job) return ok(job)
        const cloud = getCloud()
        if (!cloud || typeof cloud.getJobStatus !== 'function') return failure('NOT_FOUND', `No job ${args.jobId}.`)
        return cloudCall(tool, 'getJobStatus', args.jobId)
      }
      case 'studio_check_updates':
        return cloudCall(tool, 'checkUpdates', {})
      case 'studio_apply_updates':
        return applyUpdates(args, { source })
      case 'studio_edit_audio':
        return planTool('audio')(args, { source, onProgress })
      case 'studio_add_captions':
        return planTool('captions')(args, { source })
      case 'studio_add_graphic':
        return planTool('graphic')(args, { source })
      default:
        return notAvailable(tool)
    }
  }

  return {
    has: (name) => BY_NAME.has(name),
    inProfile: (name, profile) => Boolean(BY_NAME.get(name)?.profiles.includes(profile)),
    definitions: definitionsFor,
    call,
    pendingPlanCount: () => plans.size,
  }
}

module.exports = {
  AUDIO_INTENTS,
  promoteResyncPackage,
  CAPABILITY_TOOLS,
  ERROR_CODES,
  LIFECYCLE_TOOL_NAMES,
  MAX_REPAIR_ROUNDS,
  PLAN_WRITABLE_CAPABILITY_TOOLS,
  STUDIO_EDIT_INTENTS,
  VARIANT_KINDS,
  checkArguments,
  createCapabilityTools,
  definitionsFor,
}
