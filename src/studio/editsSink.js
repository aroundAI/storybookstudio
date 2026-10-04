// Where the op log, versions and snapshots are written (FILM-2012). A sink is
// four calls over paths relative to the project folder, all under `edits/`:
//   appendText(path, text)  append, never rewrite (the op log)
//   readText(path)          the file's text, or null when it does not exist
//   writeText(path, text)   atomic replace (versions.json, snapshots, reports)
//   sync(path)              fsync, called at version boundaries
// Pure module: the Electron sink receives the preload API as an argument.

export function createMemoryEditsSink(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles))
  const writes = []
  const reads = []
  return {
    files,
    writes,
    reads,
    async appendText(path, text) {
      writes.push({ kind: 'append', path })
      files.set(path, (files.get(path) ?? '') + text)
    },
    async readText(path) {
      reads.push(path)
      return files.has(path) ? files.get(path) : null
    },
    async writeText(path, text) {
      writes.push({ kind: 'write', path })
      files.set(path, text)
    },
    async sync(path) {
      writes.push({ kind: 'sync', path })
    },
  }
}

const unwrap = (result, what) => {
  if (!result?.success) throw new Error(`${what} failed: ${result?.error || 'no response from the main process'}`)
  return result
}

// `api` is window.electronAPI.studioEdits (electron/preload.js), backed by
// electron/studio/editsFiles.js in the main process.
export function createElectronEditsSink(api, projectDir) {
  if (!api) throw new Error('The Studio edits bridge is not available in this window.')
  return {
    async appendText(path, text) {
      unwrap(await api.append(projectDir, path, text), `Appending ${path}`)
    },
    async readText(path) {
      return unwrap(await api.read(projectDir, path), `Reading ${path}`).data ?? null
    },
    async writeText(path, text) {
      unwrap(await api.write(projectDir, path, text), `Writing ${path}`)
    },
    async sync(path) {
      unwrap(await api.sync(projectDir, path), `Syncing ${path}`)
    },
  }
}
