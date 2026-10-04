// The rough-cut builder (FILM-2012 AC3, AC4): snapshots on the three
// FILM-2001 fixture packages and the rules behind them.
// UPDATE_SNAPSHOTS=1 rewrites tests/studio/fixtures/rough-cut/*.snapshot.json.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildProject, DEFAULT_DUCK_DB, dimensionsForAspect, packageForDisk, SHOT_TRACK_ID, volumeToGainDb } from '../../src/studio/projectBuilder.js'
import { ASSET_ROLES, validateEditGraphProject } from '../../src/studio/contracts/editgraph.schema.js'
import { EditPackageSchema } from '../../src/studio/contracts/edit-package.schema.mjs'
import { BrandSchema } from '../../src/studio/contracts/brand.schema.mjs'
import { EditPolicySchema } from '../../src/studio/contracts/edit-policy.schema.mjs'
import { clipsOn, FIXTURE_SIZES, fixturePath, loadFixture, probesFor, snapshotOf, snapshotPath, trackById, tracksWhere } from './helpers/rough-cut.mjs'

const build = (pkg, extra = {}) => buildProject({ package: pkg, probedAssets: probesFor(pkg), ...extra })
const clone = (value) => JSON.parse(JSON.stringify(value))
const end = (clip) => clip.startTime + clip.duration
const onFrame = (seconds, fps = 24) => Math.round(seconds * fps) / fps

