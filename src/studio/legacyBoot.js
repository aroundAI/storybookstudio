// Imported first by src/main.jsx, before any store reads localStorage: moves
// settings saved under the app's earlier names to storybookstudio-* once.
import LEGACY_NAMES from './legacyNames.json' with { type: 'json' }
import { migrateLegacyStorage } from './legacyMigration.js'

try {
  migrateLegacyStorage(window.localStorage, LEGACY_NAMES)
} catch (error) {
  console.warn('Could not carry over earlier settings:', error)
}
