// FILM-2013 follow-up over MCP (SDK client, real server and renderer code):
// "make it 90 seconds" on an episode whose dialogue fills its scenes. The
// first preview proposes the line drops apart ("Needs your OK") and applies
// nothing to dialogue, even with autoRepair; asking with the proposal is a
// new preview whose apply lands the episode on 90.0 s.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { connectSdkClient, loadRendererModules, parseToolResult, startStudioHarness } from './helpers/studio-harness.mjs'
import { denseDialogue } from './helpers/dense-dialogue.mjs'

test('99 s → 90.0 s: the drops are proposed apart, then applied only when asked for', async () => {
  const m = await loadRendererModules()
  const harness = await startStudioHarness(m, { packageTransform: denseDialogue })
  const client = await connectSdkClient(harness)
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args })
    return { isError: result.isError, ...parseToolResult(result) }
  }
  const pictureEnd = () => Math.max(...harness.timeline().clips.filter((clip) => clip.trackId === 'video-1').map((clip) => clip.startTime + clip.duration))
  try {
    const args = { intent: 'hit_duration', params: { targetSeconds: 90, instruction: 'make it 90 seconds' } }
    const first = await call('studio_edit', args)
    assert.equal(first.isError, undefined, JSON.stringify(first.error))
    assert.equal(first.dialogueCuts, 'ask')
    assert.deepEqual(first.plan.steps, [], 'nothing in the plan cuts dialogue')
    assert.equal(first.applyWith, null)
    const [proposal] = first.proposals
    assert.equal(proposal.title, 'Needs your OK: drops 3 lines')
    assert.equal(proposal.durationAfter, 90)
    assert.deepEqual(proposal.approveWith, { tool: 'studio_edit', arguments: { intent: 'hit_duration', scope: {}, params: { targetSeconds: 90, instruction: 'make it 90 seconds', approveDialogueDrops: true }, previewOnly: true } })
    assert.deepEqual(harness.proposals.at(-1).proposals.map((entry) => entry.title), ['Needs your OK: drops 3 lines'], 'the panel gets the group on studio:plan-proposed')

    // Applying the first plan (autoRepair included) changes no dialogue: it has no steps.
    const refused = await call('studio_edit', { ...args, previewOnly: false, planId: first.planId, autoRepair: true })
    assert.equal(refused.error.code, 'VALIDATION_FAILED')
    assert.equal(pictureEnd(), 99)

    const approved = await call(proposal.approveWith.tool, proposal.approveWith.arguments)
    assert.equal(approved.isError, undefined, JSON.stringify(approved.error))
    assert.deepEqual(approved.proposals, [])
    assert.equal(approved.expected.durationAfter, 90)
    assert.ok(approved.stepPreviews.every((step) => step.ok))
    const applied = await call(approved.applyWith.tool, approved.applyWith.arguments)
    assert.equal(applied.applied, true, JSON.stringify(applied.error))
    assert.equal(Math.round(pictureEnd() * 1000) / 1000, 90)
    const drops = applied.opLog.filter((entry) => /^Least important line left in scene/.test(entry.reason || ''))
    assert.ok(drops.length >= 3, JSON.stringify(applied.opLog.map((entry) => entry.reason)))
    assert.match(applied.reportText, /Duration: 99\.0 s -> 90\.0 s/)
    if (process.env.STUDIO_EVIDENCE_DIR) {
      const { writeFile, mkdir } = await import('node:fs/promises')
      await mkdir(process.env.STUDIO_EVIDENCE_DIR, { recursive: true })
      await writeFile(`${process.env.STUDIO_EVIDENCE_DIR}/drops-proposal.json`, `${JSON.stringify(first.proposals, null, 2)}\n`)
      await writeFile(`${process.env.STUDIO_EVIDENCE_DIR}/drops-report.txt`, applied.reportText)
    }
  } finally {
    await client.close()
    await harness.close()
    await m.vite.close()
  }
})
