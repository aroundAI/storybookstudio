// A fixture package whose dialogue fills its scenes, as t2015's seeded
// episode does: every line runs until 0.45 s before the next line (or the
// scene's end), so no pause is over the 0.6 s silence limit and cutting
// silence alone cannot shorten the episode much.
export const GAP_SECONDS = 0.45

export function denseDialogue(pkg) {
  const next = structuredClone(pkg)
  const sceneEnd = new Map()
  for (const shot of next.shots) {
    const end = (shot.timelineStartSeconds ?? 0) + shot.durationSeconds
    sceneEnd.set(shot.sceneNumber, Math.max(sceneEnd.get(shot.sceneNumber) ?? 0, end))
  }
  const lines = [...next.dialogue].sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds)
  lines.forEach((line, index) => {
    const following = lines[index + 1]
    const limit = following && following.sceneNumber === line.sceneNumber ? following.timelineStartSeconds : sceneEnd.get(line.sceneNumber)
    line.estimatedDurationSeconds = Math.max(0.5, Math.round((limit - line.timelineStartSeconds - GAP_SECONDS) * 1000) / 1000)
  })
  return next
}