for (const shots of FIXTURE_SIZES) {
  test(`${shots}-shot package: the rough cut matches its snapshot`, () => {
    const actual = JSON.parse(JSON.stringify(snapshotOf(build(loadFixture(shots)))))
    const file = fileURLToPath(snapshotPath(shots))
    if (process.env.UPDATE_SNAPSHOTS === '1') {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`)
    }
    assert.ok(existsSync(file), `no snapshot at ${file}: run with UPDATE_SNAPSHOTS=1 and review it`)
    assert.deepEqual(actual, JSON.parse(readFileSync(file, 'utf8')))
  })

  test(`${shots}-shot package: the project validates as EditGraph v1 and is one master timeline at the episode's aspect and fps`, () => {
    const pkg = loadFixture(shots)
    const { project } = build(pkg)
    const result = validateEditGraphProject(project)
    assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues.slice(0, 3)))
    assert.equal(project.version, '1.2')
    assert.equal(project.studio.schema, 'editgraph/1')
    assert.equal(project.studio.episodeId, pkg.episode.id)
    assert.equal(project.timelines.length, 1)
    const [timeline] = project.timelines
    assert.equal(project.currentTimelineId, timeline.id)
    assert.deepEqual(timeline.studio, { kind: 'master', variantOf: null, aspect: pkg.episode.aspect, language: pkg.episode.language })
    assert.equal(timeline.fps, pkg.episode.fps)
    assert.deepEqual({ width: timeline.width, height: timeline.height }, dimensionsForAspect(pkg.episode.aspect))
    assert.deepEqual(project.settings, { width: 1920, height: 1080, fps: 24, aspectRatio: '1920:1080' })
  })

  test(`${shots}-shot package: every clip and asset carries semantic, a role from the taxonomy and its language dependency`, () => {
    const { project } = build(loadFixture(shots))
    for (const asset of project.assets) {
      assert.ok(asset.semantic && typeof asset.semantic === 'object', `asset ${asset.id} has no semantic`)
      assert.ok(ASSET_ROLES.includes(asset.role), `asset ${asset.id} role ${asset.role}`)
      assert.equal(asset.languageDependency, ['dialogue', 'caption'].includes(asset.role) ? 'language' : 'none', asset.id)
    }
    for (const clip of project.timelines[0].clips) {
      assert.ok(clip.metadata?.semantic, `clip ${clip.id} has no semantic`)
      assert.ok(ASSET_ROLES.includes(clip.metadata.semantic.role), `clip ${clip.id} role ${clip.metadata.semantic.role}`)
      assert.deepEqual(clip.metadata.origin, { versionId: null, opId: null, by: 'ai' })
    }
  })

  test(`${shots}-shot package: every shot is on video-1 at its planned start, and no track holds overlapping clips`, () => {
    const pkg = loadFixture(shots)
    const { project } = build(pkg)
    const shotClips = clipsOn(project, (clip) => clip.trackId === SHOT_TRACK_ID)
    assert.equal(shotClips.length, pkg.shots.length)
    for (const shot of pkg.shots) {
      const clip = shotClips.find((candidate) => candidate.metadata.semantic.shotId === shot.id)
      assert.equal(clip.startTime, onFrame(shot.timelineStartSeconds))
      assert.equal(clip.trimStart, shot.trimInSeconds ?? 0)
      assert.equal(clip.metadata.semantic.role, 'generated_video')
    }
    const byTrack = Map.groupBy(project.timelines[0].clips, (clip) => clip.trackId)
    for (const [trackId, clips] of byTrack) {
      const sorted = [...clips].sort((a, b) => a.startTime - b.startTime)
      for (let i = 1; i < sorted.length; i += 1) {
        assert.ok(sorted[i].startTime >= end(sorted[i - 1]) - 1e-6, `${trackId}: ${sorted[i - 1].id} overlaps ${sorted[i].id}`)
      }
    }
  })

  test(`${shots}-shot package: offline placeholders for the slots with no file, each listed in warnings`, () => {
    const pkg = loadFixture(shots)
    const { project, warnings } = build(pkg)
    const offline = project.assets.filter((asset) => asset.offline)
    const nullSlots = [
      ...pkg.shots.flatMap((shot) => [
        ['shot.video', shot.id, shot.video],
        ['shot.firstFrame', shot.id, shot.firstFrame],
        ['shot.lastFrame', shot.id, shot.lastFrame],
      ]),
      ...pkg.dialogue.map((line) => ['dialogue.audio', line.id, line.audio]),
      ...pkg.dubbed.flatMap((dub) => dub.lines.map((line) => ['dubbed.audio', line.id, line.audio])),
    ].filter(([source, , media]) => media.url === null && !(source.startsWith('shot.') && source !== 'shot.video' && media.mediaReason === 'not_generated'))
    assert.ok(nullSlots.some(([, , media]) => media.mediaReason === 'outside_project'), 'fixture has an outside_project slot')
    assert.ok(nullSlots.some(([, , media]) => media.mediaReason === 'missing'), 'fixture has a missing slot')
    assert.equal(offline.length, nullSlots.length)
    for (const [source, ref, media] of nullSlots) {
      const warning = warnings.find((candidate) => candidate.code === 'media_offline' && candidate.source === source && candidate.ref === ref)
      assert.ok(warning, `${source} ${ref} is not in warnings`)
      assert.equal(warning.reason, media.mediaReason)
      const asset = project.assets.find((candidate) => candidate.id === warning.assetId)
      assert.deepEqual(asset.offline, { reason: media.mediaReason })
      assert.equal(asset.path, null)
      assert.equal(asset.url, null)
    }
    // The shot with no video keeps its slot on video-1, ready for relink_asset.
    const unrendered = pkg.shots.find((shot) => shot.video.url === null)
    const slot = clipsOn(project, (clip) => clip.metadata.semantic.shotId === unrendered.id && clip.trackId === SHOT_TRACK_ID)
    assert.equal(slot.length, 1)
    assert.equal(slot[0].assetId, `sb-shot-${unrendered.id}`)
  })
}

test('a slot that was not downloaded is offline with reason not_downloaded', () => {
  const pkg = loadFixture(5)
  const key = pkg.shots[0].video.key
  const { project, warnings } = buildProject({ package: pkg, probedAssets: probesFor(pkg, { skip: new Set([key]) }) })
  const asset = project.assets.find((candidate) => candidate.id === `sb-shot-${pkg.shots[0].id}`)
  assert.deepEqual(asset.offline, { reason: 'not_downloaded' })
  assert.equal(asset.storybook.key, key)
  assert.ok(warnings.some((warning) => warning.code === 'media_offline' && warning.assetId === asset.id && warning.reason === 'not_downloaded' && warning.key === key))
  // No probe, no shot audio: the picture keeps its planned slot alone.
  assert.equal(clipsOn(project, (clip) => clip.assetId === asset.id).length, 1)
})

