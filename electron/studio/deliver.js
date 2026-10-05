// FILM-2017: Deliver (contract L8), variants and the reframe tools, in the
// main process. studioMain.js creates it; FILM-2013's capability layer calls
// studioDeliver / createVariant; mcpServer.js calls the expert tools
// set_auto_reframe and set_focal_point; the Deliver screen (FILM-2015) calls
// summary, confirm, start and retry over studio:* IPC.
//
// Delivery:
//   studio_deliver {presets[], languages[], confirm:false} → a summary per
//   render and nothing else. confirm:true needs `confirmationToken`, the
//   one-time token issueConfirmationToken(summaryHash) gives the main window
//   when the user confirms that exact summary on the Deliver screen; the
//   token is bound to the summary's hash (episode, version, destination,
//   presets, languages and the timelines' content), expires after ten
//   minutes and is used once. No MCP path issues one, so an external client
//   cannot upload without the user seeing the summary (contract S3).
//   Then a job (kind 'deliver', FILM-2011's registry): prepare (save, the
//   "Delivered" version, the explain-why report) → per render: render, QA,
//   request_render_upload, PUT, finalize_render → deliver_edit once.
//   TARGET_CHANGED keeps every finalized render in the job's state; retry
//   re-delivers them against the episode's new version after a re-sync.
// Export to file: the same renders and the QA report into a chosen folder,
// no sign-in, nothing sent anywhere.
const crypto = require('crypto')
const fs = require('fs')
const fsp = fs.promises
const http = require('http')
const https = require('https')
const path = require('path')
const { pathToFileURL } = require('url')
const { renderDelivery } = require('./deliveryRender')
const { checkDeliveredFile, combineQa } = require('./deliveryQa')
const { detectClipSamples } = require('./subjectDetect')
const { resolveBinaries } = require('./ffmpegTools')

const { PROJECT_FILE, projectFilePath, removeLegacyProjectFile } = require('./projectFile')
const TOKEN_TTL_MS = 10 * 60 * 1000
const MAX_PUT_ATTEMPTS = 3
const STATE_FILE = '.delivery-state.json'
const QA_REPORT_FILE = 'qa-report.json'

const studioModule = (relative) => import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'studio', relative)).href)
const fail = (code, message, details = null) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) })
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')
const round3 = (value) => Math.round(value * 1000) / 1000

const DELIVER_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    presets: { type: 'array', items: { type: 'string', enum: ['youtube_16x9', 'shorts_9x16', 'tiktok_9x16', 'reels_9x16', 'square_1x1', 'master'] }, minItems: 1, maxItems: 6, description: 'Delivery presets to render.' },
    languages: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Languages to render; defaults to the episode language.' },
    destination: { type: 'string', enum: ['storybook', 'folder'], description: 'storybook (upload and deliver_edit; needs sign-in) or folder (Export to file; no sign-in). Defaults to storybook.' },
    folder: { type: 'string', description: 'Absolute folder for destination folder.' },
    confirm: { type: 'boolean', description: 'false (default) returns the summary and performs nothing. true renders and delivers, and is accepted only with confirmationToken.' },
    confirmationToken: { type: 'string', description: 'The one-time token the Deliver screen issues after the user confirms this exact summary. An MCP client cannot create one.' },
  },
  required: ['presets'],
}

const CREATE_VARIANT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['short', 'hook', 'language'], description: 'short: a 9:16 variant of a range; hook: N alternative first-five-second openings; language: the episode\'s dub in `language` as a lane on the master (FILM-2019).' },
    source: {
      type: 'object',
      description: 'For a short: {candidateId} (a StoryBook shorts candidate), {hook: true} (the strongest sound bite) or {range: [start, end]} in seconds.',
      properties: { candidateId: { type: 'string' }, hook: { type: 'boolean' }, range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } },
    },
    preset: { type: 'string', enum: ['shorts_9x16', 'tiktok_9x16', 'reels_9x16'], description: 'The vertical preset the short is for (duration limit). Defaults to shorts_9x16.' },
    variants: { type: 'integer', minimum: 1, maximum: 5, description: 'For kind hook: how many openings. Defaults to 3.' },
    language: { type: 'string', description: 'Dialogue language the variant follows. For kind language: the dub to lay in (a tag such as hi or es).' },
    presets: { type: 'array', items: { type: 'string', enum: ['youtube_16x9', 'shorts_9x16', 'tiktok_9x16', 'reels_9x16', 'square_1x1', 'master'] }, maxItems: 6, description: 'For kind language: the presets rendered in that language and QA-checked when applied (exportFiles). Defaults to youtube_16x9.' },
    exportFiles: { type: 'boolean', description: 'For kind hook: also render each opening to renders/<version>/hooks/; for kind language: render and QA each preset into renders/<version>/languages/. Defaults to true when applied.' },
    previewOnly: { type: 'boolean', description: 'When true (default), returns what would be built and changes nothing.' },
  },
  required: ['kind'],
}

const AUTO_REFRAME_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    clipIds: { type: 'array', items: { type: 'string' }, description: 'Picture clips on the active timeline; defaults to every video and image clip.' },
    aspect: { type: 'string', enum: ['9:16', '1:1', '16:9'], description: 'The frame the crop follows; defaults to the active timeline\'s own aspect.' },
    previewOnly: { type: 'boolean', description: 'When true (default), returns the crop paths and the set_clip_keyframes calls without changing the timeline.' },
  },
}

const FOCAL_POINT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    clipId: { type: 'string', description: 'Video or image clip on the active timeline.' },
    x: { type: 'number', description: 'Horizontal focal point, 0 (left) to 1 (right) of the source frame.' },
    y: { type: 'number', description: 'Vertical focal point, 0 (top) to 1 (bottom) of the source frame.' },
    aspect: { type: 'string', enum: ['9:16', '1:1', '16:9'], description: 'Defaults to the active timeline\'s aspect.' },
    previewOnly: { type: 'boolean', description: 'When true (default), returns the keyframes without applying them.' },
  },
  required: ['clipId', 'x', 'y'],
}

