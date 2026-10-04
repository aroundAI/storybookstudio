// FILM-2015: the episode picker's tree and progress view, the project-close /
// app-quit prompt, and crash recovery ("Return to version before plan").
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildEpisodeTree, packageBytes, jobProgressView, statusChip, formatAgo } from '../../../src/studio/ui/pickerModel.js'
import { pendingWorkPrompt, planJournalEntry, recoveryOffer } from '../../../src/studio/ui/sessionGuard.js'

const pkg = JSON.parse(readFileSync(new URL('../fixtures/edit-package/20-shots.json', import.meta.url), 'utf8'))
const NOW = Date.parse('2026-10-04T22:00:00Z')
const S1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const S2 = 'aaaaaaaa-0000-4000-8000-000000000002'

const episodes = [
  { id: 'e3', number: 3, title: 'Three', status: 'editing', seasonId: S2, durationSeconds: null, targetDurationSeconds: 90, updatedAt: '2026-10-01T22:00:00Z' },
  { id: 'e1', number: 1, title: 'One', status: 'storyboard', seasonId: S1, durationSeconds: 99, targetDurationSeconds: 90, updatedAt: '2026-10-04T21:58:00Z' },
  { id: 'e2', number: 2, title: 'Two', status: 'ready', seasonId: S1, durationSeconds: null, targetDurationSeconds: null, updatedAt: '2026-10-04T19:00:00Z' },
  { id: 'e4', number: 4, title: 'Loose', status: 'published', seasonId: null, durationSeconds: 61, targetDurationSeconds: null, updatedAt: null },
]

test('episodes group into seasons in episode order, with status, duration, last changed and local state', () => {
  const tree = buildEpisodeTree({
    episodes,
    localLinks: new Map([['e1', { projectPath: '/Users/me/StorybookStudio/one', bytes: 1_480_000_000 }]]),
    now: NOW,
  })
  assert.deepEqual(tree.map((season) => season.label), ['Season 1', 'Season 2', 'No season'])
  assert.deepEqual(tree[0].episodes.map((e) => e.id), ['e1', 'e2'])
  const one = tree[0].episodes[0]
  assert.equal(one.title, '1. One')
  assert.deepEqual(one.status, { key: 'storyboard', label: 'Storyboard', tone: 'neutral' })
  assert.equal(one.durationLabel, '1:39')
  assert.equal(one.changedLabel, '2 min ago')
  assert.equal(one.onThisMachine, true)
  assert.equal(one.sizeLabel, '1.48 GB')
  const three = tree[1].episodes[0]
  assert.equal(three.durationLabel, 'target 1:30')
  assert.equal(three.changedLabel, '3 days ago')
  assert.equal(three.onThisMachine, false)
  assert.equal(three.sizeLabel, null)
  assert.equal(tree[0].episodes[1].durationLabel, '—')
  assert.equal(tree[2].episodes[0].changedLabel, '—')
})

test('status chips cover every StoryBook episode status', () => {
  assert.equal(statusChip('generating').tone, 'busy')
  assert.equal(statusChip('editing').label, 'Editing')
  assert.equal(statusChip('ready').tone, 'good')
  assert.equal(statusChip('published').label, 'Published')
  assert.equal(statusChip('draft').label, 'Draft')
  assert.equal(statusChip('weird').label, 'weird')
  assert.equal(formatAgo('2026-10-04T21:00:00Z', NOW), '1 h ago')
})

test('the package size sums every media file the package names, once per key', () => {
  const bytes = packageBytes(pkg)
  assert.ok(bytes > 0)
  const keys = new Set()
  let expected = 0
  const add = (media) => {
    if (!media?.key || !Number.isFinite(media.bytes) || keys.has(media.key)) return
    keys.add(media.key)
    expected += media.bytes
  }
  for (const shot of pkg.shots) [shot.video, shot.firstFrame, shot.lastFrame].forEach(add)
  for (const line of pkg.dialogue) add(line.audio)
  for (const track of pkg.audioTracks) add(track.media)
  for (const dub of pkg.dubbed) for (const line of dub.lines) add(line.audio)
  for (const character of pkg.characters) for (const image of character.referenceImages) add(image)
  assert.equal(bytes, expected)
  assert.equal(packageBytes(null), null)
})

test('pull progress reads phase, files and bytes; a failure says what failed', () => {
  assert.deepEqual(jobProgressView({ phase: 'download', status: 'running', done: 7, total: 20, bytes: 512_000_000 }), {
    label: 'Downloading media', percent: 35, detail: '7 of 20 files · 512.0 MB', failed: false, finished: false,
  })
  assert.equal(jobProgressView({ phase: 'done', status: 'done', done: 20, total: 20, bytes: 1 }).percent, 100)
  assert.deepEqual(jobProgressView({ phase: 'probe', status: 'failed', error: 'ffprobe is missing', done: 0, total: 0, bytes: 0 }), {
    label: 'Could not open the episode', percent: 0, detail: 'ffprobe is missing', failed: true, finished: true,
  })
})

test('closing or quitting prompts while a plan waits for approval or a delivery is in flight', () => {
  assert.equal(pendingWorkPrompt({ plans: [], delivery: null }), null)
  assert.equal(pendingWorkPrompt({ plans: [{ planId: 'p', status: 'applied' }], delivery: { status: 'sent' } }), null)
  const prompt = pendingWorkPrompt({
    plans: [{ planId: 'p', status: 'proposed', instruction: 'make it 90 seconds' }],
    delivery: { status: 'sending' },
  }, 'quit')
  assert.equal(prompt.title, 'Quit with work in progress?')
  assert.deepEqual(prompt.reasons, [
    'The plan “make it 90 seconds” has not been approved. It will be discarded.',
    'A delivery to StoryBook is still sending. Quitting stops it; finished files are kept and you can send again.',
  ])
  assert.equal(pendingWorkPrompt({ plans: [{ planId: 'p', status: 'applying' }], delivery: null }, 'close').title, 'Close the project with work in progress?')
})

test('crash recovery offers the version before the plan only when a plan was being applied', () => {
  const versions = [
    { id: 'v1', name: 'Rough cut', createdBy: 'internal', createdAt: '2026-10-04T20:00:00.000Z' },
    { id: 'v2', name: 'make it 90 seconds', createdBy: 'ai', createdAt: '2026-10-04T20:05:01.000Z' },
  ]
  const journal = planJournalEntry({ planId: 'p', instruction: 'make it 90 seconds', parentVersionId: 'v1', startedAt: '2026-10-04T20:05:00.000Z' })
  assert.equal(journal.status, 'applying')
  // The version the apply created holds the document before the plan's first step.
  assert.deepEqual(recoveryOffer({ journal, versions }), { planId: 'p', instruction: 'make it 90 seconds', versionId: 'v2', versionName: 'make it 90 seconds' })
  assert.deepEqual(recoveryOffer({ journal: { ...journal, versionId: 'v2' }, versions }).versionId, 'v2')
  // Finished, or crashed before anything changed: nothing to offer.
  assert.equal(recoveryOffer({ journal: { ...journal, status: 'done' }, versions }), null)
  assert.equal(recoveryOffer({ journal, versions: versions.slice(0, 1) }), null)
  assert.equal(recoveryOffer({ journal: null, versions }), null)
})
