// openFromPackage (FILM-2012): write the rough cut, open it, save 'Rough cut'.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

import { createElectronProjectFs, openFromPackage, PROJECT_FILENAME, ROUGH_CUT_VERSION_NAME, writeRoughCutProject } from '../../src/studio/openFromPackage.js'
import { loadFixture, probesFor } from './helpers/rough-cut.mjs'

const memoryFs = () => {
  const files = new Map()
  return { files, writeText: async (projectPath, relativePath, text) => { files.set(`${projectPath}/${relativePath}`, text) } }
}

test('the side files are written before the project file, and the project file is the built project', async () => {
  const pkg = loadFixture(5)
  const fs = memoryFs()
  const { project, written } = await writeRoughCutProject({ package: pkg, probedAssets: probesFor(pkg), projectPath: '/p', fs })
  assert.deepEqual(written, ['storybook/package.json', 'storybook/link.json', 'storybook/brand.json', 'storybook/policy.json', PROJECT_FILENAME])
  assert.deepEqual([...fs.files.keys()], written.map((file) => `/p/${file}`))
  assert.deepEqual(JSON.parse(fs.files.get(`/p/${PROJECT_FILENAME}`)), project)
})

test('openFromPackage opens the folder, then saves the Rough cut version by the AI', async () => {
  const pkg = loadFixture(5)
  const calls = []
  const result = await openFromPackage({
    package: pkg,
    probedAssets: probesFor(pkg),
    projectPath: '/p',
    fs: memoryFs(),
    openProject: async (projectPath) => { calls.push(['open', projectPath]); return { name: 'x' } },
    createVersion: async (name, options) => { calls.push(['version', name, options]); return { id: 'v1', name } },
  })
  assert.deepEqual(calls, [['open', '/p'], ['version', ROUGH_CUT_VERSION_NAME, { by: 'ai', prompt: null }]])
  assert.deepEqual(result.version, { id: 'v1', name: 'Rough cut' })
  assert.ok(result.warnings.length > 0)
})

test('a project that does not open gets no version', async () => {
  const pkg = loadFixture(5)
  let versions = 0
  await assert.rejects(openFromPackage({
    package: pkg,
    probedAssets: probesFor(pkg),
    projectPath: '/p',
    fs: memoryFs(),
    openProject: async () => null,
    createVersion: async () => { versions += 1 },
  }), /did not open/)
  assert.equal(versions, 0)
})

test('the desktop writer stays inside the project folder', async () => {
  const writes = []
  const api = {
    pathJoin: async (...parts) => path.join(...parts),
    pathDirname: async (target) => path.dirname(target),
    createDirectory: async () => ({ success: true }),
    writeFile: async (target) => { writes.push(target); return { success: true } },
  }
  const fs = createElectronProjectFs(api)
  await fs.writeText('/p', 'storybook/link.json', '{}')
  assert.deepEqual(writes, ['/p/storybook/link.json'])
  for (const bad of ['../escape.json', 'storybook/../../escape.json', '/etc/passwd', 'C:/x.json', 'a//b.json', 'a\\..\\b.json', '']) {
    await assert.rejects(fs.writeText('/p', bad, '{}'), /outside the project folder/, bad)
  }
  assert.equal(writes.length, 1)
  await assert.rejects(createElectronProjectFs({ ...api, writeFile: async () => ({ success: false, error: 'disk full' }) }).writeText('/p', 'a.json', '{}'), /disk full/)
  assert.throws(() => createElectronProjectFs(undefined), /not available/)
})
