// GENERATED from aroundAI/storybook packages/features/desktop-integration/src/delivery-package.schema.ts
// by scripts/sync-studio-contracts.mjs. Do not edit: change the source in
// StoryBook and run the script again. Needs zod 3.
import { z } from 'zod';
import { ExplainWhyReportSchema } from './explain-why-report.schema.mjs';
import { QaResultSchema } from './qa-result.schema.mjs';
import { RENDER_CONTENT_TYPE, RenderAspectSchema, RenderLanguageSchema, RenderPresetSchema, } from './render-presets.mjs';
/**
 * What StorybookStudio sends back (FILM-2003): the inputs of
 * request_render_upload, finalize_render and deliver_edit. The size limits
 * are the `project-assets` bucket's (KB-28): a render is a video, at most
 * 500 MB; its thumbnail an image, at most 10 MB; its captions a WebVTT file,
 * at most 2 MB. Zod only, so the fork copies this file unchanged.
 */
export const MAX_RENDER_BYTES = 500 * 1024 * 1024;
export const MAX_RENDER_THUMBNAIL_BYTES = 10 * 1024 * 1024;
export const MAX_RENDER_CAPTIONS_BYTES = 2 * 1024 * 1024;
export const RENDER_THUMBNAIL_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
];
export const RENDER_CAPTIONS_TYPE = 'text/vtt';
const Uuid = z.string().uuid();
export const RequestRenderUploadSchema = z.object({
    sessionId: Uuid,
    preset: RenderPresetSchema,
    language: RenderLanguageSchema.default('en'),
    aspect: RenderAspectSchema,
    bytes: z.number().int().positive().max(MAX_RENDER_BYTES),
    contentType: z.literal(RENDER_CONTENT_TYPE),
    /** Also sign an upload for the render's thumbnail. */
    thumbnail: z
        .object({
        bytes: z.number().int().positive().max(MAX_RENDER_THUMBNAIL_BYTES),
        contentType: z.enum(RENDER_THUMBNAIL_TYPES),
    })
        .optional(),
    /** Also sign an upload for the render's captions (WebVTT). */
    captions: z
        .object({
        bytes: z.number().int().positive().max(MAX_RENDER_CAPTIONS_BYTES),
        contentType: z.literal(RENDER_CAPTIONS_TYPE),
    })
        .optional(),
});
export const FinalizeRenderSchema = z.object({
    renderId: Uuid,
    durationSeconds: z
        .number()
        .positive()
        .max(24 * 3600),
    qa: QaResultSchema,
    /** The key request_render_upload returned for the captions, once uploaded. */
    captionsKey: z.string().min(1).max(512).optional(),
    /** The key request_render_upload returned for the thumbnail, once uploaded. */
    thumbnailKey: z.string().min(1).max(512).optional(),
});
export const DeliveryRenderSchema = z.object({
    renderId: Uuid,
    /** Informational; the stored render's own preset and language are used. */
    preset: RenderPresetSchema.optional(),
    language: RenderLanguageSchema.optional(),
    primary: z.boolean().optional(),
});
/** The package's fields without the cross-field rules, for a tool's input shape. */
export const DeliveryPackageObjectSchema = z.object({
    sessionId: Uuid,
    /** episodes.version the Studio edited: the one open_edit_session returned. */
    episodeVersion: z.number().int().positive(),
    renders: z.array(DeliveryRenderSchema).min(1).max(20),
    report: ExplainWhyReportSchema,
    qa: QaResultSchema,
});
export const DeliveryPackageSchema = DeliveryPackageObjectSchema.superRefine((value, ctx) => {
    const primaries = value.renders.filter((render) => render.primary).length;
    if (primaries !== 1) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['renders'],
            message: `Exactly one render must be primary; ${primaries} are`,
        });
    }
    const ids = value.renders.map((render) => render.renderId);
    if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['renders'],
            message: 'A render is listed twice',
        });
    }
});
