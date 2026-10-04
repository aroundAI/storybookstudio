// add_broll (contract §5): places library assets with role 'broll' over the
// shots on a "B-roll" track, ranked by studio_search_assets against
// params.query or the scene's heading and description. A placement starts
// after the scene's first voiced line ends, so no b-roll covers a speaker's
// first line in a scene, and never runs past the scene.
import { searchAssets } from '../context.js'
import { EPS, clipEnd, clipStart, dialogueClips, finishPlan, round3, sceneNote, sceneOfClip, seconds, timecode, toFrame } from './shared.js'
import { overlayTrack, scopeScenes } from './common.js'

export const INTENT = 'add_broll'
export const DEFAULT_BROLL_SECONDS = 3
export const reads = () => []

export function compile(context, scope, params = {}) {
  const scenes = scopeScenes(context, scope)
  const perScene = Math.max(1, Math.min(3, Number(params.perScene) || 1))
  const length = Number(params.durationSeconds ?? DEFAULT_BROLL_SECONDS)
  const notes = []
  const placements = []
  const used = new Set()
  for (const scene of scenes) {
    const entry = context.sceneMap.find((candidate) => candidate.scene === scene)
    if (!entry || entry.start == null) continue
    const screenplay = context.screenplay.find((candidate) => candidate.scene === scene)
    const query = params.query || [screenplay?.heading, screenplay?.description].filter(Boolean).join(' ')
    const ranked = searchAssets(context, { query, role: 'broll', limit: 20 }).filter((asset) => !asset.offline && !used.has(asset.assetId))
    const fallback = ranked.length ? ranked : searchAssets(context, { role: 'broll', limit: 20 }).filter((asset) => !asset.offline && !used.has(asset.assetId))
    if (fallback.length === 0) {
      notes.push(sceneNote(scene, `No b-roll in the library for scene ${scene} (assets with role "broll")`))
      continue
    }
    const firstLine = dialogueClips(context.timeline).find((clip) => sceneOfClip(clip) === scene || (clipStart(clip) >= entry.start - EPS && clipStart(clip) < entry.end))
    let at = firstLine ? clipEnd(firstLine) : entry.start
    for (const asset of fallback.slice(0, perScene)) {
      const duration = round3(Math.min(length, asset.duration ?? length, entry.end - at))
      if (duration < 0.5) {
        notes.push(sceneNote(scene, `No room for b-roll in scene ${scene} after its first line`))
        break
      }
      used.add(asset.assetId)
      placements.push({ scene, asset, at: toFrame(at, context.fps), duration, firstLine })
      at += duration
    }
  }
  if (placements.length === 0) return finishPlan(context, { intent: INTENT, notes })
  const track = overlayTrack(context, 'B-roll')
  const entries = [...track.entries, ...placements.map(({ scene, asset, at, duration, firstLine }) => ({
    step: { tool: 'add_asset_to_timeline', arguments: { assetId: asset.assetId, trackId: track.trackId, startSeconds: at, durationSeconds: duration, includeAudio: false, resolveOverlaps: false, selectAfterAdd: false } },
    reason: `B-roll "${asset.name}" matches ${asset.matched.length ? asset.matched.join(', ') : 'the scene'}; placed after ${firstLine ? 'the first line' : 'the scene start'} so it does not cover a speaker's first line`,
    scene,
    text: `Added b-roll "${asset.name}" at ${timecode(at)} for ${seconds(duration)}`,
  }))]
  return finishPlan(context, { intent: INTENT, entries, notes })
}