test('shots with no planned start are packed after the previous shot by sequence_number', () => {
  const pkg = loadFixture(5)
  const shuffled = clone(pkg)
  for (const shot of shuffled.shots) shot.timelineStartSeconds = null
  shuffled.shots.reverse()
  const { project, warnings } = build(shuffled)
  const placed = clipsOn(project, (clip) => clip.trackId === SHOT_TRACK_ID).sort((a, b) => a.startTime - b.startTime)
  const bySequence = [...pkg.shots].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
  assert.deepEqual(placed.map((clip) => clip.metadata.semantic.shotId), bySequence.map((shot) => shot.id))
  assert.equal(placed[0].startTime, 0)
  for (let i = 1; i < placed.length; i += 1) assert.equal(placed[i].startTime, end(placed[i - 1]))
  assert.equal(warnings.filter((warning) => warning.code === 'shot_packed').length, pkg.shots.length)

  // Mixed: a null start follows the shot before it, planned starts stay put.
  const mixed = clone(pkg)
  mixed.shots[2].timelineStartSeconds = null
  const mixedClips = clipsOn(build(mixed).project, (clip) => clip.trackId === SHOT_TRACK_ID)
  const second = mixedClips.find((clip) => clip.metadata.semantic.shotId === mixed.shots[1].id)
  const third = mixedClips.find((clip) => clip.metadata.semantic.shotId === mixed.shots[2].id)
  const fourth = mixedClips.find((clip) => clip.metadata.semantic.shotId === mixed.shots[3].id)
  assert.equal(third.startTime, end(second))
  assert.equal(fourth.startTime, onFrame(mixed.shots[3].timelineStartSeconds))
})

test('captions: one live captions clip per language on a role:captions track, the primary one showing', () => {
  const pkg = loadFixture(60)
  const { project } = build(pkg)
  const captionTracks = tracksWhere(project, (track) => track.role === 'captions')
  assert.deepEqual(captionTracks.map((track) => [track.language, track.type, track.visible]), [['en', 'video', true], ['hi', 'video', false]])
  for (const captionTrack of pkg.captions) {
    const track = captionTracks.find((candidate) => candidate.language === captionTrack.language)
    const [clip] = clipsOn(project, (candidate) => candidate.trackId === track.id)
    assert.equal(clip.type, 'captions')
    assert.equal(clip.assetId, null)
    assert.equal(clip.startTime, 0)
    assert.equal(clip.captions.preset.id, 'kinetic-traditional')
    assert.equal(clip.captions.cues.length, captionTrack.segments.length)
    const [segment] = [...captionTrack.segments].sort((a, b) => a.startSeconds - b.startSeconds)
    assert.deepEqual(clip.captions.cues[0], { id: `cue-${segment.id}`, start: segment.startSeconds, end: segment.endSeconds, text: segment.text })
    assert.equal(clip.duration, Math.max(...captionTrack.segments.map((s) => s.endSeconds)))
    assert.equal(clip.metadata.semantic.role, 'caption')
    assert.equal(clip.metadata.languageDependency, 'language')
  }
  // The first role:captions track is the one Velorn's placeLiveCaptions reuses.
  assert.equal(project.timelines[0].tracks.find((track) => track.role === 'captions').language, pkg.episode.language)

  const plain = clone(pkg)
  plain.editPolicy.captions.enabled = false
  assert.equal(tracksWhere(build(plain).project, (track) => track.role === 'captions').every((track) => track.visible === false), true)
})

test('markers: one per scene, named by its heading, at the first shot of the scene', () => {
  const pkg = loadFixture(20)
  const { project } = build(pkg)
  const { markers } = project.timelines[0]
  assert.equal(markers.length, pkg.scenes.length)
  for (const scene of pkg.scenes) {
    const marker = markers.find((candidate) => candidate.scene === scene.number)
    const first = [...pkg.shots].filter((shot) => shot.sceneNumber === scene.number).sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0]
    assert.equal(marker.label, scene.heading)
    assert.equal(marker.time, onFrame(first.timelineStartSeconds))
  }
  assert.deepEqual(markers.map((marker) => marker.id), markers.map((_, index) => `marker-${index + 1}`))
  assert.equal(project.timelines[0].markerCounter, markers.length + 1)
})

test('asset folders: one per scene, holding that scene\'s shots, frames and lines', () => {
  const pkg = loadFixture(20)
  const { project } = build(pkg)
  for (const scene of pkg.scenes) {
    const folder = project.folders.find((candidate) => candidate.name === `Scene ${scene.number} - ${scene.heading}`)
    assert.ok(folder, `no folder for scene ${scene.number}`)
    const inFolder = project.assets.filter((asset) => asset.folderId === folder.id)
    assert.ok(inFolder.length > 0)
    assert.ok(inFolder.every((asset) => asset.semantic.scene === scene.number))
  }
  assert.ok(project.assets.filter((asset) => ['music', 'sfx', 'ambience'].includes(asset.role)).every((asset) => project.folders.find((f) => f.id === asset.folderId).name === 'Music and sound'))
  assert.ok(project.assets.filter((asset) => asset.storybook.source === 'characters.referenceImages').every((asset) => project.folders.find((f) => f.id === asset.folderId).name === 'Characters'))
})

