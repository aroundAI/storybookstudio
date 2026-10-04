// FILM-2014 V2: the visual and narrative analyser.
//
// Script fidelity is read from the scene map and needs no model: scenes out of
// screenplay order, and characters the screenplay puts in a scene that none of
// its shots show. Framing, caption overlap and continuity across cuts need a
// vision model: at most MAX_VISION_FRAMES keyframes go to the client the
// caller passes (electron/studio/visionClient.js; which model is the owner's
// choice, README open question 2). With no client configured the vision part
// is skipped and the result says so; it never reports a pass it did not check.
import { issue } from '../review/qaChecks.js'
import { activeTimeline, clipStart, pictureClips, round3, sceneOfClip } from '../review/renderPlan.js'

export const MAX_VISION_FRAMES = 40
// Vision findings are judgments: they inform, and only a reviewer's own
// threshold makes them block. Capped below FAIL_SEVERITY on their own.
export const VISION_SEVERITY_CAP = 0.45
export const VISION_TYPES = ['framing', 'caption_overlap', 'continuity']

// Up to `max` frames, cuts first, then evenly spaced interval frames.
export function selectFrames(frames, max = MAX_VISION_FRAMES) {
  if (frames.length <= max) return frames
  const cuts = frames.filter((f) => f.reason === 'cut' || f.reason === 'start')
  const pick = (list, n) => (n <= 0 ? [] : list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]))
  const chosen = new Set(pick(cuts, max))
  const rest = frames.filter((f) => !chosen.has(f))
  for (const f of pick(rest, max - chosen.size)) chosen.add(f)
  return frames.filter((f) => chosen.has(f))
}

export function scriptFidelityIssues({ project, pkg, timelineId = null } = {}) {
  if (!pkg?.scenes?.length) return []
  const issues = []
  const timeline = activeTimeline(project, timelineId)
  const assets = new Map((project.assets || []).map((asset) => [asset.id, asset]))
  const shots = pictureClips(timeline)
  const firstAt = new Map()
  for (const clip of shots) {
    const scene = sceneOfClip(clip)
    if (scene && !firstAt.has(scene)) firstAt.set(scene, clipStart(clip))
  }
  const order = [...firstAt.entries()].sort((a, b) => a[1] - b[1]).map(([scene]) => scene)
  const expected = pkg.scenes.map((s) => s.number).filter((n) => firstAt.has(n))
  for (let i = 0; i < order.length; i += 1) {
    if (order[i] !== expected[i]) {
      issues.push(issue({ type: 'script_order', severity: 0.5, timeRange: null, scene: order[i], detail: `Scenes play in the order ${order.join(', ')}; the screenplay's order is ${expected.join(', ')}.` }))
      break
    }
  }
  for (const scene of pkg.scenes) {
    const sceneShots = shots.filter((clip) => sceneOfClip(clip) === scene.number)
    if (sceneShots.length === 0) continue
    const shown = new Set()
    for (const clip of sceneShots) {
      const semantic = assets.get(clip.assetId)?.semantic || {}
      for (const name of semantic.characters || []) shown.add(String(name).toUpperCase())
    }
    const missing = (scene.characters || []).filter((name) => !shown.has(String(name).toUpperCase()))
    if (missing.length) {
      issues.push(issue({ type: 'script_characters', severity: 0.4, timeRange: { start: round3(Math.min(...sceneShots.map(clipStart))), end: round3(Math.max(...sceneShots.map((c) => clipStart(c) + c.duration))) }, scene: scene.number, detail: `The screenplay puts ${missing.join(', ')} in scene ${scene.number}, but none of its shots show ${missing.length === 1 ? 'them' : 'those characters'}.` }))
    }
  }
  return issues
}

export function visionPrompt(frames, { pkg = null } = {}) {
  const system = 'You review keyframes of a short video edit for a creator. You judge only what you can see. Reply with JSON only.'
  const lines = frames.map((f, i) => `Frame ${i}: t=${f.time.toFixed(2)} s, scene ${f.scene ?? '?'}, ${f.reason === 'cut' ? 'first frame after a cut' : 'interval frame'}${f.captions?.length ? `, caption on screen: "${f.captions.join(' / ').slice(0, 120)}"` : ''}.`)
  const text = [
    'These keyframes come from one edit, in time order.',
    ...lines,
    pkg?.episode?.title ? `Episode: ${pkg.episode.title}.` : '',
    'Find problems of three kinds:',
    '- framing: the main subject is cut off, badly off-centre, or the shot is too tight or too loose to read;',
    '- caption_overlap: a caption covers a face or other important picture content;',
    '- continuity: across a cut (compare a "first frame after a cut" with the frame before it), lighting, wardrobe, props or screen direction change in a way a viewer would notice.',
    'Return a JSON array, empty when nothing is wrong: [{"frame": <index>, "type": "framing"|"caption_overlap"|"continuity", "severity": <0 to 1>, "detail": "<one sentence>"}].',
  ].filter(Boolean).join('\n')
  return { system, text }
}

// The model's reply as QA issues; anything malformed is dropped, not guessed.
export function parseVisionIssues(text, frames) {
  const match = /\[[\s\S]*\]/.exec(String(text || ''))
  if (!match) return []
  let raw
  try { raw = JSON.parse(match[0]) } catch { return [] }
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const frame = frames[entry?.frame]
    if (!frame || !VISION_TYPES.includes(entry.type) || typeof entry.detail !== 'string') return []
    const severity = Math.min(VISION_SEVERITY_CAP, Math.max(0, Number(entry.severity) || 0))
    return [issue({
      type: entry.type,
      severity,
      timeRange: { start: round3(Math.max(0, frame.time - 0.05)), end: round3(frame.time + 0.05) },
      scene: frame.scene,
      detail: `${entry.detail} (model judgment, frame at ${frame.time.toFixed(1)} s)`,
      repairIntent: entry.type === 'caption_overlap' ? 'move_caption' : undefined,
    })]
  })
}

// client: { configured, reason?, name, model, describe({system, text, images: [file]}) → {text, usage: {inputTokens, outputTokens, costUsd?}} }
export async function analyseVisual({ project, pkg = null, frames = [], client = null, timelineId = null } = {}) {
  const fidelity = scriptFidelityIssues({ project, pkg, timelineId })
  if (!client?.configured) {
    return {
      issues: fidelity,
      skipped: true,
      reason: client?.reason || 'No hosted vision model is configured (set STUDIO_VISION_PROVIDER, STUDIO_VISION_MODEL and the provider key); framing, caption overlap and continuity were not checked.',
      framesSent: 0,
      usage: null,
    }
  }
  const chosen = selectFrames(frames)
  const prompt = visionPrompt(chosen, { pkg })
  const reply = await client.describe({ system: prompt.system, text: prompt.text, images: chosen.map((f) => f.file) })
  return {
    issues: [...fidelity, ...parseVisionIssues(reply.text, chosen)],
    skipped: false,
    reason: null,
    framesSent: chosen.length,
    usage: { provider: client.name, model: client.model, ...reply.usage },
  }
}
