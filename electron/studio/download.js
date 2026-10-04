// FILM-2011: one media download with HTTP Range resume and verification.
// Main process only (Node fetch and fs). A signed URL never appears in an
// error message or a log line: it is a bearer credential for an hour.
const crypto = require('crypto')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')

// The URL was refused (FILM-2001 media rules: an expired signature is 403 on
// R2/MinIO and 400 ExpiredToken on the Supabase S3 sandbox). The caller
// fetches the package again for a fresh URL and resumes from the .part file.
class MediaUrlRefusedError extends Error {
  constructor(status) {
    super(`The storage refused the media URL (HTTP ${status}); a fresh package is needed.`)
    this.name = 'MediaUrlRefusedError'
    this.status = status
  }
}

class MediaDownloadError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message)
    this.name = 'MediaDownloadError'
    this.status = status
    if (cause) this.cause = cause
  }
}

async function sizeOf(file) {
  try {
    return (await fsp.stat(file)).size
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function sha256Of(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

// Downloads `url` to `dest` through `dest.part`. When a .part file exists the
// request asks only for the bytes after it; a server that ignores the Range
// header (200) starts the file over. Resolves when `dest` holds the whole body.
async function downloadFile({ url, dest, fetchFn = fetch, onBytes = () => {}, signal } = {}) {
  const part = `${dest}.part`
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const have = (await sizeOf(part)) || 0

  let response
  try {
    response = await fetchFn(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal })
  } catch (error) {
    throw new MediaDownloadError('The media download could not connect.', { cause: error })
  }

  if (response.status === 416 && have > 0) {
    // The .part file already holds every byte (or more): verify decides.
    await response.body?.cancel?.()
    await fsp.rename(part, dest)
    return { resumedFrom: have, written: 0 }
  }
  if (response.status >= 400 && response.status < 500) {
    await response.body?.cancel?.()
    throw new MediaUrlRefusedError(response.status)
  }
  if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel?.()
    throw new MediaDownloadError(`The media download failed (HTTP ${response.status}).`, { status: response.status })
  }

  const append = response.status === 206 && have > 0
  const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' })
  let written = 0
  try {
    for await (const chunk of response.body) {
      written += chunk.length
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve))
      onBytes(chunk.length)
    }
  } catch (error) {
    await new Promise((resolve) => out.end(resolve))
    throw new MediaDownloadError('The media download was interrupted.', { cause: error })
  }
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())))
  await fsp.rename(part, dest)
  return { resumedFrom: append ? have : 0, written }
}

// Checks a finished file against the package's ref: sha256 when StoryBook
// recorded one, else bytes (FILM-2001: sha256 is usually null).
async function verifyFile(dest, ref) {
  const size = await sizeOf(dest)
  if (size === null) return { ok: false, reason: 'missing' }
  if (Number.isInteger(ref.bytes) && size !== ref.bytes) return { ok: false, reason: 'bytes_mismatch', size }
  if (ref.sha256) {
    const sha256 = await sha256Of(dest)
    if (sha256 !== ref.sha256) return { ok: false, reason: 'sha256_mismatch', size, sha256 }
    return { ok: true, verifiedBy: 'sha256', size, sha256 }
  }
  return { ok: true, verifiedBy: 'bytes', size, sha256: null }
}

// Download, verify, and on a mismatch download once more from byte 0; a
// second mismatch marks the asset offline and removes the bad file. `known`
// is the record of an earlier verified download of the same file: when the
// file on disk still matches it, nothing is fetched (idempotent re-runs).
// `refreshRef` is called after a MediaUrlRefusedError for a fresh ref.
async function downloadVerified({ ref, dest, known = null, fetchFn = fetch, onBytes = () => {}, refreshRef = null, maxRefreshes = 3 }) {
  if (known?.status === 'verified') {
    const size = await sizeOf(dest)
    if (size !== null && size === ref.bytes && (!ref.sha256 || known.sha256 === ref.sha256)) {
      return { ...known, skipped: true }
    }
  }

  let current = ref
  let refreshes = 0
  const fetchOnce = async () => {
    for (;;) {
      try {
        return await downloadFile({ url: current.url, dest, fetchFn, onBytes })
      } catch (error) {
        if (!(error instanceof MediaUrlRefusedError) || !refreshRef || refreshes >= maxRefreshes) throw error
        refreshes += 1
        current = await refreshRef(error)
        if (!current?.url) throw error
      }
    }
  }

  let attempts = 0
  let last = null
  while (attempts < 2) {
    attempts += 1
    if (attempts > 1) {
      await fsp.rm(dest, { force: true })
      await fsp.rm(`${dest}.part`, { force: true })
    }
    await fetchOnce()
    last = await verifyFile(dest, current)
    if (last.ok) {
      return { status: 'verified', verifiedBy: last.verifiedBy, bytes: last.size, sha256: last.sha256, attempts, refreshes }
    }
  }
  await fsp.rm(dest, { force: true })
  return { status: 'offline', offlineReason: last.reason, bytes: null, sha256: null, attempts, refreshes }
}

module.exports = {
  MediaUrlRefusedError,
  MediaDownloadError,
  downloadFile,
  downloadVerified,
  verifyFile,
  sha256Of,
}