test('dialogue: a track per language at each line\'s start; dubs play at their timingAdjustment speed', () => {
  const pkg = loadFixture(60)
  const { project } = build(pkg)
  const dialogueTracks = tracksWhere(project, (track) => track.bus === 'dialogue')
  assert.deepEqual(dialogueTracks.map((track) => [track.language, track.muted]), [['en', false], ['hi', true]])
  const [en, hi] = dialogueTracks
  for (const line of pkg.dialogue.filter((candidate) => candidate.estimatedDurationSeconds)) {
    const [clip] = clipsOn(project, (candidate) => candidate.assetId === `sb-dlg-${line.id}`)
    assert.equal(clip.trackId, en.id)
    assert.equal(clip.startTime, onFrame(line.timelineStartSeconds))
    assert.equal(clip.speed, 1)
  }
  const fitted = pkg.dubbed[0].lines.find((line) => line.timingAdjustment !== 1 && line.audio.url)
  assert.ok(fitted, 'the 60-shot fixture has a dub fitted at a speed other than 1')
  const [dubClip] = clipsOn(project, (candidate) => candidate.assetId === `sb-dub-hi-${fitted.id}`)
  const original = pkg.dialogue.find((line) => line.id === fitted.dialogueId)
  assert.equal(dubClip.trackId, hi.id)
  assert.equal(dubClip.speed, fitted.timingAdjustment)
  assert.equal(dubClip.startTime, onFrame(original.timelineStartSeconds))
  assert.ok(Math.abs(dubClip.duration - fitted.durationSeconds / fitted.timingAdjustment) < 1 / 24)
  assert.ok(Math.abs(dubClip.trimEnd - dubClip.trimStart - dubClip.duration * dubClip.speed) < 1e-9)
  assert.equal(project.assets.find((asset) => asset.id === dubClip.assetId).language, 'hi')
})

test('overlapping lines on one language open a second lane of the same bus', () => {
  const pkg = clone(loadFixture(5))
  const [first, second] = pkg.dialogue
  second.timelineStartSeconds = first.timelineStartSeconds + 0.5
  const { project, warnings } = build(pkg)
  const lanes = tracksWhere(project, (track) => track.bus === 'dialogue' && track.language === 'en')
  assert.deepEqual(lanes.map((track) => track.name), ['Dialogue (en)', 'Dialogue (en) 2'])
  const [a] = clipsOn(project, (clip) => clip.assetId === `sb-dlg-${first.id}`)
  const [b] = clipsOn(project, (clip) => clip.assetId === `sb-dlg-${second.id}`)
  assert.notEqual(a.trackId, b.trackId)
  assert.ok(warnings.some((warning) => warning.code === 'overlap_lane' && warning.source === 'dialogue'))
})

test('buses: music, sfx and ambience on their own tracks at audio_tracks.volume; shot audio linked to its picture', () => {
  const pkg = loadFixture(5)
  const { project } = build(pkg)
  const busOf = Object.fromEntries(tracksWhere(project, (track) => track.type === 'audio').map((track) => [track.id, track.bus]))
  assert.deepEqual(tracksWhere(project, (track) => track.type === 'audio').map((track) => track.bus), ['dialogue', 'shotaudio', 'music', 'sfx', 'ambience'])
  for (const audioTrack of pkg.audioTracks) {
    const clips = clipsOn(project, (clip) => clip.assetId === `sb-audio-${audioTrack.id}`)
    assert.equal(clips.length, 1)
    assert.equal(busOf[clips[0].trackId], audioTrack.type)
    assert.equal(clips[0].startTime, onFrame(audioTrack.timelineStartSeconds))
    assert.equal(clips[0].gainDb, volumeToGainDb(audioTrack.volume))
    assert.equal(clips[0].metadata.storybook.volume, audioTrack.volume)
  }
  assert.equal(volumeToGainDb(1), 0)
  assert.equal(volumeToGainDb(0.5), -6.02)
  assert.equal(volumeToGainDb(2), 6.02)
  assert.equal(volumeToGainDb(0), -24)

  const shotAudio = clipsOn(project, (clip) => busOf[clip.trackId] === 'shotaudio')
  const pictures = clipsOn(project, (clip) => clip.trackId === SHOT_TRACK_ID && clip.linkGroupId)
  assert.equal(shotAudio.length, pictures.length)
  assert.equal(shotAudio.length, pkg.shots.filter((shot) => shot.video.url).length)
  for (const audio of shotAudio) {
    const picture = pictures.find((clip) => clip.id === audio.metadata.linkedVideoClipId)
    assert.equal(audio.type, 'audio')
    assert.equal(audio.assetId, picture.assetId)
    assert.equal(audio.linkGroupId, picture.linkGroupId)
    assert.deepEqual([audio.startTime, audio.duration, audio.trimStart, audio.trimEnd], [picture.startTime, picture.duration, picture.trimStart, picture.trimEnd])
    assert.equal(audio.metadata.embeddedAudioFromVideoAsset, true)
  }
})

