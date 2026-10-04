// FILM-2015: the scene strip, one segment per scene from the timeline's
// scene markers and storybook/package.json, target vs actual duration, red
// when a scene runs over its target by more than the tolerance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildSceneSegments, scopeForSegment, DEFAULT_SCENE_TOLERANCE } from '../../../src/studio/ui/sceneStrip.js'

const snapshot = JSON.parse(readFileSync(new URL('../fixtures/rough-cut/20-shots.snapshot.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(readFileSync(new URL('../fixtures/edit-package/20-shots.json', import.meta.url), 'utf8'))
const timeline = () => JSON.parse(JSON.stringify(snapshot.project.timelines[0]))

test('the 20-shot rough cut gives five segments whose actuals match the screenplay targets', () => {
  const strip = buildSceneSegments({ timeline: timeline(), pkg })
  assert.equal(strip.segments.length, 5)
  assert.deepEqual(strip.segments.map((s) => [s.scene, s.heading, s.actual, s.target, s.over]), [
    [1, 'INT. RESEARCH LAB - NIGHT (1)', 19, 19, false],
    [2, 'INT. RESEARCH LAB - NIGHT (2)', 20, 20, false],
    [3, 'INT. RESEARCH LAB - NIGHT (3)', 21, 21, false],
    [4, 'INT. RESEARCH LAB - NIGHT (4)', 19, 19, false],
    [5, 'INT. RESEARCH LAB - NIGHT (5)', 20, 20, false],
  ])
  assert.equal(strip.total.actual, 99)
  assert.equal(strip.total.target, 99)
  assert.equal(strip.segments[0].start, 0)
  assert.equal(strip.segments[1].start, 19)
})

test('a scene over its target by more than the tolerance is red; within it is not', () => {
  const t = timeline()
  // Scene 3 grows 1.5 s (7%): within the default 10%.
  t.clips.find((c) => c.id === 'clip-12').duration += 1.5
  let strip = buildSceneSegments({ timeline: t, pkg })
  assert.equal(strip.segments[2].actual, 22.5)
  assert.equal(strip.segments[2].over, false)
  // Another 1.5 s (14%): over.
  t.clips.find((c) => c.id === 'clip-12').duration += 1.5
  strip = buildSceneSegments({ timeline: t, pkg })
  assert.equal(strip.segments[2].over, true)
  assert.equal(strip.segments[2].overBy, 3)
  assert.equal(strip.segments[2].label, 'Scene 3 · 24.0 s of 21.0 s, 3.0 s over')
  // A policy tolerance replaces the default.
  strip = buildSceneSegments({ timeline: t, pkg, policy: { sceneDurationTolerance: 0.2 } })
  assert.equal(strip.segments[2].over, false)
  assert.equal(DEFAULT_SCENE_TOLERANCE, 0.1)
})

test('a scene without a planned duration has no target and is never red', () => {
  const p = JSON.parse(JSON.stringify(pkg))
  p.scenes[0].estimatedDurationSeconds = null
  const strip = buildSceneSegments({ timeline: timeline(), pkg: p })
  assert.equal(strip.segments[0].target, null)
  assert.equal(strip.segments[0].over, false)
  assert.equal(strip.segments[0].label, 'Scene 1 · 19.0 s, no target')
})

test('a trimmed scene shrinks, and audio-only and caption clips do not count', () => {
  const t = timeline()
  t.clips = t.clips.filter((c) => c.id !== 'clip-4')
  const strip = buildSceneSegments({ timeline: t, pkg })
  assert.equal(strip.segments[0].actual, 15)
  // Shot audio clip-64 stays at 15..19 but is audio: it does not stretch scene 1.
})

test('without the package, headings come from the markers and targets are unknown', () => {
  const strip = buildSceneSegments({ timeline: timeline(), pkg: null })
  assert.equal(strip.segments[3].heading, 'INT. RESEARCH LAB - NIGHT (4)')
  assert.equal(strip.segments[3].target, null)
})

test('a project that is not from StoryBook (no scene clips) has no strip', () => {
  const t = timeline()
  for (const clip of t.clips) delete clip.metadata
  t.markers = []
  assert.equal(buildSceneSegments({ timeline: t, pkg: null }).segments.length, 0)
})

test('clicking a segment selects every clip of that scene and scopes the next instruction', () => {
  const strip = buildSceneSegments({ timeline: timeline(), pkg })
  const scope = scopeForSegment(strip.segments[0])
  assert.deepEqual(scope.scenes, [1])
  // Four shots, four shot-audio clips, eight dialogue lines.
  assert.equal(scope.clipIds.length, 16)
  assert.ok(scope.clipIds.includes('clip-1') && scope.clipIds.includes('clip-61') && scope.clipIds.includes('clip-21'))
  assert.equal(scope.label, 'Scene 1 · INT. RESEARCH LAB - NIGHT (1)')
})
