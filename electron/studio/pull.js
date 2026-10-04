// FILM-2011: the pull job. Main process only; status through jobs.js.
//
//   get_edit_package → open_edit_session → get_edit_package again (the open
//   bumps episodes.version, which is part of the etag, FILM-2002) → plan →
//   download four at a time with Range resume → verify bytes / sha256 →
//   ffprobe → hand to the builder (FILM-2012, in the renderer) → done.
//
// Idempotent: storybook/downloads.json records every verified file, and a
// re-run fetches nothing whose file still matches. A 4xx on a media GET
// means the signed URL died (FILM-2001: 403 on R2, 400 on the Supabase
// sandbox): the package is fetched again (once for all downloads in flight)
// and the download resumes from its .part file.
//
// Project folder: <projectsRoot>/<project>-ep<NN>-<episode8>/
//   assets/{shots,frames,dialogue/<lang>,dubbed/<lang>,music,sfx,ambience,characters}/
//   storybook/{package,brand,policy,probed-assets,session,downloads}.json
// package.json is the package as pulled with every signed URL removed: a
// signed URL is a credential for an hour and is never written or logged.
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { downloadVerified } = require('./download')
const { localMediaName, keyOf } = require('./packageDiff')

const CONCURRENCY = 4
const PROGRESS_THROTTLE_MS = 250

const ROLE_DIRS = {
  shot_video: 'shots',
  first_frame: 'frames',
  last_frame: 'frames',
  dialogue_audio: 'dialogue',
  dubbed_audio: 'dubbed',
  music: 'music',
  sfx: 'sfx',
  ambience: 'ambience',
  character_image: 'characters',
}

// Every media slot in a package, in a stable order: [ref, owner].
function mediaSlots(pkg) {
  const slots = []
  for (const shot of pkg.shots || []) {
    slots.push([shot.video, { role: 'shot_video', ownerId: shot.id, sequenceNumber: shot.sequenceNumber, scene: shot.sceneNumber ?? null }])
    slots.push([shot.firstFrame, { role: 'first_frame', ownerId: shot.id, sequenceNumber: shot.sequenceNumber, scene: shot.sceneNumber ?? null }])
    slots.push([shot.lastFrame, { role: 'last_frame', ownerId: shot.id, sequenceNumber: shot.sequenceNumber, scene: shot.sceneNumber ?? null }])
  }
  for (const line of pkg.dialogue || []) {
    slots.push([line.audio, { role: 'dialogue_audio', ownerId: line.id, sequenceNumber: line.sequenceNumber, language: line.language, scene: line.sceneNumber ?? null }])
  }
  for (const lane of pkg.dubbed || []) {
    for (const line of lane.lines || []) {
      slots.push([line.audio, { role: 'dubbed_audio', ownerId: line.id, dialogueId: line.dialogueId, language: lane.language }])
    }
  }
  for (const track of pkg.audioTracks || []) {
    slots.push([track.media, { role: track.type === 'ambience' ? 'ambience' : track.type === 'sfx' ? 'sfx' : 'music', ownerId: track.id, label: track.name ?? null }])
  }
  for (const character of pkg.characters || []) {
    for (const image of character.referenceImages || []) {
      slots.push([image, { role: 'character_image', ownerId: character.assetId, label: character.name }])
    }
  }
  return slots
}

// One download per distinct key; the first slot names the file.
function planDownloads(pkg) {
  const byKey = new Map()
  for (const [ref, owner] of mediaSlots(pkg)) {
    const key = keyOf(ref)
    if (!key) continue
    if (byKey.has(key)) {
      byKey.get(key).owners.push(owner)
      continue
    }
    const dir = [ROLE_DIRS[owner.role], owner.language].filter(Boolean).join('/')
    const name = localMediaName({ role: owner.role, sequenceNumber: owner.sequenceNumber ?? null, label: owner.sequenceNumber == null ? owner.label : null, key, mime: ref.mime })
    byKey.set(key, { key, url: ref.url, bytes: ref.bytes, sha256: ref.sha256 ?? null, mime: ref.mime, role: owner.role, relativePath: `assets/${dir}/${name}`, owners: [owner] })
  }
  return [...byKey.values()]
}

