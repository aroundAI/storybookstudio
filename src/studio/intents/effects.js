// Semantic effects (FILM-2018 AC5, PRD R-45): punch_in, ken_burns,
// speed_ramp, freeze_frame and color_grade compile to the primitives the
// editor already renders (set_clip_keyframes, split_clip, add_glsl_effect),
// with a reason per step. No new render code. Pure module.
//
// Where the effect lands: params.clipId, else scope.clipIds, else the shot
// under params.atSeconds, else the shot under the strongest line in scope
// (the moment emphasize uses). Clips edited by hand since the last plan are
// left alone unless params.includeUserEdits, as in every other compiler.
//
// set_clip_speed is not emitted: it changes a clip's length, which opens a
// gap before the next shot and moves picture off its dialogue. A keyframed
// speed ramp keeps the length (src/utils/timeRemap.js), so speed_ramp and
// freeze_frame use set_clip_keyframes 'speed' and split the shot where the
// effect ends, so the rest of it resumes on its own sound.
import { EPS, clipEnd, clipStart, finishPlan, pictureClips, round3, sceneNote, sceneOfClip, seconds, shotLabel, timecode, toFrame } from './shared.js'
import { scopeScenes, strongestLine, unavailable } from './common.js'
import { ZOOM_CAP, ZOOM_CAP_AVOID_EXTREME } from './emphasize.js'

// The speed ramp's floor (src/utils/timeRemap.js MIN_RAMP_SPEED; the MCP
// schema clamps 'speed' keyframes to the same).
export const MIN_RAMP_SPEED = 0.05
export const DEFAULT_RAMP_SPEED = 0.5
export const DEFAULT_RAMP_SECONDS = 0.25
export const DEFAULT_HOLD_SECONDS = 1
// glslFilmLook's presets in src/utils/effects.js (a test keeps them equal).
export const FILM_LOOKS = Object.freeze({ kodak2395: 'Kodak 2395', agfa1978: 'Agfa 1978', polaroid: 'Polaroid', bw: 'B&W' })
export const DEFAULT_LOOK = 'kodak2395'
export const KEN_BURNS_PANS = Object.freeze(['left', 'right', 'up', 'down', 'none'])
const PAN_ROOM_USED = 0.9

const reads = () => []
const zoomCap = (policy) => (policy?.visual?.avoidExtremeZoom ? ZOOM_CAP_AVOID_EXTREME : ZOOM_CAP)
const capNote = (zoom, cap, policy) => (zoom === cap && policy?.visual?.avoidExtremeZoom ? '; capped by the policy (avoid extreme zoom)' : '')
const defaulted = (params, key, value, unit = '') => (params[key] == null ? ` (${key} ${value}${unit}, the default when it is left out)` : '')
const baseSpeed = (clip) => (Number(clip?.speed) > 0 ? Number(clip.speed) : 1)

function clipsById(context) {
  return new Map((context.timeline?.clips || []).map((clip) => [clip.id, clip]))
}

// The clips params.clipId or scope.clipIds name, refused when one is not a
// picture clip on the active timeline.
function namedShots(context, scope, params) {
  const ids = params.clipId ? [String(params.clipId)] : Array.isArray(scope?.clipIds) ? scope.clipIds.map(String) : []
  if (!ids.length) return null
  const pictures = new Map(pictureClips(context.timeline).map((clip) => [clip.id, clip]))
  return ids.map((id) => {
    const clip = pictures.get(id)
    if (!clip) throw unavailable(`Clip ${id} is not a picture clip on the active timeline.`)
    return clip
  })
}

const shotAt = (context, time) => pictureClips(context.timeline)
  .filter((clip) => clip.trackId === 'video-1' || sceneOfClip(clip) !== null)
  .find((clip) => clipStart(clip) <= time + EPS && clipEnd(clip) > time + EPS)

