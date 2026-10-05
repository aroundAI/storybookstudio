// FILM-2018: how long a composition render takes on this machine, through
// the app's own path (compositionRenderer.js + the Remotion engine).
//   node scripts/composition-timings.mjs [runs]
// Times a 4 s 1080p30 Counter: the first render (browser cold), further
// renders of new props (browser warm), and a cache hit. Prints the machine
// and its load, since a loaded machine reads slower. Target: under 10 s on
// the reference machine.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { BUNDLE_DIR, buildCompositions } from './build-compositions.mjs'
import { removeDir, tempDir } from '../tests/studio/helpers/review-media.mjs'

const require = createRequire(import.meta.url)
const { createCompositionRenderer } = require('../electron/studio/compositionRenderer.js')
const { createRemotionEngine } = require('../electron/studio/compositionEngines/remotion.js')

const runs = Math.max(2, Number(process.argv[2]) || 4)
if (!existsSync(path.join(BUNDLE_DIR, 'index.html'))) await buildCompositions()
const dir = await tempDir('composition-timings')
const engine = createRemotionEngine({ serveUrl: BUNDLE_DIR })
const renderer = createCompositionRenderer({ engines: { remotion: engine } })
const ask = (to) => ({ projectDir: dir, engine: 'remotion', compositionId: 'counter', props: { to, suffix: '%', label: 'retention' }, durationSeconds: 4, width: 1920, height: 1080, fps: 30 })
const rows = []
try {
  for (let i = 0; i < runs; i += 1) {
    const started = Date.now()
    const result = await renderer.render(ask(80 + i))
    rows.push({ render: i === 0 ? 'first (browser cold)' : `new props #${i} (browser warm)`, ms: Date.now() - started, cached: result.cached })
  }
  const started = Date.now()
  const hit = await renderer.render(ask(80))
  rows.push({ render: 'same props again (cache hit)', ms: Date.now() - started, cached: hit.cached })
} finally {
  await engine.close()
  await removeDir(dir)
}
console.log(`${os.cpus()[0]?.model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${process.platform}-${process.arch}; load average ${os.loadavg().map((v) => v.toFixed(1)).join(' ')}`)
console.table(rows)
