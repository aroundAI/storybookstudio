// FILM-2018: prepares what the Remotion composition engine reads at run time,
// so the packaged app needs neither webpack nor a network:
//
//   dist-compositions/   the Remotion bundle of src/studio/compositions/remotion/index.jsx
//   node_modules/.remotion/chrome-headless-shell/   Remotion's Chrome Headless Shell
//
// electron-builder ships both as extraResources (package.json "build").
// `--bundle-only` skips the browser download.
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { bundle } from '@remotion/bundler'
import { ensureBrowser } from '@remotion/renderer'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const BUNDLE_DIR = path.join(root, 'dist-compositions')
const ENTRY = path.join(root, 'src', 'studio', 'compositions', 'remotion', 'index.jsx')

export async function buildCompositions({ outDir = BUNDLE_DIR, browser = true, log = console.log } = {}) {
  const started = Date.now()
  const serveUrl = await bundle({ entryPoint: ENTRY, outDir, enableCaching: false })
  log(`compositions: bundled to ${path.relative(root, serveUrl) || serveUrl} in ${Date.now() - started} ms`)
  if (browser) {
    const status = await ensureBrowser()
    log(`compositions: Chrome Headless Shell ${status.type}${status.path ? ` at ${path.relative(root, status.path)}` : ''}`)
  }
  return serveUrl
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildCompositions({ browser: !process.argv.includes('--bundle-only') })
}
