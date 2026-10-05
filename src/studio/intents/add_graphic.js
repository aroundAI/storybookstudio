// studio_add_graphic (FILM-2018 AC4): "At 32 s show a counter to 87" as a
// plan. `kind` names a catalogue primitive (GRAPHIC_KINDS), `text` fills its
// main props (a counter reads "87%" as to 87, suffix %), `props` adds or
// overrides the rest, and the primitive's zod schema checks the lot. The
// plan:
//
//   add_track            a Graphics video track above the shots, when there is none
//   add_composition_clip the composition clip at `at` for `duration`, inside the
//                        aspect's safe area; with no `anchor`, the primitive's own
//                        unless that covers a caption on screen with it, then the
//                        first anchor that does not
//   add_track            (counter, callout) an audio track for the pop, when no
//                        SFX track is free at `at`
//   add_asset_to_timeline | add_sfx_clip
//                        (counter, callout) the pop: the project's own pop SFX
//                        when its library has one (an sfx asset named or tagged
//                        pop), else the built-in pop add_sfx_clip writes
//
// The brand contract (contracts/brand.schema.mjs, FILM-2004) has no SFX
// style field yet, so "the brand's SFX style" is the project's sound
// library first. Registered as the intent graphic:add_graphic (compile.js);
// not a studio_edit intent. Pure module.
import { COMPOSITION_ANCHORS, getComposition, graphicProps, languageDependencyOf, primitiveForKind } from '../compositions/catalogue.js'
import { captionsCovered, frameOf } from '../compositions/placement.js'
import { POP_DURATION_SECONDS } from '../compositions/sfx.js'
import { aspectOf } from '../captions/layout.js'
import { EPS, finishPlan, pictureEnd, round3, sceneNote, seconds, timecode, toFrame } from './shared.js'
import { overlayTrack, unavailable } from './common.js'

export const INTENT = 'graphic:add_graphic'
export const reads = () => []

export const POP_KINDS = Object.freeze(['counter', 'callout'])
export const BUILT_IN_POP = 'pop'
export const MAX_GRAPHIC_SECONDS = 60
const SFX_TRACK_NAME = 'Graphics SFX'
// Tried in order when the primitive's own anchor covers a caption.
const CLEAR_OF_CAPTIONS = ['top', 'top-left', 'top-right', 'center', 'left', 'right']

const overlapsAt = (timeline, trackId, start, end) => (timeline?.clips || [])
  .some((clip) => clip.trackId === trackId && clip.startTime < end - EPS && clip.startTime + clip.duration > start + EPS)

// The frame the composition renders at: the timeline's, else the episode aspect's 1080p.
export function graphicFrame(context) {
  const timeline = context.timeline || {}
  const aspect = context.project?.aspect || null
  const width = Number(timeline.width) || (aspect === '9:16' ? 1080 : aspect === '1:1' ? 1080 : 1920)
  const height = Number(timeline.height) || (aspect === '9:16' ? 1920 : 1080)
  return frameOf({ width, height, aspect: aspect || aspectOf(width, height) })
}

// The project's own pop: an sfx asset named or tagged pop, or the built-in
// one an earlier add_sfx_clip imported.
export function libraryPop(context) {
  const isSfx = (asset) => asset.type === 'audio' && !asset.offline && (asset.role === 'sfx' || asset.semantic?.purpose === 'sfx' || asset.settings?.studioSfx)
  const named = (asset) => /\bpop\b/i.test(asset.name || '') || (asset.semantic?.tags || []).some((tag) => /^pop$/i.test(tag))
  return (context.assets || []).find((asset) => isSfx(asset) && (asset.settings?.studioSfx === BUILT_IN_POP || named(asset))) || null
}

function sfxTrack(context, start) {
  const tracks = (context.timeline?.tracks || []).filter((track) => track.type === 'audio' && !track.locked)
  const sfx = tracks.filter((track) => track.bus === 'sfx' || track.name === SFX_TRACK_NAME || /\bsfx\b/i.test(track.name || ''))
  const free = sfx.find((track) => !overlapsAt(context.timeline, track.id, start, start + POP_DURATION_SECONDS))
  if (free) return { trackId: free.id, entries: [] }
  const highest = tracks.reduce((max, track) => Math.max(max, Number(/^audio-(\d+)$/.exec(track.id)?.[1]) || 0), 0)
  return {
    trackId: `audio-${highest + 1}`,
    entries: [{
      step: { tool: 'add_track', arguments: { type: 'audio', name: SFX_TRACK_NAME } },
      reason: sfx.length ? 'The SFX track has a sound at that moment; the pop gets its own track so nothing is cut' : 'No SFX track in the timeline; the pop gets one',
      scene: null,
      text: `Added the ${SFX_TRACK_NAME} track`,
    }],
  }
}

const sceneAt = (context, time) => context.sceneMap?.find((entry) => entry.start != null && time >= entry.start - EPS && time < entry.end - EPS)?.scene ?? null

