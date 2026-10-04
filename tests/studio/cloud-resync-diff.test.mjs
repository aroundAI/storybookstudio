// FILM-2011 AC5 / test plan "Etag diff": a changed shot, a new dialogue line
// and a removed shot each produce the right plan entries. Media are diffed
// by `key` (FILM-2001: the stable identity; sha256 is usually null), rows by
// id. The plan is a proposal: every step is previewOnly and carries a reason.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { diffEditPackages, buildResyncPlan, localMediaName } = require('../../electron/studio/packageDiff.js')

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ref = (key, extra = {}) => ({ url: `https://r2.example/${key}?sig=1`, key, sha256: null, sha256Reason: 'not_recorded', bytes: 1000, mime: key.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4', ...extra })

function shot(n, overrides = {}) {
  return {
    id: uuid(100 + n),
    sceneNumber: Math.ceil(n / 2),
    shotNumber: n,
    sequenceNumber: n,
    status: 'completed',
    durationSeconds: 4,
    sourceDurationSeconds: 4,
    timelineStartSeconds: (n - 1) * 4,
    trimInSeconds: null,
    trimOutSeconds: null,
    transitionType: 'cut',
    prompt: `shot ${n}`,
    video: ref(`episodes/p/e/shots/${n}.mp4`),
    firstFrame: { url: null, mediaReason: 'not_generated' },
    lastFrame: { url: null, mediaReason: 'not_generated' },
    ...overrides,
  }
}

function line(n, overrides = {}) {
  return {
    id: uuid(200 + n),
    shotId: uuid(100 + n),
    sceneNumber: Math.ceil(n / 2),
    sequenceNumber: n,
    characterName: 'MAYA',
    text: `line ${n}`,
    language: 'en',
    timelineStartSeconds: (n - 1) * 4 + 0.5,
    estimatedDurationSeconds: 2,
    status: 'voiced',
    audio: ref(`audio/p/dialogue/${n}.mp3`),
    ...overrides,
  }
}

function pkg(etag, { shots, dialogue }) {
  return { etag, shots, dialogue, audioTracks: [], captions: [], dubbed: [], characters: [] }
}

// The project as the builder saved it: one clip per shot on video-1, one per
// line on the English dialogue track, each tagged with its StoryBook row the
// way FILM-2012's builder tags them.
function project(shots, dialogue) {
  return {
    currentTimelineId: 'tl-master',
    timelines: [
      {
        id: 'tl-master',
        tracks: [
          { id: 'video-1', type: 'video' },
          { id: 'dialogue-en', type: 'audio', name: 'Dialogue (en)' },
        ],
        clips: [
          ...shots.map((s) => ({ id: `clip-shot-${s.sequenceNumber}`, trackId: 'video-1', type: 'video', metadata: { semantic: { scene: s.sceneNumber, shotId: s.id, role: 'generated_video' } } })),
          // Shot audio rides with the shot id too, on its own track: not a shot clip.
          ...shots.map((s) => ({ id: `clip-shotaudio-${s.sequenceNumber}`, trackId: 'shot-audio', type: 'audio', metadata: { semantic: { scene: s.sceneNumber, shotId: s.id, role: 'sfx' } } })),
          ...dialogue.map((d) => ({ id: `clip-line-${d.sequenceNumber}`, trackId: 'dialogue-en', type: 'audio', metadata: { semantic: { scene: d.sceneNumber, shotId: d.shotId, role: 'dialogue' }, language: 'en', storybook: { dialogueId: d.id } } })),
        ],
      },
    ],
  }
}

const before = pkg('v3-aaa', { shots: [shot(1), shot(2), shot(3)], dialogue: [line(1), line(2)] })
const after = pkg('v4-bbb', {
  shots: [
    shot(1),
    shot(2, { video: ref('episodes/p/e/shots/2-regenerated.mp4') }), // regenerated
    // shot 3 removed
  ],
  dialogue: [line(1), line(2), line(3, { shotId: uuid(102), timelineStartSeconds: 6.25 })], // new line
})

test('the diff names a changed shot by its media key, a removed shot and a new line', () => {
  const diff = diffEditPackages(before, after)
  assert.deepEqual(diff.etag, { from: 'v3-aaa', to: 'v4-bbb' })
  assert.deepEqual(diff.shots.changed.map((c) => [c.id, c.media]), [[uuid(102), ['video']]])
  assert.deepEqual(diff.shots.changed[0].keys.video, { from: 'episodes/p/e/shots/2.mp4', to: 'episodes/p/e/shots/2-regenerated.mp4' })
  assert.deepEqual(diff.shots.removed.map((s) => s.id), [uuid(103)])
  assert.deepEqual(diff.shots.added, [])
  assert.deepEqual(diff.dialogue.added.map((d) => d.id), [uuid(203)])
  assert.deepEqual(diff.dialogue.changed, [])
  assert.deepEqual(diff.dialogue.removed, [])
})

test('a new signed URL for the same key is not a change', () => {
  const resigned = pkg('v3-aaa', {
    shots: before.shots.map((s) => ({ ...s, video: { ...s.video, url: `${s.video.url}&again=1` } })),
    dialogue: before.dialogue,
  })
  const diff = diffEditPackages(before, resigned)
  assert.equal(diff.shots.changed.length + diff.shots.added.length + diff.shots.removed.length, 0)
})

test('the plan imports new media under new names and replaces, adds and deletes the right clips, all as previews', () => {
  const diff = diffEditPackages(before, after)
  const assetPaths = {
    'episodes/p/e/shots/2-regenerated.mp4': '/p/assets/shots/' + localMediaName({ role: 'shot_video', sequenceNumber: 2, key: 'episodes/p/e/shots/2-regenerated.mp4', mime: 'video/mp4' }),
    'audio/p/dialogue/3.mp3': '/p/assets/dialogue/en/' + localMediaName({ role: 'dialogue_audio', sequenceNumber: 3, key: 'audio/p/dialogue/3.mp3', mime: 'audio/mpeg' }),
  }
  const { steps, unresolved } = buildResyncPlan({ diff, next: after, project: project(before.shots, before.dialogue), assetPaths })

  assert.deepEqual(unresolved, [])
  assert.deepEqual(
    steps.map((s) => [s.tool, s.arguments.clipId ?? s.arguments.clipIds ?? s.arguments.trackId ?? s.arguments.path]),
    [
      ['import_asset_from_path', assetPaths['episodes/p/e/shots/2-regenerated.mp4']],
      ['replace_clip_with_asset', 'clip-shot-2'],
      ['delete_clips', ['clip-shot-3']],
      ['import_asset_from_path', assetPaths['audio/p/dialogue/3.mp3']],
      ['add_asset_to_timeline', 'dialogue-en'],
    ],
  )
  const replace = steps[1].arguments
  assert.equal(replace.assetName, assetPaths['episodes/p/e/shots/2-regenerated.mp4'].split('/').pop())
  assert.equal(steps[4].arguments.startSeconds, 6.25)
  for (const step of steps) {
    assert.equal(step.arguments.previewOnly, true, `${step.tool} is a preview`)
    assert.ok(step.reason && step.arguments.studioMeta?.reason === step.reason, `${step.tool} carries its reason`)
  }
  assert.match(steps[1].reason, /shot 2/i)
  assert.match(steps[2].reason, /removed/i)
})

test('a changed file lands under a new local name; the same key keeps its name', () => {
  const a = localMediaName({ role: 'shot_video', sequenceNumber: 2, key: 'episodes/p/e/shots/2.mp4', mime: 'video/mp4' })
  const b = localMediaName({ role: 'shot_video', sequenceNumber: 2, key: 'episodes/p/e/shots/2-regenerated.mp4', mime: 'video/mp4' })
  assert.notEqual(a, b)
  assert.equal(a, localMediaName({ role: 'shot_video', sequenceNumber: 2, key: 'episodes/p/e/shots/2.mp4', mime: 'video/mp4' }))
  assert.match(a, /^shot-002-[0-9a-f]{8}\.mp4$/)
})

test('a row the project has no clip for is reported, not guessed', () => {
  const diff = diffEditPackages(before, after)
  const bare = project([], [])
  const { steps, unresolved } = buildResyncPlan({ diff, next: after, project: bare, assetPaths: {} })
  assert.ok(unresolved.some((u) => u.kind === 'shot' && u.id === uuid(102)))
  assert.ok(unresolved.some((u) => u.kind === 'shot' && u.id === uuid(103)))
  assert.equal(steps.filter((s) => s.tool === 'replace_clip_with_asset' || s.tool === 'delete_clips').length, 0)
})
