// FILM-2011 AC3/AC8: the pull job, in the main process. Session, package,
// plan, four downloads at a time, verify, probe, hand to the builder; a 4xx
// on a media URL re-fetches the package and resumes; a re-run skips what is
// verified; progress {phase, done, total, bytes}; nothing signed is kept.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { runPullJob, planDownloads } = require('../../electron/studio/pull.js')
const { createJobRegistry } = require('../../electron/studio/jobs.js')

const EPISODE = '6f1c2a9e-4b7d-4e85-9a3b-1c2d3e4f5a6b'
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-pull-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Object storage: every key has fixed bytes; a signature older than `generation`
// is refused (400, as the Supabase S3 sandbox does) and in-flight GETs are counted.
async function storage(t, files) {
  const state = { generation: 1, requests: [], inFlight: 0, maxInFlight: 0, refuseFirstOf: new Set() }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const key = decodeURIComponent(url.pathname.slice(1))
    state.requests.push({ key, sig: url.searchParams.get('sig'), range: req.headers.range ?? null })
    if (Number(url.searchParams.get('sig')) < state.generation || state.refuseFirstOf.delete(key)) {
      res.writeHead(400)
      res.end('<Error><Code>ExpiredToken</Code></Error>')
      return
    }
    state.inFlight += 1
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
    await new Promise((r) => setTimeout(r, 15))
    const body = files[key]
    state.inFlight -= 1
    if (!body) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Length': body.length })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  state.origin = `http://127.0.0.1:${server.address().port}`
  return state
}

function makePackage(store, files, { shots = 6, etag = 'v2-abc' } = {}) {
  const media = (key, mime) => ({ url: `${store.origin}/${encodeURIComponent(key)}?sig=${store.generation}`, key, sha256: null, sha256Reason: 'not_recorded', bytes: files[key].length, mime })
  return {
    schemaId: 'storybook-edit-package/1',
    etag,
    generatedAt: '2026-10-04T12:00:00.000Z',
    urlsExpireAt: '2026-10-04T13:00:00.000Z',
    project: { id: uuid(1), name: 'The Lab', slug: 'the-lab' },
    episode: { id: EPISODE, projectId: uuid(1), number: 3, title: 'Lights Out', status: 'storyboard', version: 7, targetDurationSeconds: 60, aspect: '16:9', fps: 24, language: 'en', languages: ['en'] },
    scenes: [{ number: 1, heading: 'INT. LAB - NIGHT' }],
    shots: Array.from({ length: shots }, (_, i) => ({
      id: uuid(100 + i),
      sceneNumber: 1,
      sequenceNumber: i + 1,
      video: i === shots - 1 ? { url: null, mediaReason: 'not_generated' } : media(`shots/${i + 1}.mp4`, 'video/mp4'),
      firstFrame: media(`frames/${i + 1}.png`, 'image/png'),
      lastFrame: { url: null, mediaReason: 'outside_project' },
    })),
    dialogue: [{ id: uuid(200), language: 'en', sequenceNumber: 1, audio: media('dialogue/1.mp3', 'audio/mpeg') }],
    audioTracks: [{ id: uuid(300), type: 'music', media: media('music/bed.mp3', 'audio/mpeg') }],
    captions: [],
    characters: [{ assetId: uuid(400), name: 'MAYA', referenceImages: [media('frames/1.png', 'image/png')] }],
    shortsCandidates: [],
    dubbed: [],
    analyticsHints: { retention: [], publishId: null, reason: 'unmeasured' },
    brand: { fonts: {} },
    editPolicy: { minShotLength: 1.2 },
  }
}

function fixtures() {
  const files = {}
  for (let i = 1; i <= 6; i += 1) {
    files[`shots/${i}.mp4`] = crypto.randomBytes(20_000 + i)
    files[`frames/${i}.png`] = crypto.randomBytes(3000 + i)
  }
  files['dialogue/1.mp3'] = crypto.randomBytes(5000)
  files['music/bed.mp3'] = crypto.randomBytes(9000)
  return files
}