// What a render of a timeline depends on, for the summary hash. A save
// stamps `modified` (and the playhead, zoom and other view state ride along)
// on every call, so the whole timeline object would never hash the same
// twice; this keeps the frame, the tracks, clips, transitions and the
// studio metadata, and the source file of every asset a clip uses.
const TIMELINE_RENDER_KEYS = ['id', 'width', 'height', 'fps', 'tracks', 'clips', 'transitions', 'studio']
const ASSET_RENDER_KEYS = ['id', 'path', 'type', 'width', 'height', 'duration', 'proxyPath']
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]))
function renderContentHash(timeline, assets = []) {
  const used = new Set((timeline.clips || []).map((clip) => clip.assetId).filter(Boolean))
  const sources = (assets || []).filter((asset) => used.has(asset.id)).map((asset) => pick(asset, ASSET_RENDER_KEYS)).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return sha256(JSON.stringify({ timeline: pick(timeline, TIMELINE_RENDER_KEYS), sources }))
}

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

// PUT a file to a presigned URL: exactly `bytes`, exactly `headers`.
function putFile({ url, headers = {}, file, bytes, signal = null }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http
    const hasLength = Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')
    const request = transport.request(target, { method: 'PUT', headers: { ...headers, ...(hasLength ? {} : { 'Content-Length': String(bytes) }) } }, (response) => {
      let body = ''
      response.on('data', (chunk) => {
        body = (body + chunk).slice(0, 2000)
      })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    request.on('error', reject)
    signal?.addEventListener?.('abort', () => request.destroy(fail('ABORTED', 'Upload cancelled.')))
    fs.createReadStream(file).on('error', reject).pipe(request)
  })
}