test('ducking: music and shot audio duck under dialogue by the policy\'s duckDb, -8 by default', () => {
  const pkg = loadFixture(5)
  const { audioBuses } = build(pkg).project.studio
  assert.equal(DEFAULT_DUCK_DB, -8)
  assert.deepEqual(audioBuses.shotaudio, { gainDb: 0, duckUnder: 'dialogue', duckDb: -8, attackMs: 120, releaseMs: 400 })
  assert.deepEqual(audioBuses.music, { gainDb: 0, duckUnder: 'dialogue', duckDb: -8, attackMs: 120, releaseMs: 400 })
  assert.deepEqual(audioBuses.dialogue, { gainDb: 0 })
  assert.equal(audioBuses.master.limiterLufs, -14)

  const custom = buildProject({ package: pkg, probedAssets: probesFor(pkg), policy: { music: { duckDb: -12, duckUnderDialogue: false, enabled: false }, loudnessTargetLufs: -16 } }).project
  assert.deepEqual(custom.studio.audioBuses.music, { gainDb: 0, duckUnder: null })
  assert.equal(custom.studio.audioBuses.shotaudio.duckDb, -12)
  assert.equal(custom.studio.audioBuses.master.limiterLufs, -16)
  assert.equal(tracksWhere(custom, (track) => track.bus === 'music')[0].muted, true)
})

test('a loopable bed longer than its file repeats back to back; a one-shot is cut at its file', () => {
  const pkg = loadFixture(5)
  const music = pkg.audioTracks.find((track) => track.type === 'music')
  const sfx = pkg.audioTracks.find((track) => track.type === 'sfx')
  const duration = new Map([[music.media.key, 10], [sfx.media.key, 1.5]])
  const { project, warnings } = buildProject({ package: pkg, probedAssets: probesFor(pkg, { duration }) })
  const pieces = clipsOn(project, (clip) => clip.assetId === `sb-audio-${music.id}`).sort((a, b) => a.startTime - b.startTime)
  assert.deepEqual(pieces.map((clip) => [clip.startTime, clip.duration]), [[0, 10], [10, 10], [20, 4]])
  const [shot] = clipsOn(project, (clip) => clip.assetId === `sb-audio-${sfx.id}`)
  assert.equal(shot.duration, 1.5)
  assert.ok(warnings.some((warning) => warning.code === 'clip_shortened' && warning.ref === sfx.id))
})

test('a shot whose file is shorter than planned ends at the file, on a frame, and says so', () => {
  const pkg = loadFixture(5)
  const shot = pkg.shots[0]
  // 2.83 s after the trim is 67.92 frames: the nearest frame (68) would run
  // past the file, so the clip ends on the frame before, as Velorn's clamp does.
  const duration = new Map([[shot.video.key, 3.03]])
  const { project, warnings } = buildProject({ package: pkg, probedAssets: probesFor(pkg, { duration }) })
  const [clip] = clipsOn(project, (candidate) => candidate.assetId === `sb-shot-${shot.id}` && candidate.trackId === SHOT_TRACK_ID)
  assert.equal(clip.duration, 67 / 24)
  assert.ok(clip.trimEnd <= 3.03)
  assert.ok(warnings.some((warning) => warning.code === 'clip_shortened' && warning.ref === shot.id))
})

