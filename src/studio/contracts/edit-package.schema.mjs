// GENERATED from aroundAI/storybook packages/features/desktop-integration/src/edit-package.schema.ts
// by scripts/sync-studio-contracts.mjs. Do not edit: change the source in
// StoryBook and run the script again. Needs zod 3.
import { z } from 'zod';
import { BrandSchema } from './brand.schema.mjs';
import { EditPolicySchema } from './edit-policy.schema.mjs';
/**
 * FILM-2001: the edit package, everything StorybookStudio needs to open one
 * episode as a rough cut. `get_edit_package` returns it; the fork's pull job
 * (FILM-2011) downloads its media and the project builder (FILM-2012) turns
 * it into a timeline.
 *
 * This file is a shared contract with StorybookStudio:
 * `scripts/sync-studio-contracts.mjs` writes it, with its types stripped, to
 * `storybookstudio/src/studio/contracts/edit-package.schema.mjs` beside
 * `brand.schema.mjs` and `edit-policy.schema.mjs`, its only imports. Keep it zod-only, never rename
 * an export, and bump EDIT_PACKAGE_SCHEMA_ID for a change an old reader
 * would misread.
 *
 * Times are seconds from the start of the episode timeline unless named
 * otherwise; a null time means StoryBook has none, and the builder falls
 * back to packing by sequence.
 */
export const EDIT_PACKAGE_SCHEMA_ID = 'storybook-edit-package/1';
/** How long every media URL in a package stays valid, in seconds. */
export const EDIT_PACKAGE_URL_TTL_SECONDS = 3600;
const NonNegativeSeconds = z.number().finite().min(0);
const Uuid = z.string().uuid();
const IsoDateTime = z.string().datetime({ offset: true });
/**
 * Why a media slot has no URL. Never a broken link: a slot is either a
 * signed URL to an object that existed when the package was built, or one
 * of these.
 *
 * - `not_generated`: the row names no file yet (no video, no audio)
 * - `not_in_storage`: the row names a URL outside StoryBook's storage
 * - `outside_project`: the URL names another project's file; never signed
 * - `missing`: the storage has no object at that key
 * - `unavailable`: the storage could not be asked; fetch the package again
 */
export const MEDIA_REASONS = [
    'not_generated',
    'not_in_storage',
    'outside_project',
    'missing',
    'unavailable',
];
export const MediaReasonSchema = z.enum(MEDIA_REASONS);
/**
 * Why a media ref carries no sha256: StoryBook has not recorded one for
 * that object (only `assets.file_hash` is recorded today), so the client
 * verifies `bytes` instead.
 */
export const SHA256_REASONS = ['not_recorded'];
/**
 * One downloadable object.
 *
 * How a client checks and diffs media (FILM-2011):
 * - `key` is the object's stable identity. It is the same while the file is
 *   the same and new when the file is replaced (StoryBook writes new media
 *   under new keys), so re-sync diffs media by `key`, never by `url`, which
 *   changes on every call.
 * - Verify a download by `sha256` when it is set, else by `bytes`. Most
 *   entries have `sha256: null` with `sha256Reason: 'not_recorded'` until
 *   StoryBook records hashes at write time (KB-189).
 */
