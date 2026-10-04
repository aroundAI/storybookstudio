// FILM-2011: re-sync (contract L9). While a pulled project is open, every
// five minutes: get_edit_package with ifNoneMatch = the etag we hold. When
// StoryBook has a new one, diff shots by media key and dialogue by id,
// download the changed media under new file names, and propose a
// replacement plan to the AI panel (studio:plan-proposed). Nothing is
// applied here: the plan is previews only, and applying it is the user's
// approval through the normal plan path (FILM-2013 studio_apply_updates).
//
// storybook/package.json stays the package the project was built from until
// the plan is applied; the newer one waits in storybook/package.next.json.
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { diffEditPackages, isEmptyDiff, buildResyncPlan, summarizeDiff, keyOf } = require('./packageDiff')
const { planDownloads, stripSignedUrls } = require('./pull')
const { downloadVerified } = require('./download')

const RESYNC_INTERVAL_MS = 5 * 60 * 1000

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(temp, JSON.stringify(value, null, 2))
  await fsp.rename(temp, file)
}

// The keys a plan needs on disk: new videos and new dialogue audio.
function keysToFetch(diff) {
  const keys = new Set()
  for (const change of diff.shots.changed) if (change.keys.video?.to) keys.add(change.keys.video.to)
  for (const row of diff.shots.added) if (keyOf(row.video)) keys.add(keyOf(row.video))
  for (const change of diff.dialogue.changed) if (change.keys.audio?.to) keys.add(change.keys.audio.to)
  for (const row of diff.dialogue.added) if (keyOf(row.audio)) keys.add(keyOf(row.audio))
  return keys
}

async function checkForUpdates({ client, project, fetchFn = fetch, emitPlan = () => {} }) {
  const { projectDir, episodeId, sessionId = null } = project
  const storybookDir = path.join(projectDir, 'storybook')
  const current = await readJson(path.join(storybookDir, 'package.json'))
  if (!current?.etag) return { status: 'not_a_storybook_project' }
  const pendingNext = await readJson(path.join(storybookDir, 'package.next.json'))
  const heldEtag = pendingNext?.etag || current.etag

  const answer = await client.getEditPackage({ episodeId, ifNoneMatch: heldEtag })
  if (answer?.unchanged) return { status: 'unchanged', etag: answer.etag }

  const diff = diffEditPackages(current, answer)
  await writeJson(path.join(storybookDir, 'package.next.json'), stripSignedUrls(answer))
  if (isEmptyDiff(diff)) {
    return { status: 'changed', etag: diff.etag, summary: summarizeDiff(diff), steps: [], unresolved: [] }
  }

  const wanted = keysToFetch(diff)
  const assetPaths = {}
  const failed = []
  for (const item of planDownloads(answer).filter((entry) => wanted.has(entry.key))) {
    const dest = path.join(projectDir, item.relativePath)
    const outcome = await downloadVerified({ ref: item, dest, fetchFn })
    if (outcome.status === 'verified') assetPaths[item.key] = dest
    else failed.push({ key: item.key, reason: outcome.offlineReason })
  }

  const projectFile = await readJson(path.join(projectDir, 'project.comfystudio'))
  const { steps, unresolved } = buildResyncPlan({ diff, project: projectFile, assetPaths, session: sessionId })
  const proposal = {
    source: 'resync',
    planId: `resync-${diff.etag.to}`,
    episodeId,
    etag: diff.etag,
    summary: summarizeDiff(diff),
    steps,
    unresolved,
    failedDownloads: failed,
    proposedAt: new Date().toISOString(),
  }
  await writeJson(path.join(storybookDir, 'resync-plan.json'), proposal)
  emitPlan(proposal)
  return { status: 'changed', ...proposal }
}

function createResync({ getClient, getOpenProject, emitPlan, fetchFn = fetch, intervalMs = RESYNC_INTERVAL_MS, setInterval: arm = setInterval, clearInterval: disarm = clearInterval, log = () => {} }) {
  let timer = null
  let running = null

  const check = async () => {
    const project = getOpenProject()
    if (!project) return { status: 'no_project' }
    if (running) return running
    running = (async () => {
      try {
        return await checkForUpdates({ client: getClient(project.apiOrigin), project, fetchFn, emitPlan })
      } catch (error) {
        log(`[studio] re-sync check failed: ${error?.code || ''} ${error?.message || error}`)
        return { status: 'failed', error: error?.message || String(error), code: error?.code ?? null }
      } finally {
        running = null
      }
    })()
    return running
  }

  return {
    check,
    start() {
      if (timer) return
      timer = arm(() => check(), intervalMs)
      timer?.unref?.()
    },
    stop() {
      if (timer) disarm(timer)
      timer = null
    },
  }
}

module.exports = { createResync, checkForUpdates, RESYNC_INTERVAL_MS }
