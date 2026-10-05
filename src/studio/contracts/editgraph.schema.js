// EditGraph v1 (FILM-2012): the upstream editor's project file (project.storybookstudio) plus additive Studio
// fields. Every object is passthrough so validating a project never strips a
// the upstream editor field, and every Studio field is optional so a stock upstream project
// validates unchanged. Pure module: no Electron, no stores.
import { z } from 'zod'

export const EDITGRAPH_SCHEMA = 'editgraph/1'

export const ASSET_ROLES = Object.freeze([
  'primary_video',
  'broll',
  'reaction',
  'establishing',
  'generated_video',
  'stock_video',
  'overlay_video',
  'dialogue',
  'voiceover',
  'soundbite',
  'music',
  'ambience',
  'sfx',
  'caption',
  'title',
  'lower_third',
  'logo',
  'image',
  'composition',
])

export const AssetRoleSchema = z.enum(ASSET_ROLES)

// How the project builder (FILM-2012 slice B) fills asset.role from StoryBook
// edit-package entries. Not wired yet; the builder imports it.
export const STORYBOOK_ROLE_MAP = Object.freeze({
  shot: 'generated_video',
  dialogue_line: 'dialogue',
  audio_track: Object.freeze({ music: 'music', sfx: 'sfx', ambience: 'ambience' }),
  character_reference: 'image',
})

export const roleForStoryBookSource = (kind, type = null) => {
  const mapped = STORYBOOK_ROLE_MAP[kind]
  if (typeof mapped === 'string') return mapped
  if (mapped && typeof type === 'string') return mapped[type] ?? null
  return null
}

export const LanguageDependencySchema = z.enum(['none', 'language', 'locale'])
export const EditOriginBySchema = z.enum(['ai', 'user'])

const SceneNumberSchema = z.number().int().nonnegative()
const OptionalText = z.string().nullable().optional()

export const AssetSemanticSchema = z
  .object({
    scene: SceneNumberSchema.nullable().optional(),
    shotId: OptionalText,
    characters: z.array(z.string()).optional(),
    purpose: OptionalText,
    emotion: OptionalText,
    prompt: OptionalText,
    continuationFrom: OptionalText,
  })
  .passthrough()

const SecondsRangeSchema = z.tuple([z.number().nonnegative(), z.number().nonnegative()])

export const AssetAnalysisSchema = z
  .object({
    loudnessLufs: z.number().nullable().optional(),
    silences: z.array(SecondsRangeSchema).optional(),
    bpm: z.number().positive().nullable().optional(),
    keyframes: z.array(z.string()).optional(),
    semanticsVersion: z.number().int().nonnegative().optional(),
  })
  .passthrough()

export const StudioAssetSchema = z
  .object({
    id: z.string(),
    role: AssetRoleSchema.optional(),
    semantic: AssetSemanticSchema.optional(),
    analysis: AssetAnalysisSchema.optional(),
    languageDependency: LanguageDependencySchema.optional(),
  })
  .passthrough()

export const ClipSemanticSchema = z
  .object({
    scene: SceneNumberSchema.nullable().optional(),
    shotId: OptionalText,
    role: AssetRoleSchema.optional(),
  })
  .passthrough()

export const ClipOriginSchema = z
  .object({
    versionId: z.string().nullable(),
    opId: z.number().int().nonnegative().nullable(),
    by: EditOriginBySchema,
  })
  .passthrough()

export const ClipMetadataSchema = z
  .object({
    semantic: ClipSemanticSchema.optional(),
    origin: ClipOriginSchema.optional(),
  })
  .passthrough()

// FILM-2018: a composition clip's graphic (src/studio/compositions/clip.js).
// renderPath is project-relative under compositions/, and named by its key.
const RenderKeySchema = z.string().regex(/^[0-9a-f]{64}$/, 'propsHash is a sha256 hex digest')
export const CompositionSchema = z
  .object({
    engine: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    compositionId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    props: z.record(z.unknown()),
    propsHash: RenderKeySchema.nullable(),
    renderPath: z.string().regex(/^compositions\/[a-z][a-z0-9-]{0,39}-[0-9a-f]{64}\.webm$/, 'renderPath is compositions/<id>-<propsHash>.webm').nullable(),
    languageDependency: LanguageDependencySchema,
  })
  .passthrough()
  .superRefine((composition, ctx) => {
    if ((composition.propsHash === null) !== (composition.renderPath === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['renderPath'], message: 'propsHash and renderPath are set together' })
    } else if (composition.renderPath && composition.renderPath !== `compositions/${composition.compositionId}-${composition.propsHash}.webm`) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['renderPath'], message: 'renderPath is named by compositionId and propsHash' })
    }
  })

export const StudioClipSchema = z
  .object({
    id: z.string(),
    metadata: ClipMetadataSchema.nullable().optional(),
    composition: CompositionSchema.optional(),
  })
  .passthrough()
  .superRefine((clip, ctx) => {
    if (clip.type === 'composition' && !clip.composition) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['composition'], message: 'a composition clip carries its composition' })
    }
  })

const AspectSchema = z.string().regex(/^\d+:\d+$/, 'aspect is W:H, for example 16:9')

export const TimelineStudioSchema = z
  .object({
    kind: z.enum(['master', 'variant']),
    variantOf: z.string().nullable().optional(),
    aspect: AspectSchema.optional(),
    language: z.string().min(2).optional(),
  })
  .passthrough()
  .superRefine((studio, ctx) => {
    if (studio.kind === 'variant' && !studio.variantOf) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['variantOf'], message: 'a variant names the timeline it varies' })
    }
  })

export const StudioTimelineSchema = z
  .object({
    id: z.string().optional(),
    clips: z.array(StudioClipSchema).optional(),
    studio: TimelineStudioSchema.optional(),
  })
  .passthrough()

export const AudioBusSchema = z.object({}).passthrough()

export const ProjectStudioSchema = z
  .object({
    schema: z.literal(EDITGRAPH_SCHEMA),
    episodeId: z.string().nullable().optional(),
    currentVersion: z.string().nullable().optional(),
    audioBuses: z.record(AudioBusSchema).optional(),
  })
  .passthrough()

export const EditGraphProjectSchema = z
  .object({
    version: z.string().optional(),
    timelines: z.array(StudioTimelineSchema).optional(),
    // Upstream 1.0 projects hold one `timeline`; normalizeOpenedProjectData migrates it.
    timeline: StudioTimelineSchema.optional(),
    assets: z.array(StudioAssetSchema).optional(),
    studio: ProjectStudioSchema.optional(),
  })
  .passthrough()

export const validateEditGraphProject = (project) => EditGraphProjectSchema.safeParse(project)
