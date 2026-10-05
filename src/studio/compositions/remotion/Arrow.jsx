// FILM-2018: the Arrow primitive. An arrow that grows out in `direction`
// from the middle of its footprint, with an optional label behind its tail.
// Brand: colors.secondary (the arrow), colors.captionText, fonts.body.
import React from 'react'

import { fitFont, fontStack } from './layout.js'
import { Overlay, usePrimitive } from './frame.jsx'
import { angleOf } from './pointer.js'

export function Arrow({ props, brand }) {
  const { box, appear, progress } = usePrimitive('arrow', props)
  const grow = progress(0, 0.3)
  const size = Math.min(box.width, box.height)
  const color = brand['colors.secondary'] || '#F59E0B'
  const half = size * 0.42
  const shaft = half * (0.4 + 0.6 * grow)
  return (
    <Overlay box={box} style={{ opacity: appear }}>
      <svg width={box.width} height={box.height} viewBox={`${-box.width / 2} ${-box.height / 2} ${box.width} ${box.height}`}>
        <g transform={`rotate(${angleOf(props.direction)})`}>
          <line x1={-half} y1={0} x2={-half + 2 * shaft - size * 0.12} y2={0} stroke={color} strokeWidth={size * 0.09} strokeLinecap="round" />
          <polygon points={`${-half + 2 * shaft},0 ${-half + 2 * shaft - size * 0.22},${-size * 0.16} ${-half + 2 * shaft - size * 0.22},${size * 0.16}`} fill={color} />
        </g>
      </svg>
      {props.label ? (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, textAlign: 'center', color: brand['colors.captionText'] || '#FFFFFF', fontFamily: fontStack(brand['fonts.body']), fontWeight: 700, fontSize: fitFont(props.label, box.width * 0.95, size * 0.14), textShadow: '0 2px 6px rgba(0, 0, 0, 0.7)', whiteSpace: 'nowrap' }}>{props.label}</div>
      ) : null}
    </Overlay>
  )
}
