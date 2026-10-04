// GPL-3.0 §5: the app keeps the upstream copyright notice and says it was
// modified. The About panel shows only StorybookStudio and its version; the
// app menu's "Open-source licenses…" opens a view with this notice and the
// GPL text (owner decision, 2026-10-05). The notice stays in the main
// process, so the renderer bundle never carries the upstream name.
const fs = require('fs')
const path = require('path')

const NOTICE_PATH = path.join(__dirname, 'licenses', 'NOTICE.txt')
const LICENSES_MENU_LABEL = 'Open-source licenses…'

function readLicenses({ appPath }) {
  const notice = fs.readFileSync(NOTICE_PATH, 'utf8')
  let license = ''
  try {
    license = fs.readFileSync(path.join(appPath, 'LICENSE'), 'utf8')
  } catch {
    license = ''
  }
  return { notice, license }
}

function buildAppMenuTemplate({ platform = process.platform, appName, onShowLicenses }) {
  const licenses = { label: LICENSES_MENU_LABEL, click: onShowLicenses }
  const help = { role: 'help', submenu: [licenses] }
  const common = [{ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }, help]
  if (platform !== 'darwin') return common
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        licenses,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    ...common,
  ]
}

module.exports = { readLicenses, buildAppMenuTemplate, LICENSES_MENU_LABEL, NOTICE_PATH }
