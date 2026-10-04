// FILM-2013 integration: an MCP SDK client over HTTP, with the bearer,
// against the real local server and the real renderer code (headless
// harness): studio_get_context -> studio_edit preview -> apply -> the version
// exists, the op log has one line per applied step with its reason and the
// plan's session, and the report on disk matches the one returned and the
// preview's cards. Also: TARGET_CHANGED, hand edits, restore, autoRepair.
//
// The M2 check ("tighten scene 3 to 12 s") runs here; STUDIO_EVIDENCE_DIR=<dir>
// writes its cards, op-log excerpt and report there for the PR.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, beforeEach, afterEach, test } from 'node:test'

import { connectSdkClient, loadRendererModules, parseToolResult, startStudioHarness } from './helpers/studio-harness.mjs'

const M2 = { intent: 'tighten_pacing', scope: { scene: 3 }, params: { targetSeconds: 12, instruction: 'tighten scene 3 to 12 s' } }

let m
let harness
let client

before(async () => { m = await loadRendererModules() })
after(async () => { await m?.vite.close() })
beforeEach(async () => {
  harness = await startStudioHarness(m)
  client = await connectSdkClient(harness)
})
afterEach(async () => {
  await client?.close()
  await harness?.close()
})

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  return { result, body: parseToolResult(result) }
}
const sceneSpan = (scene) => {
  const clips = harness.timeline().clips.filter((clip) => clip.trackId === 'video-1' && clip.metadata?.semantic?.scene === scene)
  return Math.round((Math.max(...clips.map((clip) => clip.startTime + clip.duration)) - Math.min(...clips.map((clip) => clip.startTime))) * 1000) / 1000
}

