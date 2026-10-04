// FILM-2015 AI panel, on the editor's right (R-20, R-24). The instruction box
// sends to the in-app agent (FILM-2013 studio_edit); plan cards arrive on
// studio:plan-proposed from the agent or an external MCP client alike. Cards
// are the unit of approval: Approve all, Approve scene, Reject. Nothing here
// blocks the editor: asking returns at once and the cards arrive later,
// announced to screen readers. Applied plans offer Review and their report.
import { useState } from 'react'
import { AlertTriangle, ChevronRight, Loader2, Send, Sparkles, X } from 'lucide-react'
import { studioUiStore } from '../../studio/ui/studioStore'
import { approvePlan, askWithProposal, proposeInstruction, rejectPlan } from '../../studio/ui/planActions'
import { clearPlanJournal, createLocalPlanRunner, loadReview, returnToVersion } from '../../studio/ui/studioRuntime'
import ReportView from './ReportView'
import { Chip, StudioButton } from './StudioDialog'
import { useStudioText, useStudioUi } from './studioUi'

const SOURCE_TONES = { agent: 'accent', mcp: 'neutral', resync: 'warn' }

function PlanCard({ plan, card, disabled }) {
  const t = useStudioText()
  const approveScene = () => approvePlan({ store: studioUiStore, runner: createLocalPlanRunner(), planId: plan.planId, scenes: [card.scene] })
  return (
    <li className="rounded-lg border border-sf-dark-600 bg-sf-dark-800 p-3" data-test="studio-plan-card" data-scene={card.scene ?? ''}>
      <div className="flex items-start justify-between gap-2">
        <h4 className="min-w-0 text-xs font-semibold leading-snug text-sf-text-primary">{card.title}</h4>
        {card.durationLabel && (
          <span className="whitespace-nowrap text-[11px] tabular-nums text-sf-text-secondary" aria-label={t('panel.durationChange', { change: card.durationLabel })}>
            {card.durationLabel}{card.deltaLabel ? <span className="ml-1 text-sf-text-muted">({card.deltaLabel})</span> : null}
          </span>
        )}
      </div>
      <ul className="mt-2 space-y-1.5">
        {card.changes.map((change, index) => (
          <li key={index} className="text-[11px] leading-snug">
            <span className="text-sf-text-primary">{change.text}</span>
            {change.reason && change.reason !== change.text && <span className="block text-sf-text-muted">{change.reason}</span>}
          </li>
        ))}
      </ul>
      {card.touchesUserEdits && <p className="mt-2 flex items-center gap-1 text-[11px] text-sf-warning"><AlertTriangle className="h-3 w-3" aria-hidden />{t('panel.cardTouchesEdits')}</p>}
      {card.scene !== null && plan.status === 'proposed' && (plan.capability ? plan.capability.scoped : plan.steps.length > 0) && (
        <div className="mt-2 flex justify-end">
          <StudioButton className="px-2 py-1 text-[11px]" disabled={disabled} onClick={approveScene} data-test="studio-approve-scene">
            {t('panel.approveScene', { scene: card.scene })}
          </StudioButton>
        </div>
      )}
      {plan.approvedScenes?.includes(card.scene) && plan.status === 'applied' && <p className="mt-2 text-[11px] text-sf-success">{t('panel.sceneApplied')}</p>}
    </li>
  )
}