// The moment a punch-in, ramp or freeze lands on: {shot, start, end, why}
// in timeline seconds, or null when there is nothing in scope.
function momentOf(context, scope, params) {
  const named = namedShots(context, scope, params)
  if (params.atSeconds != null) {
    const at = Number(params.atSeconds)
    if (!Number.isFinite(at) || at < 0) throw unavailable('params.atSeconds must be a time in seconds.')
    const shot = named ? named.find((clip) => clipStart(clip) <= at + EPS && clipEnd(clip) > at + EPS) : shotAt(context, at)
    if (!shot) throw unavailable(`No shot is under ${timecode(at)}${named ? ` in ${named.map(shotLabel).join(', ')}` : ''}.`)
    return { shot, start: at, end: null, why: `${timecode(at)} as asked` }
  }
  if (named) return { shot: named[0], start: clipStart(named[0]), end: clipEnd(named[0]), why: `${shotLabel(named[0])} as asked` }
  const line = strongestLine(context, scopeScenes(context, scope), params)
  if (!line) return null
  const clips = clipsById(context)
  const lineClips = line.clipIds.map((id) => clips.get(id)).filter(Boolean)
  const start = Math.min(...lineClips.map(clipStart))
  const end = Math.max(...lineClips.map(clipEnd))
  const shot = shotAt(context, start)
  if (!shot) return null
  const how = line.chosenBy === 'params' ? 'as asked' : `importance ${line.importance}, the strongest in scope`
  return { shot, start, end, why: `line ${line.sequenceNumber} (${how})` }
}

// Splits the hand-edited shots out: they get a note, or are kept and listed
// under "touches your edits" with includeUserEdits.
function guardUserEdits(context, shots, params, intent) {
  const edited = new Set(context.userEditedClipIds || [])
  const notes = []
  const kept = shots.filter((shot) => {
    if (!edited.has(shot.id) || params.includeUserEdits) return true
    notes.push(sceneNote(sceneOfClip(shot), `${shotLabel(shot)} was edited by hand since the last plan; pass includeUserEdits to ${intent.replace(/_/g, ' ')} it anyway`))
    return false
  })
  return { kept, notes, touches: (shot) => (edited.has(shot.id) ? [shot.id] : []) }
}

const nothing = (context, intent, scope, text) => finishPlan(context, { intent, notes: [sceneNote(scopeScenes(context, scope)[0] ?? null, text)] })

// Split the shot where an effect ends, so the rest of the shot plays its
// own source time again (a ramp or a hold leaves the picture behind its
// sound). Returns the entry, or null when the effect reaches the shot's end.
function resyncSplit(context, shot, at, why) {
  const frame = 1 / context.fps
  const time = round3(toFrame(at, context.fps))
  if (time <= clipStart(shot) + frame - EPS || time >= clipEnd(shot) - frame + EPS) return null
  return {
    step: { tool: 'split_clip', arguments: { clipIds: [shot.id], timeSeconds: time } },
    reason: `Splits ${shotLabel(shot)} at ${timecode(time)} where the ${why} ends, so the rest of the shot plays in sync with its sound`,
    scene: sceneOfClip(shot),
    text: `Split ${shotLabel(shot)} at ${timecode(time)}`,
  }
}

function speedKeyframes(clipId, frames) {
  return {
    tool: 'set_clip_keyframes',
    arguments: { clipId, replaceKeyframes: true, keyframes: frames.map(([timeSeconds, value, easing]) => ({ property: 'speed', timeSeconds: round3(timeSeconds), value: round3(value), easing })) },
  }
}

