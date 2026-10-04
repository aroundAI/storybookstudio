// FILM-2010 AC5: storybookstudio-file:// serves only the project, userData and cache roots.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { resolveAllowedPath, storybookstudioUrlToPath, createGrantedFileSet } = require('../../electron/studio/protocolAllowlist.js')

function layout(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-protocol-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const project = path.join(base, 'Projects', 'Pilot')
  const userData = path.join(base, 'userData')
  const outside = path.join(base, 'outside')
  for (const dir of [project, userData, outside]) fs.mkdirSync(dir, { recursive: true })
  const thumb = path.join(project, 'thumbnail.png')
  const settings = path.join(userData, 'settings.json')
  const secretFile = path.join(outside, 'secret.txt')
  fs.writeFileSync(thumb, 'png')
  fs.writeFileSync(settings, '{}')
  fs.writeFileSync(secretFile, 'secret')
  return { base, project, userData, outside, thumb, settings, secretFile, roots: [project, userData] }
}

test('a file under the open project is served', (t) => {
  const l = layout(t)
  assert.equal(resolveAllowedPath(l.thumb, l.roots), l.thumb)
  assert.equal(resolveAllowedPath(l.settings, l.roots), l.settings)
})

test('/etc/passwd is refused', (t) => {
  const l = layout(t)
  assert.equal(resolveAllowedPath('/etc/passwd', l.roots), null)
})

test('../ traversal out of the project is refused, even when it lands on an allowed root', (t) => {
  const l = layout(t)
  assert.equal(resolveAllowedPath(`${l.project}/../../outside/secret.txt`, l.roots), null)
  assert.equal(resolveAllowedPath(`${l.project}/../../userData/settings.json`, l.roots), null)
  assert.equal(resolveAllowedPath(`${l.project}/../../../../../../etc/passwd`, l.roots), null)
})

test('a symlink inside the project that points outside it is refused', (t) => {
  const l = layout(t)
  const link = path.join(l.project, 'innocent.png')
  fs.symlinkSync(l.secretFile, link)
  assert.equal(resolveAllowedPath(link, l.roots), null)
})

test('a sibling folder sharing the root prefix is refused', (t) => {
  const l = layout(t)
  const sibling = `${l.project}-evil`
  fs.mkdirSync(sibling)
  fs.writeFileSync(path.join(sibling, 'x.png'), 'x')
  assert.equal(resolveAllowedPath(path.join(sibling, 'x.png'), l.roots), null)
})

test('the root directory itself, relative paths, NUL bytes and missing files are refused', (t) => {
  const l = layout(t)
  assert.equal(resolveAllowedPath(l.project, l.roots), null)
  assert.equal(resolveAllowedPath('thumbnail.png', l.roots), null)
  assert.equal(resolveAllowedPath(`${l.thumb}\0.png`, l.roots), null)
  assert.equal(resolveAllowedPath(path.join(l.project, 'missing.png'), l.roots), null)
  assert.equal(resolveAllowedPath(l.thumb, []), null)
})

test('a file the app itself asked a URL for is served, its neighbours are not', (t) => {
  const l = layout(t)
  const granted = createGrantedFileSet()
  const otherThumb = path.join(l.outside, 'recent-project-thumb.png')
  fs.writeFileSync(otherThumb, 'png')
  granted.grant(otherThumb)
  assert.equal(resolveAllowedPath(otherThumb, l.roots, { files: granted.list() }), otherThumb)
  assert.equal(resolveAllowedPath(l.secretFile, l.roots, { files: granted.list() }), null)
})

test('the granted set is bounded', () => {
  const granted = createGrantedFileSet({ limit: 2 })
  granted.grant('/a'); granted.grant('/b'); granted.grant('/c')
  assert.deepEqual(granted.list(), ['/b', '/c'])
})

test('storybookstudio-file:// URLs decode to paths without their cache-buster', () => {
  assert.equal(storybookstudioUrlToPath(`storybookstudio-file://${encodeURIComponent('/Users/me/P/thumb.png')}?t=123`), '/Users/me/P/thumb.png')
  assert.equal(storybookstudioUrlToPath(`storybookstudio-file://${encodeURIComponent('/a/b#c.png')}#frag`), '/a/b#c.png')
  assert.equal(storybookstudioUrlToPath('storybookstudio-file://%E0%A4%A'), null)
  assert.equal(storybookstudioUrlToPath('file:///etc/passwd'), null)
  assert.equal(storybookstudioUrlToPath(`storybookstudio-file://${encodeURIComponent('/C:/x.png')}`, { platform: 'win32' }), 'C:/x.png')
})

test('end to end: an encoded traversal URL resolves to nothing', (t) => {
  const l = layout(t)
  const url = `storybookstudio-file://${encodeURIComponent(`${l.project}/../../outside/secret.txt`)}`
  assert.equal(resolveAllowedPath(storybookstudioUrlToPath(url), l.roots), null)
  assert.equal(resolveAllowedPath(storybookstudioUrlToPath('storybookstudio-file://%2Fetc%2Fpasswd'), l.roots), null)
})
