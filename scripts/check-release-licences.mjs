// FILM-2018: an installer that contains Remotion must not be released.
// Remotion is used under its Free License for an internal tool that is never
// distributed (owner decision, 2026-10-05). release.yml builds installers on
// a v* tag and uploads them to a draft release, one click from published, so
// the release preflight refuses while @remotion/* ships in the app. A
// devDependency is build-time only and stays out of the installer.
// Publishing one needs the decision revisited first, and then the repository
// variable REMOTION_RELEASE_APPROVED set to true.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function shippedRemotionPackages(pkg) {
  return Object.keys(pkg.dependencies ?? {}).filter((name) => name === 'remotion' || name.startsWith('@remotion/'))
}

export function releaseLicenceCheck(pkg, { approved = false } = {}) {
  const shipped = shippedRemotionPackages(pkg)
  if (shipped.length === 0 || approved) return { ok: true, shipped }
  return {
    ok: false,
    shipped,
    message:
      `The installer would contain ${shipped.join(', ')}. Remotion is used under its Free License for an internal tool ` +
      'that is never distributed (FILM-2018 notes, owner decision 2026-10-05), so no installer with it is released. ' +
      'Revisit that decision first; then set the repository variable REMOTION_RELEASE_APPROVED to true.',
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const result = releaseLicenceCheck(pkg, { approved: process.env.REMOTION_RELEASE_APPROVED === 'true' })
  if (!result.ok) {
    console.error(result.message)
    process.exit(1)
  }
  console.log(result.shipped.length ? `Remotion release approved: ${result.shipped.join(', ')}` : 'No Remotion package ships in the installer.')
}
