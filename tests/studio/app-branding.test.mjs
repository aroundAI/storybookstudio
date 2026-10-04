import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const { applyAppBranding } = require('../../electron/studio/appBranding.js')
const { createStudioMain } = require('../../electron/studio/studioMain.js')

function fakeApp() {
  const calls = { dockIcon: [], about: [] }
  return Object.assign(new EventEmitter(), {
    calls,
    dock: { setIcon: (p) => calls.dockIcon.push(p) },
    getVersion: () => '9.9.9',
    getPath: () => '/tmp/storybookstudio-test-userdata',
    setAboutPanelOptions: (o) => calls.about.push(o),
    // what the cloud layer's velorn:// registration calls at construction
    setAsDefaultProtocolClient: () => true,
    requestSingleInstanceLock: () => true,
    quit: () => {},
  })
}

test('the macOS dock shows the StoryBook app icon, not Electron\'s', () => {
  const app = fakeApp()
  applyAppBranding({ app, iconPath: '/x/build/icon.png', platform: 'darwin' })
  assert.deepEqual(app.calls.dockIcon, ['/x/build/icon.png'])
})

test('the About panel names StorybookStudio and credits Velorn', () => {
  const app = fakeApp()
  applyAppBranding({ app, iconPath: '/x/build/icon.png', platform: 'linux' })
  assert.equal(app.calls.dockIcon.length, 0)
  const [about] = app.calls.about
  assert.equal(about.applicationName, 'StorybookStudio')
  assert.equal(about.applicationVersion, '9.9.9')
  assert.match(about.credits, /Velorn/)
  assert.equal(about.iconPath, '/x/build/icon.png')
})

test('studioMain applies the branding when the app is ready', () => {
  const app = fakeApp()
  const studio = createStudioMain({
    app,
    ipcMain: { handle() {}, on() {} },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: {},
    getMainWindow: () => null,
    getMcpServer: () => null,
    iconPath: '/x/build/icon.png',
  })
  try {
    studio.onReady()
  } catch {
    // secrets/cloud setup may refuse in a test process; branding runs first
  }
  assert.equal(app.calls.about[0]?.applicationName, 'StorybookStudio')
})

test('the shipped icons are the StoryBook kit, not Velorn\'s', () => {
  const root = new URL('../../', import.meta.url)
  for (const f of ['build/brand/app-icon-dark.svg', 'build/brand/monogram.svg', 'build/brand/README.md']) {
    assert.ok(existsSync(new URL(f, root)), `${f} exists`)
  }
  const welcome = readFileSync(new URL('src/components/WelcomeScreen.jsx', root), 'utf8')
  assert.doesNotMatch(welcome, /velorn-(home|project)/, 'welcome screen uses no Velorn imagery')
  const studioWelcome = readFileSync(new URL('src/components/studio/Welcome.jsx', root), 'utf8')
  assert.match(studioWelcome, /<StudioMark /, 'the StoryBook Welcome carries the monogram')
  assert.match(studioWelcome, /storybookstudio-welcome-bg\.webp/, 'the StoryBook Welcome sits on the brand wave')
  assert.ok(existsSync(new URL('public/storybookstudio-welcome-bg.webp', root)), 'the welcome background ships')
  const bottomBar = readFileSync(new URL('src/components/BottomBar.jsx', root), 'utf8')
  assert.doesNotMatch(bottomBar, /#f6d985/i, 'bottom bar drops Velorn\'s gold gradient')
  const css = readFileSync(new URL('src/index.css', root), 'utf8')
  const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
  assert.match(rootBlock, /--sf-accent: 59 130 246;/, 'the default accent is StoryBook Blue, not Velorn gold')
})
