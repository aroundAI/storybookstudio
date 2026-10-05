// FILM-2018: where a primitive sits in the frame. Anchors place the graphic
// inside a margin of the frame's short side, so a counter in a corner stays
// clear of the edge on 16:9 and 9:16 alike. (FILM-2014's safe-area QA checks
// the rendered result against captions.)
export const ANCHOR_MARGIN = 0.08

export function anchorStyle(anchor = 'center', { width, height }) {
  const margin = Math.round(Math.min(width, height) * ANCHOR_MARGIN)
  const [vertical, horizontal] = anchor === 'center' ? ['center', 'center']
    : anchor === 'top' || anchor === 'bottom' ? [anchor, 'center']
    : anchor === 'left' || anchor === 'right' ? ['center', anchor]
    : anchor.split('-')
  const flex = { top: 'flex-start', center: 'center', bottom: 'flex-end', left: 'flex-start', right: 'flex-end' }
  return {
    position: 'absolute',
    inset: 0,
    padding: margin,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: flex[vertical],
    alignItems: flex[horizontal],
  }
}

// A brand font first, then fonts every platform has.
export const fontStack = (family) => `${family ? `"${String(family).replace(/"/g, '')}", ` : ''}system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`
