// Shared by the FILM-2017 delivery tests: a pulled project on disk (the
// 20-shot rough cut), a fake StoryBook MCP server that honours FILM-2003's
// exact contract (request_render_upload, the presigned PUT, finalize_render,
// deliver_edit with TARGET_CHANGED), and a stand-in renderer.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { RequestRenderUploadSchema, FinalizeRenderSchema, DeliveryPackageSchema } from '../../../src/studio/contracts/delivery-package.schema.mjs'
import { buildDeliveryReport, versionCreatedData } from '../../../src/studio/delivery/deliveryReport.js'

const require = createRequire(import.meta.url)
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'))

export const SESSION_ID = '0b9c5a43-6a3e-4c9e-9b8e-2f1d4c7a9e11'

export function makePulledProject(t, { episodeVersion = 9 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-deliver-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const project = fixture('rough-cut/20-shots.snapshot.json').project
  const pkg = fixture('edit-package/20-shots.json')
  fs.writeFileSync(path.join(dir, 'project.storybookstudio'), JSON.stringify(project))
  fs.mkdirSync(path.join(dir, 'storybook'))
  fs.writeFileSync(path.join(dir, 'storybook', 'package.json'), JSON.stringify(pkg))
  fs.writeFileSync(path.join(dir, 'storybook', 'session.json'), JSON.stringify({ apiOrigin: 'http://storybook.test', episodeId: pkg.episode.id, sessionId: SESSION_ID, episodeVersion }))
  return { dir, project, pkg }
}

// What studio_prepare_delivery returns in the app, from the same pure code.
export function fakePrepare({ dir }) {
  const document = JSON.parse(fs.readFileSync(path.join(dir, 'project.storybookstudio'), 'utf8'))
  const versions = [
    { id: 'v1', name: 'Rough cut', parent: null, opRange: [1, 3], createdBy: 'ai', createdAt: '2026-10-04T19:00:00.000Z', prompt: null },
    { id: 'v2', name: 'Delivered', parent: 'v1', opRange: [4, null], createdBy: 'user', createdAt: '2026-10-04T19:30:00.000Z', prompt: null },
  ]
  const log = [
    { op: 1, by: 'ai', tool: 'studio_create_version', args: { versionId: 'v1' }, inverse: null },
    { op: 2, by: 'ai', tool: 'trim_clips', args: {}, inverse: null, reason: 'Tighter' },
    { op: 3, by: 'user', tool: 'move_clips', args: {}, inverse: null },
    { op: 4, by: 'user', tool: 'studio_create_version', args: { versionId: 'v2' }, inverse: null },
  ]
  return async () => {
    const report = buildDeliveryReport({ log, versions, deliveredVersionId: 'v2', before: document, after: document })
    return { versionId: 'v2', report, versionCreated: versionCreatedData({ version: versions[1], versions, log, document, durationSeconds: report.finalDuration }) }
  }
}

// A stand-in renderer: a file of a known size, a thumbnail, a sidecar.
export const fakeRender = (bytes = 4096) => async ({ outputPath, preset, project, timelineId }) => {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, crypto.randomBytes(bytes))
  const thumbnailPath = outputPath.replace(/\.mp4$/, '.jpg')
  fs.writeFileSync(thumbnailPath, crypto.randomBytes(300))
  let captionsPath = null
  if (preset.captionPolicy === 'sidecar') {
    captionsPath = outputPath.replace(/\.mp4$/, '.vtt')
    fs.writeFileSync(captionsPath, 'WEBVTT\n\n1\n00:00:00.400 --> 00:00:02.000\nLine 1\n')
  }
  const timeline = project.timelines.find((entry) => entry.id === timelineId)
  const durationSeconds = Math.max(...timeline.clips.filter((c) => c.type === 'video').map((c) => c.startTime + c.duration))
  return { outputPath, durationSeconds, thumbnailPath, captionsPath }
}

export const passingQa = async ({ file, expectedDuration }) => ({
  qa: { pass: true, issues: [] },
  probe: { durationSeconds: expectedDuration, videoCodec: 'h264', audioCodec: 'aac', bytes: fs.statSync(file).size },
  checker: 'test',
})

const ok = (structuredContent, text = 'ok') => ({ content: [{ type: 'text', text }], structuredContent })
const toolError = (code, message, details) => ({
  isError: true,
  content: [{ type: 'text', text: `${code}: ${message}` }],
  structuredContent: { code, message, retryable: false, ...(details ? { details } : {}) },
})

