import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ACCEPTED_PROJECT_VERSIONS,
  PROJECT_VERSION_BASE,
  PROJECT_VERSION_STUDIO,
  hasStudioFields,
  resolveOpenedProjectVersion,
  stampProjectVersionForSave,
} from '../../src/studio/projectVersion.js'

const readFixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

// saveProject reads window.electronAPI; a stand-in records what it writes.
const installFakeElectron = () => {
  const writes = new Map()
  globalThis.window = {
    electronAPI: {
      isElectron: true,
      pathJoin: async (...parts) => parts.join('/'),
      writeFile: async (filePath, data) => { writes.set(filePath, data); return { success: true } },
      createDirectory: async () => ({ success: true }),
      listDirectory: async () => ({ success: true, items: [] }),
      exists: async () => false,
      deleteFile: async () => ({ success: true }),
    },
  }
  return writes
}

const saveAndRead = async (project) => {
  const writes = installFakeElectron()
  const { saveProject } = await import('../../src/services/fileSystem.js')
  await saveProject('/projects/demo', project)
  return JSON.parse(writes.get('/projects/demo/project.storybookstudio'))
}

test('the accepted versions are 1.0, 1.1 and 1.2', () => {
  assert.deepEqual(ACCEPTED_PROJECT_VERSIONS, ['1.0', '1.1', '1.2'])
  assert.equal(PROJECT_VERSION_BASE, '1.1')
  assert.equal(PROJECT_VERSION_STUDIO, '1.2')
})

test('saveProject writes 1.2 and studio.schema for a project with Studio fields', async () => {
  const project = readFixture('storybookstudio-sample-project.json')
  project.studio = { episodeId: 'ep-1', currentVersion: null }
  const saved = await saveAndRead(project)
  assert.equal(saved.version, '1.2')
  assert.equal(saved.studio.schema, 'editgraph/1')
  assert.equal(saved.studio.episodeId, 'ep-1')
})

test('saveProject no longer stamps 1.0 over a stock multi-timeline project', async () => {
  const project = readFixture('storybookstudio-sample-project.json')
  const saved = await saveAndRead(project)
  assert.equal(saved.version, '1.1')
  assert.equal(saved.studio, undefined)
  const { version: _a, modified: _b, ...rest } = saved
  const { version: _c, modified: _d, ...expected } = project
  assert.deepEqual(rest, expected)
})

test('a clip or asset carrying Studio fields also makes the project 1.2', () => {
  const project = readFixture('storybookstudio-sample-project.json')
  assert.equal(hasStudioFields(project), false)
  project.timelines[0].clips[0].metadata = { origin: { versionId: 'v1', opId: 3, by: 'user' } }
  assert.equal(hasStudioFields(project), true)
  const stamped = stampProjectVersionForSave(project)
  assert.equal(stamped.version, '1.2')
  assert.equal(stamped.studio.schema, 'editgraph/1')
})

test('opening accepts 1.0, 1.1 and 1.2 as declared', () => {
  for (const version of ['1.0', '1.1']) {
    const project = { ...readFixture('storybookstudio-sample-project.json'), version }
    assert.deepEqual(resolveOpenedProjectVersion(project), { version, accepted: true })
  }
  const studio = { ...readFixture('storybookstudio-sample-project.json'), version: '1.2', studio: { schema: 'editgraph/1' } }
  assert.deepEqual(resolveOpenedProjectVersion(studio), { version: '1.2', accepted: true })
})

test('a project with no version opens as 1.0', () => {
  const { version: _v, ...project } = readFixture('storybookstudio-legacy-1.0-project.json')
  assert.deepEqual(resolveOpenedProjectVersion(project), { version: '1.0', accepted: true })
})

test('a Studio project saved by the stock upstream editor (version 1.0, studio fields kept) opens as 1.2', () => {
  const project = { ...readFixture('storybookstudio-sample-project.json'), version: '1.0', studio: { schema: 'editgraph/1' } }
  assert.deepEqual(resolveOpenedProjectVersion(project), { version: '1.2', accepted: true })
})

test('an unknown future version still opens, flagged as not accepted', () => {
  const project = { ...readFixture('storybookstudio-sample-project.json'), version: '2.0' }
  assert.deepEqual(resolveOpenedProjectVersion(project), { version: '2.0', accepted: false })
})

test('stamping for save never mutates its input', () => {
  const project = readFixture('storybookstudio-sample-project.json')
  project.studio = { episodeId: 'ep-1' }
  const before = JSON.stringify(project)
  stampProjectVersionForSave(project)
  assert.equal(JSON.stringify(project), before)
})
