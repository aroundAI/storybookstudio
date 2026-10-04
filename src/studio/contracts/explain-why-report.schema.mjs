// GENERATED from aroundAI/storybook packages/features/desktop-integration/src/explain-why-report.schema.ts
// by scripts/sync-studio-contracts.mjs. Do not edit: change the source in
// StoryBook and run the script again. Needs zod 3.
import { z } from 'zod';
/**
 * The explain-why report (PRD R-24; FILM-2012 derives it from the op log,
 * FILM-2003 stores it with the delivery). Top level: the versions of the
 * edit, the delivered cut's duration, how many operations the AI and the
 * user made, and `explain`: per scene, what was removed, trimmed, moved,
 * added or changed, each with its reason and the duration before and after.
 * Zod only, so the fork copies this file unchanged.
 */
const Seconds = z.number().nonnegative();
const Text = z.string().min(1).max(2000);
export const ReportVersionSchema = z.object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(200),
    /** The version this one was made from; null for the rough cut. */
    parentId: z.string().min(1).max(128).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    origin: z.enum(['rough_cut', 'ai', 'user']),
});
export const REPORT_CHANGE_ACTIONS = [
    'removed',
    'trimmed',
    'moved',
    'added',
    'changed',
];
export const ReportChangeSchema = z.object({
    action: z.enum(REPORT_CHANGE_ACTIONS),
    /** What the change was made to, e.g. "Shot 1.2", "silence", "Music". */
    target: z.string().min(1).max(200),
    reason: Text,
    detail: Text.optional(),
    before: Seconds.nullable().optional(),
    after: Seconds.nullable().optional(),
    by: z.enum(['ai', 'user']),
});
export const ReportSceneSchema = z.object({
    scene: z.number().int().positive(),
    durationBefore: Seconds,
    durationAfter: Seconds,
    changes: z.array(ReportChangeSchema).max(1000),
});
export const ReportAudioChangeSchema = z.object({
    target: z.string().min(1).max(200),
    change: Text,
    reason: Text,
});
/**
 * The content genome's hook_type slug: `content_tags.slug`'s rule
 * (SlugSchema in packages/features/content-analytics/src/lib/schemas/
 * taxonomy.schema.ts; delivery-schemas.test.ts keeps the two equal).
 */
export const HOOK_TYPE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * The delivered cut's style, for FILM-2006's Edit style card (cut count,
 * average shot length, AI share). Optional: a report without it reads as
 * unmeasured, never as zero.
 */
export const ReportStyleSchema = z.object({
    shotCount: z.number().int().min(1),
    /** The opening's hook, as a genome hook_type slug; null when the Studio did not classify it. */
    hookType: z.string().min(1).max(80).regex(HOOK_TYPE_SLUG).nullable(),
});
export const ExplainWhyReportSchema = z.object({
    versions: z.array(ReportVersionSchema).min(1).max(500),
    /** Seconds of the delivered cut. */
    finalDuration: Seconds,
    aiOps: z.number().int().nonnegative(),
    userOps: z.number().int().nonnegative(),
    explain: z.object({
        /** The instruction the last plan answered, e.g. "Make it 90 seconds". */
        plan: z.string().max(2000).nullable().optional(),
        targetDuration: Seconds.nullable().optional(),
        durationBefore: Seconds.nullable().optional(),
        scenes: z.array(ReportSceneSchema).max(500),
        audio: z.array(ReportAudioChangeSchema).max(200).optional(),
    }),
    style: ReportStyleSchema.optional(),
});
