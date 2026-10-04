// FILM-2010: runs tests/studio/**/*.test.{js,mjs} with Node's test runner.
// `node --test <glob>` expands globs only from Node 21, and a directory
// argument works only before it; this lists the files so both behave the same.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'tests', 'studio')

function collect(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return collect(full)
    return /\.test\.(js|mjs)$/.test(entry.name) ? [full] : []
  })
}

const files = collect(root).sort()
if (files.length === 0) {
  console.error(`No tests found under ${root}`)
  process.exit(1)
}
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)
