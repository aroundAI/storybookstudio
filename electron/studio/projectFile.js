// The project file a folder holds. Before the rename (owner decision
// 2026-10-05) it had another name; a folder pulled before then still opens,
// and the first save writes the current name and removes the old file.
const fs = require('fs')
const path = require('path')
const LEGACY_NAMES = require('../../src/studio/legacyNames.json')

const PROJECT_FILE = 'project.storybookstudio'

function projectFilePath(projectDir) {
  const current = path.join(projectDir, PROJECT_FILE)
  if (fs.existsSync(current)) return current
  const previous = path.join(projectDir, LEGACY_NAMES.projectFile)
  return fs.existsSync(previous) ? previous : current
}

async function removeLegacyProjectFile(projectDir) {
  await fs.promises.rm(path.join(projectDir, LEGACY_NAMES.projectFile), { force: true })
}

module.exports = { PROJECT_FILE, projectFilePath, removeLegacyProjectFile }
