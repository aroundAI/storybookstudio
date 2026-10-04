#!/usr/bin/env node
// FILM-2013 nightly AI eval: 10 fixture episodes x 5 instructions (one is the
// north-star "tighten scene 3 to 12 s and fix the audio"), each run with no
// human touch against the real MCP server and renderer code in the headless
// harness (tests/studio/helpers/studio-harness.mjs), scored on duration hit
// rate, QA pass rate, script coverage, revisions and cost. A release may not
// lower the QA pass rate or raise the cost by more than 20% against a
// baseline run.
//
//   node scripts/ai-eval.mjs --agent oracle                 the compilers alone: a scripted agent makes
//                                                           the calls a correct agent would (no model, no cost)
//   STUDIO_EVAL_MODEL=claude-opus-5-5 node scripts/ai-eval.mjs --agent model
//                                                           a model drives the agent profile over MCP; needs
//                                                           `npm i -D @anthropic-ai/sdk` and ANTHROPIC_API_KEY
//                                                           (or an `ant auth login` profile)
//   options: --out <dir> (results.json, summary.md)  --baseline <results.json>  --episodes e20-default,e5-default
//            --instructions north-star,hook  --max-turns 20
//
// Which model drives the agent is the owner's open question (phase 20
// README, question 2); the harness takes any model id. QA is FILM-2014's:
// until it lands the QA pass rate is reported as unmeasured, and the gate
// compares it only when both runs measured it.
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = path.join(ROOT, 'tests/studio/fixtures/ai-eval')
export const COST_REGRESSION_LIMIT = 0.2
export const DURATION_TOLERANCE = 0.05

// $ per million tokens, from the Claude API reference (cached 2026-09-25);
// cache writes at 1.25x input. A model not listed is costed as unknown.
export const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
}

export function costOf(model, usage) {
  const price = PRICES[model]
  if (!price) return null
  const million = 1e6
  return Math.round(((usage.input_tokens || 0) * price.input + (usage.output_tokens || 0) * price.output
    + (usage.cache_read_input_tokens || 0) * price.cacheRead + (usage.cache_creation_input_tokens || 0) * price.input * 1.25) / million * 1e6) / 1e6
}

const pickScene = (sceneMap) => {
  const placed = sceneMap.filter((entry) => entry.actualDuration > 0)
  return placed.find((entry) => entry.scene === 3) || placed.at(-1)
}

// An instruction's text and targets for one episode.
export function resolveInstruction(instruction, context) {
  const scene = pickScene(context.sceneMap)
  const sceneTarget = Math.max(1, Math.round(scene.actualDuration * 0.6))
  const target = Math.max(1, Math.round(context.timeline.duration * 0.85))
  const text = instruction.text.replace('{scene}', scene.scene).replace('{sceneTarget}', sceneTarget).replace('{target}', target)
  return { id: instruction.id, text, expect: instruction.expect, scene: scene.scene, sceneTarget, target }
}

// The calls a correct agent makes, previews first, then applies.
export function oraclePlan(resolved) {
  switch (resolved.id) {
    case 'north-star': return [
      { name: 'studio_edit', args: { intent: 'tighten_pacing', scope: { scene: resolved.scene }, params: { targetSeconds: resolved.sceneTarget, instruction: resolved.text } } },
      { name: 'studio_edit_audio', args: { intent: 'fade', params: { instruction: 'fix the audio' } } },
    ]
    case 'hit-duration': return [{ name: 'studio_edit', args: { intent: 'hit_duration', params: { targetSeconds: resolved.target, instruction: resolved.text } } }]
    case 'dead-air': return [{ name: 'studio_edit', args: { intent: 'remove_dead_air', params: { instruction: resolved.text } } }]
    case 'hook': return [{ name: 'studio_edit', args: { intent: 'open_with_strongest_line', params: { instruction: resolved.text } } }]
    case 'brand': return [{ name: 'studio_edit', args: { intent: 'match_brand', params: { instruction: resolved.text } } }]
    default: return []
  }
}

