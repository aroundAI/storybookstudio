// GENERATED from aroundAI/storybook packages/features/desktop-integration/src/qa-result.schema.ts
// by scripts/sync-studio-contracts.mjs. Do not edit: change the source in
// StoryBook and run the script again. Needs zod 3.
import { z } from 'zod';
/**
 * A QA result (FILM-2003, produced by FILM-2014's deterministic QA and
 * critic): `{pass, issues[]}`. Each issue names what is wrong, how bad it is
 * (0 to 1), where (a time range and a scene, either absent when the issue is
 * about the whole file, such as loudness), and optionally the studio_repair
 * intent that fixes it. Stored in `episode_renders.qa` and in the delivery's
 * session summary. Zod only, so the fork copies this file unchanged.
 */
export const REPAIR_INTENTS = [
    'duck_music',
    'trim_silence',
    'normalize_loudness',
    'move_caption',
    'replace_missing_media',
    'add_fade',
    're-time',
];
export const RepairIntentSchema = z.enum(REPAIR_INTENTS);
export const QaTimeRangeSchema = z
    .object({
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
})
    .refine((range) => range.end >= range.start, {
    message: 'end must not be before start',
    path: ['end'],
});
export const QaIssueSchema = z.object({
    /** What was checked, e.g. loudness, black_frames, caption_safe_area. */
    type: z.string().min(1).max(64),
    severity: z.number().min(0).max(1),
    timeRange: QaTimeRangeSchema.nullable(),
    /** Scene number in the screenplay, when the issue lies in one. */
    scene: z.number().int().positive().nullable(),
    detail: z.string().min(1).max(2000),
    repairIntent: RepairIntentSchema.optional(),
});
export const QaResultSchema = z.object({
    pass: z.boolean(),
    issues: z.array(QaIssueSchema).max(500),
});
