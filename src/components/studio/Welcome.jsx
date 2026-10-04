// FILM-2015 Welcome: start from StoryBook or from a project on this machine.
// Signed in: "Open from StoryBook" opens the episode picker. Signed out:
// "Sign in with StoryBook" (browser, PKCE, FILM-2011) or "Paste a token".
// Recent projects show their StoryBook episode and "Updates available" when a
// re-sync plan is waiting. Velorn's own start screen stays one click away.
import { useEffect, useState } from 'react'
import { BookOpen, FolderOpen, LogOut, RefreshCw } from 'lucide-react'
import WelcomeScreen from '../WelcomeScreen'
import useProjectStore from '../../stores/projectStore'
import { studioUiStore } from '../../studio/ui/studioStore'
import { projectFoldersIn, readLocalLink } from '../../studio/ui/studioRuntime'
import { formatAgo } from '../../studio/ui/pickerModel'
import { Chip, StudioButton } from './StudioDialog'
import { studioApi, useStudioText, useStudioUi } from './studioUi'

export function SignInForm({ compact = false }) {
  const t = useStudioText()
  const apiOrigin = useStudioUi((state) => state.apiOrigin)
  const auth = useStudioUi((state) => state.auth)
  const [form, setForm] = useState({ address: apiOrigin || '', token: '', showToken: false, busy: null, error: null })
  const update = (next) => setForm((current) => ({ ...current, ...next }))
  const address = form.address || apiOrigin

  const signIn = async (method) => {
    update({ busy: method, error: null })
    try {
      const answer = await studioApi()?.signIn({ apiOrigin: address, method, token: method === 'token' ? form.token : undefined, redirect: 'loopback' })
      if (!answer?.success) {
        update({ error: answer?.error || t('signIn.failed') })
        return
      }
      studioUiStore.getState().patch({ auth: answer.status, apiOrigin: address })
      update({ token: '', showToken: false })
    } finally {
      update({ busy: null })
    }
  }

  return (
    <form className="space-y-3" data-test="studio-signin" onSubmit={(event) => { event.preventDefault(); signIn(form.showToken ? 'token' : 'browser') }}>
      <label className="block text-xs">
        <span className="text-sf-text-secondary">{t('signIn.address')}</span>
        <input
          data-test="studio-signin-address"
          className="mt-1 w-full rounded-md border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-sm text-sf-text-primary focus:border-sf-accent focus:outline-none"
          placeholder="https://app.example.com"
          value={address}
          onChange={(event) => update({ address: event.target.value })}
          autoComplete="url"
        />
      </label>
      <StudioButton tone="primary" className={`w-full py-2 text-sm ${compact ? '' : ''}`} data-test="studio-signin-browser" disabled={!address || Boolean(form.busy)} onClick={() => signIn('browser')}>
        {form.busy === 'browser' ? t('signIn.waitingForBrowser') : t('signIn.withStoryBook')}
      </StudioButton>
      {!form.showToken ? (
        <button type="button" className="w-full text-center text-xs text-sf-text-secondary underline-offset-2 hover:text-sf-text-primary hover:underline" data-test="studio-signin-paste-toggle" onClick={() => update({ showToken: true })}>
          {t('signIn.pasteToken')}
        </button>
      ) : (
        <div className="space-y-2">
          <label className="block text-xs">
            <span className="text-sf-text-secondary">{t('signIn.tokenLabel')}</span>
            <input
              data-test="studio-signin-token"
              type="password"
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-sm focus:border-sf-accent focus:outline-none"
              placeholder="sbk_pat_…"
              value={form.token}
              onChange={(event) => update({ token: event.target.value })}
            />
          </label>
          <StudioButton className="w-full py-2" data-test="studio-signin-token-submit" disabled={!address || !form.token || Boolean(form.busy)} onClick={() => signIn('token')}>
            {form.busy === 'token' ? t('signIn.checking') : t('signIn.useToken')}
          </StudioButton>
          <p className="text-[11px] text-sf-text-muted">{t('signIn.tokenNote')}</p>
        </div>
      )}
      {(form.error || auth.message) && <p role="alert" className="text-xs text-sf-error" data-test="studio-signin-error">{form.error || auth.message}</p>}
    </form>
  )
}

function SignedInCard() {
  const t = useStudioText()
  const auth = useStudioUi((state) => state.auth)
  const apiOrigin = useStudioUi((state) => state.apiOrigin)
  const signOut = async () => {
    const answer = await studioApi()?.signOut({ apiOrigin })
    if (answer?.success) studioUiStore.getState().patch({ auth: answer.status })
  }
  return (
    <div className="space-y-4" data-test="studio-welcome-signed-in">
      <p className="text-sm text-sf-text-secondary" data-test="studio-welcome-who">
        {t('welcome.signedInAs', { who: auth.user?.email || auth.user?.name || '', team: auth.team?.name || '' })}
      </p>
      <StudioButton tone="primary" className="w-full py-2.5 text-sm" data-test="studio-open-from-storybook" onClick={() => studioUiStore.getState().patch({ pickerOpen: true })}>
        <BookOpen className="mr-2 inline h-4 w-4" aria-hidden />
        {t('welcome.openFromStoryBook')}
      </StudioButton>
      <button type="button" className="inline-flex items-center gap-1 text-xs text-sf-text-muted hover:text-sf-text-primary" onClick={signOut} data-test="studio-sign-out">
        <LogOut className="h-3 w-3" aria-hidden /> {t('welcome.signOut')}
      </button>
    </div>
  )
}