// One run's scores from the context before and after.
export function scoreRun({ resolved, before, after, toolErrors = 0, usage = null, model = null, qa = null }) {
  const scene = (context, number) => context.sceneMap.find((entry) => entry.scene === number)
  let durationHit = null
  if (resolved.expect.sceneTarget) {
    const actual = scene(after, resolved.scene)?.actualDuration ?? 0
    durationHit = Math.abs(actual - resolved.sceneTarget) <= resolved.sceneTarget * DURATION_TOLERANCE
  } else if (resolved.expect.episodeTarget) {
    durationHit = Math.abs(after.timeline.duration - resolved.target) <= resolved.target * DURATION_TOLERANCE
  }
  const lines = after.screenplay.flatMap((entry) => entry.dialogue)
  const placedLines = lines.filter((line) => line.clipIds.length > 0).length
  const scenesCovered = after.sceneMap.filter((entry) => entry.actualDuration > 0).length
  return {
    durationHit,
    durationBefore: before.timeline.duration,
    durationAfter: after.timeline.duration,
    sceneBefore: scene(before, resolved.scene)?.actualDuration ?? null,
    sceneAfter: scene(after, resolved.scene)?.actualDuration ?? null,
    scriptCoverage: lines.length + after.sceneMap.length === 0 ? null : Math.round(((placedLines + scenesCovered) / (lines.length + after.sceneMap.length)) * 1000) / 1000,
    revisions: after.versions.length - before.versions.length,
    shorter: after.timeline.duration < before.timeline.duration,
    qaPass: qa ? qa.pass : null,
    toolErrors,
    usage,
    costUsd: usage && model ? costOf(model, usage) : usage ? null : 0,
  }
}

const mean = (values) => (values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000 : null)

export function summarize(runs) {
  const hits = runs.map((run) => run.score.durationHit).filter((value) => value !== null)
  const qa = runs.map((run) => run.score.qaPass).filter((value) => value !== null)
  const costs = runs.map((run) => run.score.costUsd)
  return {
    runs: runs.length,
    durationHitRate: hits.length ? mean(hits.map(Number)) : null,
    qaPassRate: qa.length ? mean(qa.map(Number)) : null,
    qaReason: qa.length ? null : 'unmeasured: QA is FILM-2014 (studio_review not available yet)',
    scriptCoverage: mean(runs.map((run) => run.score.scriptCoverage).filter((value) => value !== null)),
    revisionsPerRun: mean(runs.map((run) => run.score.revisions)),
    toolErrors: runs.reduce((sum, run) => sum + run.score.toolErrors, 0),
    costUsd: costs.some((value) => value === null) ? null : Math.round(costs.reduce((sum, value) => sum + value, 0) * 1e6) / 1e6,
  }
}

// The release gate: the QA pass rate may not fall, the cost may not rise more than 20%.
export function gate(summary, baseline) {
  const failures = []
  if (!baseline) return { ok: true, failures, note: 'no baseline: nothing to compare' }
  if (summary.qaPassRate !== null && baseline.qaPassRate !== null && summary.qaPassRate < baseline.qaPassRate) {
    failures.push(`QA pass rate fell: ${baseline.qaPassRate} -> ${summary.qaPassRate}`)
  }
  if (summary.costUsd !== null && baseline.costUsd !== null && baseline.costUsd > 0 && summary.costUsd > baseline.costUsd * (1 + COST_REGRESSION_LIMIT)) {
    failures.push(`cost rose more than ${COST_REGRESSION_LIMIT * 100}%: $${baseline.costUsd} -> $${summary.costUsd}`)
  }
  return { ok: failures.length === 0, failures }
}

export function packageTransformFor(episode) {
  return (pkg) => ({
    ...pkg,
    episode: { ...pkg.episode, ...(episode.episode || {}) },
    editPolicy: { ...pkg.editPolicy, ...(episode.editPolicy || {}) },
    brand: { ...pkg.brand, ...(episode.brand || {}) },
  })
}

const parse = (result) => {
  try {
    return JSON.parse(result.content?.[0]?.text ?? 'null')
  } catch {
    return null
  }
}

async function runOracle(mcp, resolved) {
  let toolErrors = 0
  const calls = []
  for (const { name, args } of oraclePlan(resolved)) {
    const preview = await mcp.callTool({ name, arguments: args })
    const body = parse(preview)
    calls.push({ name, phase: 'preview', error: preview.isError ? body?.error : undefined })
    if (preview.isError) {
      toolErrors += 1
      continue
    }
    if (!body?.applyWith) continue
    const applied = await mcp.callTool({ name: body.applyWith.tool, arguments: body.applyWith.arguments })
    calls.push({ name, phase: 'apply', error: applied.isError ? parse(applied)?.error : undefined })
    if (applied.isError) toolErrors += 1
  }
  return { toolErrors, calls, usage: null }
}

const APPROVAL = 'The user has approved applying any plan you preview: after a studio_edit (or studio_edit_audio) preview, apply it with previewOnly false and its planId without asking. Do not deliver. When you are done, reply with a short summary.'

