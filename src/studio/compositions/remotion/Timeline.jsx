// FILM-2018: the Timeline primitive. A line drawn left to right with a dot
// per point as the line reaches it, the date over the dot and the label
// under it. Brand: colors.primary (line and dots), colors.background (the
// plate), colors.captionText, fonts.heading (dates), fonts.body (labels).
import React from 'react'

import { fitFont, fontStack, slotFontSize, timelineRows } from './layout.js'
import { Overlay, SlotText, usePrimitive } from './frame.jsx'

export function Timeline({ props, brand, fit }) {
  const { box, appear, progress, slots } = usePrimitive('timeline', props)
  const draw = progress(0, 0.6)
  const pad = Math.round(box.height * 0.08)
  // Each point owns a slot as wide as its labels; the end points' slots end at the plate's edges.
  const { titleHeight, slot, rowHeight } = timelineRows(box, props)
  const lineY = titleHeight + (box.height - titleHeight) * 0.5
  const step = (box.width - slot) / (props.points.length - 1)
  const primary = brand['colors.primary'] || '#2563EB'
  const dot = Math.max(6, box.height * 0.07)
  const text = { position: 'absolute', width: slot, textAlign: 'center', whiteSpace: 'nowrap' }
  return (
    <Overlay box={box} style={{ opacity: appear, backgroundColor: `${String(brand['colors.background'] || '#000000').slice(0, 7)}99`, borderRadius: pad, color: brand['colors.captionText'] || '#FFFFFF' }}>
      {props.title ? <div style={{ ...text, left: 0, width: box.width, top: pad / 2, height: titleHeight, fontFamily: fontStack(brand['fonts.heading']), fontWeight: slots.title.weight, fontSize: slotFontSize(slots.title, fit) }}><SlotText slot={slots.title} fit={fit} /></div> : null}
      <div style={{ position: 'absolute', left: slot / 2, top: lineY - dot * 0.15, height: dot * 0.3, width: (box.width - slot) * draw, backgroundColor: primary }} />
      {props.points.map((point, index) => {
        const share = props.points.length === 1 ? 0 : index / (props.points.length - 1)
        const shown = draw >= share - 1e-6 ? 1 : 0
        const x = slot / 2 + index * step
        return (
          <React.Fragment key={index}>
            <div style={{ position: 'absolute', left: x - dot / 2, top: lineY - dot / 2, width: dot, height: dot, borderRadius: dot, backgroundColor: primary, opacity: shown }} />
            <div style={{ ...text, left: x - slot / 2, top: lineY - dot - rowHeight, height: rowHeight, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', fontFamily: fontStack(brand['fonts.heading']), fontWeight: 800, fontSize: fitFont(point.date, slot * 0.9, rowHeight * 0.7), opacity: shown }}>{point.date}</div>
            {point.label ? <div style={{ ...text, left: x - slot / 2, top: lineY + dot, height: rowHeight, fontFamily: fontStack(brand['fonts.body']), fontWeight: slots[`points.label.${index}`].weight, fontSize: slotFontSize(slots[`points.label.${index}`], fit), opacity: shown }}><SlotText slot={slots[`points.label.${index}`]} fit={fit} /></div> : null}
          </React.Fragment>
        )
      })}
    </Overlay>
  )
}
