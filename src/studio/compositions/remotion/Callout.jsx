// FILM-2018: the Callout primitive. A label in a bubble with a tail toward
// `pointer`, popping in. Brand: colors.secondary (the bubble),
// colors.background (the text on it), fonts.body.
import React from 'react'

import { fitFont, fontStack } from './layout.js'
import { Overlay, usePrimitive } from './frame.jsx'
import { DIRECTION_VECTORS } from './pointer.js'

export function Callout({ props, brand }) {
  const { box, appear } = usePrimitive('callout', props)
  const fill = brand['colors.secondary'] || '#F59E0B'
  const [dx, dy] = DIRECTION_VECTORS[props.pointer] || DIRECTION_VECTORS['down-left']
  // The bubble keeps clear of the side the tail leaves from.
  const tail = Math.min(box.width, box.height) * 0.3
  const bubble = {
    left: dx < 0 ? tail : 0,
    right: dx > 0 ? tail : 0,
    top: dy < 0 ? tail : 0,
    bottom: dy > 0 ? tail : 0,
  }
  const bubbleWidth = box.width - bubble.left - bubble.right
  const bubbleHeight = box.height - bubble.top - bubble.bottom
  const cx = bubble.left + bubbleWidth / 2
  const cy = bubble.top + bubbleHeight / 2
  const tipX = cx + dx * (bubbleWidth / 2 + tail * 0.9)
  const tipY = cy + dy * (bubbleHeight / 2 + tail * 0.9)
  const spread = Math.min(bubbleWidth, bubbleHeight) * 0.18
  return (
    <Overlay box={box} style={{ opacity: appear, transform: `scale(${0.85 + appear * 0.15})` }}>
      <svg width={box.width} height={box.height} style={{ position: 'absolute', inset: 0 }}>
        <polygon points={`${cx - dy * spread},${cy + dx * spread} ${cx + dy * spread},${cy - dx * spread} ${tipX},${tipY}`} fill={fill} />
      </svg>
      <div
        style={{
          position: 'absolute',
          left: bubble.left,
          top: bubble.top,
          width: bubbleWidth,
          height: bubbleHeight,
          backgroundColor: fill,
          borderRadius: Math.round(bubbleHeight * 0.3),
          color: brand['colors.background'] || '#000000',
          fontFamily: fontStack(brand['fonts.body']),
          fontWeight: 700,
          fontSize: fitFont(props.text, bubbleWidth * 0.88, bubbleHeight * 0.42),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          whiteSpace: 'nowrap',
        }}
      >
        {props.text}
      </div>
    </Overlay>
  )
}