// StoryBook as FILM-2003 built it, in memory. `currentVersion` is the
// episode's version; deliver_edit with another one is TARGET_CHANGED.
export async function fakeStoryBook(t, { currentVersion = 9 } = {}) {
  const state = { currentVersion, renders: new Map(), puts: [], calls: [], events: [], delivered: null }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname.startsWith('/put/')) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      const id = url.pathname.slice('/put/'.length)
      const signed = state.renders.get(id.split('.')[0])
      const slot = id.endsWith('.thumb') ? signed?.thumbnail : id.endsWith('.vtt') ? signed?.captions : signed
      const headerOk = slot && Object.entries(slot.headers).every(([name, value]) => req.headers[name.toLowerCase()] === value)
      state.puts.push({ id, method: req.method, bytes: body.length, expected: slot?.bytes, headerOk })
      if (req.method !== 'PUT' || !slot || !headerOk || body.length !== slot.bytes) {
        res.writeHead(403).end('SignatureDoesNotMatch')
        return
      }
      slot.uploaded = body.length
      res.writeHead(200).end()
      return
    }
    const mcp = new McpServer({ name: 'storybook-fake', version: '0' })
    const { z } = require('zod')
    // The SDK strips keys a shape does not name; every key is any() so the
    // handler sees the raw input and the contract's own schema judges it.
    const add = (name, keys, handler) =>
      mcp.registerTool(name, { inputSchema: Object.fromEntries(keys.map((key) => [key, z.any().optional()])) }, async (input) => {
        state.calls.push({ name, input })
        return handler(input)
      })
    add('request_render_upload', ['sessionId', 'preset', 'language', 'aspect', 'bytes', 'contentType', 'thumbnail', 'captions'], (input) => {
      const parsed = RequestRenderUploadSchema.safeParse(input)
      if (!parsed.success) return toolError('VALIDATION_FAILED', parsed.error.issues[0].message)
      const renderId = crypto.randomUUID()
      const base = `http://127.0.0.1:${server.address().port}/put/${renderId}`
      const key = `projects/p/episodes/e/renders/${renderId}.mp4`
      const record = { renderId, key, bytes: parsed.data.bytes, headers: { 'Content-Type': 'video/mp4', 'x-amz-meta-render': renderId }, status: 'uploading', preset: parsed.data.preset, language: parsed.data.language }
      if (parsed.data.thumbnail) record.thumbnail = { key: `${key}.jpg`, bytes: parsed.data.thumbnail.bytes, headers: { 'Content-Type': parsed.data.thumbnail.contentType } }
      if (parsed.data.captions) record.captions = { key: `${key}.vtt`, bytes: parsed.data.captions.bytes, headers: { 'Content-Type': 'text/vtt' } }
      state.renders.set(renderId, record)
      return ok({
        renderId,
        key,
        uploadUrl: base,
        method: 'PUT',
        headers: record.headers,
        expiresIn: 3600,
        ...(record.thumbnail ? { thumbnail: { key: record.thumbnail.key, uploadUrl: `${base}.thumb`, method: 'PUT', headers: record.thumbnail.headers, expiresIn: 3600 } } : {}),
        ...(record.captions ? { captions: { key: record.captions.key, uploadUrl: `${base}.vtt`, method: 'PUT', headers: record.captions.headers, expiresIn: 3600 } } : {}),
      })
    })
    add('finalize_render', ['renderId', 'durationSeconds', 'qa', 'thumbnailKey', 'captionsKey'], (input) => {
      const parsed = FinalizeRenderSchema.safeParse(input)
      if (!parsed.success) return toolError('VALIDATION_FAILED', parsed.error.issues[0].message)
      const render = state.renders.get(parsed.data.renderId)
      if (!render) return toolError('NOT_FOUND', 'No such render')
      if (render.uploaded !== render.bytes) {
        render.status = 'failed'
        return toolError('VALIDATION_FAILED', 'The stored file is not the size it was signed for')
      }
      if (parsed.data.thumbnailKey && parsed.data.thumbnailKey !== render.thumbnail?.key) return toolError('VALIDATION_FAILED', 'thumbnailKey is not this render\'s')
      if (parsed.data.captionsKey && parsed.data.captionsKey !== render.captions?.key) return toolError('VALIDATION_FAILED', 'captionsKey is not this render\'s')
      Object.assign(render, { status: 'ready', qa: parsed.data.qa, durationSeconds: parsed.data.durationSeconds, thumbnailKey: parsed.data.thumbnailKey ?? null, captionsKey: parsed.data.captionsKey ?? null })
      return ok({ renderId: render.renderId, status: 'ready' })
    })
    add('deliver_edit', ['sessionId', 'episodeVersion', 'renders', 'report', 'qa'], (input) => {
      const parsed = DeliveryPackageSchema.safeParse(input)
      if (!parsed.success) return toolError('VALIDATION_FAILED', `${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}`)
      if (parsed.data.episodeVersion !== state.currentVersion) {
        return toolError('TARGET_CHANGED', `The episode changed (now version ${state.currentVersion})`, { currentVersion: state.currentVersion, expectedVersion: parsed.data.episodeVersion, etag: null })
      }
      const notReady = parsed.data.renders.filter((render) => state.renders.get(render.renderId)?.status !== 'ready')
      if (notReady.length) return toolError('VALIDATION_FAILED', 'renders not ready', { renders: notReady })
      state.delivered = parsed.data
      state.currentVersion += 2
      return ok({ ok: true, episodeStatus: 'ready', primaryRenderId: parsed.data.renders.find((r) => r.primary).renderId })
    })
    add('record_edit_events', ['sessionId', 'events'], (input) => {
      state.events.push(...input.events)
      return ok({ recorded: input.events.length })
    })
    add('close_edit_session', ['sessionId'], () => ok({ closed: true }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close()
      mcp.close()
    })
    await mcp.connect(transport)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    await transport.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  state.origin = `http://127.0.0.1:${server.address().port}`
  return state
}

export async function waitForJob(jobs, jobId, timeoutMs = 20000) {
  const start = Date.now()
  for (;;) {
    const job = jobs.get(jobId)
    if (job && job.status !== 'running') return job
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} still running: ${JSON.stringify(job)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
