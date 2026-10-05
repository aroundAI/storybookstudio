// GENERATED from aroundAI/storybook packages/features/desktop-integration/src/edit-policy.schema.ts
// by scripts/sync-studio-contracts.mjs. Do not edit: change the source in
// StoryBook and run the script again. Needs zod 3.
import { z } from 'zod';
/**
 * FILM-2004: the rules the Studio's AI editor follows on every run (PRD R-25):
 * intent compilers read them, the critic checks against them. Stored in
 * `projects.edit_policy`; `{}` is a valid stored value and parses to
 * `EDIT_POLICY_DEFAULTS`, so every field has a default.
 *
 * This file is a shared contract with StorybookStudio: it is copied into
 * `storybookstudio/src/studio/contracts/`. Keep it self-contained (zod only,
 * no relative imports) and never rename an export.
 */
export const POLICY_TRANSITIONS = ['cut', 'dissolve', 'dip'];
export const POLICY_CAPTION_STYLES = ['brand', 'plain'];
export const POLICY_DIALOGUE_CUTS = ['never', 'ask', 'allow'];
export const MAX_SILENCE_SECONDS_LIMIT = 10;
export const SHOT_LENGTH_MIN_SECONDS = 0.5;
export const SHOT_LENGTH_MAX_SECONDS = 30;
const ShotLengthSchema = z
    .number()
    .min(SHOT_LENGTH_MIN_SECONDS)
    .max(SHOT_LENGTH_MAX_SECONDS);
export const PolicyTransitionsSchema = z.object({
    preferred: z
        .array(z.enum(POLICY_TRANSITIONS))
        .min(1, 'Allow at least one transition')
        .default(['cut', 'dissolve']),
    /** Seconds; a cut is 0. */
    maxDuration: z.number().min(0).max(2).default(0.4),
});
export const PolicyMusicSchema = z.object({
    enabled: z.boolean().default(true),
    duckUnderDialogue: z.boolean().default(true),
    /** Gain applied to the music bus under dialogue. */
    duckDb: z.number().min(-40).max(0).default(-8),
});
export const PolicyCaptionsSchema = z.object({
    enabled: z.boolean().default(true),
    /** `brand` = the brand's captionStyle; `plain` = the Studio's default. */
    style: z.enum(POLICY_CAPTION_STYLES).default('brand'),
});
export const PolicyVisualSchema = z.object({
    avoidRepeatedShots: z.boolean().default(true),
    avoidExtremeZoom: z.boolean().default(true),
});
/**
 * The object without the cross-field rule, for partial updates and for
 * reading its shape. Validate a whole policy with `EditPolicySchema`.
 */
export const EditPolicyObjectSchema = z.object({
    /**
     * null = the episode's own target (`episodes.target_duration_seconds`,
     * else the project's `metadata.defaultEpisodeDuration`).
     */
    targetDurationSeconds: z
        .number()
        .int()
        .min(60)
        .max(7200)
        .nullable()
        .default(null),
    minShotLength: ShotLengthSchema.default(1.2),
    maxShotLength: ShotLengthSchema.default(6),
    transitions: PolicyTransitionsSchema.default({}),
    music: PolicyMusicSchema.default({}),
    captions: PolicyCaptionsSchema.default({}),
    visual: PolicyVisualSchema.default({}),
    loudnessTargetLufs: z.number().min(-31).max(-5).default(-14),
    /**
     * May the AI drop spoken dialogue to hit the target duration? `ask` =
     * the creator approves each drop in the plan; `never` and `allow` decide
     * without asking.
     */
    allowDialogueCuts: z.enum(POLICY_DIALOGUE_CUTS).default('ask'),
    /** Seconds; a silence longer than this fails the QA pass. */
    maxSilenceSeconds: z
        .number()
        .positive()
        .max(MAX_SILENCE_SECONDS_LIMIT)
        .default(1.5),
});
export const EditPolicySchema = EditPolicyObjectSchema.refine((policy) => policy.minShotLength <= policy.maxShotLength, {
    message: 'The shortest shot cannot be longer than the longest shot',
    path: ['minShotLength'],
});
export const EDIT_POLICY_DEFAULTS = EditPolicySchema.parse({});