function fakeClient(store, files, log) {
  return {
    async getEditPackage({ episodeId, ifNoneMatch }) {
      log.push(['get_edit_package', episodeId, ifNoneMatch ?? null])
      return makePackage(store, files, { etag: log.some((e) => e[0] === 'open_edit_session') ? 'v2-after-open' : 'v1-before-open' })
    },
    async openEditSession({ episodeId, packageEtag }) {
      log.push(['open_edit_session', episodeId, packageEtag])
      return { sessionId: 'sess-1', previousStatus: 'storyboard', existing: false, episodeVersion: 8 }
    },
  }
}

const fakeProbe = async (file) => {
  const isImage = file.endsWith('.png')
  return { duration: isImage ? null : 4, fps: isImage ? null : 24, width: isImage || file.endsWith('.mp4') ? 1280 : null, height: isImage || file.endsWith('.mp4') ? 720 : null, videoCodec: file.endsWith('.mp4') ? 'h264' : isImage ? 'png' : null, audioCodec: file.endsWith('.mp3') ? 'mp3' : file.endsWith('.mp4') ? 'aac' : null, hasAudio: !isImage }
}

test('the plan has one download per distinct key, under new names, and none for a null URL', () => {
  const files = fixtures()
  const pkg = makePackage({ origin: 'http://s', generation: 1 }, files)
  const plan = planDownloads(pkg)
  const keys = plan.map((p) => p.key)
  assert.equal(new Set(keys).size, keys.length, 'frames/1.png is both a first frame and a character image: one download')
  assert.equal(plan.length, 5 + 6 + 1 + 1)
  assert.ok(plan.every((p) => p.relativePath.startsWith('assets/')))
  assert.ok(plan.find((p) => p.key === 'frames/1.png').owners.length === 2)
})

test('pull: session, package, downloads at concurrency 4, probe, builder; progress events; no signed URL kept', async (t) => {
  const files = fixtures()
  const store = await storage(t, files)
  const root = tempDir(t)
  const log = []
  const events = []
  const jobs = createJobRegistry({ emit: (job) => events.push({ ...job }) })
  let built = null
  const job = jobs.create('pull', { episodeId: EPISODE })

  const result = await runPullJob({
    job,
    episodeId: EPISODE,
    apiOrigin: 'http://localhost:3306',
    client: fakeClient(store, files, log),
    projectsRoot: root,
    probe: fakeProbe,
    build: async (input) => { built = input; return { projectPath: input.projectDir, warnings: [] } },
  })

  // FILM-2002: the open bumps the episode version, so the package is fetched after it.
  assert.deepEqual(log.map((e) => e[0]), ['get_edit_package', 'open_edit_session', 'get_edit_package'])
  assert.equal(log[1][2], 'v1-before-open')
  assert.equal(result.etag, 'v2-after-open')
  assert.equal(result.sessionId, 'sess-1')
  assert.ok(store.maxInFlight <= 4 && store.maxInFlight >= 2, `concurrency ${store.maxInFlight}`)

  const verified = Object.values(result.probedAssets)
  assert.equal(verified.length, 13)
  assert.ok(verified.every((a) => a.status === 'verified' && a.probe && fs.existsSync(a.absolutePath)))
  assert.equal(result.probedAssets['shots/1.mp4'].probe.videoCodec, 'h264')
  assert.equal(built.package.etag, 'v2-after-open')
  assert.equal(built.probedAssets, result.probedAssets)

  const phases = [...new Set(events.map((e) => e.phase))]
  assert.deepEqual(phases, ['session', 'package', 'download', 'probe', 'build', 'done'])
  const last = events.at(-1)
  assert.equal(last.status, 'done')
  assert.equal(last.bytes, Object.values(files).reduce((a, b) => a + b.length, 0) - files['shots/6.mp4'].length)

  const saved = fs.readFileSync(path.join(result.projectDir, 'storybook', 'package.json'), 'utf8')
  assert.doesNotMatch(saved, /sig=/, 'signed URLs are not written to disk')
  assert.equal(JSON.parse(saved).etag, 'v2-after-open')
  for (const name of ['brand.json', 'policy.json', 'probed-assets.json', 'session.json']) {
    assert.ok(fs.existsSync(path.join(result.projectDir, 'storybook', name)), name)
  }
  assert.doesNotMatch(JSON.stringify(events), /sig=/, 'nor sent in progress events')
})