// The package with every signature removed: a media `url` keeps only its
// origin and path (the query is the presigned credential), so the package
// still validates as EditPackageSchema for the builder, and nothing on disk
// or in the renderer can fetch the object. Same rule as FILM-2012's
// packageForDisk.
const unsigned = (url) => {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return null
  }
}

function stripSignedUrls(value) {
  if (Array.isArray(value)) return value.map(stripSignedUrls)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [field, inner] of Object.entries(value)) out[field] = stripSignedUrls(inner)
  if (typeof value.url === 'string' && typeof value.key === 'string') out.url = unsigned(value.url)
  return out
}

const slug = (text) => String(text || 'episode').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'episode'

function projectFolderName(pkg) {
  const number = String(pkg.episode?.number ?? 0).padStart(2, '0')
  return `${slug(pkg.project?.name)}-ep${number}-${String(pkg.episode?.id || '').slice(0, 8)}`
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(temp, JSON.stringify(value, null, 2))
  await fsp.rename(temp, file)
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

// Runs `fn` over items with at most `limit` in flight.
async function pool(items, limit, fn) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      await fn(items[index], index)
    }
  })
  await Promise.all(workers)
}

function assertPackage(pkg) {
  if (pkg?.unchanged) throw Object.assign(new Error('StoryBook answered "unchanged" to a request for the whole package.'), { code: 'INTERNAL' })
  if (pkg?.schemaId !== 'storybook-edit-package/1' || !Array.isArray(pkg.shots)) {
    throw Object.assign(new Error(`StoryBook sent an edit package this Studio cannot read (${pkg?.schemaId ?? 'no schemaId'}).`), { code: 'VALIDATION_FAILED' })
  }
  return pkg
}