test('side files: the package as pulled without signatures, the link, brand and policy', () => {
  const pkg = loadFixture(5)
  const { files } = build(pkg, { options: { apiBase: 'https://storybook.example.test', pulledAt: '2026-10-04T12:05:00.000Z' } })
  assert.deepEqual(Object.keys(files), ['storybook/package.json', 'storybook/link.json', 'storybook/brand.json', 'storybook/policy.json'])
  const onDisk = JSON.parse(files['storybook/package.json'])
  assert.equal(EditPackageSchema.safeParse(onDisk).success, true)
  assert.equal(onDisk.etag, pkg.etag)
  assert.equal(files['storybook/package.json'].includes('X-Amz-Signature'), false)
  assert.equal(onDisk.shots[0].video.url, pkg.shots[0].video.url.split('?')[0])
  assert.deepEqual(onDisk, packageForDisk(pkg))
  assert.deepEqual(JSON.parse(files['storybook/link.json']), {
    apiBase: 'https://storybook.example.test', projectId: pkg.project.id, episodeId: pkg.episode.id,
    episodeVersion: pkg.episode.version, etag: pkg.etag, pulledAt: '2026-10-04T12:05:00.000Z',
  })
  assert.deepEqual(JSON.parse(files['storybook/brand.json']), BrandSchema.parse(pkg.brand))
  assert.deepEqual(JSON.parse(files['storybook/policy.json']), EditPolicySchema.parse(pkg.editPolicy))
})

test('the same inputs build the same project, and the inputs are not changed', () => {
  const pkg = loadFixture(20)
  const before = JSON.stringify(pkg)
  assert.equal(JSON.stringify(build(pkg)), JSON.stringify(build(pkg)))
  assert.equal(JSON.stringify(pkg), before)
})

test('a package that is not an edit package is refused', () => {
  assert.throws(() => buildProject({ package: { schemaId: 'nope' } }), /Not a StoryBook edit package/)
  const pkg = clone(loadFixture(5))
  pkg.dubbed = [{ language: 'hi', dubbedVersionId: pkg.episode.id, status: 'ready', lines: [{ ...pkg.dialogue[0], timingAdjustment: 3 }] }]
  assert.throws(() => buildProject({ package: pkg }), /Not a StoryBook edit package/)
})

test('aspect ratios map to Velorn frame sizes', () => {
  assert.deepEqual(dimensionsForAspect('16:9'), { width: 1920, height: 1080 })
  assert.deepEqual(dimensionsForAspect('9:16'), { width: 1080, height: 1920 })
  assert.deepEqual(dimensionsForAspect('1:1'), { width: 1080, height: 1080 })
  assert.deepEqual(dimensionsForAspect('4:5'), { width: 1080, height: 1350 })
  const vertical = clone(loadFixture(5))
  vertical.episode.aspect = '9:16'
  const { project } = build(vertical)
  assert.deepEqual([project.timelines[0].width, project.timelines[0].height, project.timelines[0].studio.aspect], [1080, 1920, '9:16'])
})

// The fixtures and the contract copies are StoryBook's. When a StoryBook
// checkout is beside this one (the submodule's parent, or STORYBOOK_ROOT),
// they must match it byte for byte.
const storybookRoot = () => {
  const candidates = [process.env.STORYBOOK_ROOT, fileURLToPath(new URL('../../../', import.meta.url))].filter(Boolean)
  return candidates.find((root) => existsSync(path.join(root, 'packages/features/desktop-integration/fixtures/edit-package'))) || null
}

test('the fixture packages are StoryBook\'s, byte for byte', { skip: storybookRoot() ? false : 'no StoryBook checkout beside this one (set STORYBOOK_ROOT)' }, () => {
  const root = storybookRoot()
  for (const shots of FIXTURE_SIZES) {
    const theirs = readFileSync(path.join(root, `packages/features/desktop-integration/fixtures/edit-package/${shots}-shots.json`))
    assert.ok(theirs.equals(readFileSync(fixturePath(shots))), `${shots}-shots.json differs from StoryBook's`)
  }
})

test('the contract copies are what StoryBook\'s sync script writes', { skip: storybookRoot() && existsSync(path.join(storybookRoot(), 'scripts/sync-studio-contracts.mjs')) ? false : 'no StoryBook checkout with the sync script' }, async () => {
  const script = await import(pathToFileURL(path.join(storybookRoot(), 'scripts/sync-studio-contracts.mjs')).href)
  const target = fileURLToPath(new URL('../../src/studio/contracts/', import.meta.url))
  assert.deepEqual(script.driftedContracts(target), [])
})
