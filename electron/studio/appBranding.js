// StorybookStudio wears the StoryBook brand: the dock icon (which Electron
// otherwise shows as its own logo when unpackaged) and the About panel.
// Sources: build/brand/ (copied from StoryBook's packages/branding).
// The About panel's face is the name and version only; the GPL notices are
// in the app menu's Open-source licenses view (electron/studio/licenses.js).
const APP_NAME = 'StorybookStudio'

function applyAppBranding({ app, iconPath, platform = process.platform }) {
  if (platform === 'darwin' && app.dock && iconPath) {
    app.dock.setIcon(iconPath)
  }
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: '',
    credits: '',
    // iconPath is read on Linux and Windows; macOS shows the app icon.
    ...(iconPath ? { iconPath } : {}),
  })
}

module.exports = { applyAppBranding, APP_NAME }