export const MediaRefSchema = z.object({
    /** A presigned GET, valid for EDIT_PACKAGE_URL_TTL_SECONDS from generatedAt. */
    url: z.string().url(),
    /** `<bucket>/<path>`: the stable identity to diff by (see above). */
    key: z.string().min(1),
    /** Lower-case hex SHA-256 of the object, when StoryBook recorded one. */
    sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable(),
    sha256Reason: z.enum(SHA256_REASONS).optional(),
    bytes: z.number().int().min(0),
    mime: z.string().min(1),
});
/** A media slot with nothing to download, and why. */
export const MissingMediaSchema = z.object({
    url: z.null(),
    mediaReason: MediaReasonSchema,
});
export const MediaEntrySchema = z.union([MediaRefSchema, MissingMediaSchema]);
export const EpisodeBlockSchema = z.object({
    id: Uuid,
    projectId: Uuid,
    number: z.number().int(),
    title: z.string(),
    status: z.string(),
    /** `episodes.version`; FILM-2003's deliver_edit locks on it. */
    version: z.number().int(),
    /** The episode's target, else null; the policy's own target wins when set. */
    targetDurationSeconds: z.number().positive().nullable(),
    /** `16:9` unless the episode's metadata says otherwise. */
    aspect: z.string().regex(/^\d+:\d+$/),
    fps: z.number().positive(),
    /** The language most dialogue is in. */
    language: z.string().min(2),
    /** Every language with dialogue, captions or a dub, primary first. */
    languages: z.array(z.string().min(2)).min(1),
});
export const SceneSchema = z.object({
    number: z.number().int(),
    heading: z.string(),
    description: z.string().nullable(),
    location: z.string().nullable(),
    timeOfDay: z.string().nullable(),
    characters: z.array(z.string()),
    estimatedDurationSeconds: NonNegativeSeconds.nullable(),
    dialogue: z.array(z.object({
        character: z.string().nullable(),
        text: z.string(),
    })),
});
export const PrimarySubjectSchema = z.object({
    type: z.enum(['character', 'location', 'object']),
    name: z.string(),
});
export const ShotSchema = z.object({
    id: Uuid,
    sceneNumber: z.number().int().nullable(),
    shotNumber: z.number().int().nullable(),
    sequenceNumber: z.number().int(),
    status: z.string(),
    durationSeconds: NonNegativeSeconds,
    /** Length of the generated or uploaded clip, when known. */
    sourceDurationSeconds: NonNegativeSeconds.nullable(),
    timelineStartSeconds: NonNegativeSeconds.nullable(),
    /** In and out points inside the source clip. */
    trimInSeconds: NonNegativeSeconds.nullable(),
    trimOutSeconds: NonNegativeSeconds.nullable(),
    /** `cut`, `continuation`, `match_cut`, `j_cut`, `l_cut`; null = cut. */
    transitionType: z.string().nullable(),
    prompt: z.string(),
    actionDescription: z.string().nullable(),
    cameraDirection: z.string().nullable(),
    primarySubject: PrimarySubjectSchema.nullable(),
    continuationFromShotId: Uuid.nullable(),
    inheritLastFrame: z.boolean(),
    shortsCandidate: z.boolean(),
    video: MediaEntrySchema,
    firstFrame: MediaEntrySchema,
    lastFrame: MediaEntrySchema,
});
export const DialogueLineSchema = z.object({
    id: Uuid,
    shotId: Uuid.nullable(),
    sceneNumber: z.number().int().nullable(),
    sequenceNumber: z.number().int(),
    characterName: z.string().nullable(),
    characterAssetId: Uuid.nullable(),
    text: z.string(),
    emotion: z.string().nullable(),
    language: z.string().min(2),
    timelineStartSeconds: NonNegativeSeconds.nullable(),
    estimatedDurationSeconds: NonNegativeSeconds.nullable(),
    status: z.string(),
    audio: MediaEntrySchema,
});
export const AUDIO_TRACK_TYPES = ['music', 'sfx', 'ambience'];
export const AudioTrackSchema = z.object({
    id: Uuid,
    /** `audio_tracks.type`, with `ambient` named `ambience`. */
    type: z.enum(AUDIO_TRACK_TYPES),
    name: z.string().nullable(),
    timelineStartSeconds: NonNegativeSeconds,
    durationSeconds: NonNegativeSeconds.nullable(),
    /** 0..2, 1 = unchanged. */
    volume: z.number().min(0).max(2),
    loopable: z.boolean(),
    tags: z.array(z.string()),
    audioAssetId: Uuid.nullable(),
    media: MediaEntrySchema,
});
export const CaptionSegmentSchema = z.object({
    id: Uuid,
    sequenceNumber: z.number().int(),
    startSeconds: NonNegativeSeconds,
    endSeconds: NonNegativeSeconds,
    text: z.string(),
    speakerId: Uuid.nullable(),
});
export const CaptionTrackSchema = z.object({
    language: z.string().min(2),
    captionId: Uuid,
    status: z.string(),
    stylePreset: z.string(),
    segments: z.array(CaptionSegmentSchema),
});
export const CharacterSchema = z.object({
    assetId: Uuid,
    name: z.string(),
    role: z.string().nullable(),
    description: z.string().nullable(),
    voiceId: z.string().nullable(),
    /** The character's own image first, then its reference images. */
    referenceImages: z.array(MediaEntrySchema),
});
export const ShortsCandidateSchema = z.object({
    id: Uuid,
    startSeconds: NonNegativeSeconds,
    endSeconds: NonNegativeSeconds,
    durationSeconds: NonNegativeSeconds.nullable(),
    /** `shorts.viral_score`, an integer 1..10. */
    viralScore: z.number().nullable(),
    hookType: z.string().nullable(),
    title: z.string().nullable(),
    sourceShotId: Uuid.nullable(),
    status: z.string(),
});
export const DubbedLineSchema = z.object({
    id: Uuid,
    /** The `dialogue` line this dubs. */
    dialogueId: Uuid,
    translatedText: z.string(),
    /**
     * `dubbed_dialogue_lines.timing_adjustment`: the speed factor the dub was
     * fitted with, 0.5..2 (1 = as voiced), not a time offset.
     */
    timingAdjustment: z.number().min(0.5).max(2),
    durationSeconds: NonNegativeSeconds.nullable(),
    status: z.string(),
    audio: MediaEntrySchema,
});
export const DubbedLanguageSchema = z.object({
    language: z.string().min(2),
    dubbedVersionId: Uuid,
    status: z.string(),
    lines: z.array(DubbedLineSchema),
});
/**
 * Why `retention` is empty. Distinct answers, never a zero:
 * - `unmeasured`: analytics are off here (ClickHouse disabled); nothing
 *   could be measured
 * - `no_published_video`: the episode has no published YouTube video, the
 *   one platform that reports a retention curve
 * - `no_curve`: it has one, and no curve has been fetched for it yet
 * - `unavailable`: analytics could not be read this time; ask again later
 */
