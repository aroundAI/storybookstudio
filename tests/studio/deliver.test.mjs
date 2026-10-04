// FILM-2017 AC5-AC8: studio_deliver against a fake StoryBook that honours
// FILM-2003's contract exactly. confirm:false performs nothing; confirm:true
// needs the Deliver screen's one-time token; the upload PUTs exactly the
// signed bytes with exactly the signed headers; finalize_render per file;
// deliver_edit once with the report and the pulled episodeVersion;
// TARGET_CHANGED keeps finalized renders and a retry reuses them; the
// edit events reach the session before it closes; Export to file needs no
// sign-in.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ExplainWhyReportSchema } from '../../src/studio/contracts/explain-why-report.schema.mjs'
import { fakePrepare, fakeRender, fakeStoryBook, makePulledProject, passingQa, waitForJob, SESSION_ID } from './helpers/delivery.mjs'

const require = createRequire(import.meta.url)
const { createStudioDeliver } = require('../../electron/studio/deliver.js')
const { createJobRegistry } = require('../../electron/studio/jobs.js')
const { createStoryBookClient } = require('../../electron/studio/client.js')
const { createEditEventQueue } = require('../../electron/studio/events.js')

async function setup(t, { serverVersion = 9, sessionVersion = 9, signedIn = true } = {}) {
  const { dir } = makePulledProject(t, { episodeVersion: sessionVersion })
  const storybook = await fakeStoryBook(t, { currentVersion: serverVersion })
  const client = createStoryBookClient({ apiOrigin: storybook.origin, auth: { getAccessToken: async () => 'token', refresh: async () => ({ ok: false }), onSignInRequired() {} } })
  t.after(() => client.close())
  const events = createEditEventQueue({ client, sessionId: SESSION_ID, persistPath: path.join(dir, 'storybook', 'pending-events.json'), setInterval: () => null, clearInterval: () => {} })
  const jobs = createJobRegistry()
  const checks = []
  const deliver = createStudioDeliver({
    jobs,
    getOpenProject: () => (signedIn ? { projectDir: dir, apiOrigin: storybook.origin, sessionId: SESSION_ID, events } : null),
    getClient: () => client,
    checkUpdates: async () => {
      checks.push(Date.now())
      return { status: 'changed', summary: { shots: { changed: 1 } } }
    },
    getMcpServer: () => ({ lastSnapshot: { project: { path: dir } } }),
    render: fakeRender(),
    qa: passingQa,
    prepare: fakePrepare({ dir }),
  })
  return { dir, storybook, deliver, jobs, checks }
}

const ARGS = { presets: ['youtube_16x9', 'shorts_9x16'], languages: ['en'] }
const callsTo = (storybook, name) => storybook.calls.filter((call) => call.name === name)

test('confirm:false returns the summary per render and performs nothing', async (t) => {
  const { dir, storybook, deliver } = await setup(t)
  const result = await deliver.studioDeliver(ARGS)
  assert.equal(result.previewOnly, true)
  assert.match(result.summaryHash, /^[0-9a-f]{64}$/)
  assert.equal(result.summary.episode.title, 'The Night the Lab Went Dark (20-shots)')
  assert.equal(result.summary.destination.kind, 'storybook')
  assert.deepEqual(result.summary.renders.map((r) => [r.preset, r.language, r.aspect, r.width, r.height, r.captionPolicy, r.framing]), [
    ['youtube_16x9', 'en', '16:9', 1920, 1080, 'sidecar', 'native'],
    ['shorts_9x16', 'en', '9:16', 1080, 1920, 'burn', 'boxed'],
  ])
  for (const render of result.summary.renders) {
    assert.equal(render.estimatedDurationSeconds, 99)
    assert.ok(render.estimatedBytes > 100_000_000 && render.estimatedBytes < 200_000_000, String(render.estimatedBytes))
    assert.deepEqual(render.lastQa, { state: 'not_run' })
  }
  assert.match(result.summary.renders[1].note, /No 9:16 variant/)
  assert.equal(storybook.calls.length, 0, 'no StoryBook tool was called')
  assert.equal(fs.existsSync(path.join(dir, 'renders')), false, 'nothing was rendered')
})

test('confirm:true is refused without the Deliver screen\'s token, with another summary\'s token, and twice with one token', async (t) => {
  const { storybook, deliver } = await setup(t)
  await assert.rejects(deliver.studioDeliver({ ...ARGS, confirm: true }), (error) => error.code === 'FORBIDDEN' && /confirm this exact summary/.test(error.message))
  await assert.rejects(deliver.studioDeliver({ ...ARGS, confirm: true, confirmationToken: 'f'.repeat(64) }), (error) => error.code === 'FORBIDDEN')
  const other = await deliver.studioDeliver({ presets: ['master'] })
  const { token: otherToken } = deliver.issueConfirmationToken(other.summaryHash)
  await assert.rejects(deliver.studioDeliver({ ...ARGS, confirm: true, confirmationToken: otherToken }), (error) => error.code === 'FORBIDDEN')
  assert.equal(storybook.calls.length, 0)
  assert.throws(() => deliver.issueConfirmationToken('not-a-hash'), (error) => error.code === 'VALIDATION_FAILED')
})

