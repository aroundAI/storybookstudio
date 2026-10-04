# StoryBook brand sources

These SVGs are copies. The source is StoryBook's
`packages/branding/assets/brand/`, and `scripts/brand/export.mjs` there
(`pnpm --filter @kit/branding brand:export`) renders the files this repo
ships: `build/icon.png` (then `npm run icons:generate` for the icns and ico),
`build/icons/*`, `public/splash.png`, `public/splash.jpg`,
`public/storybookstudio-welcome-hero.webp` and `public/favicon.svg`. Change a
mark there, not here. `brand.md` says which mark goes where.