export const RETENTION_REASONS = [
    'unmeasured',
    'no_published_video',
    'no_curve',
    'unavailable',
];
export const RetentionDropSchema = z.object({
    /** Seconds into the published video, null when its length is unknown. */
    timestamp: NonNegativeSeconds.nullable(),
    /** Position through the video, 0..1. */
    elapsedRatio: z.number().min(0).max(1),
    /** Percentage points of the starting audience lost at this point. */
    dropPercentage: z.number().positive(),
    platform: z.string(),
    /** When the curve was fetched from the platform. */
    asOf: IsoDateTime,
});
export const AnalyticsHintsSchema = z.object({
    /** The largest drop-offs of the latest published video, in time order. */
    retention: z.array(RetentionDropSchema),
    /** The publish the curve belongs to. */
    publishId: Uuid.nullable(),
    reason: z.enum(RETENTION_REASONS).optional(),
});
export const EditPackageSchema = z.object({
    schemaId: z.literal(EDIT_PACKAGE_SCHEMA_ID),
    /**
     * Changes whenever anything the timeline is built from changes; pass it
     * back as `ifNoneMatch` to skip an unchanged package.
     */
    etag: z.string().min(1),
    generatedAt: IsoDateTime,
    /** When every media URL in this package stops working. */
    urlsExpireAt: IsoDateTime,
    project: z.object({
        id: Uuid,
        name: z.string(),
        slug: z.string().nullable(),
    }),
    episode: EpisodeBlockSchema,
    scenes: z.array(SceneSchema),
    shots: z.array(ShotSchema),
    dialogue: z.array(DialogueLineSchema),
    audioTracks: z.array(AudioTrackSchema),
    captions: z.array(CaptionTrackSchema),
    characters: z.array(CharacterSchema),
    shortsCandidates: z.array(ShortsCandidateSchema),
    dubbed: z.array(DubbedLanguageSchema),
    analyticsHints: AnalyticsHintsSchema,
    brand: BrandSchema,
    editPolicy: EditPolicySchema,
});
/** What get_edit_package answers when `ifNoneMatch` is the current etag. */
export const EditPackageUnchangedSchema = z.object({
    unchanged: z.literal(true),
    etag: z.string().min(1),
});
/** Whether a media slot holds something to download. */
export function isMediaRef(entry) {
    return entry.url !== null;
}