async function runModel(mcp, resolved, { model, maxTurns }) {
  let Anthropic
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'))
  } catch {
    throw new Error('--agent model needs the Anthropic SDK: npm i -D @anthropic-ai/sdk')
  }
  const client = new Anthropic()
  const tools = (await mcp.listTools()).tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }))
  const system = `${mcp.getInstructions?.() || ''}\n\n${APPROVAL}`
  const messages = [{ role: 'user', content: resolved.text }]
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const calls = []
  let toolErrors = 0
  let stop = null
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system,
      tools,
      messages,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
    for (const key of Object.keys(usage)) usage[key] += response.usage?.[key] || 0
    stop = response.stop_reason
    if (stop === 'refusal') break
    messages.push({ role: 'assistant', content: response.content })
    const uses = response.content.filter((block) => block.type === 'tool_use')
    if (uses.length === 0) break
    const results = []
    for (const use of uses) {
      const result = await mcp.callTool({ name: use.name, arguments: use.input })
      if (result.isError) toolErrors += 1
      calls.push({ name: use.name, error: result.isError ? parse(result)?.error : undefined })
      results.push({ type: 'tool_result', tool_use_id: use.id, content: result.content?.[0]?.text ?? '', ...(result.isError ? { is_error: true } : {}) })
    }
    messages.push({ role: 'user', content: results })
  }
  return { toolErrors, calls, usage, stop }
}

function argsOf(argv) {
  const value = (name, fallback = null) => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : fallback
  }
  return {
    agent: value('agent', 'oracle'),
    out: value('out', path.join(ROOT, '.ai-eval')),
    baseline: value('baseline'),
    episodes: value('episodes')?.split(',') ?? null,
    instructions: value('instructions')?.split(',') ?? null,
    maxTurns: Number(value('max-turns', 20)),
    model: process.env.STUDIO_EVAL_MODEL || null,
  }
}

export function renderSummary(summary, verdict, options) {
  return [
    `# AI eval (${options.agent}${options.model ? `, ${options.model}` : ''})`,
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Runs | ${summary.runs} |`,
    `| Duration hit rate | ${summary.durationHitRate ?? 'n/a'} |`,
    `| QA pass rate | ${summary.qaPassRate ?? summary.qaReason} |`,
    `| Script coverage | ${summary.scriptCoverage} |`,
    `| Revisions per run | ${summary.revisionsPerRun} |`,
    `| Tool errors | ${summary.toolErrors} |`,
    `| Cost (USD) | ${summary.costUsd ?? 'unknown model price'} |`,
    '',
    verdict.ok ? `Gate: pass${verdict.note ? ` (${verdict.note})` : ''}` : `Gate: FAIL\n\n${verdict.failures.map((failure) => `- ${failure}`).join('\n')}`,
    '',
  ].join('\n')
}

export async function runEval(options) {
  const { episodes } = JSON.parse(await readFile(path.join(FIXTURES, 'episodes.json'), 'utf8'))
  const { instructions } = JSON.parse(await readFile(path.join(FIXTURES, 'instructions.json'), 'utf8'))
  if (options.agent === 'model' && !options.model) throw new Error('--agent model needs STUDIO_EVAL_MODEL (for example claude-opus-5-5)')
  const harnessModule = await import(path.join(ROOT, 'tests/studio/helpers/studio-harness.mjs'))
  const m = await harnessModule.loadRendererModules()
  const runs = []
  try {
    for (const episode of episodes.filter((entry) => !options.episodes || options.episodes.includes(entry.id))) {
      for (const instruction of instructions.filter((entry) => !options.instructions || options.instructions.includes(entry.id))) {
        const harness = await harnessModule.startStudioHarness(m, { shots: episode.base, packageTransform: packageTransformFor(episode) })
        const mcp = await harnessModule.connectSdkClient(harness)
        try {
          const context = async () => harnessModule.parseToolResult(await mcp.callTool({ name: 'studio_get_context', arguments: {} }))
          const before = await context()
          const resolved = resolveInstruction(instruction, before)
          const run = options.agent === 'model' ? await runModel(mcp, resolved, options) : await runOracle(mcp, resolved)
          const after = await context()
          const score = scoreRun({ resolved, before, after, toolErrors: run.toolErrors, usage: run.usage, model: options.model })
          runs.push({ episode: episode.id, instruction: resolved.id, text: resolved.text, calls: run.calls, stop: run.stop ?? null, score })
        } finally {
          await mcp.close()
          await harness.close()
        }
      }
    }
  } finally {
    await m.vite.close()
  }
  const summary = summarize(runs)
  const baseline = options.baseline ? JSON.parse(await readFile(options.baseline, 'utf8')).summary : null
  const verdict = gate(summary, baseline)
  return { runs, summary, verdict }
}

async function main() {
  const options = argsOf(process.argv.slice(2))
  const result = await runEval(options)
  await mkdir(options.out, { recursive: true })
  await writeFile(path.join(options.out, 'results.json'), `${JSON.stringify({ options: { ...options, model: options.model }, ...result }, null, 2)}\n`)
  const summary = renderSummary(result.summary, result.verdict, options)
  await writeFile(path.join(options.out, 'summary.md'), summary)
  console.log(summary)
  process.exitCode = result.verdict.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 2
  })
}