async function runPullJob({
  job,
  episodeId,
  apiOrigin,
  client,
  projectsRoot,
  probe,
  build,
  fetchFn = fetch,
  concurrency = CONCURRENCY,
  log = () => {},
}) {
  try {
    const started = Date.now()
    job.update({ phase: 'session', done: 0, total: 0 })
    const first = assertPackage(await client.getEditPackage({ episodeId }))
    const session = await client.openEditSession({ episodeId, packageEtag: first.etag })

    job.update({ phase: 'package' })
    let pkg = session.existing ? first : assertPackage(await client.getEditPackage({ episodeId }))
    const projectDir = path.join(projectsRoot, projectFolderName(pkg))
    const storybookDir = path.join(projectDir, 'storybook')
    const stripped = stripSignedUrls(pkg)
    await writeJson(path.join(storybookDir, 'package.json'), stripped)
    await writeJson(path.join(storybookDir, 'brand.json'), pkg.brand ?? {})
    await writeJson(path.join(storybookDir, 'policy.json'), pkg.editPolicy ?? {})
    await writeJson(path.join(storybookDir, 'session.json'), {
      apiOrigin,
      episodeId,
      sessionId: session.sessionId,
      episodeVersion: session.episodeVersion ?? pkg.episode?.version ?? null,
      previousStatus: session.previousStatus ?? null,
      etag: pkg.etag,
      openedAt: new Date().toISOString(),
    })

    // Downloads.
    const plan = planDownloads(pkg)
    const manifestFile = path.join(storybookDir, 'downloads.json')
    const manifest = await readJson(manifestFile, {})
    let manifestWrite = Promise.resolve()
    const saveManifest = () => {
      manifestWrite = manifestWrite.then(() => writeJson(manifestFile, manifest))
      return manifestWrite
    }

    // One package re-fetch for every download whose URL was refused at once.
    let refetch = null
    const freshRef = async (key) => {
      if (!refetch) {
        refetch = client
          .getEditPackage({ episodeId })
          .then(assertPackage)
          .then((next) => {
            pkg = next
            return new Map(planDownloads(next).map((item) => [item.key, item]))
          })
          .finally(() => {
            setTimeout(() => {
              refetch = null
            }, 0)
          })
      }
      const byKey = await refetch
      return byKey.get(key) || null
    }

    let lastPublish = 0
    const tick = () => {
      if (Date.now() - lastPublish < PROGRESS_THROTTLE_MS) return
      lastPublish = Date.now()
      job.publish()
    }

    let done = 0
    job.update({ phase: 'download', done, total: plan.length })
    const results = new Map()
    await pool(plan, concurrency, async (item) => {
      const dest = path.join(projectDir, item.relativePath)
      const outcome = await downloadVerified({
        ref: item,
        dest,
        known: manifest[item.key] ?? null,
        fetchFn,
        onBytes: (n) => {
          job.addBytes(n)
          tick()
        },
        refreshRef: () => freshRef(item.key),
      })
      results.set(item.key, outcome)
      manifest[item.key] = { path: item.relativePath, status: outcome.status, bytes: outcome.bytes, sha256: outcome.sha256, verifiedBy: outcome.verifiedBy ?? null, at: new Date().toISOString() }
      await saveManifest()
      done += 1
      job.update({ done })
    })

    // Probe what verified.
    const probedAssets = {}
    const warnings = []
    for (const item of plan) {
      const outcome = results.get(item.key)
      const verified = outcome.status === 'verified'
      // FILM-2012's builder reads `path` (project-relative; null = offline)
      // and the flat probe fields; `probe` keeps them together for others.
      probedAssets[item.key] = {
        key: item.key,
        role: item.role,
        ownerId: item.owners[0].ownerId,
        owners: item.owners,
        language: item.owners[0].language ?? null,
        status: outcome.status,
        ...(verified ? {} : { offlineReason: outcome.offlineReason }),
        path: verified ? item.relativePath : null,
        plannedPath: item.relativePath,
        absolutePath: verified ? path.join(projectDir, item.relativePath) : null,
        bytes: item.bytes,
        sha256: outcome.sha256 ?? item.sha256 ?? null,
        mime: item.mime,
        probe: null,
      }
      if (outcome.status === 'offline') warnings.push(`${item.key}: ${outcome.offlineReason} after two downloads; the asset is offline.`)
    }
    const toProbe = Object.values(probedAssets).filter((asset) => asset.status === 'verified')
    let probed = 0
    job.update({ phase: 'probe', done: 0, total: toProbe.length })
    await pool(toProbe, concurrency, async (asset) => {
      try {
        const result = await probe(asset.absolutePath)
        Object.assign(asset, {
          probe: result,
          duration: result.duration,
          fps: result.fps,
          width: result.width,
          height: result.height,
          codecs: { video: result.videoCodec ?? null, audio: result.audioCodec ?? null },
          hasAudio: result.hasAudio,
        })
      } catch (error) {
        warnings.push(`${asset.key}: ffprobe failed (${error?.message || error}).`)
      }
      probed += 1
      job.update({ done: probed })
    })
    await writeJson(path.join(storybookDir, 'probed-assets.json'), probedAssets)

    // Hand to the builder.
    job.update({ phase: 'build', done: 0, total: 1 })
    const built = await build({
      jobId: job.id,
      apiOrigin,
      episodeId,
      sessionId: session.sessionId,
      projectDir,
      package: stripSignedUrls(pkg),
      probedAssets,
    })
    job.update({ done: 1 })

    const result = {
      projectDir,
      projectPath: built?.projectPath ?? projectDir,
      etag: pkg.etag,
      sessionId: session.sessionId,
      episodeId,
      files: plan.length,
      verified: toProbe.length,
      offline: plan.length - toProbe.length,
      skipped: [...results.values()].filter((r) => r.skipped).length,
      warnings: [...warnings, ...(built?.warnings || [])],
      durationMs: Date.now() - started,
      builder: built?.builder ?? null,
    }
    job.complete(result)
    return { ...result, probedAssets }
  } catch (error) {
    log(`[studio] pull failed: ${error?.code || ''} ${error?.message || error}`)
    job.fail(error)
    throw error
  }
}

module.exports = { runPullJob, planDownloads, stripSignedUrls, projectFolderName, mediaSlots, CONCURRENCY }
