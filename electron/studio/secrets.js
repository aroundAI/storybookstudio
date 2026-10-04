// FILM-2010: secrets for the main process, encrypted with Electron safeStorage
// into userData/studio-secrets.json. Main process only: no IPC handler, the
// preload bridge, the MCP snapshot or a log line ever receives a value.
//
// Tests inject a fake safeStorage through createSecretStore(); the app calls
// configureSecrets({ userDataDir, safeStorage }) once after `ready`.
const fs = require('fs')
const path = require('path')

const SECRETS_FILE_NAME = 'studio-secrets.json'
const SECRETS_FILE_VERSION = 1
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

class SecretsUnavailableError extends Error {
  constructor() {
    super('Secure storage is not available on this system; the secret was not stored.')
    this.name = 'SecretsUnavailableError'
    this.code = 'SECRETS_UNAVAILABLE'
  }
}

function assertKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new Error('Secret keys are 1-128 characters of letters, digits, ".", "_", ":" or "-".')
  }
}

function createSecretStore({ filePath, safeStorage, fsImpl = fs } = {}) {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error('createSecretStore needs an absolute filePath.')
  if (!safeStorage) throw new Error('createSecretStore needs safeStorage.')

  const requireEncryption = () => {
    if (!safeStorage.isEncryptionAvailable()) throw new SecretsUnavailableError()
  }

  const readEntries = () => {
    let raw
    try {
      raw = fsImpl.readFileSync(filePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return {}
      throw error
    }
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed.entries === 'object' && parsed.entries ? { ...parsed.entries } : {}
  }

  const writeEntries = (entries) => {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.${process.pid}.tmp`
    const data = JSON.stringify({ version: SECRETS_FILE_VERSION, entries }, null, 2)
    fsImpl.writeFileSync(tempPath, data, { encoding: 'utf8', mode: 0o600 })
    fsImpl.renameSync(tempPath, filePath)
  }

  return {
    setSecret(key, value) {
      assertKey(key)
      if (typeof value !== 'string') throw new Error('Secret values must be strings.')
      requireEncryption()
      const entries = readEntries()
      entries[key] = safeStorage.encryptString(value).toString('base64')
      writeEntries(entries)
    },
    getSecret(key) {
      assertKey(key)
      const entries = readEntries()
      if (!Object.prototype.hasOwnProperty.call(entries, key)) return null
      requireEncryption()
      return safeStorage.decryptString(Buffer.from(entries[key], 'base64'))
    },
    deleteSecret(key) {
      assertKey(key)
      const entries = readEntries()
      if (!Object.prototype.hasOwnProperty.call(entries, key)) return false
      delete entries[key]
      writeEntries(entries)
      return true
    },
    hasSecret(key) {
      assertKey(key)
      return Object.prototype.hasOwnProperty.call(readEntries(), key)
    },
  }
}

let defaultStore = null

function configureSecrets({ userDataDir, safeStorage, fsImpl } = {}) {
  defaultStore = createSecretStore({
    filePath: path.join(userDataDir, SECRETS_FILE_NAME),
    safeStorage,
    fsImpl,
  })
  return defaultStore
}

function store() {
  if (!defaultStore) throw new Error('Secrets are not configured; call configureSecrets() after app ready.')
  return defaultStore
}

module.exports = {
  SECRETS_FILE_NAME,
  SecretsUnavailableError,
  createSecretStore,
  configureSecrets,
  setSecret: (key, value) => store().setSecret(key, value),
  getSecret: (key) => store().getSecret(key),
  deleteSecret: (key) => store().deleteSecret(key),
  hasSecret: (key) => store().hasSecret(key),
}
