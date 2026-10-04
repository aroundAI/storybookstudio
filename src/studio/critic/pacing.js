// FILM-2014 V2: the pacing analyser. Reads the document only (no render, no
// model): shot lengths against the policy, whether each dialogue line finishes
// before its shot cuts away (information delivery), shots that repeat by
// semantic similarity, and cut density per scene. Issues use the QA shape;
// severity below FAIL_SEVERITY (0.5) is advice, not a failed review.
import { issue } from '../review/qaChecks.js'
import { activeTimeline, clipEnd, clipStart, pictureClips, round3, sceneOfClip, trackMap } from '../review/renderPlan.js'

// A line that ends within this of its shot's cut lands its last word on the
// cut; past the cut it is heard over the next shot.
export const DELIVERY_MARGIN_SECONDS = 0.15
export const REPEAT_SIMILARITY = 0.9
// Picture clips this many places apart or closer are compared for repeats.
export const REPEAT_WINDOW = 3

const fmt = (seconds) => `${Number(seconds).toFixed(1)} s`
const label = (clip) => /^S\d+\.\d+/.exec(String(clip?.name || ''))?.[0] || clip?.id

// Words of what a shot shows: the prompt, purpose, camera and characters,
// minus its own number ("(shot 7)") so two takes of one setup compare equal.
export function shotWords(clip, asset) {
  const semantic = { ...(asset?.semantic || {}), ...(clip?.metadata?.semantic || {}) }
  const text = [semantic.prompt, semantic.purpose, semantic.cameraDirection, ...(semantic.characters || [])]
    .filter(Boolean).join(' ')
    .toLowerCase()
    .replace(/\(shot \d+\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
  return text.split(/\s+/).filter((word) => word.length > 2)
}

// Cosine similarity of two bags of words.
export function similarity(a, b) {
  if (a.length === 0 || b.length === 0) return 0
  const count = (words) => words.reduce((map, w) => map.set(w, (map.get(w) || 0) + 1), new Map())
  const [ca, cb] = [count(a), count(b)]
  let dot = 0
  for (const [word, n] of ca) dot += n * (cb.get(word) || 0)
  const norm = (c) => Math.sqrt([...c.values()].reduce((s, n) => s + n * n, 0))
  return dot / (norm(ca) * norm(cb))
}

export function analysePacing({ project, timelineId = null, policy = {} } = {}) {
  const timeline = activeTimeline(project, timelineId)
  if (!timeline) return []
  const assets = new Map((project.assets || []).map((asset) => [asset.id, asset]))
  const tracks = trackMap(timeline)
  const shots = pictureClips(timeline).filter((clip) => tracks.get(clip.trackId)?.role !== 'captions')
  const min = policy.minShotLength ?? 1.2
  const max = policy.maxShotLength ?? 6
  const issues = []

  // Shot lengths.
  for (const clip of shots) {
    const length = clip.duration
    if (length < min - 1e-3) {
      issues.push(issue({ type: 'shot_too_short', severity: 0.3 + Math.min(0.3, (min - length) / min), timeRange: { start: round3(clipStart(clip)), end: round3(clipEnd(clip)) }, scene: sceneOfClip(clip), detail: `${label(clip)} lasts ${fmt(length)}, under the policy minimum of ${fmt(min)}.`, repairIntent: 're-time' }))
    } else if (length > max + 1e-3) {
      issues.push(issue({ type: 'shot_too_long', severity: 0.3 + Math.min(0.3, (length - max) / max), timeRange: { start: round3(clipStart(clip)), end: round3(clipEnd(clip)) }, scene: sceneOfClip(clip), detail: `${label(clip)} lasts ${fmt(length)}, over the policy maximum of ${fmt(max)}.`, repairIntent: 're-time' }))
    }
  }

  // Information delivery: a dialogue line should finish inside the shot it plays over.
  const dialogue = (timeline.clips || []).filter((clip) => {
    const track = tracks.get(clip.trackId)
    return track?.type === 'audio' && !track.muted && clip.enabled !== false && (track.bus === 'dialogue' || clip.metadata?.semantic?.role === 'dialogue')
  })
  for (const line of dialogue) {
    const start = clipStart(line)
    const end = clipEnd(line)
    const shot = shots.find((clip) => clipStart(clip) <= start + 1e-3 && clipEnd(clip) > start + 1e-3)
    if (!shot) continue
    const spill = end - clipEnd(shot)
    if (spill > 0.05) {
      issues.push(issue({ type: 'dialogue_over_cut', severity: 0.4 + Math.min(0.3, spill / 2), timeRange: { start: round3(clipEnd(shot)), end: round3(end) }, scene: sceneOfClip(shot), detail: `${line.name || line.id} runs ${fmt(spill)} past the cut out of ${label(shot)}; the line finishes over the next shot.`, repairIntent: 're-time' }))
    } else if (spill > -DELIVERY_MARGIN_SECONDS) {
      issues.push(issue({ type: 'dialogue_tight_to_cut', severity: 0.3, timeRange: { start: round3(end - 0.2), end: round3(clipEnd(shot)) }, scene: sceneOfClip(shot), detail: `${line.name || line.id} ends ${fmt(Math.max(0, -spill))} before ${label(shot)} cuts; the last word lands on the cut.`, repairIntent: 're-time' }))
    }
  }

  // Repeated shots: near-identical setups close together, not continuations.
  if (policy.visual?.avoidRepeatedShots !== false) {
    const words = shots.map((clip) => shotWords(clip, assets.get(clip.assetId)))
    for (let i = 0; i < shots.length; i += 1) {
      for (let j = i + 1; j < Math.min(shots.length, i + 1 + REPEAT_WINDOW); j += 1) {
        const [a, b] = [shots[i], shots[j]]
        const continuation = assets.get(b.assetId)?.semantic?.continuationFrom && assets.get(b.assetId).semantic.continuationFrom === a.metadata?.semantic?.shotId
        if (continuation) continue
        const same = a.assetId && a.assetId === b.assetId
        const score = same ? 1 : similarity(words[i], words[j])
        if (score >= REPEAT_SIMILARITY) {
          issues.push(issue({ type: 'repeated_shot', severity: 0.3 + (score - REPEAT_SIMILARITY) * 1.5, timeRange: { start: round3(clipStart(b)), end: round3(clipEnd(b)) }, scene: sceneOfClip(b), detail: `${label(b)} repeats ${label(a)} (${same ? 'the same media' : `${Math.round(score * 100)}% similar setup`}) ${j - i === 1 ? 'right after it' : `${j - i} shots later`}.` }))
        }
      }
    }
  }

  // Cut density per scene: average shot length outside the policy bounds.
  const byScene = new Map()
  for (const clip of shots) {
    const scene = sceneOfClip(clip)
    if (!scene) continue
    if (!byScene.has(scene)) byScene.set(scene, [])
    byScene.get(scene).push(clip)
  }
  const densities = []
  for (const [scene, clips] of byScene) {
    const start = Math.min(...clips.map(clipStart))
    const end = Math.max(...clips.map(clipEnd))
    const average = (end - start) / clips.length
    const perMinute = ((clips.length - 1) / (end - start)) * 60
    densities.push({ scene, perMinute, start, end })
    if (average < min || average > max) {
      issues.push(issue({ type: 'cut_density', severity: 0.4, timeRange: { start: round3(start), end: round3(end) }, scene, detail: `Scene ${scene} averages ${fmt(average)} per shot (${perMinute.toFixed(1)} cuts a minute), outside the policy's ${fmt(min)}–${fmt(max)}.`, repairIntent: 're-time' }))
    }
  }
  if (densities.length >= 3) {
    const sorted = densities.map((d) => d.perMinute).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    for (const d of densities) {
      if (median > 0 && d.perMinute > median * 2) {
        issues.push(issue({ type: 'cut_density', severity: 0.3, timeRange: { start: round3(d.start), end: round3(d.end) }, scene: d.scene, detail: `Scene ${d.scene} cuts ${d.perMinute.toFixed(1)} times a minute, over twice the episode's median of ${median.toFixed(1)}.` }))
      }
    }
  }
  return issues
}
