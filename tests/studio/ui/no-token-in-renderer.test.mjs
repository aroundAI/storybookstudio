// FILM-2015 AC (contract S2): nothing in the renderer holds a token. Every
// cloud call goes through window.electronAPI.studio.*; the preload exposes no
// getter for a token or secret; the renderer source never reaches the secrets
// store; the MCP snapshot is built from the project, timeline and asset stores
// only (no auth state); and the built bundle carries no token. The live check
// (a PAT signed in, then searched for in the DOM, storage, stores and the MCP
// snapshot) is in the packaged-app e2e.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name)
  return statSync(full).isDirectory() ? walk(full) : [full]
})
const rendererFiles = walk(path.join(root, 'src')).filter((file) => /\.(jsx?|mjs)$/.test(file) && !/\.test\.(jsx?|mjs)$/.test(file))

test('renderer source never reaches the token store or the main-process auth module', () => {
  const offenders = []
  for (const file of rendererFiles) {
    const text = readFileSync(file, 'utf8')
    if (/getAccessToken|getSecret\(|studio-secrets|electron\/studio\/(secrets|auth)|from ['"]electron['"]/.test(text)) offenders.push(path.relative(root, file))
  }
  assert.deepEqual(offenders, [])
  assert.ok(rendererFiles.length > 100, 'the scan covered the renderer')
})

test('the preload’s studio bridge has no call that returns a token or a secret', () => {
  const preload = readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
  const start = preload.indexOf('  studio: (() => {')
  const end = preload.indexOf('})(),', start)
  assert.ok(start > 0 && end > start, 'found the studio block')
  const names = [...preload.slice(start, end).matchAll(/^\s{6}([a-zA-Z]+):/gm)].map((match) => match[1])
  assert.ok(names.includes('signIn') && names.includes('deliverConfirm'))
  assert.deepEqual(names.filter((name) => /token|secret|credential|bearer/i.test(name)), [])
})

test('the MCP snapshot is built from the project, timeline and asset stores only', () => {
  const snapshot = readFileSync(path.join(root, 'src', 'services', 'mcpSnapshot.js'), 'utf8')
  const imports = [...snapshot.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1])
  assert.deepEqual(imports.filter((source) => /stores|studio/.test(source)).sort(), ['../stores/assetsStore', '../stores/projectStore', '../stores/timelineStore'])
  assert.doesNotMatch(snapshot, /auth|token/i)
})

test('the built renderer bundle carries no token (when dist/ exists)', (t) => {
  const dist = path.join(root, 'dist')
  if (!existsSync(dist)) {
    t.skip('no dist/: run npm run build first')
    return
  }
  const bundle = walk(dist).filter((file) => file.endsWith('.js'))
  assert.ok(bundle.length > 0)
  for (const file of bundle) {
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /sbk_pat_[A-Za-z0-9_-]{20,}/, path.relative(root, file))
    assert.doesNotMatch(text, /studio-secrets\.json/, path.relative(root, file))
  }
})
