import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { load, render, spliceDoc, validate } from '../../scripts/capability-matrix.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('every MCP tool is classified and every classification names a tool', () => {
  const { tools, classes } = load(ROOT)
  assert.deepEqual(validate(tools, classes), [])
})

test('a tool added upstream without a classification is reported', () => {
  const { tools, classes } = load(ROOT)
  const added = [...tools, { name: 'upstream_new_tool', description: 'New.', inputSchema: { type: 'object' } }]
  assert.deepEqual(validate(added, classes), ['unclassified tool: upstream_new_tool'])
})

test('docs/CAPABILITY_MATRIX.md matches the generator', () => {
  const { tools, writable, classes } = load(ROOT)
  const doc = fs.readFileSync(path.join(ROOT, 'docs/CAPABILITY_MATRIX.md'), 'utf8')
  assert.equal(spliceDoc(doc, render(tools, writable, classes).markdown), doc,
    'run node scripts/capability-matrix.mjs --write')
})
