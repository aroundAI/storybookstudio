// choose_visual_representation (FILM-2018 AC6, PRD R-43): for a scene or a
// point in the script, ranks the ways to show it, generated_video,
// stock_video, archival_image, chart, map, diagram, timeline and
// text_graphic, with a one-line reason each. It reads the words (numbers,
// places, years, process words) and what the project has (the scene's shots,
// b-roll in the library); it changes nothing and decides nothing: the agent
// picks, and acts with the tool each entry names (studio_add_graphic for a
// drawn graphic, studio_search_assets then studio_edit add_broll for
// footage). Deterministic: the same script gives the same ranking. Pure.
import { searchAssets } from './context.js'
import { clipEnd, clipStart, pictureClips, round3, sceneOfClip, sceneSpan, timecode } from './intents/shared.js'

export const VISUAL_KINDS = Object.freeze(['generated_video', 'stock_video', 'archival_image', 'chart', 'map', 'diagram', 'timeline', 'text_graphic'])
// studio_add_graphic's primitive for each drawn kind (FILM-2018 AC3).
const GRAPHIC_KIND = { chart: 'chart', map: 'map', timeline: 'timeline' }

const PLACE_WORDS = ['map', 'route', 'border', 'borders', 'country', 'countries', 'city', 'cities', 'coast', 'island', 'region', 'continent', 'ocean', 'river', 'mountain', 'north', 'south', 'east', 'west', 'miles', 'km', 'kilometres', 'kilometers', 'across', 'where']
const TIME_WORDS = ['history', 'timeline', 'century', 'decade', 'decades', 'since', 'until', 'era', 'years', 'ago', 'then', 'later', 'before', 'after', 'first', 'finally']
const PROCESS_WORDS = ['how', 'works', 'process', 'system', 'steps', 'step', 'cycle', 'mechanism', 'structure', 'network', 'inside', 'flow', 'layers', 'compared', 'versus', 'vs']
const ARCHIVE_WORDS = ['archive', 'archival', 'photo', 'photograph', 'historic', 'historical', 'newspaper', 'headline', 'old', 'footage', 'record']
const COMPARE_WORDS = ['percent', 'rate', 'share', 'growth', 'grew', 'fell', 'rose', 'doubled', 'tripled', 'half', 'average', 'more', 'less', 'than', 'times']

const wordsOf = (text) => String(text).toLowerCase().split(/[^a-z0-9%$]+/).filter(Boolean)
const hits = (words, list) => [...new Set(words.filter((word) => list.includes(word)))]
const quote = (list) => list.slice(0, 3).map((word) => `"${word}"`).join(', ')

