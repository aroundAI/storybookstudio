// FILM-2011: a plain StoryBook panel (sign in, pick an episode, pull,
// progress, re-sync proposals). FILM-2015 replaces it with the real Welcome
// and picker screens over the same window.electronAPI.studio calls.
import { useEffect, useState } from 'react'
import useProjectStore from '../../stores/projectStore'
import { startCloudOpenBridge } from '../../studio/cloudOpen'

const api = () => globalThis.window?.electronAPI?.studio

const PHASE_LABELS = {
  queued: 'Queued',
  session: 'Opening the edit session',
  package: 'Reading the episode',
  download: 'Downloading media',
  probe: 'Checking media',
  build: 'Building the rough cut',
  done: 'Open',
}

const formatBytes = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round((bytes || 0) / 1e3)} kB`)

const INITIAL = {
  open: false,
  apiOrigin: '',
  status: { signedIn: false },
  token: '',
  busy: false,
  error: null,
  projects: [],
  projectId: '',
  episodes: [],
  episodeId: '',
  job: null,
  plan: null,
}

export default function StudioCloudPanel() {
  const [state, setState] = useState(INITIAL)
  const patch = (next) => setState((current) => ({ ...current, ...(typeof next === 'function' ? next(current) : next) }))
  const projectHandle = useProjectStore((store) => store.currentProjectHandle)

  // The IPC bridge: subscriptions to main's studio:* events, for the panel's lifetime.
  useEffect(() => {
    const studio = api()
    if (!studio) return undefined
    const stops = [
      startCloudOpenBridge(),
      studio.onAuthChanged((status) => patch({ status })),
      studio.onJobProgress((job) => patch((current) => (current.job && current.job.id !== job.id ? {} : { job }))),
      studio.onOpenRequest((link) => patch({ open: true, apiOrigin: link.api, episodeId: link.episodeId, error: link.signedIn ? null : 'Sign in to open this episode.' })),
      // studio:plan-proposed also carries FILM-2013's capability-tool plan cards
      // (source 'mcp' or 'in-app'); this panel shows only re-sync proposals.
      studio.onPlanProposed((plan) => {
        if (plan?.source === 'resync' && Array.isArray(plan.steps)) patch({ open: true, plan })
      }),
    ]
    const online = () => studio.networkOnline()
    window.addEventListener('online', online)
    studio.authStatus().then((answer) => {
      if (answer?.success) patch({ status: answer.status, apiOrigin: answer.apiOrigin || '' })
      studio.rendererReady()
    })
    return () => {
      window.removeEventListener('online', online)
      stops.forEach((stop) => stop?.())
    }
  }, [])

  // A pulled project carries storybook/session.json: attach its session (events, re-sync).
  useEffect(() => {
    const studio = api()
    if (!studio) return
    if (typeof projectHandle === 'string') studio.projectOpened({ projectPath: projectHandle })
    else studio.projectClosed()
  }, [projectHandle])

  const run = async (fn) => {
    patch({ busy: true, error: null })
    try {
      const answer = await fn()
      if (answer && answer.success === false) patch({ error: answer.role ? `${answer.error} (your role: ${answer.role})` : answer.error })
      return answer
    } finally {
      patch({ busy: false })
    }
  }

  const loadProjects = () =>
    run(async () => {
      const answer = await api().listProjects({ apiOrigin: state.apiOrigin })
      if (answer.success) patch({ projects: answer.result.projects || [] })
      return answer
    })

  const loadEpisodes = (projectId) =>
    run(async () => {
      patch({ projectId, episodes: [] })
      const answer = await api().listEpisodes({ apiOrigin: state.apiOrigin, projectId })
      if (answer.success) patch({ episodes: answer.result.episodes || [] })
      return answer
    })

  const signIn = (method) =>
    run(async () => {
      const answer = await api().signIn({ apiOrigin: state.apiOrigin, method, token: state.token, redirect: 'loopback' })
      if (answer.success) {
        patch({ status: answer.status, token: '' })
        await loadProjects()
      }
      return answer
    })

  const pull = () =>
    run(async () => {
      const answer = await api().pull({ apiOrigin: state.apiOrigin, episodeId: state.episodeId })
      if (answer.success) patch({ job: { id: answer.jobId, phase: 'queued', done: 0, total: 0, bytes: 0, status: 'running' } })
      return answer
    })

  const { status, job } = state
  const percent = job?.total ? Math.round((job.done / job.total) * 100) : 0

  return (
    <div className="fixed bottom-14 right-4 z-[60] text-xs text-sf-text-primary" data-test="studio-cloud">
      {!state.open ? (
        <button type="button" data-test="studio-cloud-toggle" className="rounded-md bg-sf-dark-800 border border-sf-dark-600 px-3 py-1.5 shadow-lg hover:bg-sf-dark-700" onClick={() => patch({ open: true })}>
          StoryBook{status.signedIn ? ` · ${status.team?.name || 'signed in'}` : ''}
        </button>
      ) : (
        <div className="w-80 max-h-[70vh] overflow-y-auto rounded-lg bg-sf-dark-900 border border-sf-dark-600 shadow-2xl p-3 space-y-3" data-test="studio-cloud-panel">
          <div className="flex items-center justify-between">
            <span className="font-semibold">StoryBook</span>
            <button type="button" className="text-sf-text-secondary hover:text-sf-text-primary" onClick={() => patch({ open: false })}>Close</button>
          </div>

          {!status.signedIn ? (
            <div className="space-y-2" data-test="studio-cloud-signin">
              <label className="block">
                <span className="text-sf-text-secondary">StoryBook address</span>
                <input data-test="studio-cloud-api" className="mt-1 w-full rounded bg-sf-dark-800 border border-sf-dark-600 px-2 py-1" placeholder="https://app.example.com" value={state.apiOrigin} onChange={(e) => patch({ apiOrigin: e.target.value })} />
              </label>
              <button type="button" data-test="studio-cloud-signin-browser" disabled={state.busy || !state.apiOrigin} className="w-full rounded bg-sf-accent px-2 py-1.5 text-white disabled:opacity-50" onClick={() => signIn('browser')}>Sign in with the browser</button>
              <div className="flex gap-1">
                <input data-test="studio-cloud-token" type="password" className="flex-1 rounded bg-sf-dark-800 border border-sf-dark-600 px-2 py-1" placeholder="or paste sbk_pat_…" value={state.token} onChange={(e) => patch({ token: e.target.value })} />
                <button type="button" data-test="studio-cloud-signin-token" disabled={state.busy || !state.token || !state.apiOrigin} className="rounded bg-sf-dark-700 px-2 disabled:opacity-50" onClick={() => signIn('token')}>Use token</button>
              </div>
              {status.message && <p className="text-amber-400">{status.message}</p>}
            </div>
          ) : (
            <div className="space-y-2" data-test="studio-cloud-picker">
              <div className="flex items-center justify-between text-sf-text-secondary">
                <span data-test="studio-cloud-who">{status.user?.email || status.user?.name} · {status.team?.name}</span>
                <button type="button" className="hover:text-sf-text-primary" onClick={() => run(async () => { const a = await api().signOut({ apiOrigin: state.apiOrigin }); if (a.success) patch({ status: a.status, projects: [], episodes: [] }); return a })}>Sign out</button>
              </div>
              <button type="button" data-test="studio-cloud-load-projects" disabled={state.busy} className="w-full rounded bg-sf-dark-700 px-2 py-1" onClick={loadProjects}>Load projects</button>
              {state.projects.length > 0 && (
                <select data-test="studio-cloud-project" className="w-full rounded bg-sf-dark-800 border border-sf-dark-600 px-2 py-1" value={state.projectId} onChange={(e) => loadEpisodes(e.target.value)}>
                  <option value="">Choose a project</option>
                  {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
              {state.episodes.length > 0 && (
                <ul className="space-y-1" data-test="studio-cloud-episodes">
                  {state.episodes.map((e) => (
                    <li key={e.id}>
                      <button type="button" data-test={`studio-cloud-episode-${e.id}`} className={`w-full text-left rounded px-2 py-1 ${state.episodeId === e.id ? 'bg-sf-accent/30 border border-sf-accent' : 'bg-sf-dark-800'}`} onClick={() => patch({ episodeId: e.id })}>
                        #{e.number} {e.title} <span className="text-sf-text-secondary">· {e.status}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {state.episodeId && (
                <div className="space-y-1">
                  <div className="text-sf-text-secondary break-all" data-test="studio-cloud-selected">Episode {state.episodeId}</div>
                  <button type="button" data-test="studio-cloud-pull" disabled={state.busy || job?.status === 'running'} className="w-full rounded bg-sf-accent px-2 py-1.5 text-white disabled:opacity-50" onClick={pull}>Open in Studio</button>
                </div>
              )}
            </div>
          )}

          {job && (
            <div className="space-y-1" data-test="studio-cloud-job" data-phase={job.phase} data-status={job.status}>
              <div className="flex justify-between">
                <span>{job.status === 'failed' ? 'Failed' : PHASE_LABELS[job.phase] || job.phase}</span>
                <span className="text-sf-text-secondary">{job.total ? `${job.done}/${job.total}` : ''} {job.bytes ? formatBytes(job.bytes) : ''}</span>
              </div>
              <div className="h-1.5 rounded bg-sf-dark-700"><div className="h-1.5 rounded bg-sf-accent" style={{ width: `${job.status === 'done' ? 100 : percent}%` }} /></div>
              {job.error && <p className="text-red-400" data-test="studio-cloud-job-error">{job.error}</p>}
              {job.result?.warnings?.length > 0 && <p className="text-amber-400">{job.result.warnings.length} warning(s): {job.result.warnings.slice(0, 2).join(' ')}</p>}
            </div>
          )}

          {state.plan && (
            <div className="space-y-1" data-test="studio-cloud-plan">
              <div className="font-semibold">StoryBook changed: {state.plan.summary}</div>
              <ol className="list-decimal pl-4 space-y-0.5">
                {state.plan.steps.map((step, i) => <li key={i}>{step.reason} <span className="text-sf-text-secondary">({step.tool})</span></li>)}
              </ol>
              <p className="text-sf-text-secondary">Proposed only; nothing is applied until you approve it.</p>
            </div>
          )}

          {state.error && <p className="text-red-400" data-test="studio-cloud-error">{state.error}</p>}
        </div>
      )}
    </div>
  )
}
