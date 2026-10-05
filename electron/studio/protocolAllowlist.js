// FILM-2010: which files the storybookstudio-file:// protocol may serve.
// Pure: no Electron import, so `node --test` covers it.
const fs = require('fs')
const path = require('path')

const STORYBOOKSTUDIO_SCHEME_PREFIX = 'storybookstudio-file://'

// "storybookstudio-file://%2FUsers%2Fme%2Fp%2Fthumb.png?t=1" -> "/Users/me/p/thumb.png".
// The query and fragment are cache-busters, never part of the path.
function storybookstudioUrlToPath(url, { platform = process.platform } = {}) {
  const value = String(url || '')
  if (!value.startsWith(STORYBOOKSTUDIO_SCHEME_PREFIX)) return null
  const encoded = value.slice(STORYBOOKSTUDIO_SCHEME_PREFIX.length).split(/[?#]/)[0]
  let decoded
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    return null
  }
  if (platform === 'win32' && /^\/[a-zA-Z]:[\\/]/.test(decoded)) decoded = decoded.slice(1)
  return decoded
}

function realpathOrNull(target, fsImpl) {
  try {
    return fsImpl.realpathSync.native ? fsImpl.realpathSync.native(target) : fsImpl.realpathSync(target)
  } catch {
    return null
  }
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

// Returns the real path to serve, or null (the handler answers 403).
// roots: directories whose contents may be served (project, userData, caches).
// files: exact files the app itself asked a URL for (media:getFileUrl).
// A path is resolved through symlinks before the check, so a link inside a
// root that points outside it is refused; any ".." segment is refused outright.
function resolveAllowedPath(requestPath, roots = [], { files = [], fsImpl = fs } = {}) {
  if (typeof requestPath !== 'string' || requestPath.length === 0) return null
  if (requestPath.includes('\0')) return null
  if (!path.isAbsolute(requestPath)) return null
  if (requestPath.split(/[\\/]+/).includes('..')) return null

  const target = realpathOrNull(requestPath, fsImpl)
  if (!target) return null

  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue
    const realRoot = realpathOrNull(root, fsImpl)
    if (realRoot && isInside(realRoot, target)) return target
  }
  for (const file of files) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) continue
    if (realpathOrNull(file, fsImpl) === target) return target
  }
  return null
}

// Exact files granted to the app's own windows, newest kept, bounded.
function createGrantedFileSet({ limit = 2000 } = {}) {
  const granted = new Set()
  return {
    grant(filePath) {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return
      granted.delete(filePath)
      granted.add(filePath)
      while (granted.size > limit) granted.delete(granted.values().next().value)
    },
    list() {
      return [...granted]
    },
  }
}

module.exports = {
  STORYBOOKSTUDIO_SCHEME_PREFIX,
  storybookstudioUrlToPath,
  resolveAllowedPath,
  createGrantedFileSet,
}
