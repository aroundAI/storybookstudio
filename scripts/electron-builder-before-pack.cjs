const { normalizeArch, normalizePlatform } = require('../electron/rifeRuntime')
const { verifyStagedReleaseInputs } = require('./runtime-package-gate.cjs')
const fs = require('fs')
const path = require('path')

// FILM-2018: the composition engine reads the Remotion bundle, Chrome
// Headless Shell and Remotion's compositor from resources (package.json "build" extraResources); a
// pack without them would ship an app whose graphics never render.
function verifyCompositionInputs({ projectRoot, platform, arch }) {
  const browserDir = platform === 'darwin' ? `mac-${arch}` : platform === 'win32' ? 'win64' : platform === 'linux' && arch === 'x64' ? 'linux64' : null
  const compositor = platform === 'darwin' ? `darwin-${arch}` : platform === 'win32' ? 'win32-x64-msvc' : platform === 'linux' && arch === 'x64' ? 'linux-x64-gnu' : null
  const missing = [
    !fs.existsSync(path.join(projectRoot, 'dist-compositions', 'index.html')) && 'dist-compositions/ (the Remotion bundle)',
    compositor && !fs.existsSync(path.join(projectRoot, 'node_modules', '@remotion', `compositor-${compositor}`)) && `node_modules/@remotion/compositor-${compositor}`,
    browserDir && !fs.existsSync(path.join(projectRoot, 'node_modules', '.remotion', 'chrome-headless-shell', browserDir)) && `node_modules/.remotion/chrome-headless-shell/${browserDir} (Chrome Headless Shell)`,
  ].filter(Boolean)
  if (missing.length) throw new Error(`Run npm run build:compositions before packaging; missing ${missing.join(' and ')}.`)
}

async function beforePack(context) {
  const platform = normalizePlatform(context.electronPlatformName)
  const arch = normalizeArch(context.arch)
  verifyStagedReleaseInputs({
    projectRoot: context.packager.projectDir,
    platform,
    arch,
  })
  verifyCompositionInputs({ projectRoot: context.packager.projectDir, platform, arch })
}

module.exports = beforePack
module.exports.verifyCompositionInputs = verifyCompositionInputs
