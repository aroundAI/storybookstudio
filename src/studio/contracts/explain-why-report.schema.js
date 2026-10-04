// FORK COPY of ExplainWhyReportSchema. StoryBook owns the definition
// (FILM-2003, packages/features/desktop-integration/src/) and a script copies
// it here with a drift test in each repo. Until FILM-2003 lands, this copy is
// written from FILM-2003's field list (versions[], finalDuration, aiOps,
// userOps, explain{scenes[]}) and the PRD's explain-why text block; replace it
// with the generated copy then, and change report.js only if the two differ.
import { z } from 'zod'

const Seconds = z.number().nonnegative()
const By = z.enum(['ai', 'user'])

export const ReportVersionSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent: z.string().nullable(),
  opRange: z.tuple([z.number().int().positive(), z.number().int().nonnegative().nullable()]),
  createdBy: By,
  createdAt: z.string(),
  prompt: z.string().nullable(),
})

const ClipPlacementSchema = z.object({ trackId: z.string().nullable(), startTime: z.number(), duration: Seconds })

export const SceneChangeSchema = z.object({
  kind: z.enum(['removed', 'added', 'trimmed', 'moved', 'changed']),
  clipId: z.string(),
  label: z.string(),
  before: ClipPlacementSchema.nullable(),
  after: ClipPlacementSchema.nullable(),
  fields: z.array(z.string()).optional(),
  reason: z.string().nullable(),
  by: By.nullable(),
  opId: z.number().int().positive().nullable(),
})

export const SceneExplainSchema = z.object({
  scene: z.number().int().nonnegative().nullable(),
  durationBefore: Seconds,
  durationAfter: Seconds,
  changes: z.array(SceneChangeSchema),
})

export const AudioChangeSchema = z.object({
  kind: z.enum(['gain', 'track_volume', 'removed', 'added', 'trimmed', 'moved', 'changed']),
  target: z.string(),
  label: z.string(),
  before: z.union([z.number(), z.null()]),
  after: z.union([z.number(), z.null()]),
  reason: z.string().nullable(),
  by: By.nullable(),
  opId: z.number().int().positive().nullable(),
})

// FILM-2003's QaResultSchema ({pass, issues[{type, severity, timeRange, scene, detail}]}).
export const ReportQaSchema = z
  .object({ pass: z.boolean(), issues: z.array(z.object({}).passthrough()) })
  .passthrough()

export const ExplainWhyReportSchema = z.object({
  versions: z.array(ReportVersionSchema),
  finalDuration: Seconds,
  aiOps: z.number().int().nonnegative(),
  userOps: z.number().int().nonnegative(),
  explain: z.object({
    versionId: z.string(),
    versionName: z.string(),
    baseVersionName: z.string().nullable(),
    plan: z.string().nullable(),
    durationBefore: Seconds,
    durationAfter: Seconds,
    target: Seconds.nullable(),
    scenesKept: z.number().int().nonnegative(),
    scenesTotal: z.number().int().nonnegative(),
    scenes: z.array(SceneExplainSchema),
    audio: z.array(AudioChangeSchema),
    qa: ReportQaSchema.nullable(),
  }),
})
