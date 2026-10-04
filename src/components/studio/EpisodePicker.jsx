// FILM-2015 Episode picker (R-11): projects → seasons → episodes from
// list_projects / list_episodes (FILM-2011 IPC), with status, duration, last
// changed, size when the episode is already on this machine, and "On this
// machine". A storybookstudio://open link pre-selects its episode. "Open" starts the
// pull; progress shows phase, files and bytes; the editor opens when the
// rough cut is built (studio:job-progress done).
import { useEffect, useMemo, useState } from 'react'
import { Download, HardDrive } from 'lucide-react'
import useProjectStore from '../../stores/projectStore'
import { studioUiStore } from '../../studio/ui/studioStore'
import { buildEpisodeTree, jobProgressView } from '../../studio/ui/pickerModel'
import { projectFoldersIn, scanLocalLinks } from '../../studio/ui/studioRuntime'
import StudioDialog, { Chip, StudioButton } from './StudioDialog'
import { SignInForm } from './Welcome'
import { studioApi, useStudioText, useStudioUi } from './studioUi'

const close = () => studioUiStore.getState().patch({ pickerOpen: false, openRequest: null })

function ProgressView({ job }) {
  const t = useStudioText()
  const view = jobProgressView(job)
  if (!view) return null
  return (
    <div className="space-y-1.5" data-test="studio-pull-progress" data-phase={job.phase} data-status={job.status}>
      <div className="flex justify-between text-xs">
        <span className={view.failed ? 'text-sf-error' : 'text-sf-text-primary'}>{view.label}</span>
        <span className="text-sf-text-muted">{view.failed ? '' : view.detail}</span>
      </div>
      <div className="h-1.5 rounded bg-sf-dark-700" role="progressbar" aria-label={t('picker.progressLabel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent} aria-valuetext={`${view.label}. ${view.detail}`}>
        <div className={`h-1.5 rounded ${view.failed ? 'bg-sf-error' : 'bg-sf-accent'}`} style={{ width: `${view.percent}%` }} />
      </div>
      {view.failed && <p role="alert" className="text-xs text-sf-error" data-test="studio-pull-error">{view.detail}</p>}
      <p className="sr-only" aria-live="polite">{`${view.label} ${view.percent}%`}</p>
    </div>
  )
}

export default function EpisodePicker() {
  const t = useStudioText()
  const signedIn = useStudioUi((state) => Boolean(state.auth?.signedIn))
  const apiOrigin = useStudioUi((state) => state.apiOrigin)
  const openRequest = useStudioUi((state) => state.openRequest)
  const projectsRoot = useStudioUi((state) => state.projectsRoot)
  const job = useStudioUi((state) => state.job)
  const recentProjects = useProjectStore((state) => state.recentProjects)
  const openProject = useProjectStore((state) => state.openProject)
  const [view, setView] = useState({ projects: [], projectId: null, episodes: [], selectedId: openRequest?.episodeId ?? null, loading: false, error: null, localLinks: new Map() })
  const update = (next) => setView((current) => ({ ...current, ...(typeof next === 'function' ? next(current) : next) }))

  const loadEpisodes = async (projectId) => {
    update({ projectId, episodes: [], loading: true, error: null })
    const answer = await studioApi()?.listEpisodes({ apiOrigin, projectId })
    update({ loading: false, episodes: answer?.success ? answer.result.episodes || [] : [], error: answer?.success ? null : answer?.error })
    return answer?.success ? answer.result.episodes || [] : []
  }

  // Loads the projects once signed in, finds a deep link's episode, and reads
  // which episodes are already on this machine. Runs when the picker opens.
  useEffect(() => {
    if (!signedIn) return undefined
    let cancelled = false
    ;(async () => {
      update({ loading: true, error: null })
      const answer = await studioApi()?.listProjects({ apiOrigin })
      if (cancelled) return
      const projects = answer?.success ? answer.result.projects || [] : []
      update({ projects, loading: false, error: answer?.success ? null : answer?.error })
      const wanted = openRequest?.episodeId
      if (wanted) {
        for (const project of projects) {
          const episodes = await loadEpisodes(project.id)
          if (cancelled) return
          if (episodes.some((episode) => episode.id === wanted)) {
            update({ selectedId: wanted })
            break
          }
        }
      } else if (projects.length > 0) {
        await loadEpisodes(projects[0].id)
      }
      const folders = [...recentProjects.map((project) => project.path), ...(await projectFoldersIn(projectsRoot))]
      const localLinks = await scanLocalLinks(folders)
      if (!cancelled) update({ localLinks })
    })()
    return () => { cancelled = true }
  }, [signedIn, apiOrigin, openRequest?.episodeId])

  const tree = useMemo(() => buildEpisodeTree({ episodes: view.episodes, localLinks: view.localLinks }), [view.episodes, view.localLinks])
  const selected = tree.flatMap((season) => season.episodes).find((episode) => episode.id === view.selectedId) || null
  const pulling = job && job.status === 'running'

  const pull = async () => {
    const answer = await studioApi()?.pull({ apiOrigin, episodeId: view.selectedId })
    if (!answer?.success) {
      update({ error: answer?.error || t('picker.pullFailed') })
      return
    }
    studioUiStore.getState().patch({ job: { id: answer.jobId, kind: 'pull', episodeId: view.selectedId, phase: 'queued', status: 'running', done: 0, total: 0, bytes: 0 } })
  }

  const openLocal = async () => {
    if (!selected?.localPath) return
    await openProject(selected.localPath)
    close()
  }

  if (!signedIn) {
    return (
      <StudioDialog title={t('picker.title')} subtitle={openRequest ? t('picker.signInForLink') : null} onClose={close} testId="studio-picker" closeLabel={t('common.close')}>
        <SignInForm compact />
      </StudioDialog>
    )
  }

  const footer = (
    <>
      {selected?.onThisMachine && (
        <StudioButton onClick={openLocal} disabled={pulling} data-test="studio-picker-open-local">
          <HardDrive className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />{t('picker.openLocal')}
        </StudioButton>
      )}
      <StudioButton tone="primary" onClick={pull} disabled={!view.selectedId || pulling} data-test="studio-picker-open">
        <Download className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />{selected?.onThisMachine ? t('picker.openFresh') : t('picker.open')}
      </StudioButton>
    </>
  )

  return (
    <StudioDialog title={t('picker.title')} subtitle={apiOrigin} onClose={close} size="lg" testId="studio-picker" footer={footer} closeLabel={t('common.close')}>
      <div className="grid min-h-[360px] grid-cols-[200px_minmax(0,1fr)] gap-4">
        <nav aria-label={t('picker.projects')} className="space-y-1 border-r border-sf-dark-700 pr-3">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-sf-text-muted">{t('picker.projects')}</h3>
          {view.projects.map((project) => (
            <button
              key={project.id}
              type="button"
              aria-pressed={view.projectId === project.id}
              className={`block w-full truncate rounded-md px-2 py-1.5 text-left text-sm ${view.projectId === project.id ? 'bg-sf-accent/20 text-sf-text-primary' : 'text-sf-text-secondary hover:bg-sf-dark-800'}`}
              onClick={() => loadEpisodes(project.id)}
              data-test="studio-picker-project"
            >
              {project.name}
            </button>
          ))}
          {view.projects.length === 0 && !view.loading && <p className="text-xs text-sf-text-muted">{t('picker.noProjects')}</p>}
        </nav>
        <div className="min-w-0 space-y-4" data-test="studio-picker-episodes">
          {view.loading && <p className="text-xs text-sf-text-muted" aria-live="polite">{t('picker.loading')}</p>}
          {view.error && <p role="alert" className="text-xs text-sf-error">{view.error}</p>}
          {tree.map((season) => (
            <section key={season.seasonId || 'none'} aria-label={season.label}>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sf-text-muted">{season.label}</h3>
              <ul className="space-y-1" role="listbox" aria-label={season.label}>
                {season.episodes.map((episode) => (
                  <li key={episode.id} role="option" aria-selected={view.selectedId === episode.id}>
                    <button
                      type="button"
                      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left ${view.selectedId === episode.id ? 'border-sf-accent bg-sf-accent/10' : 'border-transparent bg-sf-dark-800 hover:border-sf-dark-600'}`}
                      onClick={() => update({ selectedId: episode.id })}
                      data-test={`studio-picker-episode-${episode.id}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{episode.title}</span>
                        <span className="block text-[11px] text-sf-text-muted">{episode.durationLabel} · {t('picker.changed', { ago: episode.changedLabel })}{episode.sizeLabel ? ` · ${episode.sizeLabel}` : ''}</span>
                      </span>
                      {episode.onThisMachine && <Chip tone="accent" data-test="studio-on-this-machine">{t('picker.onThisMachine')}</Chip>}
                      <Chip tone={episode.status.tone}>{episode.status.label}</Chip>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {job && job.episodeId === view.selectedId && <ProgressView job={job} />}
        </div>
      </div>
    </StudioDialog>
  )
}
