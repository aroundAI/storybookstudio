// Named versions (FILM-2012 AC6). A version is a named point in the edit: the
// document as it stood when the version was created (edits/snapshots/<id>.json)
// and the range of op-log lines made while it was current. Creating a version
// closes the previous version's range. Restoring loads one snapshot (no replay,
// O(1) in the length of the log) and appends a restore op whose inverse names
// a snapshot of what it replaced, so a restore can itself be undone.
// Velorn's in-memory undo is not touched. Pure module: no Electron, no stores.
import { CREATE_VERSION_TOOL, RESTORE_SNAPSHOT_TOOL, RESTORE_VERSION_TOOL } from './oplog.js'

export const VERSIONS_PATH = 'edits/versions.json'
export const VERSIONS_FILE_SCHEMA = 'studio-versions/1'
export const snapshotPathFor = (id) => `edits/snapshots/${id}.json`

const copy = (record) => ({ ...record, opRange: [...record.opRange] })

export function createVersionStore({ sink, oplog, getDocument, setDocument, clock = () => new Date() }) {
  let versions = []
  let currentId = null

  const writeVersionsFile = () => sink.writeText(
    VERSIONS_PATH,
    `${JSON.stringify({ schema: VERSIONS_FILE_SCHEMA, current: currentId, versions }, null, 2)}\n`,
  )

  const nextId = () => {
    const highest = versions.reduce((max, { id }) => Math.max(max, Number(/^v(\d+)$/.exec(id)?.[1]) || 0), 0)
    return `v${highest + 1}`
  }

  const find = (id) => {
    const record = versions.find((version) => version.id === id)
    if (!record) throw new Error(`Unknown version ${id}`)
    return record
  }

  return {
    async load() {
      const text = await sink.readText(VERSIONS_PATH)
      if (!text) return
      const file = JSON.parse(text)
      versions = Array.isArray(file.versions) ? file.versions : []
      currentId = file.current ?? versions.at(-1)?.id ?? null
      oplog.setVersionId(currentId)
    },
    list: () => versions.map(copy),
    current: () => (currentId ? copy(find(currentId)) : null),
    get: (id) => copy(find(id)),

    async createVersion(name, { prompt = null, by = 'user' } = {}) {
      await oplog.flushPending()
      const id = nextId()
      const snapshotPath = snapshotPathFor(id)
      await sink.writeText(snapshotPath, JSON.stringify(getDocument()))
      const entry = await oplog.append({
        by,
        tool: CREATE_VERSION_TOOL,
        args: { versionId: id, name, prompt },
        inverse: null,
        reason: prompt,
        versionId: id,
      })
      const parent = currentId ? find(currentId) : null
      if (parent) parent.opRange = [parent.opRange[0], entry.op - 1]
      const record = {
        id,
        name,
        parent: parent?.id ?? null,
        opRange: [entry.op, null],
        createdBy: by,
        createdAt: clock().toISOString(),
        prompt,
        snapshotPath,
      }
      versions.push(record)
      currentId = id
      oplog.setVersionId(id)
      await writeVersionsFile()
      await oplog.sync()
      return copy(record)
    },

    async readSnapshot(id) {
      const record = find(id)
      const text = await sink.readText(record.snapshotPath)
      if (text == null) throw new Error(`The snapshot of version ${id} is missing (${record.snapshotPath})`)
      return JSON.parse(text)
    },

    async restoreVersion(id, { by = 'user', reason = null } = {}) {
      const record = find(id)
      await oplog.flushPending()
      const document = await this.readSnapshot(id)
      const replacedPath = `edits/snapshots/before-op-${oplog.lastOpId() + 1}.json`
      await sink.writeText(replacedPath, JSON.stringify(getDocument()))
      await oplog.runAs('internal', () => setDocument(document))
      const op = await oplog.append({
        by,
        tool: RESTORE_VERSION_TOOL,
        args: { versionId: record.id },
        inverse: { tool: RESTORE_SNAPSHOT_TOOL, args: { snapshotPath: replacedPath } },
        reason,
      })
      await oplog.sync()
      return { version: copy(record), document, op }
    },

    // FILM-2015: a whole-document change that is not a version restore (per-scene
    // accept on the Review screen). Logged like a restore: one op whose inverse
    // names a snapshot of the document it replaced.
    async replaceDocument(document, { by = 'user', reason = null, tool = 'studio_replace_document', args = {} } = {}) {
      await oplog.flushPending()
      const replacedPath = `edits/snapshots/before-op-${oplog.lastOpId() + 1}.json`
      await sink.writeText(replacedPath, JSON.stringify(getDocument()))
      await oplog.runAs('internal', () => setDocument(document))
      const op = await oplog.append({
        by,
        tool,
        args,
        inverse: { tool: RESTORE_SNAPSHOT_TOOL, args: { snapshotPath: replacedPath } },
        reason,
      })
      await oplog.sync()
      return { document, op }
    },
  }
}
