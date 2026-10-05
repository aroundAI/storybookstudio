// FILM-2018: what every primitive's component starts from: the current
// frame, the footprint it draws in (layout.js) and a 0-1 fade-in over the
// first quarter second. The page behind it stays transparent, so the render
// is an overlay.
import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion'

import { boxStyle, footprintFor } from './layout.js'

export function usePrimitive(compositionId, props) {
  const frame = useCurrentFrame()
  const { width, height, fps, durationInFrames } = useVideoConfig()
  const box = footprintFor(compositionId, props, { width, height })
  const appear = interpolate(frame, [0, Math.max(1, Math.round(fps * 0.25))], [0, 1], { extrapolateRight: 'clamp' })
  // 0 to 1 over [startShare, endShare] of the clip.
  const progress = (startShare, endShare) => interpolate(frame, [Math.round((durationInFrames - 1) * startShare), Math.max(1, Math.round((durationInFrames - 1) * endShare))], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  return { frame, fps, durationInFrames, box, appear, progress }
}

// The transparent page with the footprint on it.
export function Overlay({ box, style = {}, children }) {
  return (
    <AbsoluteFill style={{ backgroundColor: 'transparent' }}>
      <div style={{ ...boxStyle(box), ...style }}>{children}</div>
    </AbsoluteFill>
  )
}
