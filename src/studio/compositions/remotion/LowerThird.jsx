// FILM-2018: the LowerThird primitive. A name strip that slides in, an
// accent bar at its edge and the title under it. Brand: colors.primary (the
// accent and title strip), colors.background (the name strip),
// colors.captionText, fonts.heading (the name), fonts.body (the title).
import React from 'react'

import { fitFont, fontStack } from './layout.js'
import { Overlay, usePrimitive } from './frame.jsx'

export function LowerThird({ props, brand }) {
  const { box, appear, progress } = usePrimitive('lower-third', props)
  const slide = progress(0, 0.15)
  const accent = Math.round(box.height * 0.08)
  const nameHeight = Math.round(box.height * (props.title ? 0.58 : 1))
  const text = brand['colors.captionText'] || '#FFFFFF'
  const strip = { position: 'absolute', left: accent, display: 'flex', alignItems: 'center', paddingLeft: Math.round(box.height * 0.12), whiteSpace: 'nowrap', color: text }
  return (
    <Overlay box={box} style={{ opacity: appear, transform: `translateX(${(slide - 1) * box.width * 0.08}px)` }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: accent, height: box.height, backgroundColor: brand['colors.primary'] || '#2563EB' }} />
      <div style={{ ...strip, top: 0, height: nameHeight, width: (box.width - accent) * slide, backgroundColor: brand['colors.background'] || '#000000', fontFamily: fontStack(brand['fonts.heading']), fontWeight: 800, fontSize: fitFont(props.name, box.width * 0.85, nameHeight * 0.6) }}>{props.name}</div>
      {props.title ? (
        <div style={{ ...strip, top: nameHeight, height: box.height - nameHeight, width: (box.width - accent) * 0.8 * slide, backgroundColor: brand['colors.primary'] || '#2563EB', fontFamily: fontStack(brand['fonts.body']), fontWeight: 500, fontSize: fitFont(props.title, box.width * 0.7, (box.height - nameHeight) * 0.62) }}>{props.title}</div>
      ) : null}
    </Overlay>
  )
}
