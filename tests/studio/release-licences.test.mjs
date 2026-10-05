// FILM-2018: no installer that contains Remotion is released. The release
// preflight runs scripts/check-release-licences.mjs; this pins its rule and
// that the workflow runs it before any installer is built.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { releaseLicenceCheck, shippedRemotionPackages } from '../../scripts/check-release-licences.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')

test('a Remotion runtime dependency stops the release; a devDependency does not', () => {
  const shipping = { dependencies: { '@remotion/renderer': '4.0.533', react: '18' }, devDependencies: { '@remotion/bundler': '4.0.533' } }
  const result = releaseLicenceCheck(shipping)
  assert.equal(result.ok, false)
  assert.deepEqual(result.shipped, ['@remotion/renderer'])
  assert.match(result.message, /REMOTION_RELEASE_APPROVED/)

  assert.equal(releaseLicenceCheck({ dependencies: { react: '18' }, devDependencies: { '@remotion/bundler': '4' } }).ok, true)
  assert.deepEqual(shippedRemotionPackages({ dependencies: { remotion: '4' } }), ['remotion'])
})

test('the owner can approve a release once the decision is revisited', () => {
  assert.equal(releaseLicenceCheck({ dependencies: { '@remotion/renderer': '4' } }, { approved: true }).ok, true)
})

test('today the app ships Remotion, so a release is refused without approval', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(releaseLicenceCheck(pkg).ok, false)
})

test('release.yml checks before the draft release exists or any installer is built', () => {
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8')
  const preflight = workflow.slice(workflow.indexOf('\n  preflight:'), workflow.indexOf('\n  ensure-release:'))
  assert.match(preflight, /node scripts\/check-release-licences\.mjs/)
  assert.match(preflight, /REMOTION_RELEASE_APPROVED: \$\{\{ vars\.REMOTION_RELEASE_APPROVED \}\}/)
  const ensure = workflow.slice(workflow.indexOf('\n  ensure-release:'), workflow.indexOf('\n  build-windows:'))
  assert.match(ensure, /needs: \[preflight\]/)
  for (const job of ['build-windows', 'build-linux', 'build-macos']) {
    const start = workflow.indexOf(`\n  ${job}:`)
    assert.match(workflow.slice(start, start + 300), /needs: \[ensure-release, preflight\]/, job)
  }
})
