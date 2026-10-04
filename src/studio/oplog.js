// The operation log (FILM-2012 AC5, AC8): one JSON line per applied
// operation in <project>/edits/oplog.jsonl, written by a wrapper around
// runMcpAction (by: 'ai') and around the timeline/assets store mutators
// (by: 'user'). An operation is applied when it changed the project
// document; a preview, a read or a refused write changes nothing and logs
// nothing. Every line carries the inverse patch that undoes it. Velorn's
// in-memory undo stays the fast path; this log is the durable one.
// Pure module: no Electron, no stores; the sink and document are injected.
import { z } from 'zod'

import { applyPatch, clipsById, diffDocuments, touchedClipIds } from './documentDiff.js'

export const OPLOG_PATH = 'edits/oplog.jsonl'
export const APPLY_PATCH_TOOL = 'studio_apply_patch'
export const CREATE_VERSION_TOOL = 'studio_create_version'
export const RESTORE_VERSION_TOOL = 'studio_restore_version'
export const RESTORE_SNAPSHOT_TOOL = 'studio_restore_snapshot'
export const DEFAULT_COALESCE_MS = 400

const By = z.enum(['ai', 'user'])

export const OpLogEntrySchema = z
  .object({
    op: z.number().int().positive(),
    ts: z.string().datetime(),
    by: By,
    session: z.string().nullable(),
    tool: z.string().min(1),
    args: z.unknown(),
    inverse: z.object({ tool: z.string(), args: z.unknown() }).nullable(),
    reason: z.string().nullable(),
    scene: z.number().int().nonnegative().nullable(),
    versionId: z.string().nullable(),
  })
  .strict()

export function parseOpLog(text) {
  const entries = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // A torn line from a crash mid-append; the entries around it stand.
    }
  }
  return entries
}

export function createOpLog({ sink, session = null, clock = () => new Date(), path = OPLOG_PATH } = {}) {
  if (!sink) throw new Error('createOpLog needs a sink')
  const appSession = session ?? `session-${clock().toISOString()}`
  const flushHooks = new Set()
  const activities = []
  let entries = []
  let nextOp = 1
  let currentVersionId = null
  let needsNewline = false
  let chain = Promise.resolve()

  return {
    session: appSession,
    get activity() {
      return activities.at(-1) ?? null
    },
    async load() {
      const text = await sink.readText(path)
      if (!text) return
      entries = parseOpLog(text)
      needsNewline = !text.endsWith('\n')
      nextOp = entries.reduce((max, entry) => Math.max(max, Number(entry.op) || 0), 0) + 1
      currentVersionId = entries.at(-1)?.versionId ?? null
    },
    entries: () => [...entries],
    lastOpId: () => nextOp - 1,
    versionId: () => currentVersionId,
    setVersionId(id) {
      currentVersionId = id ?? null
    },
    append(partial) {
      const entry = {
        op: nextOp,
        ts: clock().toISOString(),
        by: partial.by,
        session: partial.session ?? appSession,
        tool: partial.tool,
        args: partial.args ?? {},
        inverse: partial.inverse ?? null,
        reason: partial.reason ?? null,
        scene: partial.scene ?? null,
        versionId: partial.versionId !== undefined ? partial.versionId : currentVersionId,
      }
      OpLogEntrySchema.parse(entry)
      nextOp += 1
      entries.push(entry)
      const line = `${needsNewline ? '\n' : ''}${JSON.stringify(entry)}\n`
      needsNewline = false
      const write = chain.then(() => sink.appendText(path, line))
      chain = write.catch(() => {})
      return write.then(() => entry)
    },
    idle: () => chain,
    async sync() {
      await chain
      await sink.sync(path)
    },
    addFlushHook(hook) {
      flushHooks.add(hook)
      return () => flushHooks.delete(hook)
    },
    async flushPending() {
      for (const hook of [...flushHooks]) await hook()
    },
    // Marks store mutations made inside `fn` as part of an MCP action or an
    // internal load, so the hand-edit logger does not log them again.
    async runAs(activity, fn) {
      activities.push(activity)
      try {
        return await fn()
      } finally {
        activities.splice(activities.lastIndexOf(activity), 1)
      }
    },
  }
}

const patchInverse = (patch) => ({ tool: APPLY_PATCH_TOOL, args: { patch } })

export function applyInverse(document, inverse) {
  if (inverse?.tool !== APPLY_PATCH_TOOL) {
    throw new Error(`Inverse ${inverse?.tool || 'none'} is not a document patch; restore it through versions.js.`)
  }
  return applyPatch(document, inverse.args.patch)
}

// The scene an operation belongs to: the scene of the clips its arguments
// name (a trim, not the ripple it caused), else of every clip it touched,
// when that is a single scene.
export function sceneOfChange(patch, before, after, args = null) {
  const scenes = new Set()
  const beforeClips = clipsById(before)
  const afterClips = clipsById(after)
  const touched = [...touchedClipIds(patch)]
  const argsText = JSON.stringify(args ?? {})
  const named = touched.filter((id) => argsText.includes(`"${id}"`))
  for (const id of named.length > 0 ? named : touched) {
    const clip = (afterClips.get(id) || beforeClips.get(id))?.clip
    const scene = clip?.metadata?.semantic?.scene
    if (Number.isInteger(scene)) scenes.add(scene)
  }
  return scenes.size === 1 ? [...scenes][0] : null
}

