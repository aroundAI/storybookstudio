// add_cta (contract §5): a call to action in the last 10 s, aligned to the
// end of the final dialogue line: the brand's outro asset when the library
// has it (brand.outroAssetId), else params.text as a text card in the brand
// heading font and colours. Music ducking under it is FILM-2016's.
import { EPS, clipEnd, dialogueClips, finishPlan, pictureEnd, round3, sceneNote, seconds, timecode, toFrame } from './shared.js'
import { overlayTrack, unavailable } from './common.js'

export const INTENT = 'add_cta'
export const CTA_WINDOW_SECONDS = 10
export const MIN_CTA_SECONDS = 2
export const reads = () => []

export function compile(context, _scope, params = {}) {
  const end = pictureEnd(context.timeline)
  const lastLine = dialogueClips(context.timeline).at(-1) || null
  const lastLineEnd = lastLine ? clipEnd(lastLine) : 0
  let start = Math.max(lastLineEnd, end - CTA_WINDOW_SECONDS)
  if (end - start < MIN_CTA_SECONDS) start = end - MIN_CTA_SECONDS
  start = toFrame(Math.max(0, start), context.fps)
  const outroId = context.brand.outroAssetId
  const outro = outroId ? context.assets.find((asset) => asset.id === outroId || asset.storybook?.ref === outroId) : null
  const notes = [sceneNote(null, 'Music ducking under the CTA is applied by FILM-2016\'s bus mixer (not available yet)')]
  if (outro && !outro.offline) {
    return finishPlan(context, {
      intent: INTENT,
      notes,
      entries: [{
        step: { tool: 'add_asset_to_timeline', arguments: { assetId: outro.id, trackId: 'video-1', startSeconds: toFrame(end, context.fps), includeAudio: true, resolveOverlaps: false, selectAfterAdd: false } },
        reason: 'The brand outro (brand.outroAssetId) closes the episode as its call to action',
        scene: null,
        text: `Appended the brand outro "${outro.name}" at ${timecode(end)}`,
      }],
    })
  }
  if (!params.text) throw unavailable('add_cta needs params.text: the brand has no outro asset in this project.')
  const track = overlayTrack(context, 'Graphics')
  const duration = round3(end - start)
  return finishPlan(context, {
    intent: INTENT,
    notes,
    entries: [...track.entries, {
      step: {
        tool: 'add_text_clip',
        arguments: {
          text: String(params.text),
          trackId: track.trackId,
          startSeconds: start,
          durationSeconds: duration,
          style: { fontFamily: context.brand.fonts.heading, textColor: context.brand.colors.captionText, backgroundColor: context.brand.colors.primary },
        },
      },
      reason: `Call to action in the last ${CTA_WINDOW_SECONDS} s${lastLine && Math.abs(start - lastLineEnd) < EPS + 1 / context.fps ? ', starting as the final line ends' : ''}; brand heading font ${context.brand.fonts.heading}, colours brand.colors.captionText on brand.colors.primary`,
      scene: null,
      text: `Added the CTA "${String(params.text).slice(0, 40)}" ${timecode(start)}-${timecode(end)} (${seconds(duration)})`,
    }],
  })
}
