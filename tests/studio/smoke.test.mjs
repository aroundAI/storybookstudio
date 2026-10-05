import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

test('the app is named StorybookStudio and registers the storybookstudio scheme', () => {
  assert.equal(pkg.build.productName, 'StorybookStudio')
  assert.deepEqual(pkg.build.protocols, [{ name: 'StorybookStudio', schemes: ['storybookstudio'] }])
})
