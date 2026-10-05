// GENERATED from aroundAI/storybook packages/features/desktop-integration/src/brand.schema.ts
// by scripts/sync-studio-contracts.mjs. Do not edit: change the source in
// StoryBook and run the script again. Needs zod 3.
import { z } from 'zod';
/**
 * FILM-2004: a project's brand, read by the Studio's caption styler, intent
 * compilers and graphics. Stored in `projects.brand`; `{}` is a valid stored
 * value and parses to `BRAND_DEFAULTS`, so every field has a default.
 *
 * This file is a shared contract with StorybookStudio: it is copied into
 * `storybookstudio/src/studio/contracts/`. Keep it self-contained (zod only,
 * no relative imports) and never rename an export.
 */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
export const BrandColorSchema = z
    .string()
    .regex(HEX_COLOR, 'Use a hex colour: #RRGGBB or #RRGGBBAA');
export const CAPTION_POSITIONS = ['top', 'center', 'bottom'];
export const CAPTION_BACKGROUNDS = ['none', 'box', 'outline'];
export const CAPTION_EMPHASES = ['none', 'color', 'scale'];
export const LOGO_POSITIONS = [
    'top-left',
    'top-right',
    'bottom-left',
    'bottom-right',
];
export const TRANSITION_STYLES = ['cut', 'dissolve', 'dip'];
export const TransitionStyleSchema = z.enum(TRANSITION_STYLES);
const FontFamilySchema = z.string().trim().min(1).max(100);
const AssetIdSchema = z.string().uuid().nullable();
export const BrandFontsSchema = z.object({
    heading: FontFamilySchema.default('Inter'),
    body: FontFamilySchema.default('Inter'),
});
export const BrandColorsSchema = z.object({
    primary: BrandColorSchema.default('#2563EB'),
    secondary: BrandColorSchema.default('#F59E0B'),
    background: BrandColorSchema.default('#000000'),
    captionText: BrandColorSchema.default('#FFFFFF'),
    captionBackground: BrandColorSchema.default('#000000'),
});
export const CaptionStyleSchema = z.object({
    /** Pixels at 1080p height; the Studio scales it per render size. */
    fontSize: z.number().int().min(12).max(200).default(48),
    position: z.enum(CAPTION_POSITIONS).default('bottom'),
    maxCharsPerLine: z.number().int().min(10).max(80).default(32),
    background: z.enum(CAPTION_BACKGROUNDS).default('box'),
    emphasis: z.enum(CAPTION_EMPHASES).default('none'),
    /** Words the kinetic captions emphasise, whatever the line they sit in. */
    emphasisWords: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
});
export const BrandLogoSchema = z.object({
    /** An `assets.id` of the project; null = no logo. */
    assetId: AssetIdSchema.default(null),
    position: z.enum(LOGO_POSITIONS).default('top-right'),
    opacity: z.number().min(0).max(1).default(0.8),
});
export const BrandSchema = z.object({
    fonts: BrandFontsSchema.default({}),
    colors: BrandColorsSchema.default({}),
    captionStyle: CaptionStyleSchema.default({}),
    logo: BrandLogoSchema.default({}),
    /** `assets.id` of the clip played before the episode; null = none. */
    introAssetId: AssetIdSchema.default(null),
    /** `assets.id` of the clip played after the episode; null = none. */
    outroAssetId: AssetIdSchema.default(null),
    transitionStyle: TransitionStyleSchema.default('cut'),
    /** Free tags the music picker matches ("lo-fi", "orchestral"). */
    musicStyle: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});
export const BRAND_DEFAULTS = BrandSchema.parse({});
