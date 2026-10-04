// FILM-2014: the main-process side of studio_render_preview and studio_review
// (contract L7, P7, V1, V2). studio_repair compiles in the renderer
// (src/studio/intents/repair.js) like every other intent.
//
// `getReviewContext({versionId})` is the renderer bridge FILM-2013 provides:
// {project, projectPath, timelineId, policy, pkg, opLog}. With a versionId it
// returns that version's snapshot as `project`. `appendOpLog(entry)` records
// the vision model's token cost (contract V2). Imports nothing from Electron.
const path = require('path')
const { createPreviewRenderer, resolveRange, loadPlan } = require('./previewRender')
const { createQa } = require('./qa')
const { createVisionClient } = require('./visionClient')

const loadCritic = () => Promise.all([
  import('../../src/studio/critic/pacing.js'),
  import('../../src/studio/critic/audio.js'),
  import('../../src/studio/critic/visual.js'),
  import('../../src/studio/review/qaChecks.js'),
])

const QUALITIES = ['keyframes', 'scene', 'audio', 'full']

function invalid(message) {
  return Object.assign(new Error(message), { code: 'VALIDATION_FAILED' })
}

// The time range a scope covers: {scene}, {scenes}, {range} or the whole timeline.
async function rangeOfScope(project, scope = {}, timelineId = null) {
  const plan = await loadPlan()
  if (Array.isArray(scope.scenes) && scope.scenes.length) {
    const spans = scope.scenes.map((scene) => resolveRange(plan, project, { scene, timelineId }))
    return [Math.min(...spans.map((s) => s[0])), Math.max(...spans.map((s) => s[1]))]
  }
  if (Number.isInteger(scope.scene)) return resolveRange(plan, project, { scene: scope.scene, timelineId })
  return resolveRange(plan, project, { range: scope.range || null, timelineId })
}