function createStudioDeliver({
  jobs,
  getOpenProject = () => null,
  getClient = () => null,
  checkUpdates = async () => ({ status: 'no_project' }),
  getMcpServer = () => null,
  getFfmpegPath = () => null,
  getFfprobePath = () => null,
  render = renderDelivery,
  qa = checkDeliveredFile,
  // FILM-2019 AC5: whisper's spoken-language check (languageCheck.js), for the qa.
  detectLanguage = null,
  prepare = null,
  put = putFile,
  now = () => new Date(),
  tokenTtlMs = TOKEN_TTL_MS,
  log = () => {},
}) {
  const tokens = new Map()
  const jobPlans = new Map()

  const server = () => getMcpServer() || null
  const performAction = async (action, payload) => {
    const perform = server()?.performAction
    if (!perform) throw fail('VALIDATION_FAILED', 'The editor window is not open.')
    return perform({ action, payload })
  }
  const projectDirOf = (snapshot) => {
    const dir = snapshot?.project?.path || server()?.lastSnapshot?.project?.path || getOpenProject()?.projectDir
    if (typeof dir !== 'string' || !dir) throw fail('VALIDATION_FAILED', 'Open a saved project first.')
    return dir
  }

  // The document the user sees. With the editor open it comes from the
  // renderer as a read (studio_delivery_document, previewOnly), so a summary
  // neither writes the project nor adds an op-log line; without a window, the
  // saved project file.
  async function loadDocument(projectDir) {
    if (server()?.performAction) {
      const live = await performAction('studio_delivery_document', { previewOnly: true }).catch((error) => {
        log(`[studio] deliver: the editor did not return the document: ${error?.message || error}`)
        return null
      })
      if (live?.document?.timelines) return live.document
    }
    const document = await readJson(projectFilePath(projectDir))
    if (!document?.timelines) throw fail('NOT_FOUND', `No ${PROJECT_FILE} in ${projectDir}.`)
    return document
  }

  async function episodeContext(projectDir) {
    const dir = path.join(projectDir, 'storybook')
    const [session, pkg] = await Promise.all([readJson(path.join(dir, 'session.json')), readJson(path.join(dir, 'package.json'))])
    return {
      session,
      episode: pkg?.episode ? { id: pkg.episode.id, title: pkg.episode.title, version: session?.episodeVersion ?? pkg.episode.version ?? null, language: pkg.episode.language ?? null, languages: pkg.episode.languages ?? [] } : null,
      shortsCandidates: Array.isArray(pkg?.shortsCandidates) ? pkg.shortsCandidates : [],
      policy: (await readJson(path.join(dir, 'policy.json'))) || null,
      brand: (await readJson(path.join(dir, 'brand.json'))) || null,
    }
  }

  // The last preview's QA: edits/qa/latest.json (FILM-2013's LAST_QA_PATH,
  // written by FILM-2014's review), a QaResult or {qa, at}.
  async function lastPreviewQa(projectDir) {
    const record = await readJson(path.join(projectDir, 'edits', 'qa', 'latest.json'))
    const qa = record?.qa ?? record
    if (typeof qa?.pass !== 'boolean') return { state: 'not_run' }
    return { state: qa.pass ? 'pass' : 'fail', issues: qa.issues?.length ?? 0, at: record.at ?? null }
  }

  // Which timeline a preset renders: a variant of the preset's aspect when
  // there is one (the newest), else the master (letterboxed or pillarboxed
  // into the preset's frame, and the summary says so).
  function timelineForPreset(document, preset) {
    const timelines = document.timelines || []
    const master = timelines.find((timeline) => timeline.studio?.kind === 'master') || timelines.find((timeline) => timeline.id === document.currentTimelineId) || timelines[0]
    const variants = timelines.filter((timeline) => timeline.studio?.kind === 'variant' && timeline.studio?.variantKind !== 'hook' && timeline.studio?.aspect === preset.aspect)
    const exact = variants.filter((timeline) => timeline.studio?.preset === preset.name)
    const chosen = (exact.length ? exact : variants).at(-1)
    if (chosen) return { timeline: chosen, framing: 'variant', note: null }
    const masterAspect = master?.studio?.aspect ?? null
    const note = masterAspect && masterAspect !== preset.aspect ? `No ${preset.aspect} variant: the ${masterAspect} master is boxed into the frame. Create a Short (studio_create_variant) for a reframed render.` : null
    return { timeline: master, framing: note ? 'boxed' : 'native', note }
  }

  const programEnd = (timeline) => round3(Math.max(0, ...(timeline.clips || []).filter((clip) => clip.enabled !== false && !['captions', 'caption'].includes(clip.type)).map((clip) => (Number(clip.startTime) || 0) + (Number(clip.duration) || 0))))

  async function buildSummary(args, { snapshot = null } = {}) {
    const presetsModule = await studioModule('delivery/presets.js')
    const contracts = await studioModule('contracts/render-presets.mjs')
    const names = [...new Set(Array.isArray(args.presets) ? args.presets : [])]
    if (!names.length) throw fail('VALIDATION_FAILED', 'Name at least one preset.')
    for (const name of names) presetsModule.presetFor(name)
    const destination = args.destination === 'folder' ? 'folder' : 'storybook'
    if (destination === 'folder' && !(typeof args.folder === 'string' && path.isAbsolute(args.folder))) throw fail('VALIDATION_FAILED', 'Export to file needs an absolute folder.')
    const projectDir = projectDirOf(snapshot)
    const document = await loadDocument(projectDir)
    const context = await episodeContext(projectDir)
    const open = getOpenProject()
    if (destination === 'storybook') {
      if (!context.session?.sessionId || !context.episode) throw fail('VALIDATION_FAILED', 'This project was not pulled from StoryBook; use Export to file.')
      if (!open || open.projectDir !== projectDir) throw fail('UNAUTHORIZED', 'Sign in to StoryBook and open the pulled episode to deliver it.')
    }
    const master = document.timelines.find((timeline) => timeline.studio?.kind === 'master') || document.timelines[0]
    const languages = [...new Set((Array.isArray(args.languages) && args.languages.length ? args.languages : [master?.studio?.language || context.episode?.language || presetsModule.DEFAULT_LANGUAGE]).map(String))]
    for (const language of languages) if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(language)) throw fail('VALIDATION_FAILED', `${language} is not a language tag such as en or pt-BR.`)
    const renders = []
    for (const name of names) {
      for (const language of languages) {
        const base = presetsModule.presetFor(name)
        const { timeline, framing, note } = timelineForPreset(document, { ...base, aspect: contracts.RENDER_PRESETS[name].aspect ?? null })
        const resolved = presetsModule.resolvePreset(name, { timeline, policy: context.policy })
        const duration = programEnd(timeline)
        renders.push({
          preset: name,
          language,
          timelineId: timeline.id,
          timelineName: timeline.name,
          framing,
          note,
          aspect: resolved.aspect,
          width: resolved.width,
          height: resolved.height,
          fps: resolved.fps,
          audioLufs: resolved.audioLufs,
          captionPolicy: resolved.captionPolicy,
          estimatedDurationSeconds: duration,
          maxDuration: resolved.maxDuration,
          overMaxDuration: resolved.maxDuration != null && duration > resolved.maxDuration,
          estimatedBytes: presetsModule.estimateBytes(name, duration),
          lastQa: await lastPreviewQa(projectDir),
          file: presetsModule.deliveryFileName(name, language),
          contentHash: renderContentHash(timeline, document.assets),
        })
      }
    }
    const summary = {
      episode: context.episode,
      destination: destination === 'storybook' ? { kind: 'storybook', apiOrigin: open?.apiOrigin ?? null, sessionId: context.session?.sessionId ?? null } : { kind: 'folder', folder: args.folder },
      projectDir,
      renders,
      totalEstimatedBytes: renders.reduce((sum, entry) => sum + entry.estimatedBytes, 0),
    }
    const summaryHash = sha256(JSON.stringify({
      episode: summary.episode,
      destination: summary.destination,
      projectDir,
      renders: renders.map(({ preset, language, timelineId, contentHash }) => ({ preset, language, timelineId, contentHash })),
    }))
    return { summary, summaryHash, document, context }
  }

  function issueConfirmationToken(summaryHash) {
    if (typeof summaryHash !== 'string' || !/^[0-9a-f]{64}$/.test(summaryHash)) throw fail('VALIDATION_FAILED', 'summaryHash is the hash studio_deliver returned.')
    for (const [token, entry] of tokens) if (entry.expiresAt <= now().getTime()) tokens.delete(token)
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = now().getTime() + tokenTtlMs
    tokens.set(token, { summaryHash, expiresAt })
    return { token, expiresAt: new Date(expiresAt).toISOString() }
  }

  // One use, unexpired, and for this exact summary.
  function consumeToken(token, summaryHash) {
    if (typeof token !== 'string' || !tokens.has(token)) return false
    const entry = tokens.get(token)
    tokens.delete(token)
    if (entry.expiresAt <= now().getTime()) return false
    const a = Buffer.from(entry.summaryHash)
    const b = Buffer.from(String(summaryHash))
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  const statePathFor = (projectDir, versionId) => path.join(projectDir, 'renders', String(versionId), STATE_FILE)

  async function prepareDelivery({ projectDir, document }) {
    if (prepare) return prepare({ projectDir, document })
    const result = await performAction('studio_prepare_delivery', { previewOnly: false, studioMeta: { by: 'user', reason: 'Delivery' } })
    if (!result?.versionId || !result.report) throw fail('VALIDATION_FAILED', 'The editor did not prepare the delivery.')
    return result
  }

  async function renderAndCheck({ job, item, projectDir, document, outputPath, presetsModule, policy }) {
    const timeline = document.timelines.find((entry) => entry.id === item.timelineId)
    const preset = presetsModule.resolvePreset(item.preset, { timeline, policy })
    job.update({ phase: `render ${item.preset}-${item.language}` })
    const rendered = await render({ project: document, projectDir, timelineId: item.timelineId, preset, language: item.language, outputPath, ffmpegPath: getFfmpegPath(), onProgress: () => {} })
    job.update({ phase: `qa ${item.preset}-${item.language}` })
    const checked = await qa({ file: outputPath, preset, expectedDuration: rendered.durationSeconds, warnings: timeline.studio?.reframeWarnings || [], ffmpegPath: getFfmpegPath(), ffprobePath: getFfprobePath(), project: document, timelineId: item.timelineId, language: item.language, detectLanguage })
    return { rendered, checked, preset }
  }

  async function uploadRender({ client, sessionId, item, outputPath, rendered, checked, preset, signal }) {
    const bytes = fs.statSync(outputPath).size
    const thumbBytes = rendered.thumbnailPath && fs.existsSync(rendered.thumbnailPath) ? fs.statSync(rendered.thumbnailPath).size : 0
    const captionsBytes = rendered.captionsPath && fs.existsSync(rendered.captionsPath) ? fs.statSync(rendered.captionsPath).size : 0
    let lastError = null
    for (let attempt = 1; attempt <= MAX_PUT_ATTEMPTS; attempt += 1) {
      // A new signed upload each attempt: a failed or expired PUT is never retried against a stale URL.
      const upload = await client.requestRenderUpload({
        sessionId,
        preset: item.preset,
        language: item.language,
        aspect: preset.aspect,
        bytes,
        contentType: 'video/mp4',
        ...(thumbBytes ? { thumbnail: { bytes: thumbBytes, contentType: 'image/jpeg' } } : {}),
        ...(captionsBytes ? { captions: { bytes: captionsBytes, contentType: 'text/vtt' } } : {}),
      })
      try {
        const sent = await put({ url: upload.uploadUrl, headers: upload.headers || {}, file: outputPath, bytes, signal })
        if (sent.status < 200 || sent.status >= 300) throw fail('UPLOAD_FAILED', `Storage answered ${sent.status} to the render upload.`)
        let thumbnailKey
        let captionsKey
        if (upload.thumbnail && thumbBytes) {
          const result = await put({ url: upload.thumbnail.uploadUrl, headers: upload.thumbnail.headers || {}, file: rendered.thumbnailPath, bytes: thumbBytes, signal })
          if (result.status >= 200 && result.status < 300) thumbnailKey = upload.thumbnail.key
        }
        if (upload.captions && captionsBytes) {
          const result = await put({ url: upload.captions.uploadUrl, headers: upload.captions.headers || {}, file: rendered.captionsPath, bytes: captionsBytes, signal })
          if (result.status >= 200 && result.status < 300) captionsKey = upload.captions.key
        }
        const durationSeconds = round3(checked.probe?.durationSeconds || rendered.durationSeconds)
        await client.finalizeRender({ renderId: upload.renderId, durationSeconds, qa: checked.qa, ...(thumbnailKey ? { thumbnailKey } : {}), ...(captionsKey ? { captionsKey } : {}) })
        return { renderId: upload.renderId, key: upload.key, bytes, durationSeconds, attempts: attempt }
      } catch (error) {
        lastError = error
        log(`[studio] deliver: upload of ${item.preset}-${item.language} failed (attempt ${attempt}): ${error?.code || ''} ${error?.message || error}`)
        if (error?.code === 'ABORTED' || error?.code === 'FORBIDDEN' || error?.code === 'UNAUTHORIZED') throw error
      }
    }
    throw lastError
  }

  const primaryOf = (items) => items.find((item) => item.preset === 'youtube_16x9') || items.find((item) => item.preset === 'master') || items[0]

  async function runDelivery(job, plan) {
    const presetsModule = await studioModule('delivery/presets.js')
    const { projectDir, destination } = plan
    const document = plan.document
    const toStoryBook = destination.kind === 'storybook'
    const open = toStoryBook ? getOpenProject() : null
    if (toStoryBook && (!open || open.projectDir !== projectDir)) throw fail('UNAUTHORIZED', 'Sign in to StoryBook and open the pulled episode to deliver it.')
    const client = toStoryBook ? getClient(open.apiOrigin) : null

    if (!plan.prepared) {
      job.update({ phase: 'prepare' })
      plan.prepared = toStoryBook || prepare ? await prepareDelivery({ projectDir, document }) : { versionId: plan.versionId || 'export', report: null, versionCreated: null }
    }
    const versionId = plan.prepared.versionId
    const statePath = toStoryBook ? statePathFor(projectDir, versionId) : path.join(destination.folder, STATE_FILE)
    const state = (await readJson(statePath)) || { versionId, items: {}, events: {} }
    const items = plan.summary.renders
    job.update({ total: items.length, done: 0 })
    const results = []
    for (const item of items) {
      const key = `${item.preset}-${item.language}`
      const outputPath = toStoryBook ? path.join(projectDir, presetsModule.deliveryRelPath(versionId, item.preset, item.language)) : path.join(destination.folder, presetsModule.deliveryFileName(item.preset, item.language))
      const saved = state.items[key]
      if (saved?.finalized && toStoryBook) {
        results.push({ ...saved, reused: true })
        job.update({ done: results.length })
        continue
      }
      const { rendered, checked, preset } = await renderAndCheck({ job, item, projectDir, document, outputPath, presetsModule, policy: plan.context.policy })
      const entry = { preset: item.preset, language: item.language, aspect: preset.aspect, file: outputPath, captionsFile: rendered.captionsPath, thumbnailFile: rendered.thumbnailPath, durationSeconds: rendered.durationSeconds, qa: checked.qa, probe: checked.probe, checker: checked.checker, languageCheck: checked.languageCheck ?? null }
      if (toStoryBook && open?.events) await open.events.push({ type: 'qa_run', data: { versionId, pass: checked.qa.pass, issues: checked.qa.issues.length, tier: 'delivery' } })
      if (!checked.qa.pass) {
        state.items[key] = entry
        await writeJson(statePath, state)
        throw fail('QA_FAILED', `${key} failed QA: ${checked.qa.issues.filter((issue) => issue.severity >= 0.5).map((issue) => issue.detail).join(' ')}`, { render: key, qa: checked.qa, file: outputPath })
      }
      if (toStoryBook) {
        job.update({ phase: `upload ${key}` })
        const uploaded = await uploadRender({ client, sessionId: plan.context.session.sessionId, item, outputPath, rendered, checked, preset, signal: null })
        Object.assign(entry, uploaded, { finalized: true })
      }
      state.items[key] = entry
      await writeJson(statePath, state)
      results.push(entry)
      job.update({ done: results.length })
    }
    const deliveryQa = combineQa(results.map((entry) => entry.qa))

    if (!toStoryBook) {
      const report = { createdAt: now().toISOString(), projectDir, versionId, qa: deliveryQa, files: results.map(({ preset, language, file, captionsFile, durationSeconds, qa: fileQa, probe, checker, languageCheck }) => ({ preset, language, file: path.basename(file), captions: captionsFile ? path.basename(captionsFile) : null, durationSeconds, qa: fileQa, probe, checker, languageCheck })) }
      await writeJson(path.join(destination.folder, QA_REPORT_FILE), report)
      return { destination: 'folder', folder: destination.folder, files: report.files, qa: deliveryQa, qaReport: path.join(destination.folder, QA_REPORT_FILE) }
    }

    const primary = primaryOf(results)
    const report = { ...plan.prepared.report, explain: { ...plan.prepared.report.explain, qa: deliveryQa } }
    // Events go before deliver_edit: it closes the session, and the summary
    // StoryBook stores is computed from the events recorded by then. Ids are
    // kept in the job's state, so a retry re-sends the same events and
    // StoryBook stores them once.
    state.events.versionCreated = state.events.versionCreated || crypto.randomUUID()
    state.events.delivered = state.events.delivered || crypto.randomUUID()
    await writeJson(statePath, state)
    if (open?.events && plan.prepared.versionCreated) await open.events.push({ type: 'version_created', data: plan.prepared.versionCreated, clientEventId: state.events.versionCreated })
    if (open?.events) {
      const flushed = await open.events.push({ type: 'delivered', data: { renderIds: results.map((entry) => entry.renderId), durationSeconds: report.finalDuration }, clientEventId: state.events.delivered })
      if (flushed && flushed.sent === false) log('[studio] deliver: edit events are queued, not yet sent; the session summary may miss them')
    }
    job.update({ phase: 'deliver' })
    const episodeVersion = plan.episodeVersion ?? plan.context.session.episodeVersion
    let delivered
    try {
      delivered = await client.deliverEdit({
        sessionId: plan.context.session.sessionId,
        episodeVersion,
        renders: results.map((entry) => ({ renderId: entry.renderId, preset: entry.preset, language: entry.language, primary: entry === primary })),
        report,
        qa: deliveryQa,
      })
    } catch (error) {
      if (error?.code === 'TARGET_CHANGED') {
        let diff = null
        try {
          const check = await checkUpdates()
          diff = check?.summary ?? check?.status ?? null
        } catch (checkError) {
          diff = { error: checkError?.message || String(checkError) }
        }
        throw fail('TARGET_CHANGED', error.message, { ...(error.details || {}), diff, finalizedRenders: results.map((entry) => entry.renderId), retry: 'Apply the re-sync plan if you want the changes, then retry; finalized renders are reused.' })
      }
      throw error
    }
    open?.events?.stop?.()
    return { destination: 'storybook', delivered, renders: results.map(({ preset, language, renderId, bytes, durationSeconds, qa: fileQa, reused }) => ({ preset, language, renderId, bytes, durationSeconds, qa: fileQa, reused: Boolean(reused) })), primary: primary.renderId, report, qa: deliveryQa, versionId }
  }

  function startJob(plan) {
    const job = jobs.create('deliver', { destination: plan.destination.kind, presets: plan.summary.renders.map((entry) => `${entry.preset}-${entry.language}`) })
    jobPlans.set(job.id, plan)
    runDelivery(job, plan)
      .then((result) => job.complete(result))
      .catch((error) => {
        job.update({ failure: { code: error?.code || 'INTERNAL', details: error?.details ?? null } })
        job.fail(error)
      })
    return job.id
  }

  async function studioDeliver(args = {}, { snapshot = null } = {}) {
    const confirm = args.confirm === true
    const built = await buildSummary(args, { snapshot })
    const { summary, summaryHash } = built
    if (!confirm) {
      return {
        previewOnly: true,
        summary,
        summaryHash,
        confirmation: 'Nothing was rendered or sent. To deliver, the user confirms this summary on the Deliver screen, which issues a one-time token; studio_deliver with confirm:true is refused without it.',
      }
    }
    if (!consumeToken(args.confirmationToken, summaryHash)) {
      throw fail('FORBIDDEN', 'Delivery needs the user to confirm this exact summary on the Deliver screen. confirm:true without its one-time token (or with a token for another summary, used or expired) is refused.')
    }
    const overLimit = summary.renders.filter((entry) => entry.overMaxDuration)
    if (overLimit.length) throw fail('VALIDATION_FAILED', `Over the platform limit: ${overLimit.map((entry) => `${entry.preset} ${entry.estimatedDurationSeconds} s > ${entry.maxDuration} s`).join('; ')}.`)
    const jobId = startJob({ ...built, projectDir: summary.projectDir, destination: summary.destination })
    return { started: true, jobId, summaryHash }
  }

  // After TARGET_CHANGED (and the re-sync the user chose): deliver again
  // against the episode's current version, reusing finalized renders.
  async function retry(jobId) {
    const previous = jobs.get(jobId)
    const plan = jobPlans.get(jobId)
    if (!previous || !plan) throw fail('NOT_FOUND', 'No such delivery job.')
    if (previous.status !== 'failed') throw fail('VALIDATION_FAILED', 'Only a failed delivery can be retried.')
    const session = await readJson(path.join(plan.projectDir, 'storybook', 'session.json'))
    const currentVersion = previous.failure?.code === 'TARGET_CHANGED' ? Number(previous.failure.details?.currentVersion) : null
    const next = { ...plan, episodeVersion: Number.isFinite(currentVersion) ? currentVersion : session?.episodeVersion ?? plan.episodeVersion }
    return { jobId: startJob(next), episodeVersion: next.episodeVersion }
  }

  // ---- variants and reframe ----

  async function reframeTimelineClips({ timeline, document, projectDir, aspect, clipIds = null }) {
    const reframe = await studioModule('reframe.js')
    const assets = new Map((document.assets || []).map((asset) => [asset.id, asset]))
    const canvasWidth = Number(timeline.width) || 1080
    const canvasHeight = Number(timeline.height) || 1920
    const wanted = clipIds ? new Set(clipIds) : null
    const picture = (timeline.clips || []).filter((clip) => ['video', 'image'].includes(clip.type) && clip.enabled !== false && (!wanted || wanted.has(clip.id)))
    if (wanted && picture.length !== wanted.size) throw fail('VALIDATION_FAILED', `Not video or image clips on this timeline: ${[...wanted].filter((id) => !picture.some((clip) => clip.id === id)).join(', ')}.`)
    const results = []
    for (const clip of picture) {
      const asset = assets.get(clip.assetId) || {}
      const sourceWidth = Number(asset.width || asset.settings?.width) || 1920
      const sourceHeight = Number(asset.height || asset.settings?.height) || 1080
      const file = asset.absolutePath || (asset.path ? (path.isAbsolute(asset.path) ? asset.path : path.join(projectDir, asset.path)) : null)
      const { samples } = await detectClipSamples({ clip, file, sourceWidth, sourceHeight, ffmpegPath: getFfmpegPath() })
      const scene = Number.isInteger(clip.metadata?.semantic?.scene) ? clip.metadata.semantic.scene : null
      const result = reframe.reframeClip({ clip, samples, sourceWidth, sourceHeight, canvasWidth, canvasHeight, targetAspect: aspect, scene, previewOnly: false })
      results.push({ ...result, faces: samples.filter((sample) => sample.boxes.some((box) => box.kind === 'face')).length, keyframesSampled: samples.length })
    }
    return results
  }

  async function applyKeyframeSteps(steps, reason) {
    for (const step of steps) await performAction('set_clip_keyframes', { ...step, previewOnly: false, studioMeta: { reason } })
  }

  async function createVariant(args = {}, { snapshot = null } = {}) {
    const previewOnly = args.previewOnly !== false
    const projectDir = projectDirOf(snapshot)
    const document = await loadDocument(projectDir)
    const context = await episodeContext(projectDir)
    const variants = await studioModule('intents/variants.js')
    if (args.kind === 'short') {
      // FILM-2016's caption styling places the cues in the 9:16 safe area, in the brand's style.
      const { styleCaptionCues } = await studioModule('captions/style.js')
      const built = variants.buildShortVariant(document, { source: args.source || {}, presetName: args.preset || 'shorts_9x16', shortsCandidates: context.shortsCandidates, language: args.language || null, styleCues: styleCaptionCues, brand: context.brand || {}, policy: context.policy || {}, now })
      const card = {
        scene: null,
        heading: `Short (9:16) from ${built.range.from.kind === 'candidate' ? `the shorts candidate "${built.range.from.title || built.range.from.candidateId}"` : built.range.from.kind === 'hook' ? 'the strongest line' : 'the chosen range'}`,
        durationBefore: null,
        durationAfter: built.expectedDuration,
        targetDuration: built.maxDuration,
        changes: [
          { text: `New timeline ${built.timeline.name}, ${built.range.start}-${built.range.end} s of the master`, reason: built.durationNote, tool: 'studio_insert_timeline', step: 0 },
          { text: `Reframe ${built.pictureClipIds.length} picture clips to 9:16, following faces or the primary subject`, reason: 'Keeps the subject in a vertical frame; a clip with no subject is centred and flagged', tool: 'set_clip_keyframes', step: 1 },
          { text: `Re-place ${built.captionsPlaced} caption cues in the 9:16 safe area`, reason: 'Clear of the bottom 25% and right 15%, where the platforms draw their buttons', tool: 'update_caption_cues', step: 2 },
        ],
        touchesYourEdits: [],
        notes: built.overMaxDuration ? [built.durationNote] : [],
      }
      const response = { kind: 'short', previewOnly, cards: [card], timelineId: built.timeline.id, name: built.timeline.name, range: built.range, expectedDuration: built.expectedDuration, maxDuration: built.maxDuration, overMaxDuration: built.overMaxDuration, durationNote: built.durationNote, captionsPlaced: built.captionsPlaced, pictureClips: built.pictureClipIds.length, captionsPlacement: 'FILM-2016 styleCaptionCues: the brand caption style inside the 9:16 safe area (clear of the bottom 25% and right 15%)' }
      if (previewOnly) return { ...response, reframe: 'Applying detects faces and subjects on each clip\'s keyframes and adds set_clip_keyframes crop paths.' }
      const reframed = await reframeTimelineClips({ timeline: built.timeline, document, projectDir, aspect: built.timeline.studio.aspect })
      built.timeline.studio.reframeWarnings = reframed.filter((entry) => entry.warning).map((entry) => entry.warning)
      if (server()?.performAction) {
        await performAction('studio_insert_timeline', { timeline: built.timeline, activate: true, previewOnly: false, studioMeta: { reason: `Short variant (${built.range.from.kind}) for ${args.preset || 'shorts_9x16'}` } })
        await applyKeyframeSteps(reframed.map((entry) => entry.arguments), 'Reframe: follow the subject in 9:16')
      } else {
        // No editor window (a headless run): write the variant into the saved project.
        variants.embedKeyframes(built.timeline, reframed.map((entry) => entry.arguments))
        document.timelines.push(built.timeline)
        await writeJson(path.join(projectDir, PROJECT_FILE), document)
        await removeLegacyProjectFile(projectDir)
      }
      return {
        ...response,
        reframe: reframed.map(({ clipId, path: cropPath, largestStep, warning, faces, keyframesSampled }) => ({ clipId, detected: cropPath.detected, faces, keyframesSampled, largestStepFraction: round3(largestStep), warning })),
        qaWarnings: built.timeline.studio.reframeWarnings,
      }
    }
    if (args.kind === 'hook') {
      const built = variants.buildHookVariants(document, { variants: args.variants ?? 3, language: args.language || null, now })
      const summary = built.variants.map(({ timeline, rank, bite, range }) => ({ timelineId: timeline.id, name: timeline.name, rank, range, bite }))
      const cards = summary.map((entry) => ({
        scene: null,
        heading: `Hook ${entry.rank}: opens on "${String(entry.bite.text || entry.bite.clipId).slice(0, 60)}"`,
        durationBefore: null,
        durationAfter: Math.round((entry.range[1] - entry.range[0]) * 1000) / 1000,
        targetDuration: 5,
        changes: [{ text: `New timeline ${entry.name}, ${entry.range[0]}-${entry.range[1]} s of the master`, reason: `${built.signal === 'energy' ? 'Loudest' : 'Strongest'} line, importance ${entry.bite.importance}`, tool: 'studio_insert_timeline', step: entry.rank - 1 }],
        touchesYourEdits: [],
        notes: [],
      }))
      if (previewOnly) return { kind: 'hook', previewOnly, signal: built.signal, requested: built.requested, variants: summary, cards }
      for (const { timeline } of built.variants) {
        if (server()?.performAction) await performAction('studio_insert_timeline', { timeline, activate: false, previewOnly: false, studioMeta: { reason: `Hook opening ${timeline.studio.hookIndex}` } })
        else document.timelines.push(timeline)
      }
      if (!server()?.performAction) {
        await writeJson(path.join(projectDir, PROJECT_FILE), document)
        await removeLegacyProjectFile(projectDir)
      }
      const files = []
      if (args.exportFiles !== false) {
        const presets = await studioModule('delivery/presets.js')
        const master = variants.masterTimeline(document)
        const versionId = master.studio?.currentVersion || document.studio?.currentVersion || 'latest'
        for (const { timeline } of built.variants) {
          const preset = presets.resolvePreset('youtube_16x9', { timeline, policy: context.policy })
          const file = path.join(projectDir, 'renders', String(versionId), 'hooks', `hook-${timeline.studio.hookIndex}-${args.language || master.studio?.language || 'en'}.mp4`)
          const withVariant = { ...document, timelines: [...document.timelines.filter((entry) => entry.id !== timeline.id), timeline] }
          const rendered = await render({ project: withVariant, projectDir, timelineId: timeline.id, preset: { ...preset, captionPolicy: 'burn' }, language: args.language || null, outputPath: file, ffmpegPath: getFfmpegPath() })
          files.push({ timelineId: timeline.id, file, durationSeconds: rendered.durationSeconds })
        }
      }
      return { kind: 'hook', previewOnly, signal: built.signal, requested: built.requested, variants: summary, cards, files }
    }
    if (args.kind === 'language') return createLanguageVariant(args, { previewOnly, projectDir, document, context })
    throw fail('VALIDATION_FAILED', 'kind is short, hook or language.')
  }

  // FILM-2019 AC3: kind language. The dubbed lines in the pulled package
  // (re-sync, FILM-2011, brings them in) become a Dialogue (<lang>) lane and
  // a Captions (<lang>) track on the master (localization/lanes.js); applied,
  // each preset is rendered in that language and QA-checked, including the
  // spoken-language check (AC5), into renders/<version>/languages/.
  async function dubProbes(pkg, language, projectDir) {
    const { planDownloads } = require('./pull')
    const { createProbe } = require('./probe')
    const pulled = (await readJson(path.join(projectDir, 'storybook', 'probed-assets.json'))) || {}
    const keys = new Set((pkg.dubbed || []).filter((entry) => entry.language === language).flatMap((entry) => entry.lines.map((line) => line.audio?.key).filter(Boolean)))
    const probe = createProbe(resolveBinaries({ ffmpegPath: getFfmpegPath(), ffprobePath: getFfprobePath() }).ffprobePath)
    const probes = new Map()
    for (const item of planDownloads(pkg).filter((entry) => keys.has(entry.key))) {
      const known = pulled[item.key]
      if (known?.path && known.duration != null) {
        probes.set(item.key, known)
        continue
      }
      const absolute = path.join(projectDir, item.relativePath)
      if (!fs.existsSync(absolute)) continue
      try {
        const result = await probe(absolute)
        probes.set(item.key, { path: item.relativePath, absolutePath: absolute, duration: result.duration, hasAudio: result.hasAudio, codecs: { video: null, audio: result.audioCodec } })
      } catch (error) {
        log(`[studio] language variant: ffprobe failed for ${item.relativePath}: ${error?.message || error}`)
      }
    }
    return probes
  }

  async function createLanguageVariant(args, { previewOnly, projectDir, document, context }) {
    const lanes = await studioModule('localization/lanes.js')
    const pkg = await readJson(path.join(projectDir, 'storybook', 'package.json'))
    if (!pkg?.episode) throw fail('NOT_FOUND', 'This project was not pulled from StoryBook: a language variant needs the dubbed lines of its package.')
    const language = String(args.language || '')
    const lane = lanes.buildLanguageLane({ document, pkg, language, probes: await dubProbes(pkg, language, projectDir), brand: context.brand, policy: context.policy })
    const presetNames = [...new Set(Array.isArray(args.presets) && args.presets.length ? args.presets : ['youtube_16x9'])]
    const presetsModule = await studioModule('delivery/presets.js')
    for (const name of presetNames) presetsModule.presetFor(name)
    const card = {
      scene: null,
      heading: `${language} language lane from StoryBook's dub`,
      durationBefore: null,
      durationAfter: null,
      targetDuration: null,
      changes: [
        { text: `Dialogue (${language}): ${lane.lines.placed} dubbed lines at their lines' starts${lane.lines.fitted ? `, ${lane.lines.fitted} speed-fitted to their slot` : ''}`, reason: 'One master timeline: a render in this language plays this lane; the others stay muted', tool: 'studio_apply_language_lane', step: 0 },
        ...(lane.captions ? [{ text: `Captions (${language}): ${lane.captions.cueCount} cues from the dubbed text`, reason: `Brand caption style inside the ${lane.aspect} safe area`, tool: 'studio_apply_language_lane', step: 0 }] : []),
        ...(lane.removeTrackIds.length ? [{ text: `Replaces the ${language} lane already on the master (${lane.removeClipIds.length} clips)`, reason: 'Re-running a language variant rebuilds its lane', tool: 'studio_apply_language_lane', step: 0 }] : []),
      ],
      touchesYourEdits: [],
      notes: [
        ...lane.overruns.slice(0, 5).map((entry) => `A dubbed line runs ${entry.overrunSeconds} s past its slot at ${entry.speed}x; it is placed whole, not trimmed.`),
        ...(lane.lines.offline ? [`${lane.lines.offline} dubbed line(s) are not downloaded and are placed offline.`] : []),
        'Graphics are not refit for this language: compositions (FILM-2018) are not in this build.',
      ],
    }
    const response = {
      kind: 'language',
      previewOnly,
      language,
      timelineId: lane.timelineId,
      dubbedVersionId: lane.dubbedVersionId,
      lines: lane.lines,
      captions: lane.captions,
      overruns: lane.overruns,
      tracks: lane.tracks.map(({ id, name, type, role, language: trackLanguage }) => ({ id, name, type, role: role ?? null, language: trackLanguage })),
      presets: presetNames,
      cards: [card],
    }
    if (previewOnly) return response
    let applied = document
    if (server()?.performAction) {
      await performAction('studio_apply_language_lane', { lane, previewOnly: false, studioMeta: { reason: `Language lane: ${language}` } })
      applied = await loadDocument(projectDir)
    } else {
      applied = { ...document, timelines: document.timelines.map((timeline) => (timeline.id === lane.timelineId ? lanes.applyLanguageLane(timeline, lane) : timeline)), assets: lanes.mergeLaneAssets(document.assets, lane.assets) }
      await writeJson(path.join(projectDir, PROJECT_FILE), applied)
      await removeLegacyProjectFile(projectDir)
    }
    if (args.exportFiles === false) return { ...response, applied: true, renders: [] }
    const contracts = await studioModule('contracts/render-presets.mjs')
    const master = applied.timelines.find((timeline) => timeline.id === lane.timelineId)
    const versionId = master?.studio?.currentVersion || applied.studio?.currentVersion || 'latest'
    const renders = []
    for (const name of presetNames) {
      const { timeline } = timelineForPreset(applied, { ...presetsModule.presetFor(name), name, aspect: contracts.RENDER_PRESETS[name].aspect ?? null })
      const preset = presetsModule.resolvePreset(name, { timeline, policy: context.policy })
      const outputPath = path.join(projectDir, 'renders', String(versionId), 'languages', presetsModule.deliveryFileName(name, language))
      const rendered = await render({ project: applied, projectDir, timelineId: timeline.id, preset, language, outputPath, ffmpegPath: getFfmpegPath() })
      const checked = await qa({ file: outputPath, preset, expectedDuration: rendered.durationSeconds, warnings: timeline.studio?.reframeWarnings || [], ffmpegPath: getFfmpegPath(), ffprobePath: getFfprobePath(), project: applied, timelineId: timeline.id, language, detectLanguage })
      renders.push({ preset: name, language, timelineId: timeline.id, file: outputPath, captionsFile: rendered.captionsPath ?? null, durationSeconds: rendered.durationSeconds, captionCues: rendered.captionCues ?? null, qa: checked.qa, languageCheck: checked.languageCheck ?? null })
    }
    return { ...response, applied: true, renders, qa: combineQa(renders.map((entry) => entry.qa)) }
  }

  // Expert tools on the active timeline (snapshot.currentTimeline).
  async function autoReframe(args = {}, { snapshot }) {
    const projectDir = projectDirOf(snapshot)
    const timeline = snapshot?.currentTimeline
    if (!timeline) throw fail('VALIDATION_FAILED', 'No active timeline.')
    const presets = await studioModule('delivery/presets.js')
    const aspect = args.aspect || presets.aspectOf(Number(timeline.width) || 1920, Number(timeline.height) || 1080) || '16:9'
    const document = { assets: snapshot.assets || [] }
    const results = await reframeTimelineClips({ timeline, document, projectDir, aspect, clipIds: Array.isArray(args.clipIds) && args.clipIds.length ? args.clipIds : null })
    const calls = results.map((entry) => ({ tool: 'set_clip_keyframes', arguments: { ...entry.arguments, previewOnly: args.previewOnly !== false } }))
    if (args.previewOnly !== false) return { previewOnly: true, aspect, clips: results.map(({ clipId, path: cropPath, largestStep, warning }) => ({ clipId, detected: cropPath.detected, points: cropPath.points, largestStepFraction: round3(largestStep), warning })), calls }
    await applyKeyframeSteps(results.map((entry) => entry.arguments), `Auto reframe to ${aspect}`)
    return { applied: true, aspect, clips: results.map(({ clipId, path: cropPath, largestStep, warning }) => ({ clipId, detected: cropPath.detected, largestStepFraction: round3(largestStep), warning })), qaWarnings: results.filter((entry) => entry.warning).map((entry) => entry.warning) }
  }

  async function focalPoint(args = {}, { snapshot }) {
    const timeline = snapshot?.currentTimeline
    const clip = (timeline?.clips || []).find((entry) => entry.id === args.clipId)
    if (!clip || !['video', 'image'].includes(clip.type)) throw fail('VALIDATION_FAILED', `${args.clipId} is not a video or image clip on the active timeline.`)
    const reframe = await studioModule('reframe.js')
    const presets = await studioModule('delivery/presets.js')
    const asset = (snapshot.assets || []).find((entry) => entry.id === clip.assetId) || {}
    const canvasWidth = Number(timeline.width) || 1920
    const canvasHeight = Number(timeline.height) || 1080
    const aspect = args.aspect || presets.aspectOf(canvasWidth, canvasHeight) || '16:9'
    const step = reframe.focalPointKeyframes({ clip, x: Number(args.x), y: Number(args.y), sourceWidth: Number(asset.width) || 1920, sourceHeight: Number(asset.height) || 1080, canvasWidth, canvasHeight, targetAspect: aspect, previewOnly: args.previewOnly !== false })
    if (args.previewOnly !== false) return { previewOnly: true, aspect, call: { tool: 'set_clip_keyframes', arguments: step } }
    await applyKeyframeSteps([step], `Focal point (${args.x}, ${args.y})`)
    return { applied: true, aspect, clipId: clip.id }
  }

  return {
    studioDeliver,
    createVariant,
    issueConfirmationToken,
    summary: (args, ctx) => buildSummary(args, ctx).then(({ summary, summaryHash }) => ({ summary, summaryHash })),
    retry,
    getJob: (jobId) => jobs.get(jobId),
    expertTools: { set_auto_reframe: autoReframe, set_focal_point: focalPoint },
    // For tests and headless runs.
    _startJob: startJob,
    _buildSummary: buildSummary,
  }
}

module.exports = {
  createStudioDeliver,
  renderContentHash,
  putFile,
  DELIVER_INPUT_SCHEMA,
  CREATE_VARIANT_INPUT_SCHEMA,
  AUTO_REFRAME_INPUT_SCHEMA,
  FOCAL_POINT_INPUT_SCHEMA,
  TOKEN_TTL_MS,
}
