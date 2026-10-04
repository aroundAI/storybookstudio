// FILM-2015 Review (R-30, R-33): the timeline before the plan above the one
// after it, clips the plan changed highlighted by origin (AI or you), one
// scrubber driving both playheads, per-scene accept (the scenes not accepted
// come back from the version before the plan), and "Why this?" on any changed
// clip, read from the explain-why report. Every control is a button, a
// checkbox or the scrubber, so the screen works from the keyboard.
import { useEffect, useMemo, useRef, useState } from 'react'
import { studioUiStore } from '../../studio/ui/studioStore'
import { reasonForClip } from '../../studio/ui/review'
import { formatDurationChange } from '../../studio/ui/planCards'
import { acceptScenes, loadReview, returnToVersion } from '../../studio/ui/studioRuntime'
import StudioDialog, { Chip, StudioButton } from './StudioDialog'
import ReportView from './ReportView'
import { useStudioText, useStudioUi } from './studioUi'

const STATUS_STYLE = {
  removed: 'bg-sf-error/30 border-sf-error line-through',
  added: 'bg-sf-success/30 border-sf-success',
  changed: 'border-2',
  moved: 'border-2 border-dashed',
  same: 'bg-sf-dark-700 border-sf-dark-600 opacity-60',
}
const ORIGIN_STYLE = { ai: 'bg-sf-accent/35 border-sf-accent', user: 'bg-sf-warning/30 border-sf-warning' }

function Lane({ label, side, model, total, time, onSeek, onWhy, laneTracks }) {
  const t = useStudioText()
  const rows = laneTracks.map((track) => ({ track, clips: side.clips.filter((clip) => clip.trackId === track.id) })).filter((row) => row.clips.length > 0)
  const at = side.clips.find((clip) => clip.picture && clip.scene !== null && clip.start <= time && clip.end > time)
  return (
    <section aria-label={label} className="space-y-1" data-test={`studio-review-lane-${label.toLowerCase()}`}>
      <div className="flex items-baseline justify-between text-xs">
        <h3 className="font-semibold">{label} <span className="font-normal tabular-nums text-sf-text-muted">{side.duration.toFixed(1)} s</span></h3>
        <span className="truncate text-[11px] text-sf-text-secondary" aria-live="off">{at ? t('review.atPlayhead', { name: at.name }) : ''}</span>
      </div>
      <div className="rounded-md border border-sf-dark-700 bg-sf-dark-950 p-1">
      <div
        className="relative ml-24 space-y-0.5"
        onClick={(event) => {
          if (event.target !== event.currentTarget) return
          const rect = event.currentTarget.getBoundingClientRect()
          onSeek(((event.clientX - rect.left) / rect.width) * total)
        }}
      >
        {rows.map(({ track, clips }) => (
          <div key={track.id} className="relative h-5" aria-label={track.name}>
            <span className="absolute -left-24 top-0 w-[92px] truncate text-[9px] leading-5 text-sf-text-muted" aria-hidden>{track.name}</span>
            {clips.map((clip) => {
              const changed = clip.status !== 'same'
              const style = changed && clip.status !== 'removed' && clip.status !== 'added' ? `${STATUS_STYLE[clip.status]} ${ORIGIN_STYLE[clip.origin] || ORIGIN_STYLE.ai}` : STATUS_STYLE[clip.status]
              return (
                <button
                  key={clip.id}
                  type="button"
                  tabIndex={changed ? 0 : -1}
                  className={`absolute top-0 h-5 overflow-hidden truncate rounded-sm border px-1 text-left text-[9px] leading-5 text-sf-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent ${style}`}
                  style={{ left: `${(clip.start / total) * 100}%`, width: `${Math.max(0.3, ((clip.end - clip.start) / total) * 100)}%` }}
                  aria-label={changed ? t('review.clipLabel', { name: clip.name, status: t(`review.status.${clip.status}`), origin: t(`review.origin.${clip.origin || 'ai'}`) }) : clip.name}
                  onClick={() => (changed ? onWhy(clip) : onSeek(clip.start))}
                  data-test="studio-review-clip"
                  data-clip-id={clip.id}
                  data-status={clip.status}
                  data-origin={clip.origin || ''}
                >
                  {clip.name}
                </button>
              )
            })}
          </div>
        ))}
        <div className="pointer-events-none absolute inset-y-0 w-px bg-sf-accent" style={{ left: `${(time / total) * 100}%` }} aria-hidden data-test="studio-review-playhead" />
      </div>
      </div>
    </section>
  )
}

