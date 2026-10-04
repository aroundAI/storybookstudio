// FILM-2015 Scene strip, above the timeline: the user's map. One segment per
// scene with its heading and target vs actual duration, red when over the
// tolerance. Clicking (or Enter) selects the scene's clips, moves the playhead
// to its start and scopes the next AI instruction to it ("tighten this").
// Arrow keys move between scenes. Renders nothing for a plain upstream project.
import { useMemo, useRef } from 'react'
import useTimelineStore from '../../stores/timelineStore'
import { studioUiStore } from '../../studio/ui/studioStore'
import { buildSceneSegments, scopeForSegment } from '../../studio/ui/sceneStrip'
import { useStudioText, useStudioUi } from './studioUi'

const seconds = (value) => `${Number(value).toFixed(1)} s`

export default function SceneStrip() {
  const t = useStudioText()
  const clips = useTimelineStore((state) => state.clips)
  const tracks = useTimelineStore((state) => state.tracks)
  const markers = useTimelineStore((state) => state.markers)
  const pkg = useStudioUi((state) => state.pkg)
  const policy = useStudioUi((state) => state.policy)
  const scope = useStudioUi((state) => state.scope)
  const buttons = useRef([])

  const strip = useMemo(() => buildSceneSegments({ timeline: { clips, tracks, markers }, pkg, policy }), [clips, tracks, markers, pkg, policy])
  if (strip.segments.length === 0) return null

  const span = Math.max(...strip.segments.map((segment) => segment.end)) - Math.min(...strip.segments.map((segment) => segment.start)) || 1
  const scopedScene = scope?.scenes?.length === 1 ? scope.scenes[0] : null

  const choose = (segment) => {
    const timeline = useTimelineStore.getState()
    timeline.selectClips?.(segment.clipIds)
    timeline.setPlayheadPosition?.(segment.start)
    studioUiStore.getState().patch({ scope: scopeForSegment(segment), aiPanelOpen: true })
  }

  const onKeyDown = (event, index) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    event.stopPropagation()
    const next = Math.max(0, Math.min(strip.segments.length - 1, index + step))
    buttons.current[next]?.focus()
  }

  const over = strip.segments.filter((segment) => segment.over).length
  return (
    <div className="flex h-8 flex-shrink-0 items-stretch gap-2 border-t border-sf-dark-700 bg-sf-dark-900 px-2" role="toolbar" aria-label={t('strip.label')} data-test="studio-scene-strip">
      <div className="flex flex-shrink-0 flex-col justify-center text-[10px] leading-tight text-sf-text-muted">
        <span className="font-semibold text-sf-text-secondary">{t('strip.scenes')}</span>
        <span className="tabular-nums" data-test="studio-strip-total">{strip.total.target ? t('strip.totalOf', { actual: seconds(strip.total.actual), target: seconds(strip.total.target) }) : seconds(strip.total.actual)}</span>
      </div>
      <div className="flex min-w-0 flex-1 items-stretch gap-0.5 py-1">
        {strip.segments.map((segment, index) => {
          const selected = scopedScene === segment.scene
          const tone = segment.over ? 'border-sf-error bg-sf-error/25 text-sf-text-primary' : 'border-sf-dark-600 bg-sf-dark-800 text-sf-text-secondary'
          return (
            <button
              key={segment.scene}
              ref={(node) => { buttons.current[index] = node }}
              type="button"
              tabIndex={index === 0 || selected ? 0 : -1}
              aria-pressed={selected}
              aria-label={`${segment.label}${segment.heading ? `, ${segment.heading}` : ''}`}
              title={segment.heading ? `${segment.heading}\n${segment.label}` : segment.label}
              className={`flex min-w-[48px] items-center justify-between gap-1 overflow-hidden rounded border px-1.5 text-left text-[10px] hover:border-sf-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent ${tone} ${selected ? 'ring-1 ring-sf-accent' : ''}`}
              style={{ flexGrow: Math.max(segment.actual, 0.5) / span, flexBasis: 0 }}
              onClick={() => choose(segment)}
              onKeyDown={(event) => onKeyDown(event, index)}
              data-test="studio-scene-segment"
              data-scene={segment.scene}
              data-over={segment.over ? 'true' : 'false'}
            >
              <span className="truncate"><span className="font-semibold">{segment.scene}</span> {segment.heading}</span>
              <span className={`flex-shrink-0 tabular-nums ${segment.over ? 'text-sf-error' : 'text-sf-text-muted'}`}>
                {seconds(segment.actual)}{segment.target ? ` / ${seconds(segment.target)}` : ''}
              </span>
            </button>
          )
        })}
      </div>
      {over > 0 && <span className="sr-only" aria-live="polite">{t('strip.overAnnounce', { count: over })}</span>}
    </div>
  )
}