test('an expired token is refused', async (t) => {
  const { dir } = makePulledProject(t)
  let clock = Date.parse('2026-10-04T20:00:00Z')
  const deliver = createStudioDeliver({
    jobs: createJobRegistry(),
    getMcpServer: () => ({ lastSnapshot: { project: { path: dir } } }),
    now: () => new Date(clock),
    render: fakeRender(),
    qa: passingQa,
  })
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-export-'))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const args = { presets: ['master'], destination: 'folder', folder }
  const { summaryHash } = await deliver.studioDeliver(args)
  const { token } = deliver.issueConfirmationToken(summaryHash)
  clock += 10 * 60 * 1000 + 1
  await assert.rejects(deliver.studioDeliver({ ...args, confirm: true, confirmationToken: token }), (error) => error.code === 'FORBIDDEN')
})

test('delivery: exact PUTs, finalize per file, TARGET_CHANGED keeps finalized renders, retry reuses them', async (t) => {
  // StoryBook's episode moved on (version 10) after the Studio opened its session at 9.
  const { dir, storybook, deliver, jobs, checks } = await setup(t, { serverVersion: 10, sessionVersion: 9 })
  const { summaryHash } = await deliver.studioDeliver(ARGS)
  const { token } = deliver.issueConfirmationToken(summaryHash)
  const started = await deliver.studioDeliver({ ...ARGS, confirm: true, confirmationToken: token })
  assert.equal(started.started, true)
  // The token is spent.
  await assert.rejects(deliver.studioDeliver({ ...ARGS, confirm: true, confirmationToken: token }), (error) => error.code === 'FORBIDDEN')

  const failed = await waitForJob(jobs, started.jobId)
  assert.equal(failed.status, 'failed', JSON.stringify(failed))
  assert.equal(failed.failure.code, 'TARGET_CHANGED')
  assert.equal(failed.failure.details.currentVersion, 10)
  assert.equal(failed.failure.details.expectedVersion, 9)
  assert.deepEqual(failed.failure.details.diff, { shots: { changed: 1 } }, 'the diff is shown')
  assert.equal(checks.length, 1, 're-sync was checked once')
  assert.equal(failed.failure.details.finalizedRenders.length, 2)

  // Files land in renders/<version>/<preset>-<lang>.mp4.
  for (const file of ['renders/v2/youtube_16x9-en.mp4', 'renders/v2/shorts_9x16-en.mp4']) assert.ok(fs.existsSync(path.join(dir, file)), file)

  // Every PUT: exactly the signed bytes with exactly the signed headers.
  assert.ok(storybook.puts.length >= 4)
  for (const put of storybook.puts) {
    assert.equal(put.method, 'PUT')
    assert.equal(put.headerOk, true, JSON.stringify(put))
    assert.equal(put.bytes, put.expected)
  }
  const uploads = callsTo(storybook, 'request_render_upload')
  assert.deepEqual(uploads.map(({ input }) => [input.preset, input.language, input.aspect, input.contentType, Boolean(input.thumbnail), Boolean(input.captions)]), [
    ['youtube_16x9', 'en', '16:9', 'video/mp4', true, true],
    ['shorts_9x16', 'en', '9:16', 'video/mp4', true, false],
  ])
  for (const { input } of uploads) assert.equal(input.sessionId, SESSION_ID)
  const finals = callsTo(storybook, 'finalize_render')
  assert.equal(finals.length, 2)
  for (const { input } of finals) {
    assert.deepEqual(input.qa, { pass: true, issues: [] })
    assert.equal(input.durationSeconds, 99)
    assert.ok(input.thumbnailKey.endsWith('.jpg'))
  }
  assert.ok(finals[0].input.captionsKey.endsWith('.vtt'), 'youtube sends its sidecar captions')

  // Retry after re-sync: same renders, the episode's new version, nothing re-uploaded.
  const retried = await deliver.retry(started.jobId)
  assert.equal(retried.episodeVersion, 10)
  const done = await waitForJob(jobs, retried.jobId)
  assert.equal(done.status, 'done', JSON.stringify(done))
  assert.equal(callsTo(storybook, 'request_render_upload').length, 2, 'no render was uploaded again')
  assert.equal(callsTo(storybook, 'finalize_render').length, 2)
  const delivers = callsTo(storybook, 'deliver_edit')
  assert.equal(delivers.length, 2)
  assert.deepEqual(delivers.map(({ input }) => input.episodeVersion), [9, 10])
  assert.deepEqual(delivers[0].input.renders, delivers[1].input.renders, 'the finalized renders are reused')
  const delivered = storybook.delivered
  assert.equal(delivered.renders.filter((r) => r.primary).length, 1)
  assert.equal(delivered.renders.find((r) => r.primary).preset, 'youtube_16x9')
  assert.equal(ExplainWhyReportSchema.safeParse(delivered.report).success, true)
  assert.equal(delivered.report.aiOps, 1)
  assert.equal(delivered.report.userOps, 1)
  assert.deepEqual(delivered.qa, { pass: true, issues: [] })
  assert.deepEqual(done.result.renders.map((r) => r.reused), [true, true])

  // Events reached the session before deliver_edit closed it, once each.
  const types = storybook.events.map((event) => event.type)
  assert.equal(types.filter((type) => type === 'qa_run').length, 2)
  const versionCreated = storybook.events.filter((event) => event.type === 'version_created')
  const deliveredEvents = storybook.events.filter((event) => event.type === 'delivered')
  assert.equal(new Set(versionCreated.map((event) => event.clientEventId)).size, 1, 'version_created has one id across attempts')
  assert.equal(new Set(deliveredEvents.map((event) => event.clientEventId)).size, 1, 'delivered has one id across attempts')
  assert.deepEqual(versionCreated[0].data, { versionId: 'v2', name: 'Delivered', durationSeconds: delivered.report.finalDuration, aiOps: 1, userOps: 1 })
  assert.deepEqual(deliveredEvents[0].data.renderIds, delivered.renders.map((r) => r.renderId))
  // The session summary StoryBook builds takes versions, duration and op counts from this report.
  assert.equal(deliveredEvents[0].data.durationSeconds, delivered.report.finalDuration)
})

