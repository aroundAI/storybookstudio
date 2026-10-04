// FILM-2015: every string the studio components ask for exists in
// public/lang/lang_en.json under "studio" (a missing key renders as its key).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const root = new URL('../../../', import.meta.url)
const english = JSON.parse(readFileSync(new URL('public/lang/lang_en.json', root), 'utf8')).studio
const lookup = (key) => key.split('.').reduce((value, part) => (value && typeof value === 'object' ? value[part] : undefined), english)

const componentsDir = new URL('src/components/studio/', root)
const sources = readdirSync(componentsDir).filter((name) => name.endsWith('.jsx')).map((name) => [name, readFileSync(new URL(name, componentsDir), 'utf8')])

// Keys built from a value: each value the code can produce.
const DYNAMIC = {
  'panel.source': ['agent', 'mcp', 'resync'],
  'panel.status': ['proposed', 'applying', 'applied', 'rejected', 'failed'],
  'review.status': ['removed', 'added', 'changed', 'moved', 'trimmed', 'same'],
  'review.origin': ['ai', 'user'],
  'deliver.progress': ['confirming', 'sending', 'rendering', 'uploading', 'sent', 'exported', 'failed'],
}

test('every static studio string key exists in English', () => {
  const missing = []
  let count = 0
  for (const [name, source] of sources) {
    for (const match of source.matchAll(/\bt\('([a-zA-Z.]+)'/g)) {
      count += 1
      if (typeof lookup(match[1]) !== 'string') missing.push(`${name}: ${match[1]}`)
    }
  }
  assert.ok(count > 100, `found ${count} keys`)
  assert.deepEqual(missing, [])
})

test('every dynamic key prefix the components use is listed here, with each value present', () => {
  const prefixes = new Set()
  for (const [, source] of sources) {
    for (const match of source.matchAll(/\bt\(`([a-zA-Z.]+)\.\$\{/g)) prefixes.add(match[1])
  }
  assert.deepEqual([...prefixes].sort(), Object.keys(DYNAMIC).sort())
  for (const [prefix, values] of Object.entries(DYNAMIC)) {
    for (const value of values) assert.equal(typeof lookup(`${prefix}.${value}`), 'string', `${prefix}.${value}`)
  }
})
