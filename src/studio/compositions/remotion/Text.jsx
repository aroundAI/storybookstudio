// FILM-2018: the Text primitive. A title (and optional subtitle) on a plate
// that fills the footprint, or bare with a shadow when `plate` is false.
// Brand: colors.primary, colors.captionText, fonts.heading.
import React from 'react'

import { fitFont, fontStack } from './layout.js'
import { Overlay, usePrimitive } from './frame.jsx'

export function Text({ props, brand }) {
  const { box, appear } = usePrimitive('text', props)
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
      <div style={{ fontSize: fitFont(props.text, box.width * 0.9, box.height * (props.subtitle ? 0.42 : 0.55)), fontWeight: 800, whiteSpace: 'nowrap' }}>{props.text}</div>
      {props.subtitle ? <div style={{ fontSize: fitFont(props.subtitle, box.width * 0.9, box.height * 0.2), fontWeight: 500, whiteSpace: 'nowrap' }}>{props.subtitle}</div> : null}
    </Overlay>
  )
}
