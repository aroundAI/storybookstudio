import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const names = Object.keys(scripts).filter((name) => name.startsWith('test:'))

for (const name of names) {
  console.log(`\n==> npm run ${name}`)
  const result = spawnSync('npm', ['run', name], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    console.error(`\n${name} failed (exit ${result.status ?? result.signal})`)
    process.exit(result.status || 1)
  }
}

console.log(`\nAll ${names.length} test scripts passed.`)
