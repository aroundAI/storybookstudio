// Carries a user's settings and projects over from the names this app had
// before it was StorybookStudio (owner decision 2026-10-05). Pure: the
// caller passes src/studio/legacyNames.json, so these run under node --test.

export const STORAGE_PREFIX = 'storybookstudio-'
export const THEME_STORAGE_KEY = 'storybookstudio-theme'
export const THEME_ID = 'storybook'
export const PROJECT_FILENAME = 'project.storybookstudio'
export const PROJECT_EXTENSION = '.storybookstudio'
export const FILE_URL_PREFIX = 'storybookstudio-file://'

/**
 * Moves every localStorage key under a legacy prefix to the same key under
 * `storybookstudio-`, once. A value already under the new key wins. The
 * stored theme id moves too. Returns the keys it moved.
 */
export function migrateLegacyStorage(storage, legacy) {
  if (!storage) return []
  const keys = []
  for (let index = 0; index < storage.length; index += 1) keys.push(storage.key(index))

  const moved = []
  for (const key of keys) {
    const prefix = (legacy.storagePrefixes || []).find((candidate) => key?.startsWith(candidate))
    if (!prefix) continue
    const target = `${STORAGE_PREFIX}${key.slice(prefix.length)}`
    const value = storage.getItem(key)
    if (storage.getItem(target) === null && value !== null) storage.setItem(target, value)
    storage.removeItem(key)
    moved.push(key)
  }

  if (storage.getItem(THEME_STORAGE_KEY) === legacy.themeId) storage.setItem(THEME_STORAGE_KEY, THEME_ID)
  return moved
}

/** The project file names a folder may hold, newest first. */
export function projectFileNames(legacy) {
  return [PROJECT_FILENAME, legacy.projectFile]
}

export function isProjectSnapshotName(name, legacy) {
  return typeof name === 'string' && (name.endsWith(PROJECT_EXTENSION) || name.endsWith(legacy.projectExtension))
}

/** Rewrites file URLs a project saved under the legacy scheme. */
export function normalizeLegacyFileUrls(value, legacy) {
  if (typeof value === 'string') {
    return value.startsWith(legacy.fileUrlPrefix) ? `${FILE_URL_PREFIX}${value.slice(legacy.fileUrlPrefix.length)}` : value
  }
  if (Array.isArray(value)) return value.map((item) => normalizeLegacyFileUrls(item, legacy))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeLegacyFileUrls(item, legacy)]))
  }
  return value
}

/**
 * Copies every record of `store` from the legacy IndexedDB database into
 * `openTarget()`'s, then deletes the legacy one. Does nothing when the
 * legacy database does not exist.
 */
export async function migrateLegacyIndexedDb({ indexedDB, legacyName, store, openTarget }) {
  if (!indexedDB?.databases) return 0
  const existing = await indexedDB.databases()
  if (!existing.some((db) => db.name === legacyName)) return 0

  const request = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const legacyDb = await request(indexedDB.open(legacyName))
  let records = []
  try {
    if (legacyDb.objectStoreNames.contains(store)) {
      records = await request(legacyDb.transaction(store, 'readonly').objectStore(store).getAll())
    }
  } finally {
    legacyDb.close()
  }

  if (records.length > 0) {
    const target = await openTarget()
    try {
      await new Promise((resolve, reject) => {
        const tx = target.transaction(store, 'readwrite')
        const objectStore = tx.objectStore(store)
        for (const record of records) objectStore.put(record)
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      target.close()
    }
  }
  await new Promise((resolve) => {
    const deletion = indexedDB.deleteDatabase(legacyName)
    deletion.onsuccess = resolve
    deletion.onerror = resolve
    deletion.onblocked = resolve
  })
  return records.length
}
