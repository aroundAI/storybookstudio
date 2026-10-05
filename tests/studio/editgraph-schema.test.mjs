import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ASSET_ROLES,
  AssetRoleSchema,
  EDITGRAPH_SCHEMA,
  EditGraphProjectSchema,
  STORYBOOK_ROLE_MAP,
  roleForStoryBookSource,
  validateEditGraphProject,
} from '../../src/studio/contracts/editgraph.schema.js'

const readFixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

const withStudioFields = () => {
  const project = readFixture('storybookstudio-sample-project.json')
  project.studio = {
    schema: 'editgraph/1',
    episodeId: '3f1c2a9e-0000-4000-8000-000000000001',
    currentVersion: 'v2',
    audioBuses: {
      dialogue: { gainDb: 0 },
      music: { duckUnder: 'dialogue', duckDb: -8 },
      master: { limiterLufs: -14 },
    },
  }
  project.timelines[0].studio = { kind: 'master', variantOf: null, aspect: '16:9', language: 'en' }
  project.assets[0] = {
    ...project.assets[0],
    role: 'generated_video',
    semantic: {
      scene: 1,
      shotId: 'shot-uuid-1',
      characters: ['Maya'],
      purpose: 'reaction',
      emotion: 'surprised',
      prompt: 'Maya turns toward the sea',
      continuationFrom: null,
    },
    analysis: { loudnessLufs: -18.2, silences: [[0, 0.4]], bpm: null, keyframes: ['cache/kf/a.jpg'], semanticsVersion: 1 },
    languageDependency: 'none',
  }
  project.assets[1] = { ...project.assets[1], role: 'music', languageDependency: 'none' }
  project.timelines[0].clips[0].metadata = {
    semantic: { scene: 1, shotId: 'shot-uuid-1', role: 'primary_video' },
    origin: { versionId: 'v2', opId: 418, by: 'ai' },
  }
  return project
}

test('a stock upstream project with no Studio fields validates', () => {
  const result = validateEditGraphProject(readFixture('storybookstudio-sample-project.json'))
  assert.equal(result.success, true, JSON.stringify(result.error?.issues))
})

test('a legacy single-timeline upstream project validates', () => {
  const result = validateEditGraphProject(readFixture('storybookstudio-legacy-1.0-project.json'))
  assert.equal(result.success, true, JSON.stringify(result.error?.issues))
})

test('a project carrying every Studio field validates', () => {
  const result = validateEditGraphProject(withStudioFields())
  assert.equal(result.success, true, JSON.stringify(result.error?.issues))
})

test('validation keeps unknown the upstream editor fields (passthrough, nothing stripped)', () => {
  const project = withStudioFields()
  const parsed = EditGraphProjectSchema.parse(project)
  assert.deepEqual(parsed, project)
})

test('an unknown asset role is refused', () => {
  const project = withStudioFields()
  project.assets[0].role = 'hero_shot'
  const result = validateEditGraphProject(project)
  assert.equal(result.success, false)
  assert.deepEqual(result.error.issues[0].path, ['assets', 0, 'role'])
})

test('a clip origin by anyone but ai or user is refused', () => {
  const project = withStudioFields()
  project.timelines[0].clips[0].metadata.origin.by = 'robot'
  assert.equal(validateEditGraphProject(project).success, false)
})

test('project.studio.schema must be editgraph/1', () => {
  const project = withStudioFields()
  project.studio.schema = 'editgraph/2'
  assert.equal(validateEditGraphProject(project).success, false)
  assert.equal(EDITGRAPH_SCHEMA, 'editgraph/1')
})

test('a variant timeline names the timeline it varies', () => {
  const project = withStudioFields()
  project.timelines[0].studio = { kind: 'variant', variantOf: null, aspect: '9:16', language: 'en' }
  assert.equal(validateEditGraphProject(project).success, false)
  project.timelines[0].studio.variantOf = 'timeline-0'
  assert.equal(validateEditGraphProject(project).success, true)
})

test('languageDependency is none, language or locale', () => {
  const project = withStudioFields()
  project.assets[0].languageDependency = 'dialect'
  assert.equal(validateEditGraphProject(project).success, false)
})

test('the role taxonomy is the nineteen roles of AC2, in order', () => {
  assert.deepEqual(ASSET_ROLES, [
    'primary_video', 'broll', 'reaction', 'establishing', 'generated_video', 'stock_video', 'overlay_video',
    'dialogue', 'voiceover', 'soundbite', 'music', 'ambience', 'sfx', 'caption', 'title', 'lower_third',
    'logo', 'image', 'composition',
  ])
  for (const role of ASSET_ROLES) assert.equal(AssetRoleSchema.safeParse(role).success, true)
})

test('StoryBook sources map to roles as AC2 says', () => {
  assert.equal(STORYBOOK_ROLE_MAP.shot, 'generated_video')
  assert.equal(STORYBOOK_ROLE_MAP.dialogue_line, 'dialogue')
  assert.equal(STORYBOOK_ROLE_MAP.character_reference, 'image')
  assert.deepEqual(STORYBOOK_ROLE_MAP.audio_track, { music: 'music', sfx: 'sfx', ambience: 'ambience' })
  assert.equal(roleForStoryBookSource('shot'), 'generated_video')
  assert.equal(roleForStoryBookSource('dialogue_line'), 'dialogue')
  assert.equal(roleForStoryBookSource('audio_track', 'ambience'), 'ambience')
  assert.equal(roleForStoryBookSource('audio_track', 'sfx'), 'sfx')
  assert.equal(roleForStoryBookSource('character_reference'), 'image')
  assert.equal(roleForStoryBookSource('audio_track', 'podcast'), null)
  assert.equal(roleForStoryBookSource('unknown'), null)
  for (const role of [STORYBOOK_ROLE_MAP.shot, STORYBOOK_ROLE_MAP.dialogue_line, ...Object.values(STORYBOOK_ROLE_MAP.audio_track)]) {
    assert.ok(ASSET_ROLES.includes(role))
  }
})
