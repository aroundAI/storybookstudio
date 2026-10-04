// FILM-2017 AC2 and AC4: variant timelines from the 20-shot rough cut
// (FILM-2012's builder output for FILM-2001's fixture).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  HOOK_SECONDS,
  VERTICAL_CAPTION_SAFE_AREA,
  buildHookVariants,
  buildShortVariant,
  embedKeyframes,
  lineImportance,
  soundBites,
  timelineEnd,
  trimTimelineToRange,
} from '../../src/studio/intents/variants.js'

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/rough-cut/20-shots.snapshot.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(readFileSync(new URL('./fixtures/edit-package/20-shots.json', import.meta.url), 'utf8'))
const project = () => structuredClone(snapshot.project)
const NOW = () => new Date('2026-10-04T20:00:00.000Z')

// Give some lines the words a hook is made of.
function withStrongLines() {
  const p = project()
  const set = (sequence, text, emotion) => {
    const clip = p.timelines[0].clips.find((c) => c.metadata?.storybook?.sequenceNumber === sequence && c.metadata?.semantic?.role === 'dialogue')
    const asset = p.assets.find((a) => a.id === clip.assetId)
    asset.semantic = { ...asset.semantic, text, emotion }
    return clip
  }
  return { p, l12: set(12, 'Who cut the power?', 'shocked'), l30: set(30, 'Run!', 'afraid'), l7: set(7, 'We have ten minutes before the backup fails, maybe less.', 'tense') }
}

test('sound bites rank by the hook weights (emotion, question, exclamation, brevity)', () => {
  assert.equal(lineImportance({ text: 'Who cut the power?', emotion: 'shocked' }), 0.65)
  assert.equal(lineImportance({ text: 'Run!', emotion: 'afraid' }), 0.6)
  const { p, l12, l30 } = withStrongLines()
  const { source, bites } = soundBites(p)
  assert.equal(source, 'analysis')
  assert.equal(bites.length, 40)
  assert.deepEqual(bites.slice(0, 2).map((bite) => bite.clipId), [l12.id, l30.id])
})

test('with no line text the bites rank by dialogue energy; with neither there are none', () => {
  const p = project()
  const dialogue = new Set(p.timelines[0].clips.filter((c) => c.metadata?.semantic?.role === 'dialogue').map((c) => c.assetId))
  let loud = null
  p.assets.filter((a) => dialogue.has(a.id)).forEach((asset, index) => {
    delete asset.semantic.text
    asset.analysis = { loudnessLufs: index === 17 ? -9 : -20 - (index % 5) }
    if (index === 17) loud = asset.id
  })
  const { source, bites } = soundBites(p)
  assert.equal(source, 'energy')
  assert.equal(p.timelines[0].clips.find((c) => c.id === bites[0].clipId).assetId, loud)
  for (const asset of p.assets) delete asset.analysis
  assert.deepEqual(soundBites(p), { source: null, bites: [] })
})

test('hook variants: N five-second openings from the strongest bites, never two from one shot', () => {
  const { p, l12, l30 } = withStrongLines()
  const { signal, variants } = buildHookVariants(p, { variants: 3, now: NOW })
  assert.equal(signal, 'analysis')
  assert.equal(variants.length, 3)
  assert.deepEqual(variants.map((v) => v.bite.clipId).slice(0, 2), [l12.id, l30.id])
  for (const [index, { timeline, range }] of variants.entries()) {
    assert.equal(timeline.id, `timeline-hook-${index + 1}`)
    assert.equal(timeline.studio.kind, 'variant')
    assert.equal(timeline.studio.variantKind, 'hook')
    assert.equal(timeline.studio.variantOf, p.timelines[0].id)
    assert.ok(Math.abs(range[1] - range[0] - HOOK_SECONDS) < 1e-6)
    assert.ok(Math.abs(timelineEnd(timeline) - HOOK_SECONDS) < 1e-6, `${timeline.id} ends at ${timelineEnd(timeline)}`)
    // The line plays inside its opening.
    const line = timeline.clips.find((clip) => clip.id === variants[index].bite.clipId)
    assert.ok(line, 'the bite is in its own opening')
  }
  assert.equal(new Set(variants.map((v) => v.range[0])).size, 3)
  assert.throws(() => buildHookVariants(p, { variants: 9 }), (error) => error.code === 'VALIDATION_FAILED')
})

