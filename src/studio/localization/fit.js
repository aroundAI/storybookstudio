// FILM-2019: how a dubbed line fits the slot of the line it dubs, on one
// master timeline (no per-language picture edit). Open question answered
// with the lead default (2026-10-05), speed-fit with a 0.9 floor:
// - a dub plays at the speed StoryBook fitted it with (FILM-2007's
//   dubbed_dialogue_lines.timing_adjustment), never slower than 0.9: a line
//   slowed further drags, and a short dub leaves a pause instead;
// - a dub that still runs past its slot (to the next line's start, or the
//   end of the picture for the last line) is sped up to fit, up to 1.25 (or
//   StoryBook's own faster fit);
// - a dub that still overruns is never trimmed, and the picture is not
//   extended (that would change every language's cut): it is placed whole,
//   and the builder and the lane report it (dub_overruns_slot) so the
//   creator can re-voice or retime it.
// Pure.

export const DUB_SPEED_FLOOR = 0.9
export const DUB_SPEED_CEILING = 1.25
const EPS = 1e-6
const round3 = (value) => Math.round(value * 1000) / 1000

// sourceSeconds: the dub file's length; slotSeconds: the room it has (null
// = unbounded). → { speed, playedSeconds, overrunSeconds, fitted, floored }
export function fitDubbedLine({ sourceSeconds, timingAdjustment = 1, slotSeconds = null }) {
  const asFitted = Number(timingAdjustment) > 0 ? Number(timingAdjustment) : 1
  let speed = Math.max(DUB_SPEED_FLOOR, asFitted)
  let fitted = false
  const slot = Number(slotSeconds) > 0 ? Number(slotSeconds) : null
  if (slot && sourceSeconds / speed > slot + EPS) {
    const ceiling = Math.max(DUB_SPEED_CEILING, asFitted)
    speed = Math.min(ceiling, sourceSeconds / slot)
    fitted = true
  }
  speed = round3(speed)
  const playedSeconds = sourceSeconds / speed
  return {
    speed,
    playedSeconds: round3(playedSeconds),
    overrunSeconds: slot ? round3(Math.max(0, playedSeconds - slot)) : 0,
    fitted,
    floored: asFitted < DUB_SPEED_FLOOR,
  }
}

// The slot of each line: from its start to the next line's start (any
// line, in timeline order), the last one to `programEnd`. lines: [{id, start}].
export function dubSlots(lines, programEnd = null) {
  const ordered = [...lines].filter((line) => Number.isFinite(line.start)).sort((a, b) => a.start - b.start)
  const slots = new Map()
  ordered.forEach((line, index) => {
    const next = ordered.slice(index + 1).find((candidate) => candidate.start > line.start + EPS)
    const end = next ? next.start : programEnd
    slots.set(line.id, Number.isFinite(end) && end > line.start + EPS ? round3(end - line.start) : null)
  })
  return slots
}