function RecentProjects({ onOpen }) {
  const t = useStudioText()
  const recentProjects = useProjectStore((state) => state.recentProjects)
  const projectsRoot = useStudioUi((state) => state.projectsRoot)
  const [scan, setScan] = useState({ links: new Map(), pulled: [] })

  // The badges read each project's storybook/ files. Episodes pulled into the
  // Studio's projects folder are listed too: Velorn writes its recent list
  // lazily, so after a crash the project being edited may be missing from it.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const links = new Map()
      for (const project of recentProjects) {
        if (typeof project.path !== 'string') continue
        const link = await readLocalLink(project.path)
        if (link) links.set(project.path, link)
      }
      const pulled = []
      for (const folder of await projectFoldersIn(projectsRoot)) {
        if (links.has(folder) || recentProjects.some((project) => project.path === folder)) continue
        const link = await readLocalLink(folder)
        if (!link) continue
        links.set(folder, link)
        pulled.push({ name: link.title || folder.split('/').pop(), path: folder, modified: null, pulled: true })
      }
      if (!cancelled) setScan({ links, pulled })
    })()
    return () => { cancelled = true }
  }, [recentProjects, projectsRoot])

  const { links } = scan
  const projects = [...recentProjects, ...scan.pulled]
  if (projects.length === 0) return <p className="text-sm text-sf-text-muted">{t('welcome.noRecent')}</p>
  return (
    <ul className="divide-y divide-sf-dark-700 overflow-hidden rounded-lg border border-sf-dark-700" data-test="studio-recent-projects">
      {projects.map((project) => {
        const link = links.get(project.path)
        return (
          <li key={project.path || project.name}>
            <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-sf-dark-800 focus:bg-sf-dark-800 focus:outline-none" onClick={() => onOpen(project)} data-test="studio-recent-project">
              <FolderOpen className="h-4 w-4 flex-shrink-0 text-sf-text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-sf-text-primary">{project.name}</span>
                <span className="block truncate text-[11px] text-sf-text-muted">{link?.title ? `${t('welcome.fromStoryBook')} · ${link.title}` : project.path}{project.modified ? ` · ${formatAgo(project.modified)}` : ''}</span>
              </span>
              {link?.updatesAvailable && <Chip tone="warn" data-test="studio-updates-badge"><RefreshCw className="h-3 w-3" aria-hidden />{t('welcome.updatesAvailable')}</Chip>}
              {link && !link.updatesAvailable && <Chip tone="neutral">StoryBook</Chip>}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export default function Welcome() {
  const t = useStudioText()
  const signedIn = useStudioUi((state) => Boolean(state.auth?.signedIn))
  const openRecentProject = useProjectStore((state) => state.openRecentProject)
  const openProject = useProjectStore((state) => state.openProject)
  const [showVelornStart, setShowVelornStart] = useState(false)

  if (showVelornStart) {
    return (
      <>
        <WelcomeScreen />
        <StudioButton className="fixed bottom-4 left-4 z-[70] shadow-lg" onClick={() => setShowVelornStart(false)} data-test="studio-back-to-welcome">
          {t('welcome.backToStoryBook')}
        </StudioButton>
      </>
    )
  }

  return (
    <main className="flex h-screen flex-col bg-sf-dark-950 text-sf-text-primary" data-test="studio-welcome">
      <div className="mx-auto grid w-full max-w-5xl flex-1 grid-cols-1 gap-10 overflow-y-auto px-8 py-14 md:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <section aria-labelledby="studio-welcome-title" className="space-y-6">
          <div>
            <h1 id="studio-welcome-title" className="text-2xl font-semibold tracking-tight">StorybookStudio</h1>
            <p className="mt-2 text-sm leading-relaxed text-sf-text-secondary">{t('welcome.lede')}</p>
          </div>
          <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900 p-5">
            <h2 className="mb-4 text-sm font-semibold">{signedIn ? t('welcome.storyBookTitle') : t('signIn.title')}</h2>
            {signedIn ? <SignedInCard /> : <SignInForm />}
          </div>
        </section>
        <section aria-labelledby="studio-recent-title" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 id="studio-recent-title" className="text-sm font-semibold">{t('welcome.recentTitle')}</h2>
            <button type="button" className="text-xs text-sf-text-secondary hover:text-sf-text-primary" onClick={() => setShowVelornStart(true)} data-test="studio-velorn-start">
              {t('welcome.allProjects')}
            </button>
          </div>
          <RecentProjects onOpen={(project) => (project.pulled ? openProject(project.path) : openRecentProject(project))} />
        </section>
      </div>
    </main>
  )
}
