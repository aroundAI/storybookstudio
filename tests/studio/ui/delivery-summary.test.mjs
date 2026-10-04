// FILM-2015: what the Deliver screen shows before anything is rendered or
// leaves the machine (R-62, contract L8), built from FILM-2017's summary
// (studio_deliver confirm:false / studio:deliverSummary): the episode, the
// destination, every file with its estimated size, and what blocks sending.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDeliveryConfirmation, formatBytes, qaBadge, presetLabel } from '../../../src/studio/ui/deliverySummary.js'

const workspace = { name: 'Acme Studios', slug: 'acme' }
const render = (overrides = {}) => ({
  preset: 'youtube_16x9', language: 'en', file: 'youtube_16x9-en.mp4', estimatedDurationSeconds: 90, estimatedBytes: 92_000_000,
  maxDuration: null, overMaxDuration: false, note: null, lastQa: { state: 'pass', issues: 0 }, ...overrides,
})
const summary = (overrides = {}) => ({
  episode: { id: '2902a7c0-bdcc-4df9-8ee5-c79da5cffbfa', title: 'The Night the Lab Went Dark', version: 9 },
  destination: { kind: 'storybook', apiOrigin: 'http://localhost:3309', sessionId: 's1' },
  renders: [render(), render({ preset: 'shorts_9x16', file: 'shorts_9x16-en.mp4', estimatedDurationSeconds: 45, estimatedBytes: 61_500_000, maxDuration: 60 })],
  totalEstimatedBytes: 153_500_000,
  ...overrides,
})

test('sizes read in kB, MB and GB', () => {
  assert.equal(formatBytes(950), '1 kB')
  assert.equal(formatBytes(12_500_000), '12.5 MB')
  assert.equal(formatBytes(1_230_000_000), '1.23 GB')
  assert.equal(formatBytes(null), 'size unknown')
})

test('sending to StoryBook names the episode, the workspace and host, every file and its estimated size', () => {
  const view = buildDeliveryConfirmation({ summary: summary(), workspace, episodeNumber: 1 })
  assert.equal(view.episodeLine, 'Episode 1 · The Night the Lab Went Dark')
  assert.equal(view.destinationLine, 'Workspace “Acme Studios” on localhost:3309')
  assert.deepEqual(view.files.map((f) => [f.name, f.sizeLabel]), [
    ['youtube_16x9-en.mp4', 'about 92.0 MB'],
    ['shorts_9x16-en.mp4', 'about 61.5 MB'],
    ['explain-why report and QA results', 'with the delivery'],
  ])
  assert.equal(view.files[0].detail, 'YouTube 16:9 · en · 1:30')
  assert.equal(view.totalLabel, 'about 153.5 MB')
  assert.equal(view.statusLine, 'Each file is rendered, checked and uploaded; the episode is then set to Ready in StoryBook.')
  assert.equal(view.canSend, true)
  assert.deepEqual(view.warnings, [])
  assert.equal(view.toStoryBook, true)
})

test('export to a folder says nothing leaves the machine and lists the QA report', () => {
  const view = buildDeliveryConfirmation({ summary: summary({ destination: { kind: 'folder', folder: '/Users/me/Deliveries' } }), workspace })
  assert.equal(view.episodeLine, 'The Night the Lab Went Dark')
  assert.equal(view.destinationLine, 'The folder /Users/me/Deliveries')
  assert.equal(view.statusLine, 'Each file is rendered and checked, then written to the folder with the QA report beside it. Nothing leaves this machine.')
  assert.equal(view.files.at(-1).name, 'QA report')
  assert.equal(view.toStoryBook, false)
})

test('a render over its platform limit blocks; a failed preview QA and a framing note warn', () => {
  const view = buildDeliveryConfirmation({
    summary: summary({ renders: [
      render({ lastQa: { state: 'fail', issues: 2 } }),
      render({ preset: 'shorts_9x16', file: 'shorts_9x16-en.mp4', estimatedDurationSeconds: 94, maxDuration: 60, overMaxDuration: true, note: 'No 9:16 variant yet: the 16:9 master is boxed into 9:16.' }),
    ] }),
    workspace,
  })
  assert.equal(view.canSend, false)
  assert.deepEqual(view.warnings, [
    { text: 'The last preview QA found 2 issues; each file is checked again before it is sent.', blocking: false },
    { text: 'shorts_9x16-en.mp4 runs 1:34, over the Shorts 9:16 limit of 60 s. Make a Short first, or leave this format out.', blocking: true },
    { text: 'No 9:16 variant yet: the 16:9 master is boxed into 9:16.', blocking: false },
  ])
})

test('nothing chosen cannot be sent', () => {
  const view = buildDeliveryConfirmation({ summary: summary({ renders: [], totalEstimatedBytes: 0 }), workspace })
  assert.equal(view.canSend, false)
  assert.deepEqual(view.warnings, [{ text: 'Choose at least one format.', blocking: true }])
})

test('QA badges read a full QA result or the last preview’s state', () => {
  const issue = { type: 'loudness', severity: 0.7, timeRange: null, scene: null, detail: 'Too loud.', repairIntent: 'normalize_loudness' }
  assert.deepEqual(qaBadge({ pass: true, issues: [] }), { tone: 'pass', label: 'QA passed' })
  assert.deepEqual(qaBadge({ pass: false, issues: [issue] }), { tone: 'fail', label: '1 issue' })
  assert.deepEqual(qaBadge({ pass: true, issues: [{ ...issue, severity: 0.2 }] }), { tone: 'warn', label: '1 warning' })
  assert.deepEqual(qaBadge({ state: 'pass', issues: 0 }), { tone: 'pass', label: 'Preview QA passed' })
  assert.deepEqual(qaBadge({ state: 'fail', issues: 3 }), { tone: 'fail', label: 'Preview QA: 3 issues' })
  assert.deepEqual(qaBadge({ state: 'not_run' }), { tone: 'none', label: 'Not checked yet' })
  assert.deepEqual(qaBadge(null), { tone: 'none', label: 'Not checked yet' })
  assert.equal(presetLabel('shorts_9x16'), 'Shorts 9:16')
})
