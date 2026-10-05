// FILM-2018: the render key of a composition clip. One key, one file:
// compositions/<compositionId>-<propsHash>.webm, where propsHash is the
// sha256 of everything that changes the picture:
//
//   the composition id and its props (defaults filled), the brand tokens the
//   primitive reads, the engine that draws it, the render's length, frame
//   size and frame rate, and a language render's refit (FILM-2019: the font
//   size and lines of each text slot; absent in the master's, so its keys
//   are unchanged).
//
// A language render's localized props and refit are both in the key, so
// each language caches its own file and the master's is never reused for it.
//
// So a props edit, a brand change the primitive reads, or a new frame size
// is a new key and a new render (the old file is never reused for it), and
// an unchanged clip finds its file again after a restart. Pure and
// isomorphic: Web Crypto exists in the renderer and in Node 18+.
import { brandTokensFor, resolveCompositionProps } from './catalogue.js'

export const COMPOSITIONS_DIR = 'compositions'
// 2: each primitive draws inside its safe-area footprint (remotion/layout.js).
export const COMPOSITION_KEY_VERSION = 2

const round3 = (value) => Math.round(Number(value) * 1000) / 1000

// JSON with object keys sorted at every depth, so equal values give equal text.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: numbers must be finite')
    return JSON.stringify(value ?? null)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function compositionKeyMaterial({ engine, compositionId, props, brand, durationSeconds, width, height, fps, fit = null }) {
  if (typeof engine !== 'string' || !engine) throw Object.assign(new Error('A composition render names its engine.'), { code: 'VALIDATION_FAILED' })
  const size = [durationSeconds, width, height, fps].map(Number)
  if (!size.every((value) => Number.isFinite(value) && value > 0)) {
    throw Object.assign(new Error('A composition render needs a positive duration, width, height and fps.'), { code: 'VALIDATION_FAILED' })
  }
  return canonicalJson({
    v: COMPOSITION_KEY_VERSION,
    engine,
    compositionId,
    props: resolveCompositionProps(compositionId, props),
    brand: brandTokensFor(compositionId, brand),
    render: { durationSeconds: round3(durationSeconds), width: Math.round(width), height: Math.round(height), fps: round3(fps) },
    fit: normalizeFit(fit) ?? undefined,
  })
}

// A refit as the key and the engine take it: {slots: {<key>: {fontScale,
// lines}}}, scales in (0, 1], or null.
export function normalizeFit(fit) {
  if (fit == null) return null
  const slots = fit?.slots
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) throw Object.assign(new Error('A refit is {slots: {<key>: {fontScale, lines}}}.'), { code: 'VALIDATION_FAILED' })
  return {
    slots: Object.fromEntries(Object.entries(slots).map(([key, slot]) => {
      const fontScale = Number(slot?.fontScale)
      if (!(fontScale > 0 && fontScale <= 1) || !Array.isArray(slot.lines) || !slot.lines.length || !slot.lines.every((line) => typeof line === 'string')) {
        throw Object.assign(new Error(`The refit of ${key} needs a fontScale in (0, 1] and its lines.`), { code: 'VALIDATION_FAILED' })
      }
      return [key, { fontScale: round3(fontScale), lines: [...slot.lines] }]
    })),
  }
}

export async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const compositionPropsHash = async (request) => sha256Hex(compositionKeyMaterial(request))

// Project-relative, forward slashes on every platform (it is stored in the project file).
export const compositionRenderPath = (compositionId, propsHash) => `${COMPOSITIONS_DIR}/${compositionId}-${propsHash}.webm`
