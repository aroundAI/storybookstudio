// FILM-2010: MCP project checkpoints persist under <project>/edits/checkpoints/<id>.json
// and survive a restart; the in-memory map is a cache in front of the files.
// Pure: file access goes through `io`, the renderer's window.electronAPI fs
// bridge in the app and a node:fs adapter under `node --test`.

export const CHECKPOINT_DIR_SEGMENTS = ['edits', 'checkpoints']
const CHECKPOINT_ID_PATTERN = /^checkpoint-(\d{1,16})-[a-z0-9]{1,16}$/

export function isCheckpointId(id) {
  return typeof id === 'string' && CHECKPOINT_ID_PATTERN.test(id)
}

function checkpointTime(id) {
  const match = CHECKPOINT_ID_PATTERN.exec(id)
  return match ? Number(match[1]) : -1
}

function newestId(ids) {
  return ids.reduce((best, id) => (best === null || checkpointTime(id) > checkpointTime(best) ? id : best), null)
}

// io: { pathJoin, createDirectory, writeFile, readFile, listDirectory, deleteFile }
// with the return shapes of electron/preload.js. Pass a function to resolve it lazily.
export function createCheckpointStore({ io, cache = new Map(), limit = 20 } = {}) {
  const getIo = () => (typeof io === 'function' ? io() : io)
  const canPersist = (projectPath) => typeof projectPath === 'string' && projectPath.length > 0 && Boolean(getIo()?.writeFile)

  const checkpointDir = (projectPath) => Promise.resolve(getIo().pathJoin(projectPath, ...CHECKPOINT_DIR_SEGMENTS))

  const listPersistedIds = async (projectPath) => {
    if (!canPersist(projectPath)) return []
    const result = await getIo().listDirectory(await checkpointDir(projectPath))
    if (!result?.success) return []
    return (result.items || [])
      .filter((item) => item.isFile !== false && item.name.endsWith('.json'))
      .map((item) => item.name.slice(0, -'.json'.length))
      .filter(isCheckpointId)
  }

  const trimCache = () => {
    while (cache.size > limit) cache.delete(cache.keys().next().value)
  }

  const readPersisted = async (projectPath, id) => {
    if (!canPersist(projectPath) || !isCheckpointId(id)) return null
    const filePath = await getIo().pathJoin(await checkpointDir(projectPath), `${id}.json`)
    const result = await getIo().readFile(filePath, { encoding: 'utf8' })
    if (!result?.success) return null
    const checkpoint = JSON.parse(result.data)
    if (checkpoint?.id !== id) return null
    cache.set(id, checkpoint)
    trimCache()
    return checkpoint
  }

  return {
    // Writes the file first, then caches; returns where it was written (null when the
    // project has no folder path, e.g. the browser build, where the cache is all there is).
    async save(projectPath, checkpoint) {
      if (!isCheckpointId(checkpoint?.id)) throw new Error('Checkpoint id is malformed.')
      let filePath = null
      if (canPersist(projectPath)) {
        const dir = await checkpointDir(projectPath)
        const created = await getIo().createDirectory(dir, { recursive: true })
        if (created && created.success === false) throw new Error(`Could not create ${dir}: ${created.error}`)
        filePath = await getIo().pathJoin(dir, `${checkpoint.id}.json`)
        const written = await getIo().writeFile(filePath, JSON.stringify(checkpoint), { encoding: 'utf8' })
        if (!written?.success) throw new Error(`Could not write checkpoint: ${written?.error || 'unknown error'}`)

        const ids = await listPersistedIds(projectPath)
        const stale = ids.sort((a, b) => checkpointTime(a) - checkpointTime(b)).slice(0, Math.max(0, ids.length - limit))
        for (const id of stale) {
          await getIo().deleteFile?.(await getIo().pathJoin(dir, `${id}.json`))
          cache.delete(id)
        }
      }
      cache.set(checkpoint.id, checkpoint)
      trimCache()
      return { filePath, persisted: Boolean(filePath) }
    },

    async load(projectPath, id) {
      if (!isCheckpointId(id)) return null
      return cache.get(id) || readPersisted(projectPath, id)
    },

    async latest(projectPath) {
      const persisted = await listPersistedIds(projectPath)
      const id = newestId([...cache.keys(), ...persisted])
      return id ? (cache.get(id) || readPersisted(projectPath, id)) : null
    },

    async count(projectPath) {
      const ids = new Set([...cache.keys(), ...(await listPersistedIds(projectPath))])
      return ids.size
    },
  }
}