test('a re-run skips every verified file', async (t) => {
  const files = fixtures()
  const store = await storage(t, files)
  const root = tempDir(t)
  const jobs = createJobRegistry({ emit() {} })
  const args = { episodeId: EPISODE, apiOrigin: 'http://localhost:3306', projectsRoot: root, probe: fakeProbe, build: async (i) => ({ projectPath: i.projectDir }) }
  await runPullJob({ ...args, job: jobs.create('pull'), client: fakeClient(store, files, []) })
  const mediaGets = store.requests.length
  const second = await runPullJob({ ...args, job: jobs.create('pull'), client: fakeClient(store, files, []) })
  assert.equal(store.requests.length, mediaGets, 'no media fetched again')
  assert.ok(Object.values(second.probedAssets).every((a) => a.status === 'verified'))
})

test('a 400 on a media GET (expired signature) re-fetches the package and resumes', async (t) => {
  const files = fixtures()
  const store = await storage(t, files)
  const root = tempDir(t)
  const log = []
  const jobs = createJobRegistry({ emit() {} })
  const client = fakeClient(store, files, log)
  // The URLs in hand are expired: everything signed with generation 1 is refused.
  store.generation = 1
  const realGet = client.getEditPackage
  let packages = 0
  client.getEditPackage = async (args) => {
    packages += 1
    const pkg = await realGet(args)
    if (packages === 2) store.generation = 2 // expires right after the job's fetch
    return pkg
  }
  const result = await runPullJob({ job: jobs.create('pull'), episodeId: EPISODE, apiOrigin: 'http://localhost:3306', client, projectsRoot: root, probe: fakeProbe, build: async (i) => ({ projectPath: i.projectDir }) })
  assert.ok(packages >= 3, 'the package was fetched again for fresh URLs')
  assert.ok(store.requests.some((r) => r.sig === '1') && store.requests.some((r) => r.sig === '2'))
  assert.ok(Object.values(result.probedAssets).every((a) => a.status === 'verified'))
})

test('a file whose bytes never match is offline, reported, and the pull still completes', async (t) => {
  const files = fixtures()
  const store = await storage(t, files)
  const root = tempDir(t)
  const client = fakeClient(store, files, [])
  const realGet = client.getEditPackage
  client.getEditPackage = async (args) => {
    const pkg = await realGet(args)
    pkg.dialogue[0].audio.bytes += 1 // the package says one byte more than storage has
    return pkg
  }
  const jobs = createJobRegistry({ emit() {} })
  const result = await runPullJob({ job: jobs.create('pull'), episodeId: EPISODE, apiOrigin: 'http://localhost:3306', client, projectsRoot: root, probe: fakeProbe, build: async (i) => ({ projectPath: i.projectDir }) })
  const audio = result.probedAssets['dialogue/1.mp3']
  assert.equal(audio.status, 'offline')
  assert.equal(audio.offlineReason, 'bytes_mismatch')
  assert.equal(audio.probe, null)
  assert.ok(result.warnings.some((w) => /dialogue\/1\.mp3/.test(w)))
})

test('the job registry answers studio_get_job_status without tokens or URLs', () => {
  const jobs = createJobRegistry({ emit() {} })
  const job = jobs.create('pull', { episodeId: EPISODE })
  job.update({ phase: 'download', done: 3, total: 13, bytes: 4096 })
  assert.deepEqual(jobs.get(job.id), { id: job.id, kind: 'pull', status: 'running', phase: 'download', done: 3, total: 13, bytes: 4096, error: null, episodeId: EPISODE, result: null, startedAt: jobs.get(job.id).startedAt, finishedAt: null })
  job.fail(new Error('boom'))
  assert.equal(jobs.get(job.id).status, 'failed')
  assert.equal(jobs.get(job.id).error, 'boom')
  assert.equal(jobs.get('nope'), null)
})
