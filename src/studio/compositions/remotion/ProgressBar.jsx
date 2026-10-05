// FILM-2018: the ProgressBar primitive. A track that fills to `value`
// percent over the first 70% of the clip, the percentage riding at its end
// and the label above. Brand: colors.primary (the fill), colors.background
// (the track), colors.captionText, fonts.body.
import React from 'react'
import { Easing, interpolate } from 'remotion'

import { fontStack, progressLabelHeight, slotFontSize } from './layout.js'
import { Overlay, usePrimitive } from './frame.jsx'

export function ProgressBar({ props, brand, fit }) {
  const { box, appear, progress, slots } = usePrimitive('progress-bar', props)
  const filled = interpolate(progress(0, 0.7), [0, 1], [0, props.value], { easing: Easing.out(Easing.cubic) })
  const labelHeight = progressLabelHeight(box)
  const barHeight = box.height - labelHeight
  const font = fontStack(brand['fonts.body'])
  const percent = `${Math.round(filled)}%`
  return (
    <Overlay box={box} style={{ opacity: appear, color: brand['colors.captionText'] || '#FFFFFF', fontFamily: font, textShadow: '0 1px 4px rgba(0, 0, 0, 0.6)' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: labelHeight, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: slots.label.weight, fontSize: Math.min(slotFontSize(slots.label, fit), labelHeight * 0.8), whiteSpace: 'nowrap' }}>
        <span>{props.label}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{percent}</span>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: labelHeight, height: barHeight, borderRadius: barHeight / 2, backgroundColor: `${String(brand['colors.background'] || '#000000').slice(0, 7)}B3` }} />
      <div style={{ position: 'absolute', left: 0, top: labelHeight, height: barHeight, width: (box.width * filled) / 100, borderRadius: barHeight / 2, backgroundColor: brand['colors.primary'] || '#2563EB' }} />
    </Overlay>
  )
}
