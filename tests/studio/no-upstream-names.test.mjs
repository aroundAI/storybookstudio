// Owner decision, 2026-10-05: StorybookStudio carries none of the upstream
// editor's names (FILM-2010). This walks every tracked file, the built
// renderer bundle (dist/) and, when one has been packed, the macOS app's
// Info.plist, and fails on any file name or text that still says them.
//
// What may still say them, and why:
//   LICENSE                               the GPL-3.0 text
//   docs/UPSTREAM.md                      where the fork pulls from
//   electron/studio/licenses/NOTICE.txt   the GPL-3.0 §5 notice shown in
//                                         About → Open-source licenses
//   src/studio/legacyNames.json           names read once, to migrate what a
//                                         user already has (old project file,
//                                         storage keys, theme, ComfyUI bridge)
//   this file
// In dist/ the legacy names may appear only as the exact quoted strings
// legacyNames.json holds, which is how the bundle inlines that file.
//
// REQUIRE_DIST=1 (CI, after `npm run build`) makes a missing dist/ a failure.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NAMES = new RegExp(['vel', 'orn', '|', 'comfy', 'studio'].join(''), 'i')
const SELF = 'tests/studio/no-upstream-names.test.mjs'
const LEGACY_FILE = 'src/studio/legacyNames.json'
const ALLOWED = new Set([
  'LICENSE',
  'docs/UPSTREAM.md',
  'electron/studio/licenses/NOTICE.txt',
  LEGACY_FILE,
  SELF,
])

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0)
}

function hitsIn(text) {
  return text
    .split('\n')
    .map((line, index) => ({ line: index + 1, text: line.trim().slice(0, 160) }))
    .filter(({ text: line }) => NAMES.test(line))
}

function legacyStrings() {
  const collect = (value) =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(collect)
        : value && typeof value === 'object'
          ? Object.entries(value).filter(([key]) => !key.startsWith('_')).flatMap(([, v]) => collect(v))
          : []
  const file = path.join(ROOT, LEGACY_FILE)
  if (!existsSync(file)) return []
  return collect(JSON.parse(readFileSync(file, 'utf8')))
    .filter((value) => NAMES.test(value))
    .sort((a, b) => b.length - a.length)
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

test('no tracked file is named for, or mentions, the upstream editor', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  assert.ok(files.length > 500, `git ls-files listed only ${files.length} files`)

  const problems = []
  for (const file of files) {
    if (ALLOWED.has(file)) continue
    if (NAMES.test(file)) problems.push(`${file}: the path`)
    const full = path.join(ROOT, file)
    if (!existsSync(full) || !statSync(full).isFile()) continue
    const buffer = readFileSync(full)
    if (isBinary(buffer)) {
      // Media metadata can carry the names too (a ComfyUI prompt in an mp4).
      if (NAMES.test(buffer.toString('latin1'))) problems.push(`${file}: binary content`)
      continue
    }
    for (const hit of hitsIn(buffer.toString('utf8'))) problems.push(`${file}:${hit.line}: ${hit.text}`)
  }
  assert.deepEqual(problems.slice(0, 80), [], `${problems.length} hits`)
})

test('the built renderer bundle says StorybookStudio only', (t) => {
  const dist = path.join(ROOT, 'dist')
  if (!existsSync(dist)) {
    assert.ok(!process.env.REQUIRE_DIST, 'dist/ is missing; run npm run build first')
    t.skip('dist/ not built')
    return
  }
  const allowed = legacyStrings()
  const problems = []
  for (const full of walk(dist)) {
    const rel = path.relative(ROOT, full)
    if (NAMES.test(rel)) problems.push(`${rel}: the path`)
    const buffer = readFileSync(full)
    if (isBinary(buffer)) {
      if (NAMES.test(buffer.toString('latin1'))) problems.push(`${rel}: binary content`)
      continue
    }
    let text = buffer.toString('utf8')
    for (const value of allowed) {
      text = text.split(JSON.stringify(value)).join('""').split(`'${value}'`).join("''")
    }
    for (const hit of hitsIn(text)) problems.push(`${rel}:${hit.line}: ${hit.text}`)
  }
  assert.deepEqual(problems.slice(0, 40), [], `${problems.length} hits`)
})

test('a packed macOS app registers storybookstudio:// under the aroundAI bundle id', (t) => {
  const release = path.join(ROOT, 'release')
  const plist = existsSync(release)
    ? walk(release).find((file) => file.endsWith('.app/Contents/Info.plist') && !file.includes('Helper'))
    : null
  if (!plist) {
    t.skip('no packed app under release/')
    return
  }
  const text = readFileSync(plist, 'utf8')
  assert.equal(hitsIn(text).length, 0, hitsIn(text).map((hit) => hit.text).join('\n'))
  assert.match(text, /<key>CFBundleIdentifier<\/key>\s*<string>co\.aroundai\.storybookstudio<\/string>/)
  assert.match(text, /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>storybookstudio<\/string>/)
})
