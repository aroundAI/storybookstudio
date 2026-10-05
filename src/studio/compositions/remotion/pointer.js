// FILM-2018: a direction (DIRECTIONS in catalogue.js) as a unit vector, x to
// the right and y down, for Arrow and Callout.
const DIAGONAL = Math.SQRT1_2

export const DIRECTION_VECTORS = Object.freeze({
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
  'up-left': [-DIAGONAL, -DIAGONAL],
  'up-right': [DIAGONAL, -DIAGONAL],
  'down-left': [-DIAGONAL, DIAGONAL],
  'down-right': [DIAGONAL, DIAGONAL],
})

export const angleOf = (direction) => {
  const [x, y] = DIRECTION_VECTORS[direction] || DIRECTION_VECTORS.right
  return (Math.atan2(y, x) * 180) / Math.PI
}