function pointOf(context, sceneOrPoint = {}) {
  const lines = context.screenplay.flatMap((scene) => scene.dialogue.map((line) => ({ ...line, scene: scene.scene })))
  const clips = new Map((context.timeline?.clips || []).map((clip) => [clip.id, clip]))
  const spanOf = (line) => {
    const placed = line.clipIds.map((id) => clips.get(id)).filter(Boolean)
    return placed.length ? [Math.min(...placed.map(clipStart)), Math.max(...placed.map(clipEnd))] : null
  }
  if (sceneOrPoint.text != null && String(sceneOrPoint.text).trim()) {
    const scene = Number.isInteger(sceneOrPoint.scene) ? sceneOrPoint.scene : null
    const span = scene != null ? sceneSpan(context.timeline, scene) : null
    return { kind: 'text', scene, lineId: null, text: String(sceneOrPoint.text), span: span ? [span.start, span.end] : null }
  }
  if (sceneOrPoint.lineId != null || sceneOrPoint.sequenceNumber != null) {
    const line = lines.find((entry) => entry.lineId === sceneOrPoint.lineId || entry.sequenceNumber === Number(sceneOrPoint.sequenceNumber))
    if (!line) throw Object.assign(new Error(`Line ${sceneOrPoint.lineId ?? sceneOrPoint.sequenceNumber} is not in this episode.`), { code: 'VALIDATION_FAILED' })
    return { kind: 'line', scene: line.scene, lineId: line.lineId, text: line.text, span: spanOf(line) }
  }
  if (sceneOrPoint.atSeconds != null) {
    const at = Number(sceneOrPoint.atSeconds)
    const line = lines.find((entry) => {
      const span = spanOf(entry)
      return span && span[0] <= at && span[1] > at
    })
    if (line) return { kind: 'line', scene: line.scene, lineId: line.lineId, text: line.text, span: spanOf(line) }
    const shot = pictureClips(context.timeline).find((clip) => clipStart(clip) <= at && clipEnd(clip) > at)
    const scene = sceneOfClip(shot)
    if (scene == null) throw Object.assign(new Error(`Nothing is on the timeline at ${timecode(at)}.`), { code: 'VALIDATION_FAILED' })
    sceneOrPoint = { scene }
  }
  const scene = Number(sceneOrPoint.scene)
  const entry = context.screenplay.find((candidate) => candidate.scene === scene)
  if (!entry) throw Object.assign(new Error(`Pass sceneOrPoint {scene}, {lineId}, {sequenceNumber}, {atSeconds} or {text}${sceneOrPoint.scene != null ? `; scene ${sceneOrPoint.scene} is not in this episode` : ''}.`), { code: 'VALIDATION_FAILED' })
  const span = sceneSpan(context.timeline, scene)
  return { kind: 'scene', scene, lineId: null, text: [entry.heading, entry.description, ...entry.dialogue.map((line) => line.text)].filter(Boolean).join(' '), span: span ? [span.start, span.end] : null }
}

