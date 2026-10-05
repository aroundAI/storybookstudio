// FILM-2018: the Chart primitive. A bar chart of up to six values that grow
// in one after another, each with its value over it and its label under it,
// on a translucent plate. Brand: colors.primary (bars, alternating with
// colors.secondary), colors.background (the plate), colors.captionText,
// fonts.heading (the title), fonts.body.
import React from 'react'

import { fitFont, fontStack } from './layout.js'
import { Overlay, usePrimitive } from './frame.jsx'

const formatValue = (value, unit) => `${Number.isInteger(value) ? value : value.toFixed(1)}${unit}`

export function Chart({ props, brand }) {
  const { box, appear, progress } = usePrimitive('chart', props)
  const pad = Math.round(box.height * 0.06)
  const titleHeight = props.title ? Math.round(box.height * 0.13) : 0
  const labelHeight = Math.round(box.height * 0.1)
  const valueHeight = Math.round(box.height * 0.09)
  const plotHeight = box.height - pad * 2 - titleHeight - labelHeight - valueHeight
  const slot = (box.width - pad * 2) / props.items.length
  const max = Math.max(...props.items.map((item) => item.value), 0) || 1
  const text = brand['colors.captionText'] || '#FFFFFF'
  const colors = [brand['colors.primary'] || '#2563EB', brand['colors.secondary'] || '#F59E0B']
  const font = fontStack(brand['fonts.body'])
  return (
    <Overlay box={box} style={{ opacity: appear, backgroundColor: `${String(brand['colors.background'] || '#000000').slice(0, 7)}B3`, borderRadius: pad, color: text }}>
      {props.title ? <div style={{ position: 'absolute', left: pad, right: pad, top: pad, height: titleHeight, textAlign: 'center', fontFamily: fontStack(brand['fonts.heading']), fontWeight: 800, fontSize: fitFont(props.title, box.width - pad * 2, titleHeight * 0.8), whiteSpace: 'nowrap' }}>{props.title}</div> : null}
      {props.items.map((item, index) => {
        const grow = progress(0.05 + index * 0.08, 0.35 + index * 0.08)
        const barHeight = Math.max(2, (item.value / max) * plotHeight * grow)
        const left = pad + index * slot
        const baseline = pad + titleHeight + valueHeight + plotHeight
        return (
          <React.Fragment key={index}>
            <div style={{ position: 'absolute', left: left + slot * 0.18, width: slot * 0.64, top: baseline - barHeight, height: barHeight, backgroundColor: colors[index % 2], borderRadius: `${pad / 3}px ${pad / 3}px 0 0` }} />
            <div style={{ position: 'absolute', left, width: slot, top: baseline - barHeight - valueHeight, height: valueHeight, textAlign: 'center', fontFamily: font, fontWeight: 700, fontSize: fitFont(formatValue(item.value, props.unit), slot * 0.9, valueHeight * 0.8), opacity: grow, whiteSpace: 'nowrap' }}>{formatValue(item.value, props.unit)}</div>
            <div style={{ position: 'absolute', left, width: slot, top: baseline + labelHeight * 0.1, height: labelHeight, textAlign: 'center', fontFamily: font, fontWeight: 500, fontSize: fitFont(item.label, slot * 0.92, labelHeight * 0.75), whiteSpace: 'nowrap' }}>{item.label}</div>
          </React.Fragment>
        )
      })}
    </Overlay>
  )
}
