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
//   fromText(text)         the props studio_add_graphic's `text` stands for
//                          (a counter reads "87%" as to 87, suffix %)
//
// Adding a primitive is one entry here plus its Remotion component
// (remotion/Root.jsx COMPONENTS; a test checks the two agree).
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
const Words = (max) => z.string().trim().min(1).max(max)
const Fraction = z.number().min(0).max(1)

export const DIRECTIONS = Object.freeze(['left', 'right', 'up', 'down', 'up-left', 'up-right', 'down-left', 'down-right'])
const DirectionSchema = z.enum(DIRECTIONS)
export const MAX_CHART_ITEMS = 6
export const MAX_TIMELINE_POINTS = 6

const compositionError = (message, details = null) => Object.assign(new Error(message), { code: 'VALIDATION_FAILED', details })

// ---- text to props: what studio_add_graphic's `text` means per primitive ----

// A number standing alone (not the 1 of Q1), with a currency or sign before it and a unit after.
const NUMBER = /(^|[\s(])([$€£¥₹#+~]{0,2})(-?\d[\d,]*(?:\.\d+)?)([^\s\d,;)]{0,8})/
const squash = (text) => String(text).replace(/\s+/g, ' ').trim()
const parts = (text) => String(text).split(/[;,]|\s+and\s+|\n/).map(squash).filter(Boolean)

function numberIn(text) {
  const match = NUMBER.exec(text)
  if (!match) return null
  const raw = match[3].replace(/,/g, '')
  return {
    value: Number(raw),
    decimals: Math.min(3, (raw.split('.')[1] || '').length),
    prefix: match[2],
    suffix: match[4],
    rest: squash(`${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`),
  }
}

function counterFromText(text) {
  const found = numberIn(text)
  if (!found) throw compositionError(`A counter needs a number in its text ("87%", "$1.2M raised"); got "${String(text).slice(0, 60)}".`)
  return { to: found.value, decimals: found.decimals, prefix: found.prefix, suffix: found.suffix, label: found.rest.slice(0, 60) }
}

function chartFromText(text) {
  const items = parts(text).map((part, index) => {
    const found = numberIn(part)
    if (!found) throw compositionError(`Each chart item needs a number ("Q1 12, Q2 18"); "${part.slice(0, 40)}" has none.`)
    return { label: (found.rest || `${found.prefix}${found.value}${found.suffix}` || `#${index + 1}`).slice(0, 24), value: found.value, suffix: found.suffix }
  })
  const suffixes = [...new Set(items.map((item) => item.suffix))]
  return { items: items.map(({ label, value }) => ({ label, value })), unit: suffixes.length === 1 ? suffixes[0] : '' }
}

const DATE = /\b(\d{3,4}s?|\d{1,2}:\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+\d{1,4})?)\b/i

function timelineFromText(text) {
  return {
    points: parts(text).map((part) => {
      const match = DATE.exec(part)
      const date = match ? match[1] : part.split(' ')[0]
      return { date: date.slice(0, 16), label: squash(part.replace(date, '')).slice(0, 24) }
    }),
  }
}

function lowerThirdFromText(text) {
  const [name, ...rest] = String(text).split(/\s*(?:,|\||—|–| - )\s*/)
  return { name: squash(name).slice(0, 60), title: squash(rest.join(', ')).slice(0, 80) }
}

function progressFromText(text) {
  const found = numberIn(text)
  if (!found) throw compositionError(`A progress bar needs a number in its text ("72%"); got "${String(text).slice(0, 60)}".`)
  return { value: found.value, label: found.rest.slice(0, 60) }
}

// ---- the primitives ----

const BRAND_PLATE = ['colors.primary', 'colors.captionText', 'fonts.heading']

const PRIMITIVES = [
  {
    id: 'text',
    title: 'Text',
    description: 'A title card: a line of text on a brand plate (or bare), with an optional subtitle. `text` is the title.',
    propsSchema: z.object({
      text: Words(120),
      subtitle: z.string().trim().max(80).default(''),
      plate: z.boolean().default(true),
      anchor: AnchorSchema.default('center'),
    }).strict(),
    brandTokens: BRAND_PLATE,
    textProps: ['text', 'subtitle'],
    defaultDurationSeconds: 3,
    fromText: (text) => ({ text: squash(text).slice(0, 120) }),
  },
  {
    id: 'counter',
    title: 'Counter',
    description: 'A number that counts from `from` to `to` over the clip, with an optional prefix, suffix and label. `text` is read for the number ("87%", "$1.2M raised": prefix, value, suffix, and the rest as the label).',
    propsSchema: z.object({
      from: z.number().finite().default(0),
      to: z.number().finite(),
      decimals: z.number().int().min(0).max(3).default(0),
      prefix: ShortText.default(''),
      suffix: ShortText.default(''),
      label: ShortText.default(''),
      anchor: AnchorSchema.default('center'),
    }).strict(),
    brandTokens: BRAND_PLATE,
    textProps: ['prefix', 'suffix', 'label'],
    defaultDurationSeconds: 4,
    fromText: counterFromText,
  },
  {
    id: 'callout',
    title: 'Callout',
    description: 'A short label in a bubble with a pointer toward something in the picture. `text` is the label; `pointer` is the direction the tail points.',
    propsSchema: z.object({
      text: Words(80),
      pointer: DirectionSchema.default('down-left'),
      anchor: AnchorSchema.default('top-right'),
    }).strict(),
    brandTokens: ['colors.secondary', 'colors.background', 'fonts.body'],
    textProps: ['text'],
    defaultDurationSeconds: 3,
    fromText: (text) => ({ text: squash(text).slice(0, 80) }),
  },
  {
    id: 'arrow',
    title: 'Arrow',
    description: 'An arrow pointing in `direction` from where it is anchored, with an optional short label. `text` is the label.',
    propsSchema: z.object({
      direction: DirectionSchema.default('right'),
      label: z.string().trim().max(40).default(''),
      anchor: AnchorSchema.default('center'),
    }).strict(),
    brandTokens: ['colors.secondary', 'colors.captionText', 'fonts.body'],
    textProps: ['label'],
    defaultDurationSeconds: 2.5,
    fromText: (text) => ({ label: squash(text).slice(0, 40) }),
  },
  {
    id: 'highlight',
    title: 'Highlight',
    description: 'An outline (box or ellipse) around a region of the picture, given as fractions of the frame (x, y, width, height from the top left), kept inside the safe area; optional label. `text` is the label.',
    propsSchema: z.object({
      x: Fraction.default(0.3),
      y: Fraction.default(0.3),
      width: Fraction.default(0.4),
      height: Fraction.default(0.4),
      shape: z.enum(['box', 'ellipse']).default('box'),
      label: z.string().trim().max(40).default(''),
    }).strict(),
    brandTokens: ['colors.secondary', 'colors.captionText', 'fonts.body'],
    textProps: ['label'],
    defaultDurationSeconds: 2.5,
    fromText: (text) => ({ label: squash(text).slice(0, 40) }),
  },
  {
    id: 'lower-third',
    title: 'Lower third',
    description: 'A name and title strip. `text` is "Name, Title" (split at the first comma, dash or bar).',
    propsSchema: z.object({
      name: Words(60),
      title: z.string().trim().max(80).default(''),
      anchor: AnchorSchema.default('bottom-left'),
    }).strict(),
    brandTokens: ['colors.primary', 'colors.background', 'colors.captionText', 'fonts.heading', 'fonts.body'],
    textProps: ['name', 'title'],
    defaultDurationSeconds: 4,
    fromText: lowerThirdFromText,
  },
  {
    id: 'chart',
    title: 'Chart',
    description: `A bar chart of up to ${MAX_CHART_ITEMS} values (zero or more) that grow in, with an optional title and unit. \`text\` is "label value" items separated by commas ("Q1 12, Q2 18, Q3 30").`,
    propsSchema: z.object({
      items: z.array(z.object({ label: Words(24), value: z.number().finite().min(0) }).strict()).min(1).max(MAX_CHART_ITEMS),
      title: z.string().trim().max(60).default(''),
      unit: z.string().trim().max(8).default(''),
      anchor: AnchorSchema.default('center'),
    }).strict(),
    brandTokens: ['colors.primary', 'colors.secondary', 'colors.background', 'colors.captionText', 'fonts.heading', 'fonts.body'],
    textProps: ['title', 'items.label'],
    defaultDurationSeconds: 5,
    fromText: chartFromText,
  },
  {
    id: 'map',
    title: 'Map',
    description: 'A stylised location marker: a drawn pin dropping onto a ground disc with the place name, and an optional caption. A drawn shape, not a real map: no tiles, no geography, no network. `text` is the place.',
    propsSchema: z.object({
      place: Words(60),
      caption: z.string().trim().max(80).default(''),
      anchor: AnchorSchema.default('center'),
    }).strict(),
    brandTokens: ['colors.primary', 'colors.secondary', 'colors.background', 'colors.captionText', 'fonts.heading'],
    textProps: ['place', 'caption'],
    defaultDurationSeconds: 4,
    fromText: (text) => ({ place: squash(text).slice(0, 60) }),
  },
  {
    id: 'timeline',
    title: 'Timeline',
    description: `Two to ${MAX_TIMELINE_POINTS} dated points on a line, revealed left to right. \`text\` is points separated by commas, each a date (a year, a time, a month) and an optional label ("1990 founded, 2005 IPO, 2020 sold").`,
    propsSchema: z.object({
      points: z.array(z.object({ date: Words(16), label: z.string().trim().max(24).default('') }).strict()).min(2).max(MAX_TIMELINE_POINTS),
      title: z.string().trim().max(60).default(''),
      anchor: AnchorSchema.default('center'),
    }).strict(),
    brandTokens: ['colors.primary', 'colors.background', 'colors.captionText', 'fonts.heading', 'fonts.body'],
    textProps: ['title', 'points.label'],
    defaultDurationSeconds: 5,
    fromText: timelineFromText,
  },
  {
    id: 'progress-bar',
    title: 'Progress bar',
    description: 'A bar that fills to `value` percent over the clip, with an optional label. `text` is read for the value ("72% funded").',
    propsSchema: z.object({
      value: z.number().min(0).max(100),
      label: ShortText.default(''),
      anchor: AnchorSchema.default('top'),
    }).strict(),
    brandTokens: ['colors.primary', 'colors.background', 'colors.captionText', 'fonts.body'],
    textProps: ['label'],
    defaultDurationSeconds: 3,
    fromText: progressFromText,
  },
]

// studio_add_graphic's `kind`: a catalogue id, or one of these names for it
// (studio_choose_visual_representation's kinds among them). One table.
export const GRAPHIC_KINDS = Object.freeze({
  text: 'text', text_graphic: 'text', title: 'text',
  counter: 'counter', number: 'counter',
  callout: 'callout',
  arrow: 'arrow',
  highlight: 'highlight',
  'lower-third': 'lower-third', lower_third: 'lower-third',
  chart: 'chart', bar_chart: 'chart',
  map: 'map',
  timeline: 'timeline',
  'progress-bar': 'progress-bar', progress_bar: 'progress-bar', progress: 'progress-bar',
})

const COMPOSITION_ID = /^[a-z][a-z0-9-]{0,39}$/

const byId = new Map(PRIMITIVES.map((primitive) => {
  if (!COMPOSITION_ID.test(primitive.id)) throw new Error(`Composition id "${primitive.id}" is not a lowercase slug.`)
  return [primitive.id, Object.freeze(primitive)]
}))

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

// The catalogue id a studio_add_graphic `kind` names (GRAPHIC_KINDS).
export function primitiveForKind(kind) {
  const id = GRAPHIC_KINDS[String(kind || '').trim().toLowerCase()]
  if (!id) throw compositionError(`No graphic primitive for kind "${kind}". Kinds: ${Object.keys(GRAPHIC_KINDS).join(', ')}.`)
  return id
}

// studio_add_graphic's props: what `text` stands for, then the caller's
// `props` over it, checked against the primitive's schema with the defaults
// filled. Throws VALIDATION_FAILED naming the bad prop.
export function graphicProps(compositionId, text, props = {}) {
  const primitive = getComposition(compositionId)
  if (!primitive) throw compositionError(`Unknown composition "${compositionId}". Known: ${COMPOSITION_IDS.join(', ')}.`)
  const fromText = String(text ?? '').trim() ? primitive.fromText(String(text)) : {}
  return resolveCompositionProps(compositionId, { ...fromText, ...(props || {}) })
}

// 'language' when the graphic shows words (any text prop is filled), so a
// language variant knows to re-render it (FILM-2019); else 'none'.
export function languageDependencyOf(compositionId, props = {}) {
  const primitive = getComposition(compositionId)
  const filled = (path) => {
    const [head, tail] = path.split('.')
    const value = props?.[head]
    return tail ? Array.isArray(value) && value.some((item) => String(item?.[tail] ?? '').trim()) : typeof value === 'string' && value.trim() !== ''
  }
  return primitive?.textProps.some(filled) ? 'language' : 'none'
}

// What the agent reads (studio_get_context, FILM-2018 AC3).
export function listCompositions() {
  return PRIMITIVES.map((primitive) => ({
    id: primitive.id,
    title: primitive.title,
    description: primitive.description,
    kinds: Object.keys(GRAPHIC_KINDS).filter((kind) => GRAPHIC_KINDS[kind] === primitive.id),
    props: describeShape(primitive.propsSchema),
    textProps: [...primitive.textProps],
    brandTokens: [...primitive.brandTokens],
    defaultDurationSeconds: primitive.defaultDurationSeconds,
  }))
}

// Each prop in one line ("number 0..3, default 0"), so the catalogue fits in
// studio_get_context under the in-app agent's 18,000-character result cap
// (src/services/agentTools.js). "anchor" is one of COMPOSITION_ANCHORS,
// which studio_add_graphic's anchor enum lists.
const describeShape = (schema) => Object.fromEntries(Object.entries(schema.shape).map(([key, value]) => [key, describeProp(value)]))

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
  const bound = (kind) => inner._def.checks?.find((check) => check.kind === kind)?.value
  let type
  if (name === 'ZodEnum') type = inner._def.values.join('|') === COMPOSITION_ANCHORS.join('|') ? 'anchor' : `one of ${inner._def.values.join('|')}`
  else if (name === 'ZodArray') {
    const items = Object.entries(describeShape(inner._def.type)).map(([key, value]) => `${key}: ${value}`).join('; ')
    type = `list of ${inner._def.minLength?.value ?? 0} to ${inner._def.maxLength?.value ?? 'any'} {${items}}`
  } else if (name === 'ZodNumber') {
    const [min, max] = [bound('min'), bound('max')]
    type = `number${min !== undefined || max !== undefined ? ` ${min ?? ''}..${max ?? ''}` : ''}`
  } else if (name === 'ZodString') type = `text${bound('max') !== undefined ? ` up to ${bound('max')}` : ''}`
  else type = name === 'ZodBoolean' ? 'boolean' : 'value'
  if (!optional) return `${type}, required`
  return defaultValue === undefined ? type : `${type}, default ${JSON.stringify(defaultValue)}`
}