function createReviewTools({ getReviewContext, ffmpegPath, ffprobePath, env = process.env, getSecret = () => null, appendOpLog = async () => {}, visionClient = null, renderer = null, qa = null } = {}) {
  if (typeof getReviewContext !== 'function') throw new Error('createReviewTools needs getReviewContext')
  const previews = renderer || createPreviewRenderer({ ffmpegPath, ffprobePath })
  const checker = qa || createQa({ ffmpegPath, ffprobePath })

  async function context({ versionId = null, timeline = null } = {}) {
    const ctx = await getReviewContext({ versionId })
    if (!ctx?.project) throw Object.assign(new Error('No project is open.'), { code: 'NOT_FOUND' })
    if (!ctx.projectPath || !path.isAbsolute(ctx.projectPath)) throw invalid('The open project has no folder on disk; save it first.')
    return { ...ctx, timelineId: timeline || ctx.timelineId || null }
  }

  // studio_render_preview {scope, range, timeline, quality}: renders the tier,
  // always the keyframes, and QA on what was rendered.
  async function renderPreview(args = {}) {
    const quality = args.quality || (args.scope?.scene || args.scope?.scenes ? 'scene' : 'keyframes')
    if (!QUALITIES.includes(quality)) throw invalid(`quality must be one of ${QUALITIES.join(', ')}.`)
    const ctx = await context({ timeline: args.timeline })
    const { project, projectPath, timelineId } = ctx
    const scope = args.range ? { ...(args.scope || {}), range: args.range } : args.scope || {}
    const [from, to] = await rangeOfScope(project, scope, timelineId)
    const keyframes = await previews.renderKeyframes({ project, projectDir: projectPath, timelineId, range: [from, to] })
    let render = null
    if (quality === 'scene' || quality === 'full') {
      render = await previews.renderScenePreview({ project, projectDir: projectPath, timelineId, range: quality === 'full' ? null : [from, to], policy: ctx.policy })
    } else if (quality === 'audio') {
      render = await previews.renderAudioMix({ project, projectDir: projectPath, timelineId, range: [from, to], policy: ctx.policy })
    }
    const result = await checker.runQa({
      file: render?.file || null,
      project, projectDir: projectPath, timelineId,
      policy: ctx.policy, pkg: ctx.pkg, opLog: ctx.opLog || [],
      timeOffset: render ? render.range[0] : 0,
      expectedDuration: render ? render.duration : null,
      formatChecks: false,
    })
    return {
      quality,
      range: [from, to],
      file: render?.file || null,
      renderMs: render?.ms ?? null,
      realtimeFactor: render?.realtimeFactor ?? null,
      keyframes: { dir: keyframes.dir, count: keyframes.count, ms: keyframes.ms, files: keyframes.frames.map((f) => ({ time: f.time, reason: f.reason, file: f.file, scene: f.scene })) },
      qa: result.qa,
    }
  }

  // studio_review {scope, versionId?}: QA (V1) on a fresh preview of the
  // scope, then the critic (V2). Top-level pass/issues merge both, which is
  // what FILM-2013's autoRepair loop reads.
  async function review(args = {}) {
    const started = Date.now()
    const ctx = await context({ versionId: args.versionId || null, timeline: args.scope?.timelineId })
    const { project, projectPath, timelineId, policy = {}, pkg = null, opLog = [] } = ctx
    const [from, to] = await rangeOfScope(project, args.scope || {}, timelineId)
    const [pacing, audio, visual, checks] = await loadCritic()

    const [keyframes, video, mix] = await Promise.all([
      previews.renderKeyframes({ project, projectDir: projectPath, timelineId, range: [from, to] }),
      previews.renderScenePreview({ project, projectDir: projectPath, timelineId, range: [from, to], policy }),
      previews.renderAudioMix({ project, projectDir: projectPath, timelineId, range: [from, to], stems: true, policy }),
    ])
    const qaRun = await checker.runQa({
      file: video.file, project, projectDir: projectPath, timelineId, policy, pkg, opLog,
      timeOffset: from, expectedDuration: video.duration, formatChecks: false,
    })
    const levels = await checker.measureMixLevels({ file: mix.file, stems: mix.stems, from })

    const client = visionClient || createVisionClient({ env, getSecret })
    const visualResult = await visual.analyseVisual({ project, pkg, frames: keyframes.frames, client, timelineId })
    const inScope = (issue) => !issue.timeRange || (issue.timeRange.end > from - 1e-6 && issue.timeRange.start < to + 1e-6)
    const criticIssues = [
      ...pacing.analysePacing({ project, timelineId, policy }),
      ...audio.analyseAudio({ project, timelineId, levels, policy }),
      ...visualResult.issues,
    ].filter(inScope)
    const critic = checks.qaResult(criticIssues)

    if (visualResult.usage) {
      await appendOpLog({
        tool: 'studio_review',
        args: { vision: { provider: visualResult.usage.provider, model: visualResult.usage.model, framesSent: visualResult.framesSent, inputTokens: visualResult.usage.inputTokens, outputTokens: visualResult.usage.outputTokens, costUsd: visualResult.usage.costUsd ?? null } },
        reason: `Vision critic on ${visualResult.framesSent} keyframes`,
        scene: Number.isInteger(args.scope?.scene) ? args.scope.scene : null,
      })
    }

    const issues = [...qaRun.qa.issues, ...critic.issues].sort((a, b) => b.severity - a.severity)
    return {
      pass: qaRun.qa.pass && critic.pass,
      issues,
      qa: qaRun.qa,
      critic,
      skipped: visualResult.skipped ? [{ analyser: 'visual', reason: visualResult.reason }] : [],
      range: [from, to],
      versionId: args.versionId || null,
      keyframes: { dir: keyframes.dir, count: keyframes.count, ms: keyframes.ms },
      renders: { video: video.file, audio: mix.file, stems: mix.stems },
      vision: visualResult.usage ? { ...visualResult.usage, framesSent: visualResult.framesSent } : null,
      ms: Date.now() - started,
    }
  }

  return { renderPreview, review }
}

module.exports = { createReviewTools, rangeOfScope, QUALITIES }