// → {point, signals, ranked: [{kind, score, reason, act}], decidedBy: 'agent'}
export function chooseVisualRepresentation(context, sceneOrPoint = {}) {
  const point = pointOf(context, sceneOrPoint)
  const words = wordsOf(point.text)
  const numbers = [...new Set(String(point.text).match(/\$?\d[\d,]*(?:\.\d+)?%?/g) || [])].filter((value) => !/^(1[5-9]|20)\d\d$/.test(value))
  const years = [...new Set(String(point.text).match(/\b(?:1[5-9]|20)\d\d\b/g) || [])]
  const places = hits(words, PLACE_WORDS)
  const times = hits(words, TIME_WORDS)
  const process = hits(words, PROCESS_WORDS)
  const archive = hits(words, ARCHIVE_WORDS)
  const compare = hits(words, COMPARE_WORDS)
  const shots = point.scene != null ? pictureClips(context.timeline).filter((clip) => sceneOfClip(clip) === point.scene && clip.metadata?.semantic?.role === 'generated_video') : []
  const query = words.filter((word) => word.length > 3 && !/^\d/.test(word)).slice(0, 6).join(' ')
  const broll = query ? searchAssets(context, { query, role: 'broll', limit: 3 }) : []
  const archival = query ? searchAssets(context, { query, role: 'archival', limit: 3 }) : []
  const at = point.span ? round3(point.span[0]) : null
  const duration = point.span ? round3(Math.max(1, Math.min(6, point.span[1] - point.span[0]))) : null
  const graphic = (kind, text) => ({ tool: 'studio_add_graphic', arguments: { kind, text, ...(at == null ? {} : { at, duration }) } })

  const candidates = {
    generated_video: shots.length
      ? [3, `The scene already has ${shots.length} generated shot${shots.length === 1 ? '' : 's'}; keep the footage when the point is what the characters do`, null]
      : [1, 'No generated shot covers this point; a new one is made in StoryBook, not here', null],
    stock_video: broll.length
      ? [2 + Math.min(1, broll[0].score / 10), `${broll.length} b-roll asset${broll.length === 1 ? '' : 's'} in the library match "${query}"`, { tool: 'studio_edit', arguments: { intent: 'add_broll', scope: point.scene != null ? { scene: point.scene } : {}, params: { query } } }]
      : [0, `No b-roll in the library matches${query ? ` "${query}"` : ' this point'}`, { tool: 'studio_search_assets', arguments: { query, role: 'broll' } }],
    archival_image: archival.length || archive.length || years.length
      ? [1 + archival.length + archive.length * 0.5 + (years.length ? 0.5 : 0), `${[archive.length ? `archive words ${quote(archive)}` : null, years.length ? `a past year (${years.join(', ')})` : null, archival.length ? `${archival.length} archival asset(s) match` : null].filter(Boolean).join('; ')}`, { tool: 'studio_search_assets', arguments: { query: [query, ...years].filter(Boolean).join(' '), role: 'archival' } }]
      : [0, 'No year, archive word or archival asset points to a historical image', null],
    // Two figures with units (12%, $4) or with a comparison word; bare counts are not a chart.
    chart: numbers.filter((value) => /[%$]/.test(value)).length >= 2 || (numbers.length >= 2 && compare.length)
      ? [2 + Math.min(2, numbers.length * 0.5) + (compare.length ? 1 : 0), `Numbers to compare (${numbers.slice(0, 4).join(', ')})${compare.length ? ` and ${quote(compare)}` : ''} read faster drawn than spoken`, graphic(GRAPHIC_KIND.chart, numbers.join(', '))]
      : [0, numbers.length ? `One number (${numbers[0]}) is not a comparison` : 'No numbers to chart', null],
    map: places.length
      ? [2 + places.length * 0.75, `Place words ${quote(places)}: where something is reads faster on a map`, graphic(GRAPHIC_KIND.map, point.text.slice(0, 80))]
      : [0, 'No place or route words', null],
    diagram: process.length
      ? [1.5 + process.length * 0.75, `Process words ${quote(process)}: how something works is clearer drawn`, { tool: null, note: 'No diagram primitive yet (FILM-2018 AC3 lists text, counter, callout, arrow, highlight, lower third, chart, map, timeline, progress bar); a callout or arrow over the shot is the nearest' }]
      : [0, 'No process or structure words', null],
    timeline: years.length >= 2 || (years.length && times.length) || times.length >= 2
      ? [2 + years.length * 0.75 + times.length * 0.25, `A sequence in time (${[...years, ...times].slice(0, 4).join(', ')}) reads as a timeline`, graphic(GRAPHIC_KIND.timeline, [...years].join(', ') || point.text.slice(0, 80))]
      : [0, years.length ? `One year (${years[0]}) is not a sequence` : 'No dates or sequence words', null],
    text_graphic: numbers.length === 1 && !compare.length
      ? [2.5, `One number (${numbers[0]}) lands harder on screen as a counter`, graphic('counter', numbers[0])]
      : point.kind === 'line' && String(point.text).length <= 90
        ? [1, 'A short line can be put on screen as text for emphasis', graphic('text', point.text)]
        : [0.5, 'Text on screen only helps a short line or a single figure', null],
  }
  const ranked = VISUAL_KINDS
    .map((kind, order) => ({ kind, order, score: round3(candidates[kind][0]), reason: candidates[kind][1], act: candidates[kind][2] }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ order, ...entry }) => entry)
  return {
    point: { kind: point.kind, scene: point.scene, lineId: point.lineId, text: point.text, at, duration },
    signals: { numbers, years, places, timeWords: times, processWords: process, archiveWords: archive, sceneShots: shots.length, brollMatches: broll.length, archivalMatches: archival.length },
    ranked,
    decidedBy: 'agent',
    note: 'A ranking, not a decision: pick one and act with the tool its entry names. studio_add_graphic previews then places a drawn graphic from the catalogue in studio_get_context (diagram has no primitive; its entry names the nearest).',
  }
}
