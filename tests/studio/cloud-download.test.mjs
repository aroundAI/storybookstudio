// FILM-2011 AC3 / test plan: a download interrupted at 40% completes with one
// request for the remainder; a size or sha256 mismatch re-downloads once,
// then the asset is offline; a 4xx is reported so the job can re-fetch the
// package and resume.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { downloadFile, downloadVerified, MediaUrlRefusedError } = require('../../electron/studio/download.js')

const BODY = crypto.randomBytes(256 * 1024)
const SHA = crypto.createHash('sha256').update(BODY).digest('hex')

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-download-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A media server that honours Range, records every request, and can be told
// to cut the first response at 40%, serve wrong bytes, or refuse with a status.
async function mediaServer(t, { cutFirstAt = null, corrupt = 0, status = null } = {}) {
  const requests = []
  let served = 0
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, range: req.headers.range ?? null })
    if (status) {
      res.writeHead(status, { 'Content-Type': 'application/xml' })
      res.end('<Error><Code>ExpiredToken</Code></Error>')
      return
    }
    let body = BODY
    if (served < corrupt) {
      body = Buffer.from(BODY)
      body[10] ^= 0xff
    }
    served += 1
    const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    if (match) {
      const start = Number(match[1])
      res.writeHead(206, {
        'Content-Length': body.length - start,
        'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`,
        'Content-Type': 'video/mp4',
      })
      res.end(body.subarray(start))
      return
    }
    res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'video/mp4' })
    if (cutFirstAt !== null && requests.length === 1) {
      res.write(body.subarray(0, Math.floor(body.length * cutFirstAt)), () => res.destroy())
      return
    }
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { url: `http://127.0.0.1:${server.address().port}/media.mp4?X-Amz-Signature=secret`, requests }
}

test('an interrupted download resumes with one Range request for the remainder', async (t) => {
  const dir = tempDir(t)
  const server = await mediaServer(t, { cutFirstAt: 0.4 })
  const dest = path.join(dir, 'shot.mp4')

  await assert.rejects(downloadFile({ url: server.url, dest }))
  const partial = fs.statSync(`${dest}.part`).size
  assert.ok(partial > 0 && partial <= BODY.length * 0.4 + 1, `partial file holds the first 40% (${partial})`)

  const progress = []
  await downloadFile({ url: server.url, dest, onBytes: (n) => progress.push(n) })
  assert.equal(server.requests.length, 2, 'exactly one more request')
  assert.equal(server.requests[1].range, `bytes=${partial}-`)
  assert.deepEqual(fs.readFileSync(dest), BODY)
  assert.equal(fs.existsSync(`${dest}.part`), false)
  assert.equal(progress.reduce((a, b) => a + b, 0), BODY.length - partial, 'progress counts only new bytes')
})

test('verified by sha256 when the package has one, else by bytes; a re-run skips a verified file', async (t) => {
  const dir = tempDir(t)
  const server = await mediaServer(t)
  const ref = { url: server.url, bytes: BODY.length, sha256: SHA }
  const dest = path.join(dir, 'a.mp4')

  const first = await downloadVerified({ ref, dest })
  assert.deepEqual({ status: first.status, attempts: first.attempts, sha256: first.sha256 }, { status: 'verified', attempts: 1, sha256: SHA })

  const again = await downloadVerified({ ref, dest, known: first })
  assert.equal(again.status, 'verified')
  assert.equal(again.skipped, true)
  assert.equal(server.requests.length, 1, 'a verified file is not fetched again')

  const bytesOnly = await downloadVerified({ ref: { url: server.url, bytes: BODY.length, sha256: null }, dest: path.join(dir, 'b.mp4') })
  assert.equal(bytesOnly.status, 'verified')
  assert.equal(bytesOnly.verifiedBy, 'bytes')
})

test('a sha256 mismatch re-downloads once and passes when the second copy is right', async (t) => {
  const dir = tempDir(t)
  const server = await mediaServer(t, { corrupt: 1 })
  const result = await downloadVerified({ ref: { url: server.url, bytes: BODY.length, sha256: SHA }, dest: path.join(dir, 'c.mp4') })
  assert.equal(result.status, 'verified')
  assert.equal(result.attempts, 2)
  assert.equal(server.requests.length, 2)
  assert.equal(server.requests[1].range, null, 'the re-download starts from byte 0')
})

test('a second mismatch marks the asset offline and leaves no file behind', async (t) => {
  const dir = tempDir(t)
  const server = await mediaServer(t, { corrupt: 5 })
  const dest = path.join(dir, 'd.mp4')
  const result = await downloadVerified({ ref: { url: server.url, bytes: BODY.length, sha256: SHA }, dest })
  assert.equal(result.status, 'offline')
  assert.equal(result.offlineReason, 'sha256_mismatch')
  assert.equal(server.requests.length, 2, 'one re-download, not more')
  assert.equal(fs.existsSync(dest), false)
})

test('a bytes mismatch (no sha256) is the same path', async (t) => {
  const dir = tempDir(t)
  const server = await mediaServer(t)
  const result = await downloadVerified({ ref: { url: server.url, bytes: BODY.length + 7, sha256: null }, dest: path.join(dir, 'e.mp4') })
  assert.equal(result.status, 'offline')
  assert.equal(result.offlineReason, 'bytes_mismatch')
  assert.equal(server.requests.length, 2)
})

for (const status of [403, 400]) {
  test(`a ${status} on the media URL is a MediaUrlRefusedError, without the signed URL in its message`, async (t) => {
    const dir = tempDir(t)
    const server = await mediaServer(t, { status })
    const error = await downloadFile({ url: server.url, dest: path.join(dir, 'f.mp4') }).catch((e) => e)
    assert.ok(error instanceof MediaUrlRefusedError)
    assert.equal(error.status, status)
    assert.doesNotMatch(error.message, /X-Amz-Signature|secret|127\.0\.0\.1/)
  })
}