test('M2: "tighten scene 3 to 12 s" over MCP: context, preview cards, apply into a version, one logged line per step, the report', async () => {
  const { body: context } = await call('studio_get_context', { scope: { scene: 3 } })
  assert.deepEqual(context.sceneMap.map((entry) => [entry.scene, entry.actualDuration]), [[3, 21]])
  assert.equal(context.screenplay[0].dialogue.length, 8)
  assert.deepEqual(context.versions.map((version) => version.name), ['Rough cut'])
  assert.ok(context.intents.includes('tighten_pacing'))

  const before = JSON.stringify(harness.timeline().clips)
  const { result: previewResult, body: preview } = await call('studio_edit', M2)
  assert.equal(previewResult.isError, undefined, JSON.stringify(preview.error))
  assert.equal(preview.previewOnly, true)
  assert.equal(JSON.stringify(harness.timeline().clips), before, 'a preview changes nothing')
  assert.deepEqual(await harness.readLog().then((log) => log.map((entry) => entry.tool)), ['studio_create_version'], 'and logs nothing')
  assert.ok(preview.stepPreviews.every((step) => step.ok), JSON.stringify(preview.stepPreviews))
  assert.equal(preview.stepPreviews.length, preview.plan.steps.length)
  const card = preview.cards.find((entry) => entry.scene === 3)
  assert.deepEqual([card.durationBefore, card.durationAfter, card.targetDuration], [21, 13.917, 12])
  assert.equal(card.changes.length, 6)
  assert.ok(card.notes.some((note) => /target is not reached without cutting dialogue/.test(note)))
  assert.deepEqual(harness.proposals.map((proposal) => [proposal.phase, proposal.source, proposal.intent]), [['proposed', 'mcp', 'tighten_pacing']])
  assert.deepEqual(harness.proposals[0].cards, preview.cards)

  const { result: applyResult, body: applied } = await call('studio_edit', { ...M2, previewOnly: false, planId: preview.planId })
  assert.equal(applyResult.isError, undefined, JSON.stringify(applied.error))
  assert.equal(applied.applied, true)
  assert.equal(applied.version.name, 'AI: tighten scene 3 to 12 s')
  assert.equal(applied.version.parent, harness.roughCut.id)
  assert.deepEqual(applied.steps.map((step) => step.tool), ['create_project_checkpoint', ...preview.plan.steps.map((step) => step.tool)])
  assert.ok(applied.steps.every((step) => step.success))
  assert.equal(sceneSpan(3), 13.917, 'the timeline now has what the card promised')

  // The op log: the version line, then one ai line per step with its reason, scene and the plan's session.
  const log = await harness.readLog()
  const planLines = log.filter((entry) => entry.versionId === applied.version.id && entry.tool !== 'studio_create_version')
  assert.equal(planLines.length, preview.plan.steps.length)
  assert.deepEqual(planLines.map((entry) => entry.reason), preview.plan.reasons)
  assert.deepEqual(planLines.map((entry) => entry.scene), preview.plan.scenes.map((scene) => scene ?? null))
  assert.ok(planLines.every((entry) => entry.by === 'ai' && entry.session === `studio-plan-${preview.planId}`))
  assert.deepEqual(applied.opLog.map((entry) => entry.reason), preview.plan.reasons)

  // The version on disk, and the report on disk equal to the one returned and to the preview's draft.
  const versions = JSON.parse(await readFile(path.join(harness.dir, 'edits/versions.json'), 'utf8'))
  assert.deepEqual(versions.versions.map((version) => version.name), ['Rough cut', 'AI: tighten scene 3 to 12 s'])
  const report = JSON.parse(await readFile(path.join(harness.dir, applied.reportPath), 'utf8'))
  assert.deepEqual(report, applied.report)
  assert.deepEqual(report.explain.scenes.find((scene) => scene.scene === 3).changes.map((change) => [change.action, change.target.slice(0, 4), change.before, change.after, change.reason]),
    preview.report.explain.scenes.find((scene) => scene.scene === 3).changes.map((change) => [change.action, change.target.slice(0, 4), change.before, change.after, change.reason]))
  assert.equal(report.explain.durationAfter, preview.report.explain.durationAfter)
  assert.equal(report.aiOps, preview.plan.steps.length)
  assert.match(applied.reportText, /Scene 3 {2}21\.0 s -> 13\.9 s/)
  assert.deepEqual(harness.proposals.map((proposal) => proposal.phase), ['proposed', 'applied'])

  if (process.env.STUDIO_EVIDENCE_DIR) {
    const dir = process.env.STUDIO_EVIDENCE_DIR
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'm2-cards.json'), `${JSON.stringify(preview.cards, null, 2)}\n`)
    await writeFile(path.join(dir, 'm2-step-previews.json'), `${JSON.stringify(preview.stepPreviews, null, 2)}\n`)
    await writeFile(path.join(dir, 'm2-oplog.jsonl'), `${log.map((entry) => JSON.stringify({ ...entry, args: undefined, inverse: undefined })).join('\n')}\n`)
    await writeFile(path.join(dir, 'm2-report.txt'), applied.reportText)
    await writeFile(path.join(dir, 'm2-report.json'), `${JSON.stringify(applied.report, null, 2)}\n`)
  }

  // Undo the plan: restore the version, whose snapshot is the timeline before it.
  const { body: restored } = await call('studio_restore_version', { versionId: applied.version.id, reason: 'Undo the tighten' })
  assert.equal(restored.version.id, applied.version.id)
  assert.equal(sceneSpan(3), 21)
})

test('apply refuses without a preview, and with TARGET_CHANGED when the timeline changed after the preview', async () => {
  const noPlan = await call('studio_edit', { ...M2, previewOnly: false })
  assert.equal(noPlan.result.isError, true)
  assert.match(noPlan.body.error.message, /Preview the edit first/)

  const { body: preview } = await call('studio_edit', M2)
  const s1 = harness.timeline().clips.find((clip) => clip.trackId === 'video-1' && clip.metadata?.semantic?.scene === 1)
  m.timelineStore.useTimelineStore.getState().updateClipTrim(s1.id, { duration: s1.duration - 0.5 })
  harness.timers.fire()
  const changed = await call('studio_edit', { ...M2, previewOnly: false, planId: preview.planId })
  assert.equal(changed.result.isError, true)
  assert.equal(changed.body.error.code, 'TARGET_CHANGED')
  assert.equal(sceneSpan(3), 21, 'nothing was applied')
  const versions = JSON.parse(await readFile(path.join(harness.dir, 'edits/versions.json'), 'utf8'))
  assert.equal(versions.versions.length, 1, 'no version was created')
})

