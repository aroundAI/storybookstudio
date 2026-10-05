// FILM-2018: the Text primitive. A title (and optional subtitle) on a plate
// that fills the footprint, or bare with a shadow when `plate` is false.
// Brand: colors.primary, colors.captionText, fonts.heading.
import React from 'react'

import { fontStack, slotFontSize } from './layout.js'
import { Overlay, SlotText, usePrimitive } from './frame.jsx'

export function Text({ props, brand, fit }) {
  const { box, appear, slots } = usePrimitive('text', props)
  const color = brand['colors.captionText'] || '#FFFFFF'
  return (
    <Overlay
      box={box}
      style={{
        opacity: appear,
        transform: `translateY(${(1 - appear) * box.height * 0.15}px)`,
        backgroundColor: props.plate ? brand['colors.primary'] || '#2563EB' : 'transparent',
        borderRadius: Math.round(box.height * 0.1),
        color,
        fontFamily: fontStack(brand['fonts.heading']),
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textShadow: props.plate ? 'none' : '0 2px 8px rgba(0, 0, 0, 0.6)',
      }}
    >
      <div style={{ fontSize: slotFontSize(slots.text, fit), fontWeight: slots.text.weight, whiteSpace: 'nowrap' }}><SlotText slot={slots.text} fit={fit} /></div>
      {props.subtitle ? <div style={{ fontSize: slotFontSize(slots.subtitle, fit), fontWeight: slots.subtitle.weight, whiteSpace: 'nowrap' }}><SlotText slot={slots.subtitle} fit={fit} /></div> : null}
    </Overlay>
  )
}