// punch_in: a cut-in, not a push: the scale jumps to the zoom on the frame
// the moment starts ('hold' keyframes) and back when it ends.
const punchIn = {
  INTENT: 'punch_in',
  reads,
  compile(context, scope, params = {}, policy = context.policy) {
    const moment = momentOf(context, scope, params)
    if (!moment) return nothing(context, 'punch_in', scope, 'No shot to punch in on in scope')
    const { shot } = moment
    const guard = guardUserEdits(context, [shot], params, 'punch_in')
    if (!guard.kept.length) return finishPlan(context, { intent: 'punch_in', notes: guard.notes })
    const frame = 1 / context.fps
    const cap = zoomCap(policy)
    const zoom = Math.min(cap, Math.max(101, Number(params.zoomPercent) || cap))
    const from = round3(Math.max(0, toFrame(moment.start - clipStart(shot), context.fps)))
    const holdEnd = params.holdSeconds != null ? moment.start + Number(params.holdSeconds) : moment.end ?? clipEnd(shot)
    const to = round3(Math.min(shot.duration, toFrame(holdEnd - clipStart(shot), context.fps)))
    if (to - from < frame - EPS) throw unavailable(`The punch-in on ${shotLabel(shot)} would last under a frame.`)
    const backOut = to < shot.duration - frame + EPS
    const frames = [
      ...(from > EPS ? [[0, 100]] : []),
      [from, zoom],
      ...(backOut ? [[to, 100]] : []),
    ]
    const keyframes = ['scaleX', 'scaleY'].flatMap((property) => frames.map(([timeSeconds, value]) => ({ property, timeSeconds, value, easing: 'hold' })))
    return finishPlan(context, {
      intent: 'punch_in',
      notes: guard.notes,
      entries: [{
        step: { tool: 'set_clip_keyframes', arguments: { clipId: shot.id, replaceKeyframes: true, keyframes } },
        reason: `Punch-in: a cut to ${zoom}% on ${moment.why}, held ${backOut ? `until ${timecode(clipStart(shot) + to)}` : 'to the end of the shot'}${capNote(zoom, cap, policy)}`,
        scene: sceneOfClip(shot),
        text: `Punch-in on ${shotLabel(shot)} at ${timecode(clipStart(shot) + from)} to ${zoom}%${backOut ? `, back at ${timecode(clipStart(shot) + to)}` : ''}`,
        touches: guard.touches(shot),
      }],
    })
  },
}

// ken_burns: a slow zoom and pan across a still (or a named shot), kept
// inside the frame: the pan never exceeds the room the smaller scale leaves.
const kenBurns = {
  INTENT: 'ken_burns',
  reads,
  compile(context, scope, params = {}, policy = context.policy) {
    const named = namedShots(context, scope, params)
    const scenes = scopeScenes(context, scope)
    const stills = pictureClips(context.timeline).filter((clip) => clip.type === 'image' && scenes.includes(sceneOfClip(clip)))
    const shots = named || stills
    if (!shots.length) return nothing(context, 'ken_burns', scope, 'No still images in scope; pass params.clipId (or scope.clipIds) to move over a video shot')
    const direction = params.direction ?? 'in'
    if (!['in', 'out'].includes(direction)) throw unavailable('params.direction is in or out.')
    const pan = params.pan ?? 'right'
    if (!KEN_BURNS_PANS.includes(pan)) throw unavailable(`params.pan is one of ${KEN_BURNS_PANS.join(', ')}.`)
    const cap = zoomCap(policy)
    const far = Math.min(cap, Math.max(102, Number(params.zoomPercent) || cap))
    const near = Math.round(100 + (far - 100) / 2)
    const [startScale, endScale] = direction === 'in' ? [near, far] : [far, near]
    const width = Number(context.timeline?.width) || 1920
    const height = Number(context.timeline?.height) || 1080
    const room = (size) => Math.floor(((size * (near - 100)) / 100 / 2) * PAN_ROOM_USED)
    const travel = { left: ['positionX', -room(width)], right: ['positionX', room(width)], up: ['positionY', -room(height)], down: ['positionY', room(height)], none: [null, 0] }[pan]
    const guard = guardUserEdits(context, shots, params, 'ken_burns')
    const entries = guard.kept.map((shot) => {
      const end = round3(shot.duration)
      const keyframes = [
        ...['scaleX', 'scaleY'].flatMap((property) => [{ property, timeSeconds: 0, value: startScale, easing: 'linear' }, { property, timeSeconds: end, value: endScale, easing: 'linear' }]),
        // The frame moves `pan`, so the picture moves the other way under it.
        ...(travel[0] ? [{ property: travel[0], timeSeconds: 0, value: travel[1], easing: 'linear' }, { property: travel[0], timeSeconds: end, value: -travel[1], easing: 'linear' }] : []),
      ]
      return {
        step: { tool: 'set_clip_keyframes', arguments: { clipId: shot.id, replaceKeyframes: true, keyframes } },
        reason: `Ken Burns over ${seconds(shot.duration)}: ${startScale}% -> ${endScale}%${travel[0] ? `, panning ${pan} ${Math.abs(travel[1]) * 2} px, inside the ${near}% frame so no edge shows` : ''}${defaulted(params, 'direction', 'in')}${defaulted(params, 'pan', 'right')}${capNote(far, cap, policy)}`,
        scene: sceneOfClip(shot),
        text: `Ken Burns on ${shotLabel(shot)}, ${direction}${travel[0] ? ` and ${pan}` : ''}`,
        touches: guard.touches(shot),
      }
    })
    return finishPlan(context, { intent: 'ken_burns', entries, notes: guard.notes })
  },
}