// runMcpAction(action, payload) -> the same, logged. Callers that know why a
// step runs (FILM-2013's compiler) put {reason, scene, session, by} under
// payload.studioMeta; the wrapper strips it before Velorn's handler sees it.
export function wrapMcpActionRunner(run, { oplog, getDocument, by = 'ai' } = {}) {
  return async function runMcpActionWithOpLog(action, payload = {}) {
    const { studioMeta = null, ...args } = payload || {}
    if (!oplog || !getDocument || oplog.activity) return run(action, args)
    if (args.previewOnly === true) return oplog.runAs('mcp', () => run(action, args))

    await oplog.flushPending()
    const before = getDocument()
    let result
    let failure = null
    try {
      result = await oplog.runAs('mcp', () => run(action, args))
    } catch (error) {
      failure = error
    }
    if (!failure && result?.previewOnly === true) return result

    const after = getDocument()
    const inversePatch = diffDocuments(after, before)
    if (inversePatch) {
      await oplog.append({
        by: studioMeta?.by === 'user' ? 'user' : by,
        session: studioMeta?.session ?? null,
        tool: action,
        args,
        inverse: patchInverse(inversePatch),
        reason: studioMeta?.reason ?? null,
        scene: Number.isInteger(studioMeta?.scene) ? studioMeta.scene : sceneOfChange(inversePatch, before, after, args),
      })
    }
    if (failure) throw failure
    return result
  }
}

// Hand edits: wraps the listed mutators of zustand-like stores
// ({getState, setState}). Nested mutator calls are one edit; edits within
// `quietMs` of each other (a drag, a slider) coalesce into one line, which is
// written when the user pauses, before the next AI op, or at a version
// boundary (flushPending). Returns detach().
export function attachUserEditLogger({ stores, oplog, getDocument, quietMs = DEFAULT_COALESCE_MS, timers = globalThis }) {
  let depth = 0
  let pending = null
  const restores = []

  const flush = () => {
    if (!pending) return Promise.resolve()
    const edit = pending
    pending = null
    if (edit.timer != null) timers.clearTimeout(edit.timer)
    const inversePatch = diffDocuments(edit.after, edit.before)
    if (!inversePatch) return Promise.resolve()
    return oplog.append({
      by: 'user',
      tool: edit.mutators[0],
      args: { store: edit.label, mutators: edit.mutators },
      inverse: patchInverse(inversePatch),
      reason: null,
      scene: sceneOfChange(inversePatch, edit.before, edit.after),
    })
  }

  const record = (name, label, before) => {
    const after = getDocument()
    if (!pending) {
      if (after === before || !diffDocuments(before, after)) return
      pending = { before, after, mutators: [name], label, timer: null }
    } else {
      pending.after = after
      if (!pending.mutators.includes(name)) pending.mutators.push(name)
    }
    if (pending.timer != null) timers.clearTimeout(pending.timer)
    pending.timer = timers.setTimeout(() => { flush() }, quietMs)
  }

  const wrap = (name, label, original) => function wrappedMutator(...args) {
    if (depth > 0 || oplog.activity) return original.apply(this, args)
    const before = getDocument()
    depth += 1
    let result
    try {
      result = original.apply(this, args)
    } catch (error) {
      depth -= 1
      record(name, label, before)
      throw error
    }
    depth -= 1
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => { record(name, label, before); return value },
        (error) => { record(name, label, before); throw error },
      )
    }
    record(name, label, before)
    return result
  }

  for (const { store, mutators, label } of stores) {
    const state = store.getState()
    const originals = {}
    const wrapped = {}
    for (const name of mutators) {
      if (typeof state[name] !== 'function') continue
      originals[name] = state[name]
      wrapped[name] = wrap(name, label, state[name])
    }
    store.setState(wrapped)
    restores.push(() => store.setState(originals))
  }
  const removeHook = oplog.addFlushHook(flush)

  return function detach() {
    removeHook()
    flush()
    for (const restore of restores) restore()
  }
}

// AC8: the clips whose most recent edit since `versionId` began is the
// user's. FILM-2013's compiler lists these under "touches your edits" or
// leaves them alone. With no version (or an unknown one) the whole log counts.
export function clipsTouchedByUserSince(log, versionId) {
  let start = 0
  if (versionId) {
    const boundary = log.findIndex((entry) => entry.tool === CREATE_VERSION_TOOL && entry.args?.versionId === versionId)
    if (boundary >= 0) start = boundary + 1
  }
  const lastBy = new Map()
  for (const entry of log.slice(start)) {
    for (const id of touchedClipIds(entry.inverse?.args?.patch)) lastBy.set(id, entry.by)
  }
  return [...lastBy].filter(([, by]) => by === 'user').map(([id]) => id).sort()
}

// The clip.metadata.origin each clip would carry: who last changed it, in
// which op and version. The review screen (FILM-2015) diffs on this.
export function lastOriginByClip(log) {
  const origins = new Map()
  for (const entry of log) {
    for (const id of touchedClipIds(entry.inverse?.args?.patch)) {
      origins.set(id, { versionId: entry.versionId ?? null, opId: entry.op, by: entry.by })
    }
  }
  return origins
}
