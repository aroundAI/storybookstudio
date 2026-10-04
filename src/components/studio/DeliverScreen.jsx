// FILM-2015 Deliver (R-62): choose presets and languages, see each file's
// estimated size and QA (the last preview's, then each delivered file's with
// its issues and "Fix with AI" → studio_repair), then "Send to StoryBook": a
// confirmation names the episode, the workspace, every file and its size, and
// only after the user confirms does the screen ask FILM-2017 for the one-time
// token bound to that exact summary and start the delivery. "Export to file"
// writes the same presets to a folder (FILM-2017's folder destination): no
// sign-in, no network.
import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileDown, Loader2, RotateCw, Send, Wand2 } from 'lucide-react'
import useTimelineStore from '../../stores/timelineStore'
import { studioUiStore } from '../../studio/ui/studioStore'
import { buildDeliveryConfirmation, formatBytes, presetLabel, qaBadge } from '../../studio/ui/deliverySummary'
import { buildSceneSegments } from '../../studio/ui/sceneStrip'
import { repairIssues } from '../../studio/ui/planActions'
import { RENDER_PRESET_NAMES } from '../../studio/contracts/render-presets.mjs'
import StudioDialog, { Chip, StudioButton } from './StudioDialog'
import { studioApi, useStudioText, useStudioUi } from './studioUi'

const close = () => studioUiStore.getState().patch({ deliverOpen: false })
const IN_FLIGHT = ['confirming', 'sending', 'rendering', 'uploading']

