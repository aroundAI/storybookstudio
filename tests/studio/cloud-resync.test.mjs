// FILM-2011 AC5: re-sync asks with ifNoneMatch, downloads changed media
// under new names, proposes a plan, and changes nothing in the project.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { checkForUpdates, createResync, RESYNC_INTERVAL_MS } = require('../../electron/studio/sync.js')

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function media(t) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    const body = Buffer.from(`bytes of ${req.url.split('?')[0]}`)
    res.writeHead(200, { 'Content-Length': body.length })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const ref = (key) => ({ url: `${origin}/${key}?sig=1`, key, sha256: null, bytes: Buffer.byteLength(`bytes of /${key}`), mime: 'video/mp4' })
  return { requests, ref }
}

function project(t, pkg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-resync-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'storybook'))
  fs.writeFileSync(path.join(dir, 'storybook', 'package.json'), JSON.stringify(pkg))
  const projectFile = {
    currentTimelineId: 't1',
    timelines: [{ id: 't1', tracks: [{ id: 'video-1', type: 'video' }], clips: pkg.shots.map((s) => ({ id: `clip-${s.sequenceNumber}`, trackId: 'video-1', type: 'video', metadata: { semantic: { shotId: s.id, scene: 1 } } })) }],
  }
  fs.writeFileSync(path.join(dir, 'project.comfystudio'), JSON.stringify(projectFile))
  return dir
}

test('unchanged: one call with ifNoneMatch, nothing downloaded, no plan', async (t) => {
  const m = await media(t)
  const pkg = { etag: 'v1', shots: [{ id: uuid(1), sequenceNumber: 1, video: { ...m.ref('s/1.mp4'), url: m.ref('s/1.mp4').url.split('?')[0] } }], dialogue: [] }
  const dir = project(t, pkg)
  const calls = []
  const plans = []
  const client = { getEditPackage: async (args) => { calls.push(args); return { unchanged: true, etag: 'v1' } } }
  const result = await checkForUpdates({ client, project: { projectDir: dir, episodeId: uuid(9) }, emitPlan: (p) => plans.push(p) })
  assert.equal(result.status, 'unchanged')
  assert.deepEqual(calls, [{ episodeId: uuid(9), ifNoneMatch: 'v1' }])
  assert.equal(plans.length, 0)
  assert.equal(m.requests.length, 0)
})

test('changed: the new video lands under a new name, a plan is proposed, the project file is untouched', async (t) => {
  const m = await media(t)
  const stored = { etag: 'v1', shots: [{ id: uuid(1), sequenceNumber: 1, sceneNumber: 1, video: { ...m.ref('s/1.mp4'), url: m.ref('s/1.mp4').url.split('?')[0] } }], dialogue: [] }
  const dir = project(t, stored)
  const before = fs.readFileSync(path.join(dir, 'project.comfystudio'), 'utf8')
  const next = { etag: 'v2', shots: [{ id: uuid(1), sequenceNumber: 1, sceneNumber: 1, video: m.ref('s/1-v2.mp4') }], dialogue: [], audioTracks: [], characters: [], dubbed: [] }
  const plans = []
  const client = { getEditPackage: async () => next }
  const result = await checkForUpdates({ client, project: { projectDir: dir, episodeId: uuid(9), sessionId: 'sess' }, emitPlan: (p) => plans.push(p) })

  assert.equal(result.status, 'changed')
  assert.equal(plans.length, 1)
  assert.deepEqual(plans[0].steps.map((s) => s.tool), ['import_asset_from_path', 'replace_clip_with_asset'])
  assert.ok(plans[0].steps.every((s) => s.arguments.previewOnly === true && s.arguments.studioMeta.session === 'sess'))
  const imported = plans[0].steps[0].arguments.path
  assert.ok(fs.existsSync(imported))
  assert.match(path.basename(imported), /^shot-001-[0-9a-f]{8}\.mp4$/)
  assert.equal(fs.readFileSync(path.join(dir, 'project.comfystudio'), 'utf8'), before, 'nothing applied')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'storybook', 'package.json'), 'utf8')).etag, 'v1', 'still the package the project was built from')
  const waiting = fs.readFileSync(path.join(dir, 'storybook', 'package.next.json'), 'utf8')
  assert.equal(JSON.parse(waiting).etag, 'v2')
  assert.doesNotMatch(waiting, /sig=/)
})

test('the poll runs every five minutes while a project is open, and stops', async () => {
  assert.equal(RESYNC_INTERVAL_MS, 300_000)
  const armed = []
  const resync = createResync({
    getClient: () => ({}),
    getOpenProject: () => null,
    emitPlan() {},
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false }; armed.push(t); return t },
    clearInterval: (t) => { t.cleared = true },
  })
  resync.start()
  resync.start()
  assert.equal(armed.length, 1)
  assert.equal(armed[0].ms, 300_000)
  assert.deepEqual(await armed[0].fn(), { status: 'no_project' })
  resync.stop()
  assert.equal(armed[0].cleared, true)
})