function WhyPopover({ clip, report, onClose }) {
  const t = useStudioText()
  const why = reasonForClip(report, clip.id)
  const closeRef = useRef(null)
  // Focus moves into the popover when it opens and back to the clip after.
  useEffect(() => {
    const opener = document.activeElement
    closeRef.current?.focus()
    return () => opener?.focus?.()
  }, [clip.id])
  return (
    <div role="dialog" aria-label={t('review.whyTitle')} className="rounded-lg border border-sf-accent/50 bg-sf-dark-800 p-3 text-xs shadow-xl" data-test="studio-why">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h4 className="font-semibold">{t('review.whyTitle')} · {clip.name}</h4>
          {why ? (
            <>
              <p className="text-sf-text-secondary">{t(`review.status.${why.action}`) || why.action}{why.scene ? ` · ${t('report.scene', { scene: why.scene })}` : ''} · {t(`review.origin.${why.by}`)}</p>
              <p className="text-sf-text-primary" data-test="studio-why-reason">{why.reason}</p>
            </>
          ) : (
            <p className="text-sf-text-secondary">{t('review.noReason')}</p>
          )}
        </div>
        <StudioButton ref={closeRef} tone="ghost" className="px-2 py-1" onClick={onClose} data-test="studio-why-close">{t('common.close')}</StudioButton>
      </div>
    </div>
  )
}