export function compile(context, _scope, params = {}) {
  const compositionId = primitiveForKind(params.kind)
  const primitive = getComposition(compositionId)
  if (params.anchor != null && !COMPOSITION_ANCHORS.includes(params.anchor)) throw unavailable(`anchor is one of ${COMPOSITION_ANCHORS.join(', ')}.`)
  if (params.anchor != null && compositionId === 'highlight') throw unavailable('A highlight sits on its region (props x, y, width, height), not at an anchor.')
  const at = Number(params.at)
  const end = pictureEnd(context.timeline)
  if (!(at >= 0)) throw unavailable('at is the start in seconds on the timeline (0 or more).')
  if (at >= end - EPS) throw unavailable(`at ${seconds(at)} is past the end of the picture (${seconds(end)}).`)
  const wanted = params.duration == null ? primitive.defaultDurationSeconds : Number(params.duration)
  if (!(wanted > 0) || wanted > MAX_GRAPHIC_SECONDS) throw unavailable(`duration is more than 0 and at most ${MAX_GRAPHIC_SECONDS} seconds.`)
  const start = toFrame(at, context.fps)
  const duration = Math.max(1 / context.fps, toFrame(Math.min(wanted, end - start), context.fps))
  const notes = []
  if (wanted > end - start + EPS) notes.push(sceneNote(null, `Shortened to ${seconds(duration)}: the picture ends at ${timecode(end)}`))

  const frame = graphicFrame(context)
  const asked = { ...(params.props || {}), ...(params.anchor ? { anchor: params.anchor } : {}) }
  let props = graphicProps(compositionId, params.text, asked)
  const covered = (candidate) => captionsCovered({ compositionId, props: candidate, start, end: start + duration, timeline: context.timeline, frame })
  let placement = `the ${props.anchor ?? 'region'} of the ${frame.aspect} safe area`
  const clash = covered(props)
  if (clash.length && compositionId !== 'highlight' && asked.anchor == null) {
    const clear = CLEAR_OF_CAPTIONS.find((anchor) => anchor !== props.anchor && !covered({ ...props, anchor }).length)
    if (clear) {
      placement = `the ${clear} of the ${frame.aspect} safe area, clear of the caption "${clash[0].text.slice(0, 40)}" (its own ${props.anchor} would cover it)`
      props = { ...props, anchor: clear }
    }
  }
  const stillCovered = covered(props)
  if (stillCovered.length) notes.push(sceneNote(sceneAt(context, start), `The ${primitive.title.toLowerCase()} covers the caption "${stillCovered[0].text.slice(0, 40)}" at ${timecode(stillCovered[0].start)}; QA will flag it. Give another anchor to move it`))

  const scene = sceneAt(context, start)
  const label = String(params.text || primitive.title).replace(/\s+/g, ' ').trim().slice(0, 40)
  const track = overlayTrack(context, 'Graphics')
  const entries = [...track.entries, {
    step: {
      tool: 'add_composition_clip',
      arguments: { trackId: track.trackId, engine: 'remotion', compositionId, props, languageDependency: languageDependencyOf(compositionId, props), startSeconds: start, durationSeconds: duration, name: `${primitive.title}: ${label}` },
    },
    reason: `A ${primitive.title.toLowerCase()} drawn from the catalogue in the brand's colours and fonts (${primitive.brandTokens.join(', ')}), placed in ${placement}`,
    scene,
    text: `Added the ${primitive.title.toLowerCase()} "${label}" ${timecode(start)}-${timecode(start + duration)} (${seconds(duration)})`,
  }]

  if (POP_KINDS.includes(compositionId)) {
    const sfx = sfxTrack(context, start)
    const pop = libraryPop(context)
    entries.push(...sfx.entries, pop
      ? {
        step: { tool: 'add_asset_to_timeline', arguments: { assetId: pop.id, trackId: sfx.trackId, startSeconds: start, durationSeconds: round3(Math.min(Number(pop.duration) || POP_DURATION_SECONDS, duration)), resolveOverlaps: false, selectAfterAdd: false } },
        reason: `A ${primitive.title.toLowerCase()} lands with a pop: the project's own pop SFX "${pop.name}"`,
        scene,
        text: `Added the pop "${pop.name}" at ${timecode(start)}`,
      }
      : {
        step: { tool: 'add_sfx_clip', arguments: { sfx: BUILT_IN_POP, trackId: sfx.trackId, startSeconds: start } },
        reason: `A ${primitive.title.toLowerCase()} lands with a pop: StorybookStudio's built-in pop (the project's sound library has no pop SFX)`,
        scene,
        text: `Added a pop at ${timecode(start)}`,
      })
  }

  const plan = finishPlan(context, { intent: INTENT, entries, notes })
  // A step on a track this plan adds previews once that track exists.
  const adds = new Map()
  plan.previewAfter = plan.steps.map((step, index) => {
    if (step.tool === 'add_track') {
      adds.set(step.arguments.type === 'audio' ? sfxTrackIdOf(entries, index) : track.trackId, index)
      return undefined
    }
    return adds.has(step.arguments.trackId) ? adds.get(step.arguments.trackId) : undefined
  })
  return plan
}

// The id an audio add_track step creates: the trackId of the next step.
const sfxTrackIdOf = (entries, index) => entries[index + 1]?.step.arguments.trackId
