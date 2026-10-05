// FILM-2018: the composition clip, as the timeline holds it.
//
//   clip.type === 'composition'
//   clip.composition = {
//     engine,              which engine draws it ('remotion')
//     compositionId,       a catalogue id ('counter')
//     props,               the primitive's props, defaults filled
//     propsHash,           the render key of the file in renderPath (key.js);
//                          null until a render lands
//     renderPath,          project-relative alpha WebM, compositions/<id>-<hash>.webm;
//                          null until a render lands
//     languageDependency,  'none' | 'language' | 'locale' (FILM-2019)
//     renderUrl,           session only: the URL the preview and export read
//   }
//
// The preview shows a placeholder until renderPath (and its URL) exist; then
// the render plays like a baked clip (FILM-2018 AC1). Pure module: the store,
// the preview, the exporter and the render plan import it.
import { resolveCompositionProps, getComposition } from './catalogue.js'
import { canonicalJson } from './key.js'

export const COMPOSITION_CLIP_TYPE = 'composition'
export const LANGUAGE_DEPENDENCIES = Object.freeze(['none', 'language', 'locale'])
const ENGINE_NAME = /^[a-z][a-z0-9-]{0,39}$/

export const isCompositionClip = (clip) => clip?.type === COMPOSITION_CLIP_TYPE

export function buildCompositionFields({ engine, compositionId, props = {}, languageDependency = 'none' } = {}) {
  if (typeof engine !== 'string' || !ENGINE_NAME.test(engine)) {
    throw Object.assign(new Error('A composition clip names its engine (a lowercase slug).'), { code: 'VALIDATION_FAILED' })
  }
  if (!LANGUAGE_DEPENDENCIES.includes(languageDependency)) {
    throw Object.assign(new Error(`languageDependency is one of ${LANGUAGE_DEPENDENCIES.join(', ')}.`), { code: 'VALIDATION_FAILED' })
  }
  return { engine, compositionId, props: resolveCompositionProps(compositionId, props), propsHash: null, renderPath: null, languageDependency }
}

export const sameProps = (a, b) => canonicalJson(a ?? {}) === canonicalJson(b ?? {})

// A render is shown only with both its file and the URL to read it.
export const compositionRenderReady = (clip) => (
  isCompositionClip(clip) && typeof clip.composition?.renderPath === 'string' && !!clip.composition.renderPath && !!clip.composition.renderUrl
)

export const compositionRenderUrl = (clip) => (compositionRenderReady(clip) ? clip.composition.renderUrl : null)

export function compositionPlaceholderLabel(clip) {
  const title = getComposition(clip?.composition?.compositionId)?.title || 'Graphic'
  return clip?.composition?.renderError ? `${title}: render failed` : `${title}: rendering…`
}

// The placeholder frame: a dashed outline with the primitive's name, drawn
// over the layers below so the edit stays readable while the render runs.
export function drawCompositionPlaceholder(ctx, { width, height }, clip) {
  const short = Math.min(width, height)
  const boxWidth = Math.round(width * 0.36)
  const boxHeight = Math.round(short * 0.18)
  const x = Math.round((width - boxWidth) / 2)
  const y = Math.round((height - boxHeight) / 2)
  ctx.save()
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = 'none'
  ctx.fillStyle = 'rgba(17, 24, 39, 0.72)'
  ctx.fillRect(x, y, boxWidth, boxHeight)
  ctx.setLineDash([Math.max(4, Math.round(short * 0.012)), Math.max(3, Math.round(short * 0.008))])
  ctx.lineWidth = Math.max(2, Math.round(short * 0.004))
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
  ctx.strokeRect(x, y, boxWidth, boxHeight)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = `600 ${Math.max(10, Math.round(short * 0.04))}px system-ui, -apple-system, Arial, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(compositionPlaceholderLabel(clip), width / 2, height / 2)
  ctx.restore()
  return { x, y, width: boxWidth, height: boxHeight }
}