// speed_ramp: eases into slow motion on the moment, holds, eases back to
// full speed, then splits so the rest of the shot is back on its sound.
const speedRamp = {
  INTENT: 'speed_ramp',
  reads,
  compile(context, scope, params = {}) {
    const speed = params.speed == null ? DEFAULT_RAMP_SPEED : Number(params.speed)
    if (!(speed >= MIN_RAMP_SPEED && speed < 1)) {
      throw unavailable(`params.speed is a slow-motion speed from ${MIN_RAMP_SPEED} up to (not including) 1. A ramp above 1x would need picture past the shot's out point; the shot keeps its length, so its last frame would freeze.`)
    }
    const moment = momentOf(context, scope, params)
    if (!moment) return nothing(context, 'speed_ramp', scope, 'No shot to ramp in scope')
    const { shot } = moment
    const guard = guardUserEdits(context, [shot], params, 'speed_ramp')
    if (!guard.kept.length) return finishPlan(context, { intent: 'speed_ramp', notes: guard.notes })
    const ramp = params.rampSeconds == null ? DEFAULT_RAMP_SECONDS : Math.max(1 / context.fps, Number(params.rampSeconds))
    const hold = params.holdSeconds == null ? DEFAULT_HOLD_SECONDS : Math.max(1 / context.fps, Number(params.holdSeconds))
    const base = baseSpeed(shot)
    const at = Math.max(0, toFrame(moment.start - clipStart(shot), context.fps))
    const inStart = Math.max(0, at - ramp)
    const holdEnd = Math.min(shot.duration, at + hold)
    const outEnd = Math.min(shot.duration, holdEnd + ramp)
    const frames = [
      ...(inStart > EPS ? [[0, base, 'linear'], [inStart, base, 'linear']] : []),
      [at, base * speed, 'linear'],
      [holdEnd, base * speed, 'linear'],
      ...(outEnd > holdEnd + EPS ? [[outEnd, base, 'linear']] : []),
    ]
    // Source time the ramp does not play: what the rest of the shot lags by.
    const lag = round3((holdEnd - at) * (1 - speed) + ((at - inStart) + (outEnd - holdEnd)) * (1 - speed) / 2)
    const split = params.resync === false ? null : resyncSplit(context, shot, clipStart(shot) + outEnd, 'speed ramp')
    const entries = [
      ...(split ? [split] : []),
      {
        step: speedKeyframes(shot.id, frames),
        reason: `Slow motion at ${speed}x on ${moment.why}: eases in over ${seconds(at - inStart)}, holds ${seconds(holdEnd - at)}, eases out${defaulted(params, 'speed', DEFAULT_RAMP_SPEED, 'x')}${defaulted(params, 'holdSeconds', DEFAULT_HOLD_SECONDS, ' s')}; the shot keeps its length${split ? '' : `, and its picture runs ${seconds(lag)} behind its sound after the ramp`}`,
        scene: sceneOfClip(shot),
        text: `Speed ramp on ${shotLabel(shot)} ${timecode(clipStart(shot) + inStart)}-${timecode(clipStart(shot) + outEnd)} to ${speed}x`,
        touches: guard.touches(shot),
      },
    ]
    return finishPlan(context, { intent: 'speed_ramp', entries, notes: guard.notes })
  },
}

