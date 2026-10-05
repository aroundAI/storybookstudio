// StoryBook pins one commit of this repo and moves the pin when it hears that
// main moved. The event name is the contract with StoryBook's studio-pin.yml
// (repository_dispatch types: [storybookstudio-main]); renaming it here
// leaves StoryBook waiting for its daily run.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../../.github/workflows/notify-storybook.yml', import.meta.url), 'utf8')

test('every push to main sends storybookstudio-main to aroundAI/storybook', () => {
  assert.match(workflow, /on:\n  push:\n    branches: \[main\]/)
  assert.match(workflow, /gh api repos\/aroundAI\/storybook\/dispatches -f event_type=storybookstudio-main/)
})

test('without the token the job passes and says StoryBook catches up daily', () => {
  assert.match(workflow, /if \[ -z "\$GH_TOKEN" \]; then[\s\S]*?exit 0/)
})
