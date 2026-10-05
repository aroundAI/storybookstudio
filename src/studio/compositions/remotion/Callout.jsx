// FILM-2018: the Callout primitive. A label in a bubble with a tail toward
// `pointer`, popping in. Brand: colors.secondary (the bubble),
// colors.background (the text on it), fonts.body.
import React from 'react'

import { calloutBubble, fontStack, slotFontSize } from './layout.js'
import { Overlay, SlotText, usePrimitive } from './frame.jsx'

export function Callout({ props, brand, fit }) {
  const { box, appear, slots } = usePrimitive('callout', props)
  const fill = brand['colors.secondary'] || '#F59E0B'
  // The bubble keeps clear of the side the tail leaves from.
  const bubble = calloutBubble(box, props.pointer)
  const { dx, dy, tail, width: bubbleWidth, height: bubbleHeight } = bubble
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
          fontWeight: slots.text.weight,
          fontSize: slotFontSize(slots.text, fit),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          whiteSpace: 'nowrap',
        }}
      >
        <SlotText slot={slots.text} fit={fit} />
      </div>
    </Overlay>
  )
}
