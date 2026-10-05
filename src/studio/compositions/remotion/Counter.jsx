// FILM-2018: the Counter primitive. A number counts from `from` to `to` over
// the first 75% of the clip, eased out, then holds; prefix, suffix and label
// around it. Brand: colors.primary (the plate), colors.captionText (the
// text), fonts.heading. Transparent everywhere else, so it renders as an
// overlay.
import React from 'react'
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion'

import { anchorStyle, fontStack } from './layout.js'

export const COUNT_SHARE = 0.75

export function counterValue({ from, to, decimals }, frame, durationInFrames) {
  const end = Math.max(1, Math.round((durationInFrames - 1) * COUNT_SHARE))
  const value = interpolate(frame, [0, end], [from, to], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) })
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export function Counter({ props, brand }) {
  const frame = useCurrentFrame()
  const { width, height, durationInFrames, fps } = useVideoConfig()
  const short = Math.min(width, height)
  const appear = interpolate(frame, [0, Math.max(1, Math.round(fps * 0.25))], [0, 1], { extrapolateRight: 'clamp' })
  const text = brand['colors.captionText'] || '#FFFFFF'
  return (
    <AbsoluteFill style={{ backgroundColor: 'transparent' }}>
      <div style={anchorStyle(props.anchor, { width, height })}>
        <div
          style={{
            opacity: appear,
            transform: `scale(${0.9 + appear * 0.1})`,
            backgroundColor: brand['colors.primary'] || '#2563EB',
            color: text,
            fontFamily: fontStack(brand['fonts.heading']),
            borderRadius: Math.round(short * 0.025),
            padding: `${Math.round(short * 0.02)}px ${Math.round(short * 0.045)}px`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <div style={{ fontSize: Math.round(short * 0.14), fontWeight: 800, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>
            {props.prefix}
            {counterValue(props, frame, durationInFrames)}
            {props.suffix}
          </div>
          {props.label ? <div style={{ fontSize: Math.round(short * 0.045), fontWeight: 600, marginTop: Math.round(short * 0.006) }}>{props.label}</div> : null}
        </div>
      </div>
    </AbsoluteFill>
  )
}
