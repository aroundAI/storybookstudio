// StorybookStudio wears the StoryBook brand: the dock icon (which Electron
// otherwise shows as its own logo when unpackaged) and the About panel.
// Sources: build/brand/ (copied from StoryBook's packages/branding).
const APP_NAME = 'StorybookStudio'
const CREDITS = 'Built on Velorn, free software under the GNU GPL v3.'

function applyAppBranding({ app, iconPath, platform = process.platform }) {
  if (platform === 'darwin' && app.dock && iconPath) {
    app.dock.setIcon(iconPath)
  }
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    credits: CREDITS,
    // iconPath is read on Linux and Windows; macOS shows the app icon.
    ...(iconPath ? { iconPath } : {}),
  })
}

module.exports = { applyAppBranding, APP_NAME }