// A tier the plan does not apply: what it would drop and why. Asking for it
// is a new preview with the drops included, approved like any plan.
function ProposalGroup({ plan, proposal, disabled }) {
  const t = useStudioText()
  return (
    <section className="rounded-md border border-sf-warning/50 bg-sf-warning/10 p-2" aria-label={proposal.title} data-test="studio-needs-ok" data-kind={proposal.kind}>
      <h4 className="flex items-center gap-1 text-xs font-semibold text-sf-warning"><AlertTriangle className="h-3 w-3" aria-hidden />{proposal.title}</h4>
      {proposal.why && <p className="mt-1 text-[11px] leading-snug text-sf-text-secondary">{proposal.why}</p>}
      <ul className="mt-2 space-y-1.5">
        {proposal.lines.map((line) => (
          <li key={line.key} className="text-[11px] leading-snug" data-test="studio-needs-ok-line">
            <span className="block text-sf-text-muted">{line.label}{line.seconds !== null ? ` · ${line.seconds.toFixed(1)} s` : ''}</span>
            <span className="text-sf-text-primary">“{line.text}”</span>
            {line.reason && <span className="block text-sf-text-muted">{line.reason}</span>}
          </li>
        ))}
      </ul>
      {plan.status === 'proposed' && (
        <div className="mt-2 flex items-center justify-between gap-2">
          {proposal.durationAfter !== null && <span className="text-[11px] tabular-nums text-sf-text-secondary">{t('panel.needsOkTotal', { seconds: proposal.durationAfter.toFixed(1) })}</span>}
          <StudioButton className="px-2 py-1 text-[11px]" disabled={disabled} onClick={() => askWithProposal({ store: studioUiStore, plan, proposal })} data-test="studio-ask-with-drops">
            {t('panel.needsOkAsk')}
          </StudioButton>
        </div>
      )}
    </section>
  )
}

