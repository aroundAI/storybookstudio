import { useId } from 'react'

// The StoryBook S monogram (build/brand/favicon.svg: no perforations, so it
// holds up at 14 px). Source of truth: StoryBook packages/branding/assets/brand.
export default function StudioMark({ className = 'h-4 w-4', title }) {
  const gradientId = `storybook-mark-${useId().replace(/:/g, '')}`
  return (
    <svg
      className={className}
      viewBox="0 0 256 256"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
    >
      <defs>
        <linearGradient id={gradientId} x1="72" y1="232" x2="196" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3B82F6" />
          <stop offset="0.62" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#A855F7" />
        </linearGradient>
      </defs>
      <g transform="translate(128 128) skewX(-12) translate(-128 -128)">
        <path
          d="M162 26H118A62 62 0 0 0 118 150H138A18 18 0 0 1 138 186H70V230H138A62 62 0 0 0 138 106H118A18 18 0 0 1 118 70H186V50Z"
          fill={`url(#${gradientId})`}
        />
        <path d="M162 26L186 50H162Z" fill="#DDD6FE" />
      </g>
    </svg>
  )
}
