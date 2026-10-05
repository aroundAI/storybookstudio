// FILM-2018: the catalogue of composition primitives, the graphics a
// composition clip renders (a counter, a callout, a lower third, ...).
//
// A primitive is data, not a renderer: the render engine
// (electron/studio/compositionRenderer.js) draws it. Each entry has
//
//   id                     a lowercase slug; it names the render file
//                          (compositions/<id>-<propsHash>.webm)
//   title, description     what the agent reads in the catalogue
//   propsSchema            a zod object; parse() fills the defaults, and the
//                          parsed props are what the render key hashes
//   brandTokens            dotted paths into the brand (contracts/brand.schema.mjs)
//                          the primitive reads; they join the render key, so
//                          a brand change re-renders only what it touches
//   textProps              props that hold words: re-written per language when
//                          a clip's languageDependency is 'language' (FILM-2019)
//   defaultDurationSeconds a clip's length when the caller gives none
//
// Adding a primitive is one entry here plus its drawing in the engine.
// Pure module: no Electron, no stores.
import { z } from 'zod'

import { BrandSchema } from '../contracts/brand.schema.mjs'

export const COMPOSITION_ANCHORS = Object.freeze([
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
])

const AnchorSchema = z.enum(COMPOSITION_ANCHORS)
const ShortText = z.string().trim().max(60)

const CounterPropsSchema = z
  .object({
    from: z.number().finite().default(0),
    to: z.number().finite(),
    decimals: z.number().int().min(0).max(3).default(0),
    prefix: ShortText.default(''),
    suffix: ShortText.default(''),
    label: ShortText.default(''),
    anchor: AnchorSchema.default('center'),
  })
  .strict()

const PRIMITIVES = [
  {
    id: 'counter',
    title: 'Counter',
    description: 'A number that counts from `from` to `to` over the clip, with an optional prefix, suffix and label.',
    propsSchema: CounterPropsSchema,
    brandTokens: ['colors.primary', 'colors.captionText', 'fonts.heading'],
    textProps: ['prefix', 'suffix', 'label'],
    defaultDurationSeconds: 4,
  },
]

const COMPOSITION_ID = /^[a-z][a-z0-9-]{0,39}$/

const byId = new Map(PRIMITIVES.map((primitive) => {
  if (!COMPOSITION_ID.test(primitive.id)) throw new Error(`Composition id "${primitive.id}" is not a lowercase slug.`)
  return [primitive.id, Object.freeze(primitive)]
}))

const compositionError = (message, details = null) => Object.assign(new Error(message), { code: 'VALIDATION_FAILED', details })

export const COMPOSITION_IDS = Object.freeze([...byId.keys()])

export const getComposition = (compositionId) => byId.get(compositionId) || null

// The props a render uses: the caller's, checked, with the defaults filled.
export function resolveCompositionProps(compositionId, props = {}) {
  const primitive = getComposition(compositionId)
  if (!primitive) throw compositionError(`Unknown composition "${compositionId}". Known: ${COMPOSITION_IDS.join(', ')}.`)
  const parsed = primitive.propsSchema.safeParse(props ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    throw compositionError(`The ${primitive.title} props are not valid: ${issues.map((issue) => `${issue.path || 'props'} ${issue.message}`).join('; ')}.`, { issues })
  }
  return parsed.data
}

const readPath = (object, dotted) => dotted.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object)

// The brand values one primitive reads, by path, from a brand with its
// defaults filled ({} is the default brand).
export function brandTokensFor(compositionId, brand) {
  const primitive = getComposition(compositionId)
  if (!primitive) throw compositionError(`Unknown composition "${compositionId}".`)
  const parsed = BrandSchema.safeParse(brand ?? {})
  const full = parsed.success ? parsed.data : BrandSchema.parse({})
  return Object.fromEntries(primitive.brandTokens.map((token) => [token, readPath(full, token) ?? null]))
}

// What the agent reads (studio_get_context, FILM-2018 AC3).
export function listCompositions() {
  return PRIMITIVES.map((primitive) => ({
    id: primitive.id,
    title: primitive.title,
    description: primitive.description,
    props: Object.fromEntries(Object.entries(primitive.propsSchema.shape).map(([key, schema]) => [key, describeProp(schema)])),
    textProps: [...primitive.textProps],
    brandTokens: [...primitive.brandTokens],
    defaultDurationSeconds: primitive.defaultDurationSeconds,
  }))
}

function describeProp(schema) {
  let inner = schema
  let defaultValue
  let optional = false
  for (;;) {
    const name = inner?._def?.typeName
    if (name === 'ZodDefault') {
      defaultValue = inner._def.defaultValue()
      optional = true
      inner = inner._def.innerType
    } else if (name === 'ZodOptional' || name === 'ZodNullable') {
      optional = true
      inner = inner._def.innerType
    } else break
  }
  const name = inner?._def?.typeName
  const type = name === 'ZodNumber' ? 'number' : name === 'ZodString' ? 'string' : name === 'ZodEnum' ? 'enum' : name === 'ZodBoolean' ? 'boolean' : 'unknown'
  return {
    type,
    required: !optional,
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(type === 'enum' ? { values: [...inner._def.values] } : {}),
  }
}
