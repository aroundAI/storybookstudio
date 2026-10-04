// FILM-2013: the scene map and studio_get_context's assembly from a built
// rough cut, scope resolution, the TARGET_CHANGED fingerprint and search.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildSceneMap, documentFingerprint, resolveScope, searchAssets, summarizeContext } from '../../src/studio/context.js'
import { contextFor, roughCut } from './helpers/compile-fixture.mjs'

test('the scene map lists every screenplay scene with its clips, planned, actual and target duration', () => {
  const context = contextFor()
  assert.deepEqual(context.sceneMap.map((entry) => [entry.scene, entry.start, entry.end, entry.plannedDuration, entry.actualDuration, entry.targetDuration]), [
    [1, 0, 19, 19, 19, 19],
    [2, 19, 39, 20, 20, 20],
    [3, 39, 60, 21, 21, 21],
    [4, 60, 79, 19, 19, 19],
    [5, 79, 99, 20, 20, 20],
  ])
  // The target is the episode's 99 s shared by planned length; a 60 s policy target scales each scene.
  assert.deepEqual(contextFor({ policy: { targetDurationSeconds: 60 } }).sceneMap.map((entry) => entry.targetDuration), [11.515, 12.121, 12.727, 11.515, 12.121])
  const scene3 = context.sceneMap[2]
  assert.equal(scene3.heading, 'INT. RESEARCH LAB - NIGHT (3)')
  assert.equal(scene3.shotClipIds.length, 4)
  // 4 shots, 4 shot-audio clips and 8 dialogue clips carry scene 3.
  assert.equal(scene3.clipIds.length, 16)
  assert.equal(context.target.seconds, 99)
  assert.equal(context.target.source, 'episode')
})

test('a scene with no clip still appears, with actual duration 0, so a coverage gap shows', () => {
  const context = contextFor({ mutate: (project) => { project.timelines[0].clips = project.timelines[0].clips.filter((clip) => clip.metadata?.semantic?.scene !== 2) } })
  const scene2 = context.sceneMap.find((entry) => entry.scene === 2)
  assert.deepEqual([scene2.actualDuration, scene2.clipIds, scene2.start], [0, [], null])
  const map = buildSceneMap({ timeline: { clips: [], tracks: [] }, screenplay: [{ scene: 7, heading: 'EXT. ROOF', estimatedDurationSeconds: 10 }] })
  assert.deepEqual(map.map((entry) => [entry.scene, entry.actualDuration, entry.targetDuration]), [[7, 0, null]])
})

test('the screenplay carries every line\'s text and the clips that play it; the policy and brand come from storybook/', () => {
  const context = contextFor()
  const scene3 = context.screenplay.find((scene) => scene.scene === 3)
  assert.equal(scene3.dialogue.length, 8)
  assert.equal(scene3.dialogue[0].text, 'Line 17: MAYA says what the scene needs, in about ten words.')
  assert.equal(scene3.dialogue[0].clipIds.length, 1)
  assert.equal(context.policySource, 'storybook/policy.json')
  assert.equal(context.policy.minShotLength, 1.2)
  assert.equal(context.brand.fonts.heading, 'Inter')
  const defaults = contextFor({ policy: {}, brand: {}, pkg: { ...roughCut().pkg, editPolicy: undefined } })
  assert.equal(defaults.policy.maxShotLength, 6)
})

test('studio_get_context\'s summary: scoped screenplay and scene map, timeline summary, versions, user edits, QA slot', () => {
  const context = contextFor({ versions: [{ id: 'v1', name: 'Rough cut', parent: null, createdBy: 'ai', createdAt: 't', prompt: null, opRange: [1, null] }], currentVersionId: 'v1' })
  const summary = summarizeContext(context, { scene: 3 })
  assert.deepEqual(summary.sceneMap.map((entry) => entry.scene), [3])
  assert.deepEqual(summary.screenplay.map((scene) => scene.scene), [3])
  assert.equal(summary.timeline.duration, 99)
  assert.equal(summary.timeline.shotCount, 20)
  assert.equal(summary.timeline.dialogueClipCount, 40)
  assert.deepEqual(summary.timeline.tracks.find((track) => track.role === 'captions'), { id: 'video-2', name: 'Captions (en)', type: 'video', role: 'captions', bus: null, language: 'en', muted: false, locked: false, clipCount: 1 })
  assert.deepEqual(summary.versions.map((version) => version.id), ['v1'])
  assert.equal(summary.currentVersionId, 'v1')
  assert.deepEqual(summary.userEditedClipIds, [])
  assert.equal(summary.lastQa, null)
  assert.equal(summary.brand.source, 'storybook/brand.json')
  assert.ok(!('document' in summary) && !('timeline' in summary && Array.isArray(summary.timeline.clips)), 'the summary carries no clip list')
})

test('scope: scene, scenes, range and clipIds resolve to scenes; an unknown scene or another timeline is refused', () => {
  const context = contextFor()
  assert.deepEqual(resolveScope(context, {}).scenes, [1, 2, 3, 4, 5])
  assert.equal(resolveScope(context, {}).whole, true)
  assert.deepEqual(resolveScope(context, { scene: 3 }).scenes, [3])
  assert.deepEqual(resolveScope(context, { scenes: [4, 2] }).scenes, [2, 4])
  assert.deepEqual(resolveScope(context, { range: [50, 65] }).scenes, [3, 4])
  const s5 = context.timeline.clips.find((clip) => clip.metadata?.semantic?.scene === 5)
  assert.deepEqual(resolveScope(context, { clipIds: [s5.id] }).scenes, [5])
  assert.throws(() => resolveScope(context, { scene: 6 }), (error) => error.code === 'VALIDATION_FAILED' && /Scene 6 is not in this episode/.test(error.message))
  assert.throws(() => resolveScope(context, { timelineId: 'tl-other' }), /not the active timeline/)
})

test('the fingerprint changes with any clip, track, transition or marker change, and with nothing else', () => {
  const { project } = roughCut()
  const document = { currentTimelineId: project.currentTimelineId, timelines: project.timelines, assets: project.assets }
  const same = documentFingerprint(JSON.parse(JSON.stringify(document)))
  assert.equal(documentFingerprint(document), same)
  const trimmed = JSON.parse(JSON.stringify(document))
  trimmed.timelines[0].clips[0].duration -= 1 / 24
  assert.notEqual(documentFingerprint(trimmed), same)
  const moved = JSON.parse(JSON.stringify(document))
  moved.timelines[0].markers[0].time += 1
  assert.notEqual(documentFingerprint(moved), same)
  const assetsOnly = JSON.parse(JSON.stringify(document))
  assetsOnly.assets[0].name = 'renamed'
  assert.equal(documentFingerprint(assetsOnly), same)
})

test('studio_search_assets ranks by name, transcript, then semantic text, and filters by role and scene', () => {
  const context = contextFor()
  const lines = searchAssets(context, { query: 'Line 18', role: 'dialogue' })
  assert.equal(lines[0].transcript, 'Line 18: ARJUN says what the scene needs, in about ten words.')
  assert.ok(lines[0].score >= lines.at(-1).score)
  const scene3Shots = searchAssets(context, { query: 'alarm', role: 'generated_video', scene: 3 })
  assert.deepEqual(scene3Shots.map((asset) => asset.name.slice(0, 4)), ['S3.1', 'S3.2', 'S3.3', 'S3.4'])
  // Each shot asset plays twice: its picture and its own linked sound.
  assert.ok(scene3Shots.every((asset) => asset.onTimeline.length === 2))
  assert.deepEqual(searchAssets(context, { query: 'zebra' }), [])
})
