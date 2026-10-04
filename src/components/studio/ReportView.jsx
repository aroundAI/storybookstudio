// FILM-2015: the explain-why report (R-24) as a screen reader reads it: a
// heading per scene with its duration change, then each change and its reason.
import { formatDurationChange } from '../../studio/ui/planCards'
import { useStudioText } from './studioUi'

const ACTIONS = { removed: 'Removed', trimmed: 'Trimmed', moved: 'Moved', added: 'Added', changed: 'Changed' }

export default function ReportView({ report }) {
  const t = useStudioText()
  if (!report?.explain) return <p className="text-xs text-sf-text-muted">{t('report.none')}</p>
  const { explain } = report
  return (
    <section aria-label={t('report.title')} className="space-y-3 text-xs" data-test="studio-report">
      <p className="text-sf-text-secondary">
        {t('report.summary', { before: explain.durationBefore?.toFixed?.(1) ?? '?', after: (explain.durationAfter ?? report.finalDuration)?.toFixed?.(1) ?? '?', ai: report.aiOps, user: report.userOps })}
      </p>
      {explain.scenes.filter((scene) => scene.changes.length > 0).map((scene) => (
        <div key={scene.scene}>
          <h4 className="font-semibold text-sf-text-primary">{t('report.scene', { scene: scene.scene })} · {formatDurationChange(scene.durationBefore, scene.durationAfter)}</h4>
          <ul className="mt-1 space-y-1">
            {scene.changes.map((change, index) => (
              <li key={`${change.clipId || change.target}-${index}`} className="leading-snug">
                <span className="text-sf-text-primary">{ACTIONS[change.action] || change.action} {change.target}</span>
                {change.before != null && change.after != null && change.action === 'trimmed' ? <span className="text-sf-text-muted"> ({formatDurationChange(change.before, change.after)})</span> : null}
                <span className="block text-sf-text-secondary">{change.by === 'user' ? t('report.byYou') : t('report.why')}: {change.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {(explain.audio || []).length > 0 && (
        <div>
          <h4 className="font-semibold text-sf-text-primary">{t('report.audio')}</h4>
          <ul className="mt-1 space-y-1">
            {explain.audio.map((change, index) => (
              <li key={`${change.target}-${index}`}><span className="text-sf-text-primary">{change.target}: {change.change}</span><span className="block text-sf-text-secondary">{change.reason}</span></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