// freeze_frame: holds the picture at the moment while the sound plays on.
// The speed ramp's floor (0.05x) is the hold; the split at the hold's end
// puts the rest of the shot back on its sound.
const freezeFrame = {
  INTENT: 'freeze_frame',
  reads,
  compile(context, scope, params = {}) {
    const moment = momentOf(context, scope, params)
    if (!moment) return nothing(context, 'freeze_frame', scope, 'No shot to freeze in scope')
    const { shot } = moment
    const guard = guardUserEdits(context, [shot], params, 'freeze_frame')
    if (!guard.kept.length) return finishPlan(context, { intent: 'freeze_frame', notes: guard.notes })
    const frame = 1 / context.fps
    const hold = params.holdSeconds == null ? DEFAULT_HOLD_SECONDS : Math.max(frame, Number(params.holdSeconds))
    const base = baseSpeed(shot)
    const at = round3(Math.max(0, toFrame(moment.start - clipStart(shot), context.fps)))
    if (at >= shot.duration - frame + EPS) throw unavailable(`${timecode(moment.start)} is the last frame of ${shotLabel(shot)}; there is nothing to hold.`)
    const holdEnd = Math.min(shot.duration, at + hold)
    const split = resyncSplit(context, shot, clipStart(shot) + holdEnd, 'freeze')
    const sourceFps = Number(shot.sourceFps) || context.fps
    const drift = MIN_RAMP_SPEED * base * (holdEnd - at) * sourceFps
    const frames = [...(at > EPS ? [[0, base, 'hold']] : []), [at, MIN_RAMP_SPEED * base, 'hold']]
    const entries = [
      ...(split ? [split] : []),
      {
        step: speedKeyframes(shot.id, frames),
        reason: `Freezes the picture on ${moment.why} for ${seconds(holdEnd - at)} while the sound plays on${defaulted(params, 'holdSeconds', DEFAULT_HOLD_SECONDS, ' s')}; the hold is the speed ramp's floor (${MIN_RAMP_SPEED}x, ${drift < 1 ? 'under one' : round3(drift)} source frame${drift < 1 || drift === 1 ? '' : 's'} over the hold)${split ? '' : ', to the end of the shot'}`,
        scene: sceneOfClip(shot),
        text: `Freeze frame on ${shotLabel(shot)} at ${timecode(clipStart(shot) + at)} for ${seconds(holdEnd - at)}`,
        touches: guard.touches(shot),
      },
    ]
    return finishPlan(context, { intent: 'freeze_frame', entries, notes: guard.notes })
  },
}

// color_grade: one film look on every shot in scope, replacing an earlier
// film look on the shot so re-grading never stacks two.
const colorGrade = {
  INTENT: 'color_grade',
  reads,
  compile(context, scope, params = {}) {
    const look = params.look ?? DEFAULT_LOOK
    if (!FILM_LOOKS[look]) throw unavailable(`params.look is one of ${Object.keys(FILM_LOOKS).join(', ')}.`)
    const blend = params.blend == null ? null : Math.max(0, Math.min(100, Math.round(Number(params.blend))))
    const named = namedShots(context, scope, params)
    const scenes = scopeScenes(context, scope)
    const shots = named || pictureClips(context.timeline).filter((clip) => scenes.includes(sceneOfClip(clip))).sort((a, b) => clipStart(a) - clipStart(b))
    if (!shots.length) return nothing(context, 'color_grade', scope, 'No shots to grade in scope')
    const guard = guardUserEdits(context, shots, params, 'color_grade')
    const entries = guard.kept.map((shot) => ({
      step: {
        tool: 'add_glsl_effect',
        arguments: { clipId: shot.id, effectType: 'glslFilmLook', presetId: look, replaceExisting: true, ...(blend == null ? {} : { settings: { blend } }) },
      },
      reason: `Grades ${shotLabel(shot)} with the ${FILM_LOOKS[look]} film look${blend == null ? '' : ` at ${blend}% blend`}${defaulted(params, 'look', DEFAULT_LOOK)}; an earlier film look on the shot is replaced, not stacked`,
      scene: sceneOfClip(shot),
      text: `${FILM_LOOKS[look]} look on ${shotLabel(shot)}`,
      touches: guard.touches(shot),
    }))
    return finishPlan(context, { intent: 'color_grade', entries, notes: guard.notes })
  },
}

export const EFFECT_COMPILERS = Object.freeze([punchIn, kenBurns, speedRamp, freezeFrame, colorGrade])
export const EFFECT_INTENTS = Object.freeze(EFFECT_COMPILERS.map((compiler) => compiler.INTENT))