test('a clip edited by hand since the last plan is left alone, or listed under "touches your edits" when included', async () => {
  const s32 = harness.timeline().clips.find((clip) => clip.trackId === 'video-1' && clip.name.startsWith('S3.2'))
  m.timelineStore.useTimelineStore.getState().updateClipTrim(s32.id, { duration: s32.duration - 0.25 })
  harness.timers.fire()
  await harness.readLog()
  const { body: context } = await call('studio_get_context', {})
  assert.ok(context.userEditedClipIds.includes(s32.id))

  const { body: preview } = await call('studio_edit', { intent: 'tighten_pacing', scope: { scene: 3 } })
  const card = preview.cards.find((entry) => entry.scene === 3)
  assert.deepEqual(card.touchesYourEdits, [])
  assert.ok(card.notes.some((note) => /S3\.2.*by hand since the last plan/.test(note)), JSON.stringify(card.notes))
  const end = s32.startTime + s32.duration - 0.25
  for (const step of preview.plan.steps.filter((entry) => entry.tool === 'extract_range')) {
    assert.ok(step.arguments.endSeconds <= s32.startTime + 1e-6 || step.arguments.startSeconds >= end - 1e-6, JSON.stringify(step.arguments))
  }

  const { body: forced } = await call('studio_edit', { intent: 'tighten_pacing', scope: { scene: 3 }, params: { includeUserEdits: true } })
  assert.deepEqual(forced.cards.find((entry) => entry.scene === 3).touchesYourEdits.map((entry) => entry.label), ['S3.2'])
  assert.ok(forced.touchesUserEdits.includes(s32.id))
})

test('autoRepair runs one round inside the version and says QA is FILM-2014\'s; readiness, versions and deliver summary over MCP', async () => {
  const { body: preview } = await call('studio_edit', { intent: 'remove_dead_air', scope: { scene: 2 } })
  const { body: applied } = await call('studio_edit', { intent: 'remove_dead_air', scope: { scene: 2 }, previewOnly: false, planId: preview.planId, autoRepair: true })
  assert.equal(applied.autoRepair.rounds.length, 1)
  assert.match(applied.autoRepair.stoppedBecause, /FILM-2014/)
  const versions = JSON.parse(await readFile(path.join(harness.dir, 'edits/versions.json'), 'utf8'))
  assert.equal(versions.versions.length, 2, 'one draft version for the whole loop')

  const { body: readiness } = await call('studio_check_readiness', {})
  assert.equal(readiness.checks.packagePresent, true)
  assert.equal(readiness.checks.policyLoaded, true)
  assert.equal(readiness.checks.targetKnown, true)
  assert.equal(typeof readiness.pass, 'boolean')

  const { body: version } = await call('studio_create_version', { name: 'Before music' })
  assert.equal(version.version.name, 'Before music')

  const { body: deliver } = await call('studio_deliver', { presets: ['youtube_16x9', 'shorts_9x16'] })
  assert.equal(deliver.sideEffects, 'none')
  assert.deepEqual(deliver.renders.map((render) => [render.preset, render.aspect, render.language]), [['youtube_16x9', '16:9', 'en'], ['shorts_9x16', '9:16', 'en']])
  assert.equal(deliver.episode.id, harness.pkg.episode.id)

  const { body: search } = await call('studio_search_assets', { query: 'alarm', role: 'generated_video', scene: 3 })
  assert.equal(search.results.length, 4)
})