export default function ReviewScreen() {
  const t = useStudioText()
  const review = useStudioUi((state) => state.review)
  const [view, setView] = useState({ loading: true, error: null, data: null, time: 0, why: null, accepted: null, busy: false, showReport: false })
  const update = (next) => setView((current) => ({ ...current, ...next }))
  const close = () => studioUiStore.getState().patch({ review: null })

  // Loads the two documents when the screen opens for a version.
  useEffect(() => {
    let cancelled = false
    loadReview(review.versionId)
      .then((data) => {
        if (cancelled) return
        const changed = data.model.scenes.filter((scene) => scene.changed).map((scene) => scene.scene)
        update({ loading: false, data, accepted: new Set(changed) })
      })
      .catch((error) => !cancelled && update({ loading: false, error: error?.message || String(error) }))
    return () => { cancelled = true }
  }, [review.versionId])

  const total = useMemo(() => Math.max(1, view.data?.model.durationBefore || 0, view.data?.model.durationAfter || 0), [view.data])

  if (view.loading || view.error) {
    return (
      <StudioDialog title={t('review.title', { instruction: review.instruction || '' })} onClose={close} size="lg" testId="studio-review" closeLabel={t('common.close')}>
        {view.error ? <p role="alert" className="text-sm text-sf-error">{view.error}</p> : <p aria-live="polite" className="text-sm text-sf-text-muted">{t('review.loading')}</p>}
      </StudioDialog>
    )
  }

  const { model, report, before, after, versionId } = view.data
  const changedScenes = model.scenes.filter((scene) => scene.changed)
  const laneTracks = model.tracks.filter((track) => track.type !== 'audio' || model.before.clips.concat(model.after.clips).some((clip) => clip.trackId === track.id && clip.scene !== null))
  const allAccepted = changedScenes.every((scene) => view.accepted.has(scene.scene))

  const toggleScene = (scene) => {
    const accepted = new Set(view.accepted)
    if (accepted.has(scene)) accepted.delete(scene)
    else accepted.add(scene)
    update({ accepted })
  }

  const finish = (announcement) => {
    studioUiStore.getState().patch({ review: null, announcement })
  }

  const acceptSelected = async () => {
    update({ busy: true })
    try {
      if (allAccepted) return finish(t('review.keptAll'))
      const scenes = [...view.accepted, ...model.scenes.filter((scene) => !scene.changed).map((scene) => scene.scene)]
      await acceptScenes({ versionId, before, after, scenes, instruction: review.instruction })
      finish(t('review.acceptedSome', { scenes: [...view.accepted].sort((a, b) => a - b).join(', ') || '—' }))
    } catch (error) {
      update({ busy: false, error: null })
      studioUiStore.getState().patch({ panelError: error?.message || String(error) })
    }
  }

  const rejectAll = async () => {
    update({ busy: true })
    await returnToVersion(versionId, `Rejected “${review.instruction || 'the plan'}” on the Review screen`)
    finish(t('review.returned'))
  }

  const footer = (
    <>
      <StudioButton tone="danger" disabled={view.busy} onClick={rejectAll} data-test="studio-review-return">{t('review.returnToBefore')}</StudioButton>
      <StudioButton tone="primary" disabled={view.busy} onClick={acceptSelected} data-test="studio-review-accept">
        {allAccepted ? t('review.acceptAll') : t('review.acceptSelected', { count: view.accepted.size })}
      </StudioButton>
    </>
  )

  return (
    <StudioDialog
      title={t('review.title', { instruction: review.instruction || '' })}
      subtitle={t('review.subtitle', { change: formatDurationChange(model.durationBefore, model.durationAfter), count: changedScenes.length })}
      onClose={close}
      size="full"
      testId="studio-review"
      footer={footer}
      closeLabel={t('common.close')}
    >
      <div
        className="space-y-4"
        onKeyDown={(event) => {
          // Escape closes "Why this?" first, the Review screen only after.
          if (event.key !== 'Escape' || !view.why) return
          event.preventDefault()
          event.stopPropagation()
          update({ why: null })
        }}
      >
        <fieldset className="flex flex-wrap items-center gap-2" data-test="studio-review-scenes">
          <legend className="mb-1 text-xs font-semibold">{t('review.scenesLegend')}</legend>
          {model.scenes.map((scene) => (
            <label key={scene.scene} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${scene.changed ? 'border-sf-dark-600 bg-sf-dark-800' : 'border-transparent text-sf-text-muted'}`}>
              <input type="checkbox" disabled={!scene.changed} checked={scene.changed ? view.accepted.has(scene.scene) : true} onChange={() => toggleScene(scene.scene)} data-test="studio-review-scene" data-scene={scene.scene} />
              {t('report.scene', { scene: scene.scene })}
              <span className="tabular-nums text-sf-text-muted">{formatDurationChange(scene.durationBefore, scene.durationAfter)}</span>
              {!scene.changed && <span>· {t('review.unchanged')}</span>}
            </label>
          ))}
        </fieldset>

        <div className="flex items-center gap-3 text-[11px] text-sf-text-secondary" aria-hidden>
          <Chip tone="accent">{t('review.legendAi')}</Chip>
          <Chip tone="warn">{t('review.legendUser')}</Chip>
          <Chip tone="fail">{t('review.legendRemoved')}</Chip>
          <Chip tone="good">{t('review.legendAdded')}</Chip>
        </div>

        <Lane label={t('review.before')} side={model.before} model={model} total={total} time={view.time} onSeek={(time) => update({ time })} onWhy={(clip) => update({ why: clip })} laneTracks={laneTracks} />
        <Lane label={t('review.after')} side={model.after} model={model} total={total} time={view.time} onSeek={(time) => update({ time })} onWhy={(clip) => update({ why: clip })} laneTracks={laneTracks} />

        <label className="flex items-center gap-3 text-xs">
          <span className="w-20 text-sf-text-secondary">{t('review.scrub')}</span>
          <input
            type="range"
            min={0}
            max={total}
            step={0.1}
            value={view.time}
            onChange={(event) => update({ time: Number(event.target.value) })}
            className="flex-1 accent-sf-accent"
            aria-valuetext={`${view.time.toFixed(1)} s`}
            data-test="studio-review-scrub"
          />
          <span className="w-14 text-right tabular-nums">{view.time.toFixed(1)} s</span>
        </label>

        {view.why && <WhyPopover clip={view.why} report={report} onClose={() => update({ why: null })} />}

        <details open={view.showReport} onToggle={(event) => update({ showReport: event.currentTarget.open })}>
          <summary className="cursor-pointer text-xs font-semibold">{t('review.report')}</summary>
          <div className="mt-2"><ReportView report={report} /></div>
        </details>
      </div>
    </StudioDialog>
  )
}
