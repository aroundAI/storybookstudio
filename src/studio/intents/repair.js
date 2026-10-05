// FILM-2014 V3: studio_repair. Compiles QA and critic issues, by their
// repairIntent, into ONE action plan with a reason per step (contract A1):
//
//   normalize_loudness     set_audio_buses master target (Studio project), else
//                          set_master_audio volume plus a limiter
//   duck_music             set_audio_buses ducks the music bus deeper (Studio
//                          project), else set_clip_audio gain on the music
//   trim_silence           extract_range over the silence, keeping a pause each side
//   move_caption           update_caption_cues re-places the cues in the safe area
//   replace_missing_media  replace_clip_with_asset onto the shot's own still frame
//   add_fade               set_clip_audio fades on the clip edges at the issue
//
// Bus, fade and caption decisions use FILM-2016's modules (audio/buses.js,
// intents/audio.js, intents/captions.js), so a repair and the equivalent
// studio_edit_audio / studio_add_captions call produce the same edit.
//   re-time                extract_range closes a gap; update_caption_cues ends
//                          an overlapping cue before the next one starts
//
// An intent compiler in FILM-2013's shape: compile(context, scope, params,
// policy), pure, run in the renderer on the live document. Targets are found
// in the document at the issue's time range when the plan is compiled, so a
// plan never points at a clip that is gone. What no primitive can fix is
// returned in `unrepaired` with why, and becomes a card.
import { DUCK_ATTACK_MS, DUCK_DB_RANGE, DUCK_RELEASE_MS, loudnessTargetFor, resolveAudioBuses } from '../audio/buses.js'
import { TRUE_PEAK_MAX_DBTP } from '../review/presetTargets.js'
import { dbToVolume, round3, volumeToDb } from '../review/renderPlan.js'
import { DEFAULT_DIALOGUE_OVER_MUSIC_DB, FADE_AT_CUT_SECONDS } from './audio.js'
import { compileCaptionsPlacement } from './captions.js'

export const INTENT = 'repair'
export const reads = () => []

// A cut keeps this much of a silence on each side so lines do not collide.
export const KEEP_PAUSE_SECONDS = 0.25
// The upstream editor's master fader tops out at 200 (+6 dB).
export const MASTER_MAX_DB = 20 * Math.log10(2)
export const LIMITER_CEILING_DB = TRUE_PEAK_MAX_DBTP - 0.5
export const MAX_PLAN_STEPS = 50
const EPS = 1e-6

const num = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const fmt = (seconds) => `${Number(seconds).toFixed(1)} s`
const round2 = (value) => Math.round(value * 100) / 100
const db = (value) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
const start = (clip) => num(clip.startTime)
const end = (clip) => start(clip) + num(clip.duration)
const overlaps = (clip, range) => end(clip) > range.start + EPS && start(clip) < range.end - EPS
const sceneOf = (clip) => (Number.isInteger(clip?.metadata?.semantic?.scene) ? clip.metadata.semantic.scene : null)

// Numbers our own QA/critic detail strings carry (qaChecks.js, critic/audio.js).
const readNumber = (text, re) => {
  const match = re.exec(String(text || ''))
  return match ? Number(match[1]) : null
}

function tracksOf(timeline) {
  return new Map((timeline?.tracks || []).map((track) => [track.id, track]))
}

function busOf(clip, track) {
  return track?.bus || clip.metadata?.bus || ({ music: 'music', ambience: 'ambience', sfx: 'sfx', dialogue: 'dialogue', generated_video: 'shotaudio' })[clip.metadata?.semantic?.role] || null
}

function audioClipsOn(timeline, buses) {
  const tracks = tracksOf(timeline)
  return (timeline?.clips || []).filter((clip) => {
    const track = tracks.get(clip.trackId)
    return track?.type === 'audio' && clip.enabled !== false && buses.has(busOf(clip, track))
  })
}

