// The app's data folder is named after the app. Before the rename (owner
// decision 2026-10-05) it had another name, so settings, the MCP secret,
// saved localStorage and downloaded caption models live there. The first
// launch under the new name moves that folder, once, before anything reads
// userData. A folder already under the new name is never replaced.
const fs = require('fs')
const path = require('path')
const LEGACY_NAMES = require('../../src/studio/legacyNames.json')

function carryOverUserData({ app, env = process.env, fsImpl = fs }) {
  if (env.STUDIO_USER_DATA_DIR) return null
  const target = app.getPath('userData')
  const source = path.join(app.getPath('appData'), LEGACY_NAMES.userDataDir)
  if (fsImpl.existsSync(target) || !fsImpl.existsSync(source)) return null
  fsImpl.renameSync(source, target)
  return { from: source, to: target }
}

module.exports = { carryOverUserData }
