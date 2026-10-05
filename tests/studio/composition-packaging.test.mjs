// FILM-2018: the packaged app carries what the composition engine reads, at
// the paths it reads them from. A drift between package.json "build" and
// compositionEngines/remotion.js is a packaged app whose graphics never
// render, which no unit test of the engine would see. (Measured on a
// packaged --dir build: see the PR.)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { packagedRemotionPaths } = require('../../electron/studio/compositionEngines/remotion.js')
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const build = pkg.build

const PLATFORMS = [
  { key: 'mac', platform: 'darwin', arch: 'arm64', browser: 'mac-${arch}', compositor: 'darwin-${arch}', expand: (s) => s.replace('${arch}', 'arm64') },
  { key: 'win', platform: 'win32', arch: 'x64', browser: 'win64', compositor: 'win32-x64-msvc', expand: (s) => s },
  { key: 'linux', platform: 'linux', arch: 'x64', browser: 'linux64', compositor: 'linux-x64-gnu', expand: (s) => s },
]

test('each platform ships Chrome Headless Shell and the compositor where the engine looks', () => {
  const resources = '/R'
  for (const { key, platform, arch, browser, compositor, expand } of PLATFORMS) {
    const extra = build[key].extraResources || []
    const browserEntry = extra.find((entry) => entry.to === 'remotion-browser')
    const compositorEntry = extra.find((entry) => entry.to === 'remotion-compositor')
    assert.equal(browserEntry?.from, `node_modules/.remotion/chrome-headless-shell/${browser}`, key)
    assert.equal(compositorEntry?.from, `node_modules/@remotion/compositor-${compositor}`, key)
    const paths = packagedRemotionPaths({ isPackaged: true, resourcesPath: resources, platform, arch })
    // ensureBrowser() unpacks to <platform>/chrome-headless-shell-<platform>/.
    assert.equal(path.dirname(path.dirname(paths.browserExecutable)), path.join(resources, 'remotion-browser'), key)
    assert.equal(path.basename(path.dirname(paths.browserExecutable)), `chrome-headless-shell-${expand(browser)}`, key)
    assert.equal(paths.binariesDirectory, path.join(resources, 'remotion-compositor'), key)
    assert.equal(paths.serveUrl, path.join(resources, 'compositions'), key)
  }
})

test('the bundle ships with the map Remotion reads, the compositor stays out of app.asar, and nothing is unpacked', () => {
  const bundle = build.extraResources.find((entry) => entry.to === 'compositions')
  assert.equal(bundle.from, 'dist-compositions')
  assert.deepEqual(bundle.filter, ['**/*', '!*.bundle.js.map'], 'bundle.js.map stays: Remotion opens it to serve the bundle')
  assert.ok(build.files.includes('!node_modules/@remotion/compositor-*/**'))
  assert.equal(build.asarUnpack, undefined)
})

test('every src/studio module the main process imports is packaged', () => {
  const source = readFileSync(new URL('../../electron/studio/compositionRenderer.js', import.meta.url), 'utf8')
  const imported = [...source.matchAll(/studioModule\('([^']+)'\)/g)].map((match) => `src/studio/${match[1]}`)
  assert.deepEqual(imported.sort(), ['src/studio/compositions/catalogue.js', 'src/studio/compositions/key.js'])
  for (const file of imported) assert.ok(build.files.includes(file), `${file} is in build.files`)
  assert.ok(build.files.includes('src/studio/contracts/**/*'), 'catalogue.js reads the brand contract')
})

test('every packaging script builds the compositions first', () => {
  for (const name of ['electron:build', 'electron:build:win', 'electron:build:mac', 'electron:build:linux', 'electron:pack']) {
    assert.match(pkg.scripts[name], /npm run build:compositions && electron-builder/, name)
  }
  assert.equal(pkg.scripts['build:compositions'], 'node ./scripts/build-compositions.mjs')
  assert.equal(pkg.devDependencies['@remotion/bundler'], pkg.dependencies['@remotion/renderer'], 'one Remotion version')
  assert.equal(pkg.dependencies.remotion, pkg.dependencies['@remotion/renderer'])
})
