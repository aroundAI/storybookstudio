# StoryBook brand kit

These SVGs are the single source of StoryBook's logos and icons. Every PNG,
ICO and ICNS in the web app and in StorybookStudio is rendered from them by
`scripts/brand/export.mjs`:

```bash
pnpm --filter @kit/branding brand:export
```

The script writes the web app's files in place (`apps/web/public/images/`) and
the StorybookStudio set to `packages/branding/dist/studio/` (gitignored). The
fork keeps a copy of these sources in `build/brand/` and the rendered files in
`build/` and `public/`. Change a mark here, export, then copy the Studio set
into the fork.

FILM-2004's brand settings, which hold a team's own logo and colours for their
episodes, are unrelated. This kit is StoryBook's own identity.

## The marks

| Mark | Files | Use it for |
|---|---|---|
| S monogram | `monogram.svg`, `monogram-mono-white.svg`, `monogram-mono-black.svg` | The primary mark. App icons, favicons, avatars, and anywhere the name is already visible. |
| Wordmark | `wordmark.svg` (white), `wordmark-on-light.svg` | Only with the monogram nearby, or where the mark would be too small. |
| UI lockup | `lockup-ui.svg`, `lockup-ui-on-light.svg` | App headers and navigation. The web app's `logo-dark.png` and `logo-light.png` are this lockup. |
| Lockup with tagline | `lockup-horizontal*.svg` ("AI-powered story studio"), `lockup-horizontal-alt*.svg` ("From concept to screen.") | Marketing, sign-in screens, documents. |
| Monochrome lockup | `lockup-mono-white.svg`, `lockup-mono-black.svg` | One-colour print, embossing, partner pages that ask for it. |
| Brand mark (book) | `brand-mark-book.svg` | Hero and splash art only. The open book whose right page is a film frame. It is never the app icon. |
| App icons | `app-icon-dark.svg` (default), `app-icon-light.svg`, `app-icon-mono.svg` | Full-bleed 1024 squares. The export applies the macOS squircle and shadow. iOS and Android mask the square themselves. |
| Favicon | `favicon.svg` | Browser tabs. It drops the perforations, which disappear below 32 px. |
| Social avatar | `social-avatar.svg` | Profile pictures. It is safe inside a circular crop. |
| Studio art | `splash-studio.svg`, `hero-studio.svg`, `wordmark-studio*.svg`, `background-wave.svg` | StorybookStudio's splash window, its welcome screen, and the product name. |

The monogram is an S whose top corner folds back like a page and whose lower
bowl is punched like film stock. Keep both details. Do not redraw the mark,
re-space the wordmark, or recolour the gradient.

## Product names

- **StoryBook** is the brand and the web app. Write it with a capital B.
- **StorybookStudio** is the desktop editor, written as one word. It uses the
  StoryBook monogram and app icon. Its own wordmark appears only in Studio art.

## Clear space and minimum sizes

- **Clear space:** keep at least the height of the wordmark's capital S free
  around every lockup. Around the monogram alone, keep a quarter of its height.
- **Monogram:** at least 16 px. Below 32 px use `favicon.svg`.
- **UI lockup:** at least 96 px wide on screen.
- **Lockups with a tagline:** at least 240 px wide. Below that, use the UI lockup.

## Colour

The marks use the brand gradient, Blue `#3B82F6` to Violet `#8B5CF6` with a
Purple `#A855F7` tip, running from bottom-left to top-right. Put them on
Midnight `#0B0F1A`, on white, or on a photograph dark enough for the white
wordmark. On mid-tone or busy grounds, use a monochrome version.
`palette.json` lists the whole palette.

## Type

The wordmark is Outfit SemiBold (600) at -0.012 em tracking. Taglines are
Outfit Regular (400): caps tracked 0.32 em, and sentence case at 0.04 em.
Outfit is licensed under the SIL Open Font License 1.1. Every SVG carries its
text as outlines, so no font has to be installed to render one. To change a
word, re-outline it from Outfit at the same weight and size rather than
editing the paths by hand.