function Plan({ plan }) {
  const t = useStudioText()
  const [report, setReport] = useState({ open: false, data: plan.report ?? null, error: null })
  const busy = plan.status === 'applying'
  const toggleReport = async () => {
    if (report.open) return setReport((current) => ({ ...current, open: false }))
    if (report.data || plan.reportText || !plan.versionId) return setReport((current) => ({ ...current, open: true }))
    try {
      const loaded = await loadReview(plan.versionId)
      setReport({ open: true, data: loaded.report, error: null })
    } catch (error) {
      setReport({ open: true, data: null, error: error?.message || String(error) })
    }
  }
  return (
    <article className="space-y-3 border-b border-sf-dark-700 pb-4" data-test="studio-plan" data-plan-id={plan.planId} data-status={plan.status} aria-label={t('panel.planLabel', { instruction: plan.instruction })}>
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <Chip tone={SOURCE_TONES[plan.source]}>{t(`panel.source.${plan.source}`)}</Chip>
          <Chip tone={plan.status === 'applied' ? 'good' : plan.status === 'rejected' ? 'muted' : plan.status === 'failed' ? 'fail' : 'busy'}>{t(`panel.status.${plan.status}`)}</Chip>
        </div>
        <h3 className="text-sm font-semibold leading-snug">{plan.instruction}</h3>
        {plan.totalLabel && <p className="text-xs tabular-nums text-sf-text-secondary">{t('panel.total', { change: plan.totalLabel })}</p>}
      </header>

      {plan.touchesUserEdits.length > 0 && (
        <section className="rounded-md border border-sf-warning/40 bg-sf-warning/10 p-2" aria-label={t('panel.touchesTitle')} data-test="studio-touches-edits">
          <h4 className="flex items-center gap-1 text-[11px] font-semibold text-sf-warning"><AlertTriangle className="h-3 w-3" aria-hidden />{t('panel.touchesTitle')}</h4>
          <ul className="mt-1 space-y-0.5 text-[11px] text-sf-text-primary">
            {plan.touchesUserEdits.map((entry) => <li key={entry.clipId}>{entry.text}</li>)}
          </ul>
        </section>
      )}

      <ul className="space-y-2">
        {plan.cards.map((card) => <PlanCard key={card.key} plan={plan} card={card} disabled={busy} />)}
      </ul>

      {(plan.proposals || []).map((proposal) => <ProposalGroup key={proposal.kind} plan={plan} proposal={proposal} disabled={busy} />)}

      {plan.unresolved.length > 0 && (
        <details className="text-[11px] text-sf-text-secondary">
          <summary className="cursor-pointer">{t('panel.unresolved', { count: plan.unresolved.length })}</summary>
          <ul className="mt-1 list-disc pl-4">{plan.unresolved.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
        </details>
      )}

      {plan.error && <p role="alert" className="text-xs text-sf-error" data-test="studio-plan-error">{plan.error}</p>}

      {plan.status === 'proposed' || plan.status === 'applying' ? (
        <div className="flex gap-2">
          <StudioButton tone="primary" className="flex-1" disabled={busy} onClick={() => approvePlan({ store: studioUiStore, runner: createLocalPlanRunner(), planId: plan.planId })} data-test="studio-approve-all">
            {busy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden /> : null}{busy ? t('panel.applying') : t('panel.approveAll')}
          </StudioButton>
          <StudioButton tone="danger" disabled={busy} onClick={() => rejectPlan({ store: studioUiStore, planId: plan.planId })} data-test="studio-reject">
            {t('panel.reject')}
          </StudioButton>
        </div>
      ) : null}

      {plan.status === 'applied' && (
        <div className="flex flex-wrap gap-2">
          <StudioButton tone="primary" onClick={() => studioUiStore.getState().patch({ review: { versionId: plan.versionId, planId: plan.planId, instruction: plan.instruction } })} data-test="studio-open-review">
            {t('panel.review')}
          </StudioButton>
          <StudioButton onClick={toggleReport} aria-expanded={report.open} data-test="studio-toggle-report">
            {report.open ? t('panel.hideReport') : t('panel.showReport')}
          </StudioButton>
        </div>
      )}
      {plan.status !== 'applied' && plan.reportText && (
        <StudioButton onClick={toggleReport} aria-expanded={report.open} data-test="studio-toggle-report">
          {report.open ? t('panel.hideReport') : t('panel.showReport')}
        </StudioButton>
      )}
      {report.open && (report.error
        ? <p role="alert" className="text-xs text-sf-error">{report.error}</p>
        : report.data
          ? <ReportView report={report.data} />
          : plan.reportText
            ? <pre className="whitespace-pre-wrap rounded-md bg-sf-dark-950 p-2 font-mono text-[11px] leading-relaxed text-sf-text-secondary" data-test="studio-report-text">{plan.reportText}</pre>
            : <ReportView report={null} />)}
    </article>
  )
}

function RecoveryBanner({ recovery }) {
  const t = useStudioText()
  const [busy, setBusy] = useState(false)
  const back = async () => {
    setBusy(true)
    try {
      await returnToVersion(recovery.versionId)
      studioUiStore.getState().patch({ recovery: null, announcement: t('panel.recoveryDone') })
    } finally {
      setBusy(false)
    }
  }
  const dismiss = async () => {
    await clearPlanJournal()
    studioUiStore.getState().patch({ recovery: null })
  }
  return (
    <div role="alert" className="space-y-2 rounded-md border border-sf-warning/50 bg-sf-warning/10 p-3 text-xs" data-test="studio-recovery">
      <p>{t('panel.recovery', { instruction: recovery.instruction || '' })}</p>
      <div className="flex gap-2">
        <StudioButton tone="primary" disabled={busy} onClick={back} data-test="studio-recovery-return">{t('panel.returnToBefore')}</StudioButton>
        <StudioButton tone="ghost" onClick={dismiss}>{t('panel.keepAsIs')}</StudioButton>
      </div>
    </div>
  )
}

export default function AIPanel() {
  const t = useStudioText()
  const open = useStudioUi((state) => state.aiPanelOpen)
  const plans = useStudioUi((state) => state.plans)
  const pending = useStudioUi((state) => state.pending)
  const panelError = useStudioUi((state) => state.panelError)
  const announcement = useStudioUi((state) => state.announcement)
  const scope = useStudioUi((state) => state.scope)
  const recovery = useStudioUi((state) => state.recovery)
  const isStoryBookProject = useStudioUi((state) => Boolean(state.pkg))
  const [instruction, setInstruction] = useState('')
  const { patch } = studioUiStore.getState()

  const ask = async () => {
    const answer = await proposeInstruction({ store: studioUiStore, instruction })
    if (answer.ok) setInstruction('')
  }

  const live = <p className="sr-only" aria-live="polite" data-test="studio-ai-live">{announcement}</p>

  if (!open) {
    return (
      <div className="flex w-8 flex-shrink-0 flex-col items-center border-l border-sf-dark-700 bg-sf-dark-900 py-2">
        {live}
        <button type="button" className="flex flex-col items-center gap-1 rounded p-1 text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-accent" onClick={() => patch({ aiPanelOpen: true })} aria-label={t('panel.open')} data-test="studio-ai-toggle">
          <Sparkles className="h-4 w-4" aria-hidden />
          <span className="text-[10px] [writing-mode:vertical-rl]">AI</span>
          {plans.some((plan) => plan.status === 'proposed') && <span className="h-2 w-2 rounded-full bg-sf-accent" aria-label={t('panel.planWaiting')} />}
        </button>
      </div>
    )
  }

  const visible = [...plans].reverse()
  return (
    <aside className="flex w-[340px] flex-shrink-0 flex-col border-l border-sf-dark-700 bg-sf-dark-900 text-sf-text-primary" aria-label={t('panel.title')} data-test="studio-ai-panel">
      {live}
      <div className="flex items-center justify-between border-b border-sf-dark-700 px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold"><Sparkles className="h-3.5 w-3.5 text-sf-accent" aria-hidden />{t('panel.title')}</h2>
        <div className="flex items-center gap-1">
          {isStoryBookProject && (
            <StudioButton className="px-2 py-1 text-[11px]" onClick={() => patch({ deliverOpen: true })} data-test="studio-open-deliver">
              {t('panel.deliver')} <ChevronRight className="inline h-3 w-3" aria-hidden />
            </StudioButton>
          )}
          <button type="button" className="rounded p-1 text-sf-text-muted hover:bg-sf-dark-700" onClick={() => patch({ aiPanelOpen: false })} aria-label={t('panel.close')} data-test="studio-ai-close">
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      <form className="space-y-2 border-b border-sf-dark-700 p-3" onSubmit={(event) => { event.preventDefault(); ask() }}>
        {scope && (
          <div className="flex items-center justify-between gap-2 rounded bg-sf-accent/10 px-2 py-1 text-[11px]" data-test="studio-scope">
            <span className="truncate">{t('panel.scoped', { label: scope.label })}</span>
            <button type="button" className="text-sf-text-muted hover:text-sf-text-primary" onClick={() => patch({ scope: null })} aria-label={t('panel.clearScope')}><X className="h-3 w-3" aria-hidden /></button>
          </div>
        )}
        <label className="sr-only" htmlFor="studio-instruction">{t('panel.instructionLabel')}</label>
        <textarea
          id="studio-instruction"
          rows={3}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              ask()
            }
          }}
          placeholder={scope ? t('panel.placeholderScoped') : t('panel.placeholder')}
          className="w-full resize-none rounded-md border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-xs focus:border-sf-accent focus:outline-none"
          data-test="studio-instruction"
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-sf-text-muted">{t('panel.askHint')}</span>
          <StudioButton tone="primary" type="submit" disabled={!instruction.trim() || Boolean(pending)} data-test="studio-ask">
            <Send className="mr-1 inline h-3 w-3" aria-hidden />{t('panel.ask')}
          </StudioButton>
        </div>
        {pending && <p className="flex items-center gap-1.5 text-[11px] text-sf-text-secondary" data-test="studio-pending"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />{t('panel.preparing')}</p>}
        {panelError && <p role="alert" className="text-[11px] text-sf-error" data-test="studio-panel-error">{panelError}</p>}
      </form>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {recovery && <RecoveryBanner recovery={recovery} />}
        {visible.length === 0 && <p className="text-xs text-sf-text-muted">{t('panel.empty')}</p>}
        {visible.map((plan) => <Plan key={plan.planId} plan={plan} />)}
      </div>
    </aside>
  )
}
