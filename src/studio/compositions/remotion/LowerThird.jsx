// FILM-2018: the LowerThird primitive. A name strip that slides in, an
// accent bar at its edge and the title under it. Brand: colors.primary (the
// accent and title strip), colors.background (the name strip),
// colors.captionText, fonts.heading (the name), fonts.body (the title).
import React from 'react'

import { fontStack, lowerThirdNameHeight, slotFontSize } from './layout.js'
import { Overlay, SlotText, usePrimitive } from './frame.jsx'

export function LowerThird({ props, brand, fit }) {
  const { box, appear, progress, slots } = usePrimitive('lower-third', props)
  const slide = progress(0, 0.15)
  const accent = Math.round(box.height * 0.08)
  const nameHeight = lowerThirdNameHeight(box, props)
  const text = brand['colors.captionText'] || '#FFFFFF'
  const strip = { position: 'absolute', left: accent, display: 'flex', alignItems: 'center', paddingLeft: Math.round(box.height * 0.12), whiteSpace: 'nowrap', color: text }
  return (
    <Overlay box={box} style={{ opacity: appear, transform: `translateX(${(slide - 1) * box.width * 0.08}px)` }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: accent, height: box.height, backgroundColor: brand['colors.primary'] || '#2563EB' }} />
      <div style={{ ...strip, top: 0, height: nameHeight, width: (box.width - accent) * slide, backgroundColor: brand['colors.background'] || '#000000', fontFamily: fontStack(brand['fonts.heading']), fontWeight: slots.name.weight, fontSize: slotFontSize(slots.name, fit) }}><SlotText slot={slots.name} fit={fit} align="flex-start" /></div>
      {props.title ? (
        <div style={{ ...strip, top: nameHeight, height: box.height - nameHeight, width: (box.width - accent) * 0.8 * slide, backgroundColor: brand['colors.primary'] || '#2563EB', fontFamily: fontStack(brand['fonts.body']), fontWeight: slots.title.weight, fontSize: slotFontSize(slots.title, fit) }}><SlotText slot={slots.title} fit={fit} align="flex-start" /></div>
      ) : null}
    </Overlay>
  )
}