function pictureEnd(timeline) {
  const tracks = tracksOf(timeline)
  return round3((timeline?.clips || []).filter((clip) => tracks.get(clip.trackId)?.type === 'video' && tracks.get(clip.trackId)?.role !== 'captions')
    .reduce((max, clip) => Math.max(max, end(clip)), 0))
}

function sceneSpans(timeline) {
  const tracks = tracksOf(timeline)
  const spans = new Map()
  for (const clip of timeline?.clips || []) {
    const track = tracks.get(clip.trackId)
    if (track?.type !== 'video' || track.role === 'captions') continue
    const scene = sceneOf(clip)
    if (!scene) continue
    const span = spans.get(scene) || { start: Infinity, end: 0 }
    spans.set(scene, { start: Math.min(span.start, start(clip)), end: Math.max(span.end, end(clip)) })
  }
  return spans
}

// Seconds of `cuts` that fall inside [a, b].
const removedWithin = (cuts, a, b) => cuts.reduce((sum, cut) => sum + Math.max(0, Math.min(b, cut.end) - Math.max(a, cut.start)), 0)

export function compile(context, scope = {}, params = {}, policy = context?.policy || {}) {
  const timeline = context.timeline
  const assets = new Map((context.assets || context.document?.assets || []).map((asset) => [asset.id, asset]))
  const issues = Array.isArray(params.issues) ? params.issues : []
  const entries = []
  const unrepaired = []
  const cuts = []
  const notes = []
  const userEdited = new Set((timeline?.clips || []).filter((clip) => clip.metadata?.origin?.by === 'user').map((clip) => clip.id))
  const add = (step, reason, { scene = null, text = reason, touches = [] } = {}) => {
    entries.push({ step, reason, scene, text, touches: touches.filter((id) => userEdited.has(id)) })
  }
  const skip = (issue, why) => unrepaired.push({ issue, why })
  const byIntent = new Map()
  for (const issue of issues) {
    if (!issue?.repairIntent) {
      skip(issue, 'No repair intent: this needs a judgment call, shown as a card.')
      continue
    }
    if (!byIntent.has(issue.repairIntent)) byIntent.set(issue.repairIntent, [])
    byIntent.get(issue.repairIntent).push(issue)
  }

  const studioBuses = resolveAudioBuses(context.audioBuses ?? context.project?.audioBuses ?? context.document?.studio?.audioBuses ?? null, { policy })

  // normalize_loudness. A Studio project normalises at export to
  // master.limiterLufs (FILM-2016's loudnorm pass), so a level off target is
  // a target change on the master bus; peaks are kept under -1 dBTP by the
  // same pass, so clipping left in a Studio render is in the source. A plain
  // upstream project moves its master fader and gets a limiter insert.
  const loudness = byIntent.get('normalize_loudness') || []
  if (loudness.length && studioBuses) {
    const level = loudness.find((i) => i.type === 'loudness')
    const target = readNumber(level?.detail, /target is (-?[\d.]+) LUFS/) ?? loudnessTargetFor({ policy })
    if (level && studioBuses.master.limiterLufs !== target) {
      add({ tool: 'set_audio_buses', arguments: { buses: { master: { limiterLufs: target } } } },
        `The master normalises to ${studioBuses.master.limiterLufs} LUFS but this render's target is ${target} LUFS; the export's loudnorm pass lands within ±1 LU of the new target`,
        { text: `Normalise the master to ${target} LUFS` })
    } else if (level) {
      skip(level, `The master already normalises to ${target} LUFS; a render this far off means the loudnorm pass could not apply (silent or near-silent mix).`)
    }
    for (const peak of loudness.filter((i) => i.type !== 'loudness')) {
      skip(peak, 'The export normalises with a -1 dBTP ceiling, so clipping that survives it is in a source clip; lower or replace that clip.')
    }
  } else if (loudness.length) {
    const currentDb = volumeToDb(timeline?.masterAudioVolume ?? 100)
    const level = loudness.find((i) => i.type === 'loudness')
    const measured = readNumber(level?.detail, /Integrated loudness is (-?[\d.]+) LUFS/)
    const target = readNumber(level?.detail, /target is (-?[\d.]+) LUFS/) ?? num(policy.loudnessTargetLufs, -14)
    let deltaDb = 0
    if (measured !== null) deltaDb = target - measured
    else if (loudness.some((i) => i.type === 'clipping' || i.type === 'true_peak')) deltaDb = -3
    const wanted = currentDb + deltaDb
    const applied = Math.min(MASTER_MAX_DB, wanted)
    const inserts = (timeline?.masterAudioInserts || []).filter((insert) => insert?.type !== 'limiter')
    inserts.push({ type: 'limiter', enabled: true, ceilingDb: LIMITER_CEILING_DB, releaseMs: 50 })
    const why = [
      measured !== null ? `Integrated loudness ${measured.toFixed(1)} LUFS against a ${target} LUFS target: master ${db(applied - currentDb)}` : `Clipping and true peak over ${TRUE_PEAK_MAX_DBTP} dBTP: master ${db(applied - currentDb)}`,
      `limiter at ${LIMITER_CEILING_DB} dBTP so the gain cannot clip`,
      wanted > MASTER_MAX_DB + 0.05 ? `the master fader stops at +6 dB, ${(wanted - MASTER_MAX_DB).toFixed(1)} dB short; raise the buses next round` : null,
    ].filter(Boolean).join('; ')
    add({ tool: 'set_master_audio', arguments: { volume: dbToVolume(applied), inserts } }, why, { text: `Master ${db(applied - currentDb)} with a limiter` })
  }

  // duck_music: bring dialogue to FILM-2016's dialogue-over-music target
  // (DEFAULT_DIALOGUE_OVER_MUSIC_DB) from the worst measured stretch. A Studio
  // project ducks the music bus deeper (to the -40 dB floor) and lowers the
  // bus for any remainder; a plain project lowers the music clips.
  const duck = byIntent.get('duck_music') || []
  if (duck.length) {
    const music = audioClipsOn(timeline, new Set(['music']))
    let shortfall = 0
    const need = new Map()
    for (const issue of duck) {
      const ratio = readNumber(issue.detail, /sits (-?[\d.]+) dB above/) ?? 0
      const cut = DEFAULT_DIALOGUE_OVER_MUSIC_DB - ratio
      const targets = music.filter((clip) => issue.timeRange && overlaps(clip, issue.timeRange))
      if (targets.length === 0) { skip(issue, 'No music clip plays under that dialogue any more.'); continue }
      shortfall = Math.max(shortfall, cut)
      for (const clip of targets) need.set(clip.id, Math.max(need.get(clip.id) || 0, cut))
    }
    if (studioBuses && shortfall > 0) {
      const bus = studioBuses.music
      const currentDuck = bus.duckUnder === 'dialogue' ? num(bus.duckDb, 0) : 0
      const duckDb = round2(Math.max(DUCK_DB_RANGE.min, currentDuck - shortfall))
      const remainder = round2(shortfall - (currentDuck - duckDb))
      const patch = { duckUnder: 'dialogue', duckDb, attackMs: num(bus.attackMs, DUCK_ATTACK_MS), releaseMs: num(bus.releaseMs, DUCK_RELEASE_MS) }
      if (remainder > 0.05) patch.gainDb = round2(num(bus.gainDb) - remainder)
      add({ tool: 'set_audio_buses', arguments: { buses: { music: patch } } },
        `Music masks dialogue (${shortfall.toFixed(1)} dB short of ${DEFAULT_DIALOGUE_OVER_MUSIC_DB} dB clear); duck the music bus to ${duckDb} dB under dialogue${patch.gainDb !== undefined ? ` and lower it ${remainder.toFixed(1)} dB` : ''}, so the bed keeps its level between lines`,
        { text: `Duck music to ${duckDb} dB under dialogue`, touches: [...need.keys()] })
    } else {
      for (const [clipId, cut] of need) {
        const clip = music.find((c) => c.id === clipId)
        const gain = round3(num(clip.gainDb) - cut)
        add({ tool: 'set_clip_audio', arguments: { clipId, gainDb: gain } }, `Music masks dialogue; ${clip.name || clipId} down ${cut.toFixed(1)} dB to ${db(gain)} so lines sit ${DEFAULT_DIALOGUE_OVER_MUSIC_DB} dB clear (this project has no audio buses to duck)`, { scene: sceneOf(clip), text: `Lower ${clip.name || clipId} by ${cut.toFixed(1)} dB`, touches: [clipId] })
      }
    }
  }

  // add_fade: fades on the audio clip edges at the issue, FILM-2016's
  // FADE_AT_CUT_SECONDS per bus (a de-click for effects and shot sound, a
  // softer edge for beds); never on dialogue, never past a third of the clip.
  const fades = byIntent.get('add_fade') || []
  if (fades.length) {
    const beds = audioClipsOn(timeline, new Set(['music', 'ambience', 'sfx', 'shotaudio']))
    const tracks = tracksOf(timeline)
    const changes = new Map()
    for (const issue of fades) {
      const range = issue.timeRange
      if (!range) { skip(issue, 'No time range to place a fade.'); continue }
      const at = (range.start + range.end) / 2
      const near = (t) => Math.abs(t - at) <= Math.max(0.2, (range.end - range.start) / 2 + 0.1)
      let found = false
      for (const clip of beds) {
        if (num(clip.duration) < 0.15) continue
        const length = Math.min(FADE_AT_CUT_SECONDS[busOf(clip, tracks.get(clip.trackId))] ?? FADE_AT_CUT_SECONDS.none, num(clip.duration) / 3)
        const change = changes.get(clip.id) || {}
        if (near(start(clip)) && start(clip) > EPS && num(clip.fadeIn) < EPS) { change.fadeInSeconds = round3(length); found = true }
        if (near(end(clip)) && num(clip.fadeOut) < EPS) { change.fadeOutSeconds = round3(length); found = true }
        if (Object.keys(change).length) changes.set(clip.id, change)
      }
      if (!found) skip(issue, 'No music, ambience, effect or shot-audio clip edge sits at that moment; the jump is inside a clip.')
    }
    for (const [clipId, change] of changes) {
      const clip = beds.find((c) => c.id === clipId)
      const parts = [change.fadeInSeconds ? `fade in ${change.fadeInSeconds} s` : null, change.fadeOutSeconds ? `fade out ${change.fadeOutSeconds} s` : null].filter(Boolean)
      add({ tool: 'set_clip_audio', arguments: { clipId, ...change } }, `${clip.name || clipId} starts or stops hard; ${parts.join(' and ')} so the edge does not click`, { scene: sceneOf(clip), text: `${parts.join(', ')} on ${clip.name || clipId}`, touches: [clipId] })
    }
  }

  // move_caption: re-place the flagged captions clip's cues inside the
  // aspect's safe area with FILM-2016's placement (captions/style.js through
  // compileCaptionsPlacement): one update_caption_cues with styled cues.
  const captions = byIntent.get('move_caption') || []
  if (captions.length) {
    const captionClips = (timeline?.clips || []).filter((clip) => clip.type === 'captions' && clip.enabled !== false)
    const tracks = tracksOf(timeline)
    const done = new Set()
    for (const issue of captions) {
      const targets = captionClips.filter((clip) => !issue.timeRange || overlaps(clip, issue.timeRange))
      if (targets.length === 0) { skip(issue, 'No captions clip covers that time any more.'); continue }
      for (const clip of targets) {
        if (done.has(clip.id)) continue
        done.add(clip.id)
        const language = clip.metadata?.language || tracks.get(clip.trackId)?.language || 'en'
        const placement = compileCaptionsPlacement({ ...context, timeline }, clip.captions?.cues || [], { language }, policy)
        if (placement.refused) { skip(issue, placement.refused.reason); continue }
        for (const [index, entry] of placement.steps.entries()) {
          if (entry.tool !== 'update_caption_cues') continue
          const { studioMeta, ...args } = entry.arguments
          add({ tool: entry.tool, arguments: { ...args, clipId: clip.id } }, `Captions on ${clip.id} were not placed for the safe area; ${placement.reasons[index]}`, { text: `Place captions inside the ${placement.expected?.aspect || ''} safe area`.replace('  ', ' '), touches: [clip.id] })
        }
      }
    }
  }

  // replace_missing_media: a missing shot becomes its own first or last frame.
  const missing = byIntent.get('replace_missing_media') || []
  if (missing.length) {
    const tracks = tracksOf(timeline)
    const done = new Set()
    for (const issue of missing) {
      const range = issue.timeRange
      const offline = (timeline?.clips || []).filter((clip) => {
        const asset = assets.get(clip.assetId)
        return clip.assetId && (!asset || asset.offline || !asset.path) && (!range || overlaps(clip, range)) && !done.has(clip.id)
      })
      if (offline.length === 0) { skip(issue, 'The missing clip is no longer on the timeline.'); continue }
      for (const clip of offline) {
        done.add(clip.id)
        const track = tracks.get(clip.trackId)
        const shotId = clip.metadata?.semantic?.shotId
        const still = track?.type === 'video' && shotId
          ? [`sb-first-${shotId}`, `sb-last-${shotId}`].map((id) => assets.get(id)).find((asset) => asset && asset.path && !asset.offline)
          : null
        if (still) {
          add({ tool: 'replace_clip_with_asset', arguments: { clipId: clip.id, assetId: still.id } },
            `${clip.name || clip.id} has no media (${assets.get(clip.assetId)?.offline?.reason || 'missing'}); its ${still.id.startsWith('sb-first-') ? 'first' : 'last'} frame holds the shot's place until StoryBook regenerates it`,
            { scene: sceneOf(clip), text: `Hold ${clip.name || clip.id} on its still frame`, touches: [clip.id] })
        } else {
          skip(issue, `${clip.name || clip.id} has no media and no still to stand in; regenerate it in StoryBook (regenerate_shots or the voice pipeline) and re-sync.`)
        }
      }
    }
  }

  // re-time: close black gaps; end an overlapping caption cue before the next.
  const retime = byIntent.get('re-time') || []
  for (const issue of retime) {
    if (issue.type === 'black_frames' && issue.timeRange) {
      cuts.push({ start: issue.timeRange.start, end: issue.timeRange.end, scene: issue.scene, reason: `${fmt(issue.timeRange.end - issue.timeRange.start)} of empty picture at ${fmt(issue.timeRange.start)}; the gap is closed`, text: `Close the ${fmt(issue.timeRange.end - issue.timeRange.start)} gap` })
    } else if (issue.type === 'caption_overlap' && issue.timeRange) {
      const clip = (timeline?.clips || []).find((c) => c.type === 'captions' && overlaps(c, issue.timeRange))
      const offset = clip ? start(clip) - num(clip.trimStart) : 0
      const cues = clip ? [...(clip.captions?.cues || [])].sort((a, b) => num(a.start) - num(b.start)) : []
      const index = cues.findIndex((cue, i) => i + 1 < cues.length && Math.abs(offset + num(cues[i + 1].start) - issue.timeRange.start) < 0.05 && num(cue.end) > num(cues[i + 1].start))
      if (index < 0) { skip(issue, 'The overlapping cues changed since the review.'); continue }
      const [a, b] = [cues[index], cues[index + 1]]
      add({ tool: 'update_caption_cues', arguments: { clipId: clip.id, edits: [{ id: a.id, endSeconds: round3(num(b.start) - 0.04) }] } }, `Caption "${String(a.text).slice(0, 30)}" overlaps the next cue; it now ends as the next one starts`, { text: 'End the overlapping caption cue earlier', touches: [clip.id] })
    } else {
      skip(issue, issue.type === 'duration'
        ? 'Hitting the target length is a pacing edit; run studio_edit hit_duration (or tighten_pacing).'
        : 'This re-time needs a pacing edit (studio_edit tighten_pacing or a hand trim), not a mechanical fix.')
    }
  }

  // trim_silence: ripple out each silence, keeping a short pause each side.
  for (const issue of byIntent.get('trim_silence') || []) {
    const range = issue.timeRange
    if (!range || range.end - range.start <= 2 * KEEP_PAUSE_SECONDS + 0.05) { skip(issue, 'Too short to cut and still keep a pause.'); continue }
    cuts.push({ start: round3(range.start + KEEP_PAUSE_SECONDS), end: round3(range.end - KEEP_PAUSE_SECONDS), scene: issue.scene, reason: `${fmt(range.end - range.start)} of silence at ${fmt(range.start)}; cut, keeping ${fmt(KEEP_PAUSE_SECONDS)} each side`, text: `Cut ${fmt(range.end - range.start - 2 * KEEP_PAUSE_SECONDS)} of silence at ${fmt(range.start)}` })
  }

  // Ripple cuts last and latest first, so every earlier time stays valid.
  const merged = []
  for (const cut of [...cuts].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && cut.start <= last.end + EPS) { last.end = Math.max(last.end, cut.end); last.reason = `${last.reason}; ${cut.reason}` } else merged.push({ ...cut })
  }
  const trackIds = (timeline?.tracks || []).filter((track) => !track.locked).map((track) => track.id)
  for (const cut of [...merged].sort((a, b) => b.start - a.start)) {
    const touched = (timeline?.clips || []).filter((clip) => overlaps(clip, cut)).map((clip) => clip.id)
    add({ tool: 'extract_range', arguments: { startSeconds: cut.start, endSeconds: cut.end, trackIds, ripple: true } }, cut.reason, { scene: cut.scene, text: cut.text, touches: touched })
  }
  if ((timeline?.tracks || []).some((track) => track.locked) && merged.length) notes.push({ scene: null, text: 'Locked tracks are left out of the cuts and will drift; unlock them to keep sync.' })

  if (entries.length > MAX_PLAN_STEPS) {
    // Ripple cuts run latest first, so dropping the tail keeps every kept step's times valid.
    notes.push({ scene: null, text: `The repair plan was cut to ${MAX_PLAN_STEPS} steps (run_mcp_action_plan's limit); the next review round picks up the rest` })
    const dropped = entries.splice(MAX_PLAN_STEPS)
    for (const entry of dropped) if (entry.step.tool === 'extract_range') {
      const index = merged.findIndex((cut) => cut.start === entry.step.arguments.startSeconds)
      if (index >= 0) merged.splice(index, 1)
    }
  }
  const before = pictureEnd(timeline)
  const removed = merged.reduce((sum, cut) => sum + (cut.end - cut.start), 0)
  const spans = sceneSpans(timeline)
  const sceneNumbers = (context.sceneMap || []).map((entry) => entry.scene).filter(Number.isInteger)
  const scenes = sceneNumbers.length ? sceneNumbers : [...spans.keys()].sort((a, b) => a - b)
  // What no edit fixes rides in the notes too, so the cards show it however
  // the compiler is registered.
  notes.push(...unrepaired.map((entry) => ({ scene: entry.issue?.scene ?? null, text: `Not repaired (${entry.issue?.type || 'issue'}): ${entry.why}` })))
  return {
    intent: INTENT,
    steps: entries.map((entry) => entry.step),
    reasons: entries.map((entry) => entry.reason),
    scenes: entries.map((entry) => (Number.isInteger(entry.scene) ? entry.scene : null)),
    changes: entries.map((entry) => entry.text),
    touchesUserEdits: [...new Set(entries.flatMap((entry) => entry.touches))].sort(),
    notes,
    unrepaired,
    expected: {
      durationBefore: before,
      durationAfter: round3(before - removed),
      perScene: scenes.map((scene) => {
        const span = spans.get(scene)
        const length = span ? span.end - span.start : 0
        return { scene, before: round3(length), after: round3(length - (span ? removedWithin(merged, span.start, span.end) : 0)) }
      }),
    },
  }
}
