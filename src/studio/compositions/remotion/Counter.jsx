// FILM-2018: the Counter primitive. A number counts from `from` to `to` over
// the first 75% of the clip, eased out, then holds; prefix, suffix and label
// around it, on a plate that fills the footprint. Brand: colors.primary (the
// plate), colors.captionText (the text), fonts.heading.
import React from 'react'
import { Easing, interpolate } from 'remotion'

import { fitFont, fontStack } from './layout.js'
import { Overlay, usePrimitive } from './frame.jsx'

export const COUNT_SHARE = 0.75

export function counterValue({ from, to, decimals }, frame, durationInFrames) {
  const end = Math.max(1, Math.round((durationInFrames - 1) * COUNT_SHARE))
  const value = interpolate(frame, [0, end], [from, to], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) })
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export function Counter({ props, brand }) {
  const { frame, durationInFrames, box, appear } = usePrimitive('counter', props)
  const widest = `${props.prefix}${counterValue({ ...props, from: props.to }, 0, 1)}${props.suffix}`
  return (
    <Overlay
      box={box}
      style={{
        opacity: appear,
        transform: `scale(${0.9 + appear * 0.1})`,
        backgroundColor: brand['colors.primary'] || '#2563EB',
        color: brand['colors.captionText'] || '#FFFFFF',
        fontFamily: fontStack(brand['fonts.heading']),
        borderRadius: Math.round(box.height * 0.08),
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ fontSize: fitFont(widest, box.width * 0.86, box.height * (props.label ? 0.5 : 0.62)), fontWeight: 800, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {props.prefix}
        {counterValue(props, frame, durationInFrames)}
        {props.suffix}
      </div>
      {props.label ? <div style={{ fontSize: fitFont(props.label, box.width * 0.86, box.height * 0.16), fontWeight: 600, whiteSpace: 'nowrap' }}>{props.label}</div> : null}
    </Overlay>
  )
}
