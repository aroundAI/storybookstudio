// Main-process file access for the Studio op log, versions and snapshots
// (FILM-2012). The renderer may touch only <projectDir>/edits/**: appends for
// the op log, atomic replaces for versions.json, snapshots and reports, and an
// fsync at version boundaries. Takes ipcMain as an argument so this module
// imports nothing from Electron and runs under `node --test`.
const path = require('path')
const crypto = require('crypto')
const fsp = require('fs').promises

const SEGMENT = /^[A-Za-z0-9._-]+$/

function resolveEditsPath(projectDir, relPath) {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
    throw new Error('projectDir must be an absolute path')
  }
  if (typeof relPath !== 'string') throw new Error('path must be a string')
  const segments = relPath.split('/')
  if (segments[0] !== 'edits' || segments.length < 2 || !segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..')) {
    throw new Error(`Refusing ${relPath}: Studio edits stay under edits/`)
  }
  const editsRoot = path.resolve(projectDir, 'edits')
  const full = path.resolve(projectDir, ...segments)
  if (!full.startsWith(editsRoot + path.sep)) throw new Error(`Refusing ${relPath}: outside edits/`)
  return full
}

async function appendText(projectDir, relPath, text) {
  const full = resolveEditsPath(projectDir, relPath)
  await fsp.mkdir(path.dirname(full), { recursive: true })
  await fsp.appendFile(full, String(text), 'utf8')
}

async function readText(projectDir, relPath) {
  const full = resolveEditsPath(projectDir, relPath)
  try {
    return await fsp.readFile(full, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function writeTextAtomic(projectDir, relPath, text) {
  const full = resolveEditsPath(projectDir, relPath)
  await fsp.mkdir(path.dirname(full), { recursive: true })
  const temp = `${full}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  const handle = await fsp.open(temp, 'w')
  try {
    await handle.writeFile(String(text), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fsp.rename(temp, full)
}

async function syncFile(projectDir, relPath) {
  const full = resolveEditsPath(projectDir, relPath)
  let handle
  try {
    handle = await fsp.open(full, 'r')
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const respond = (work) => async (_event, ...args) => {
  try {
    const data = await work(...args)
    return { success: true, data: data ?? null }
  } catch (error) {
    return { success: false, error: error?.message || String(error) }
  }
}

function registerStudioEditsHandlers({ ipcMain }) {
  ipcMain.handle('studioEdits:append', respond(appendText))
  ipcMain.handle('studioEdits:read', respond(readText))
  ipcMain.handle('studioEdits:write', respond(writeTextAtomic))
  ipcMain.handle('studioEdits:sync', respond(syncFile))
}

module.exports = {
  appendText,
  readText,
  registerStudioEditsHandlers,
  resolveEditsPath,
  syncFile,
  writeTextAtomic,
}
