// FILM-2018: the Highlight primitive. An outline (box or ellipse) drawn
// round a region of the picture, with an optional label inside its top
// edge. The footprint is the region (cut to the safe area). Brand:
// colors.secondary (the outline), colors.captionText, fonts.body.
import React from 'react'

import { fontStack, slotFontSize } from './layout.js'
import { Overlay, SlotText, usePrimitive } from './frame.jsx'

export function Highlight({ props, brand, fit }) {
  const { box, appear, progress, slots } = usePrimitive('highlight', props)
  const draw = progress(0, 0.25)
  const stroke = Math.max(3, Math.round(Math.min(box.width, box.height) * 0.04))
  const color = brand['colors.secondary'] || '#F59E0B'
  const inset = stroke / 2
  const shape = props.shape === 'ellipse'
    ? <ellipse cx={box.width / 2} cy={box.height / 2} rx={box.width / 2 - inset} ry={box.height / 2 - inset} pathLength={1} />
    : <rect x={inset} y={inset} width={box.width - stroke} height={box.height - stroke} rx={stroke * 2} pathLength={1} />
  return (
    <Overlay box={box} style={{ opacity: appear }}>
      <svg width={box.width} height={box.height} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={1} strokeDashoffset={1 - draw}>
        {shape}
      </svg>
      {props.label ? (
        <div style={{ position: 'absolute', left: stroke * 2, top: stroke * 2, padding: `0 ${stroke}px`, backgroundColor: color, color: brand['colors.captionText'] || '#FFFFFF', fontFamily: fontStack(brand['fonts.body']), fontWeight: slots.label.weight, fontSize: slotFontSize(slots.label, fit), whiteSpace: 'nowrap' }}><SlotText slot={slots.label} fit={fit} align="flex-start" /></div>
      ) : null}
    </Overlay>
  )
}
