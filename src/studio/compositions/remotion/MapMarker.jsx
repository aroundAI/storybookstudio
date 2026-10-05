// FILM-2018: the Map primitive (MapMarker, so as not to shadow Map). Not a
// map: a drawn location marker. A pin drops onto a ground disc with rings
// pulsing out from it and the place name under it. No tiles, no geography, no network. Brand: colors.primary (the
// pin), colors.secondary (the rings), colors.background (the disc),
// colors.captionText, fonts.heading.
import React from 'react'
import { Easing, interpolate } from 'remotion'

import { fontStack, mapLabelHeight, slotFontSize } from './layout.js'
import { Overlay, SlotText, usePrimitive } from './frame.jsx'

export function MapMarker({ props, brand, fit }) {
  const { frame, fps, box, appear, progress, slots } = usePrimitive('map', props)
  const size = Math.min(box.width, box.height)
  const labelHeight = mapLabelHeight(box, props)
  const ground = { x: box.width / 2, y: (box.height - labelHeight) * 0.78 }
  const drop = interpolate(progress(0, 0.2), [0, 1], [-size * 0.3, 0], { easing: Easing.out(Easing.back(1.6)) })
  const pin = size * 0.22
  const ring = ((frame / fps) % 1.2) / 1.2
  const primary = brand['colors.primary'] || '#2563EB'
  return (
    <Overlay box={box} style={{ opacity: appear, color: brand['colors.captionText'] || '#FFFFFF' }}>
      <svg width={box.width} height={box.height - labelHeight}>
        <ellipse cx={ground.x} cy={ground.y} rx={size * 0.3} ry={size * 0.09} fill={brand['colors.background'] || '#000000'} fillOpacity={0.55} />
        <ellipse cx={ground.x} cy={ground.y} rx={size * 0.3 * ring} ry={size * 0.09 * ring} fill="none" stroke={brand['colors.secondary'] || '#F59E0B'} strokeWidth={Math.max(2, size * 0.012)} strokeOpacity={1 - ring} />
        <g transform={`translate(${ground.x} ${ground.y + drop})`}>
          <path d={`M 0 0 C ${-pin * 0.15} ${-pin * 0.45} ${-pin * 0.5} ${-pin * 0.7} ${-pin * 0.5} ${-pin * 1.05} A ${pin * 0.5} ${pin * 0.5} 0 1 1 ${pin * 0.5} ${-pin * 1.05} C ${pin * 0.5} ${-pin * 0.7} ${pin * 0.15} ${-pin * 0.45} 0 0 Z`} fill={primary} />
          <circle cx={0} cy={-pin * 1.05} r={pin * 0.2} fill={brand['colors.background'] || '#000000'} />
        </g>
      </svg>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: labelHeight, textAlign: 'center', fontFamily: fontStack(brand['fonts.heading']), textShadow: '0 2px 6px rgba(0, 0, 0, 0.7)', whiteSpace: 'nowrap' }}>
        <div style={{ fontWeight: slots.place.weight, fontSize: slotFontSize(slots.place, fit) }}><SlotText slot={slots.place} fit={fit} /></div>
        {props.caption ? <div style={{ fontWeight: slots.caption.weight, fontSize: slotFontSize(slots.caption, fit) }}><SlotText slot={slots.caption} fit={fit} /></div> : null}
      </div>
    </Overlay>
  )
}