test('a short from a StoryBook shorts candidate: 9:16 variant of the range, captions in the vertical safe area', () => {
  const p = project()
  const candidate = pkg.shortsCandidates[0]
  const built = buildShortVariant(p, { source: { candidateId: candidate.id }, shortsCandidates: pkg.shortsCandidates, now: NOW })
  const { timeline } = built
  assert.deepEqual(timeline.studio, {
    ...p.timelines[0].studio,
    kind: 'variant',
    variantKind: 'short',
    variantOf: p.timelines[0].id,
    aspect: '9:16',
    preset: 'shorts_9x16',
    language: 'en',
    range: [4, 22],
    source: { kind: 'candidate', candidateId: candidate.id, title: 'Who cut the power?', hookType: 'question' },
    reframeWarnings: [],
  })
  assert.equal(timeline.width, 1080)
  assert.equal(timeline.height, 1920)
  assert.equal(built.expectedDuration, 18)
  assert.equal(built.overMaxDuration, false)
  assert.equal(built.durationNote, "18 s, within shorts_9x16's 180 s limit.")
  assert.ok(Math.abs(timelineEnd(timeline) - 18) < 1e-6)
  for (const clip of timeline.clips) assert.ok(clip.startTime >= -1e-9 && clip.startTime + clip.duration <= 18 + 1e-6, clip.id)
  // The master is untouched.
  assert.equal(p.timelines.length, 1)
  assert.deepEqual(p.timelines[0], snapshot.project.timelines[0])
  // Captions: re-placed for 9:16, shifted to the range.
  const captions = timeline.clips.find((clip) => clip.type === 'captions')
  assert.ok(built.captionsPlaced > 0)
  for (const cue of captions.captions.cues) {
    assert.deepEqual(cue.globalOverrides.safeArea, VERTICAL_CAPTION_SAFE_AREA)
    assert.ok(cue.start >= 0 && cue.end <= captions.duration + 1e-6)
  }
})

test('a short\'s clips are trimmed at the range edges in source time', () => {
  const p = project()
  const shot = p.timelines[0].clips.find((c) => c.type === 'video' && c.startTime < 5 && c.startTime + c.duration > 5)
  const trimmed = trimTimelineToRange(p.timelines[0], 5, 9)
  const copy = trimmed.clips.find((c) => c.id === shot.id)
  assert.equal(copy.startTime, 0)
  assert.ok(Math.abs(copy.trimStart - (shot.trimStart + (5 - shot.startTime))) < 1e-6)
  assert.ok(Math.abs(copy.duration - (shot.startTime + shot.duration - 5)) < 1e-6)
})

test('a short over the preset\'s limit is built and flagged; a hook short ends on a cut', () => {
  const p = project()
  const long = buildShortVariant(p, { source: { range: [0, 98.5] }, presetName: 'shorts_9x16', now: NOW })
  assert.equal(long.overMaxDuration, false, 'Shorts take 180 s')
  const { p: strong } = withStrongLines()
  const hook = buildShortVariant(strong, { source: { hook: true }, presetName: 'reels_9x16', now: NOW })
  assert.equal(hook.range.from.kind, 'hook')
  const cuts = new Set(strong.timelines[0].clips.filter((c) => c.type === 'video').flatMap((c) => [c.startTime, c.startTime + c.duration].map((t) => Math.round(t * 1000) / 1000)))
  assert.ok(cuts.has(hook.range.start) && cuts.has(hook.range.end), JSON.stringify(hook.range))
  assert.ok(hook.expectedDuration <= 180)
  // A 200-second cut is over the 180 s Shorts limit: built, and flagged.
  const longer = project()
  const last = longer.timelines[0].clips.filter((c) => c.type === 'video').at(-1)
  last.duration = 200 - last.startTime
  const over = buildShortVariant(longer, { source: { range: [0, 200] }, presetName: 'shorts_9x16', now: NOW })
  assert.equal(over.expectedDuration, 200)
  assert.equal(over.overMaxDuration, true)
  assert.equal(over.durationNote, "200 s is over shorts_9x16's 180 s limit; trim it before delivering.")
  assert.throws(() => buildShortVariant(p, { source: { range: [0, 10] }, presetName: 'youtube_16x9' }), (error) => error.code === 'VALIDATION_FAILED')
  assert.throws(() => buildShortVariant(p, { source: { candidateId: 'nope' }, shortsCandidates: pkg.shortsCandidates }), /not in the episode's package/)
})

test('keyframes embedded in a document match what set_clip_keyframes stores', () => {
  const p = project()
  const clip = p.timelines[0].clips.find((c) => c.type === 'video')
  embedKeyframes(p.timelines[0], [{ clipId: clip.id, keyframes: [
    { property: 'positionX', timeSeconds: 2, value: -100, easing: 'easeInOut' },
    { property: 'positionX', timeSeconds: 0, value: 50, easing: 'easeInOut' },
    { property: 'scaleX', timeSeconds: 0, value: 316, easing: 'hold' },
  ] }])
  assert.deepEqual(clip.keyframes, {
    positionX: [{ time: 0, value: 50, easing: 'easeInOut' }, { time: 2, value: -100, easing: 'easeInOut' }],
    scaleX: [{ time: 0, value: 316, easing: 'hold' }],
  })
})