function Confirmation({ view, onCancel, onSend, sending }) {
  const t = useStudioText()
  const count = view.files.filter((file) => file.kind === 'render').length
  return (
    <StudioDialog
      title={view.toStoryBook ? t('deliver.confirmTitle') : t('deliver.confirmExportTitle')}
      subtitle={view.destinationLine}
      onClose={onCancel}
      testId="studio-deliver-confirm"
      closeLabel={t('common.close')}
      footer={(
        <>
          <StudioButton onClick={onCancel} data-test="studio-deliver-cancel">{t('common.cancel')}</StudioButton>
          <StudioButton tone="primary" disabled={!view.canSend || sending} onClick={onSend} data-test="studio-deliver-send" data-autofocus>
            {view.toStoryBook ? <Send className="mr-1 inline h-3 w-3" aria-hidden /> : <FileDown className="mr-1 inline h-3 w-3" aria-hidden />}
            {view.toStoryBook ? t('deliver.sendFiles', { count, size: view.totalLabel }) : t('deliver.exportFiles', { count, size: view.totalLabel })}
          </StudioButton>
        </>
      )}
    >
      <div className="space-y-3 text-sm" data-test="studio-deliver-summary">
        <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-sf-text-muted">{t('deliver.episode')}</dt><dd data-test="studio-deliver-episode">{view.episodeLine}</dd>
          <dt className="text-sf-text-muted">{t('deliver.destination')}</dt><dd data-test="studio-deliver-destination">{view.destinationLine}</dd>
          <dt className="text-sf-text-muted">{t('deliver.total')}</dt><dd className="tabular-nums">{view.totalLabel}</dd>
        </dl>
        <table className="w-full text-xs">
          <caption className="sr-only">{t('deliver.filesCaption')}</caption>
          <thead><tr className="text-left text-sf-text-muted"><th className="py-1 font-normal">{t('deliver.file')}</th><th className="py-1 font-normal">{t('deliver.details')}</th><th className="py-1 text-right font-normal">{t('deliver.size')}</th></tr></thead>
          <tbody>
            {view.files.map((file) => (
              <tr key={file.name} className="border-t border-sf-dark-700" data-test="studio-deliver-file">
                <td className="py-1.5 pr-2 font-mono">{file.name}</td>
                <td className="py-1.5 pr-2 text-sf-text-secondary">{file.detail}</td>
                <td className="py-1.5 text-right tabular-nums">{file.sizeLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-sf-text-secondary">{view.statusLine}</p>
        {view.warnings.length > 0 && (
          <ul className="space-y-1 rounded-md border border-sf-warning/40 bg-sf-warning/10 p-2 text-xs" role="alert">
            {view.warnings.map((warning) => (
              <li key={warning.text} className={`flex gap-1.5 ${warning.blocking ? 'text-sf-error' : ''}`}>
                <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-sf-warning" aria-hidden />{warning.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </StudioDialog>
  )
}

function RenderRow({ render, deliveredQa }) {
  const t = useStudioText()
  const badge = qaBadge(deliveredQa ?? render.lastQa)
  const issues = deliveredQa?.issues || []
  return (
    <li className="rounded-lg border border-sf-dark-600 bg-sf-dark-800 p-3" data-test="studio-deliver-render" data-preset={render.preset}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{presetLabel(render.preset)} · {render.language}</span>
        <span className="flex items-center gap-1.5">
          {render.overMaxDuration && <Chip tone="fail">{t('deliver.overLimit', { max: render.maxDuration })}</Chip>}
          <Chip tone={badge.tone} data-test="studio-qa-badge">{badge.label}</Chip>
        </span>
      </div>
      <p className="mt-1 text-[11px] tabular-nums text-sf-text-muted">
        {render.file} · {Number(render.estimatedDurationSeconds || 0).toFixed(1)} s · {t('deliver.about', { size: formatBytes(render.estimatedBytes) })}
      </p>
      {render.note && <p className="mt-1 text-[11px] text-sf-warning">{render.note}</p>}
      {issues.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-label={t('deliver.issues')}>
          {issues.map((issue, index) => (
            <li key={index} className="flex items-start justify-between gap-2 text-[11px]" data-test="studio-qa-issue">
              <span><span className="font-semibold">{issue.type}</span>{issue.scene ? ` · ${t('report.scene', { scene: issue.scene })}` : ''}: {issue.detail}</span>
              <StudioButton className="flex-shrink-0 px-2 py-1 text-[11px]" onClick={() => repairIssues({ store: studioUiStore, issues: [issue] })} data-test="studio-fix-with-ai">
                <Wand2 className="mr-1 inline h-3 w-3" aria-hidden />{t('deliver.fixWithAi')}
              </StudioButton>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

export default function DeliverScreen() {
  const t = useStudioText()
  const pkg = useStudioUi((state) => state.pkg)
  const auth = useStudioUi((state) => state.auth)
  const apiOrigin = useStudioUi((state) => state.apiOrigin)
  const link = useStudioUi((state) => state.link)
  const delivery = useStudioUi((state) => state.delivery)
  const qaAnnouncement = useStudioUi((state) => state.qaAnnouncement)
  const clips = useTimelineStore((state) => state.clips)
  const tracks = useTimelineStore((state) => state.tracks)
  const languagesAvailable = pkg?.episode?.languages?.length ? pkg.episode.languages : [pkg?.episode?.language || 'en']
  const [choice, setChoice] = useState({ presets: new Set(['youtube_16x9']), languages: new Set([languagesAvailable[0]]) })
  const [state, setState] = useState({ checking: false, error: null, prepared: null, confirming: false })
  const update = (next) => setState((current) => ({ ...current, ...next }))
  // The cut's length as the scene strip measures it: the scenes' picture.
  const durationSeconds = useMemo(() => buildSceneSegments({ timeline: { clips, tracks } }).total.actual, [clips, tracks])
  const api = studioApi()

  const request = (destination, folder = null) => ({
    presets: [...choice.presets],
    languages: [...choice.languages],
    destination,
    ...(folder ? { folder } : {}),
    durationSeconds,
    episode: pkg?.episode ? { id: pkg.episode.id, title: pkg.episode.title } : null,
    apiOrigin: link?.apiBase || apiOrigin,
  })

  const toggle = (key, value) => {
    const next = new Set(choice[key])
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setChoice({ ...choice, [key]: next })
    update({ prepared: null })
  }

  const prepare = async (destination, folder = null) => {
    update({ checking: true, error: null })
    const args = request(destination, folder)
    const answer = await api.deliverSummary(args)
    if (!answer?.success) {
      update({ checking: false, error: answer?.error || t('deliver.checkFailed') })
      return null
    }
    const prepared = { ...answer, args }
    update({ checking: false, prepared })
    return prepared
  }

  const openConfirmation = async (destination) => {
    let folder = null
    if (destination === 'folder') {
      const chosen = await api.chooseExportFolder()
      folder = chosen?.folder
      if (!folder) return
    }
    const prepared = await prepare(destination, folder)
    if (prepared) update({ confirming: true })
  }

  const send = async () => {
    const { prepared } = state
    const { patch } = studioUiStore.getState()
    patch({ delivery: { status: 'confirming', destination: prepared.args.destination } })
    const confirmation = await api.deliverConfirm({ summaryHash: prepared.summaryHash })
    if (!confirmation?.success) {
      patch({ delivery: { status: 'failed', error: confirmation?.error } })
      return
    }
    const started = await api.deliverStart({ ...prepared.args, confirmationToken: confirmation.token })
    update({ confirming: false })
    if (!started?.success) {
      patch({ delivery: { status: 'failed', code: started?.code, error: started?.error } })
      return
    }
    patch({ delivery: { jobId: started.jobId, status: 'sending', destination: prepared.args.destination } })
  }

  const retry = async () => {
    const answer = await api.deliverRetry?.({ jobId: delivery.jobId })
    if (answer?.success) studioUiStore.getState().patch({ delivery: { ...delivery, jobId: answer.jobId, status: 'sending', error: null, code: null } })
  }


  const signedIn = Boolean(auth?.signedIn)
  const online = globalThis.navigator?.onLine !== false
  const busy = IN_FLIGHT.includes(delivery?.status)
  const view = state.prepared ? buildDeliveryConfirmation({ summary: state.prepared.summary, workspace: auth.team, episodeNumber: pkg?.episode?.number ?? null }) : null
  const renders = state.prepared?.summary?.renders || []

  const footer = (
    <>
      <StudioButton onClick={() => openConfirmation('folder')} disabled={busy || state.checking} data-test="studio-export-file"><FileDown className="mr-1 inline h-3 w-3" aria-hidden />{t('deliver.exportToFile')}</StudioButton>
      <StudioButton tone="primary" disabled={!signedIn || !online || !pkg?.episode || busy || state.checking} onClick={() => openConfirmation('storybook')} data-test="studio-send-to-storybook">
        <Send className="mr-1 inline h-3 w-3" aria-hidden />{t('deliver.sendToStoryBook')}
      </StudioButton>
    </>
  )

  return (
    <StudioDialog title={t('deliver.title')} subtitle={pkg?.episode ? `${pkg.episode.number}. ${pkg.episode.title}` : null} onClose={close} size="lg" testId="studio-deliver" footer={footer} closeLabel={t('common.close')}>
      <p className="sr-only" aria-live="polite" data-test="studio-qa-live">{qaAnnouncement}</p>
      <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-5">
        <div className="space-y-4">
          <fieldset data-test="studio-deliver-presets">
            <legend className="mb-1.5 text-xs font-semibold">{t('deliver.formats')}</legend>
            {RENDER_PRESET_NAMES.map((preset) => (
              <label key={preset} className="flex items-center gap-2 py-0.5 text-xs">
                <input type="checkbox" checked={choice.presets.has(preset)} onChange={() => toggle('presets', preset)} data-test="studio-deliver-preset" data-preset={preset} />
                {presetLabel(preset)}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend className="mb-1.5 text-xs font-semibold">{t('deliver.languages')}</legend>
            {languagesAvailable.map((language) => (
              <label key={language} className="flex items-center gap-2 py-0.5 text-xs">
                <input type="checkbox" checked={choice.languages.has(language)} onChange={() => toggle('languages', language)} />
                {language}
              </label>
            ))}
          </fieldset>
          <StudioButton className="w-full" disabled={state.checking || choice.presets.size === 0 || choice.languages.size === 0} onClick={() => prepare('storybook')} data-test="studio-deliver-check">
            {state.checking ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden /> : null}{t('deliver.prepare')}
          </StudioButton>
          {!signedIn && <p className="text-[11px] text-sf-text-muted">{t('deliver.signInToSend')}</p>}
          {!online && <p className="text-[11px] text-sf-text-muted">{t('deliver.offline')}</p>}
        </div>

        <div className="min-w-0 space-y-3">
          {state.error && <p role="alert" className="text-xs text-sf-error" data-test="studio-deliver-error">{state.error}</p>}
          {!state.prepared && !state.error && <p className="text-xs text-sf-text-muted">{t('deliver.empty')}</p>}
          {renders.length > 0 && (
            <ul className="space-y-2" data-test="studio-deliver-renders">
              {renders.map((render) => <RenderRow key={`${render.preset}-${render.language}`} render={render} deliveredQa={delivery?.qa?.[`${render.preset}-${render.language}`] ?? null} />)}
            </ul>
          )}
          {delivery && (
            <div className={`flex flex-wrap items-center gap-2 rounded-md p-2 text-xs ${delivery.status === 'failed' ? 'bg-sf-error/15 text-sf-error' : ['sent', 'exported'].includes(delivery.status) ? 'bg-sf-success/15 text-sf-success' : 'bg-sf-dark-800'}`} role="status" data-test="studio-delivery-status" data-status={delivery.status}>
              {['sent', 'exported'].includes(delivery.status) ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : delivery.status === 'failed' ? <AlertTriangle className="h-4 w-4" aria-hidden /> : <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              <span>
                {delivery.status === 'failed' ? delivery.error : t(`deliver.progress.${delivery.status}`)}
                {busy && delivery.total ? ` (${delivery.done ?? 0}/${delivery.total})` : ''}
              </span>
              {delivery.status === 'exported' && delivery.result?.folder && <span className="w-full font-mono text-[11px] text-sf-text-secondary">{delivery.result.folder}</span>}
              {delivery.code === 'TARGET_CHANGED' && (
                <span className="ml-auto flex gap-1.5">
                  <StudioButton onClick={() => studioApi()?.checkUpdates()} data-test="studio-deliver-resync">{t('deliver.resync')}</StudioButton>
                  <StudioButton onClick={retry} data-test="studio-deliver-retry"><RotateCw className="mr-1 inline h-3 w-3" aria-hidden />{t('deliver.retry')}</StudioButton>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {state.confirming && view && <Confirmation view={view} sending={delivery?.status === 'confirming'} onCancel={() => update({ confirming: false })} onSend={send} />}
    </StudioDialog>
  )
}