test('a file that fails QA is not uploaded', async (t) => {
  const { storybook, jobs } = await setup(t)
  let calls = 0
  // Same project, same StoryBook, a QA that fails.
  const { dir } = makePulledProject(t)
  const client = createStoryBookClient({ apiOrigin: storybook.origin, auth: { getAccessToken: async () => 'token', refresh: async () => ({ ok: false }), onSignInRequired() {} } })
  t.after(() => client.close())
  const qaFails = createStudioDeliver({
    jobs,
    getOpenProject: () => ({ projectDir: dir, apiOrigin: storybook.origin }),
    getClient: () => client,
    getMcpServer: () => ({ lastSnapshot: { project: { path: dir } } }),
    render: fakeRender(),
    prepare: fakePrepare({ dir }),
    qa: async () => {
      calls += 1
      return { qa: { pass: false, issues: [{ type: 'loudness', severity: 0.6, timeRange: null, scene: null, detail: 'Integrated loudness -6 LUFS; youtube_16x9 targets -14 ±1 LU.', repairIntent: 'normalize_loudness' }] }, probe: {} }
    },
  })
  const { summaryHash } = await qaFails.studioDeliver({ presets: ['youtube_16x9'] })
  const { jobId } = await qaFails.studioDeliver({ presets: ['youtube_16x9'], confirm: true, confirmationToken: qaFails.issueConfirmationToken(summaryHash).token })
  const job = await waitForJob(jobs, jobId)
  assert.equal(job.status, 'failed')
  assert.equal(job.failure.code, 'QA_FAILED')
  assert.equal(job.failure.details.qa.issues[0].repairIntent, 'normalize_loudness')
  assert.equal(calls, 1)
  assert.equal(callsTo(storybook, 'request_render_upload').length, 0)
})

test('Export to file: the same presets and a QA report in a folder, with no sign-in', async (t) => {
  const { storybook, deliver, jobs } = await setup(t, { signedIn: false })
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-export-'))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const args = { ...ARGS, destination: 'folder', folder }
  await assert.rejects(deliver.studioDeliver(ARGS), (error) => error.code === 'UNAUTHORIZED', 'StoryBook needs sign-in')
  const { summaryHash, summary } = await deliver.studioDeliver(args)
  assert.deepEqual(summary.destination, { kind: 'folder', folder })
  const { jobId } = await deliver.studioDeliver({ ...args, confirm: true, confirmationToken: deliver.issueConfirmationToken(summaryHash).token })
  const job = await waitForJob(jobs, jobId)
  assert.equal(job.status, 'done', JSON.stringify(job))
  assert.deepEqual(fs.readdirSync(folder).filter((name) => name.endsWith('.mp4')).sort(), ['shorts_9x16-en.mp4', 'youtube_16x9-en.mp4'])
  const report = JSON.parse(fs.readFileSync(path.join(folder, 'qa-report.json'), 'utf8'))
  assert.deepEqual(report.files.map((file) => [file.preset, file.file, file.qa.pass]), [['youtube_16x9', 'youtube_16x9-en.mp4', true], ['shorts_9x16', 'shorts_9x16-en.mp4', true]])
  assert.equal(report.qa.pass, true)
  assert.equal(storybook.calls.length, 0, 'nothing went to StoryBook')
})
