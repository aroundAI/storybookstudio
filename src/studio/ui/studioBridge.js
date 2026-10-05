// FILM-2015: the renderer's half of FILM-2011's studio:* IPC. Subscribes to
// main's events for the app's lifetime, feeds the studio store, and calls
// rendererReady only once every listener is attached (main holds storybookstudio://
// links until then). Replaces FILM-2011's placeholder panel's wiring.
import { normalizePlan, planAnnouncement } from './planCards.js'
import { pendingWorkPrompt } from './sessionGuard.js'

const DELIVERY_PHASES = { render: 'rendering', qa: 'rendering', prepare: 'rendering', upload: 'uploading', finalize: 'uploading', deliver: 'uploading' }

// FILM-2017's deliver job (studio:job-progress, kind 'deliver'): the screen's
// delivery state, each file's QA, and one announcement when QA is in.
function deliveryProgress(state, job) {
  if (!state.delivery || state.delivery.jobId !== job.id) return {}
  const base = { ...state.delivery, phase: job.phase, done: job.done, total: job.total }
  if (job.status === 'failed') {
    const failed = { ...base, status: 'failed', error: job.error || 'The delivery failed.', code: job.failure?.code ?? null }
    // QA_FAILED names the file and carries its QA: show it, with its issues.
    const { render, qa } = job.failure?.details || {}
    if (job.failure?.code !== 'QA_FAILED' || !render || !qa) return { delivery: failed }
    const count = (qa.issues || []).length
    return {
      delivery: { ...failed, qa: { ...(state.delivery.qa || {}), [render]: qa } },
      qaAnnouncement: `QA stopped the delivery: ${render} has ${count} issue${count === 1 ? '' : 's'}.`,
    }
  }
  if (job.status !== 'done') return { delivery: { ...base, status: DELIVERY_PHASES[job.phase] || 'sending' } }
  // A StoryBook delivery lists its files as renders; an export to a folder as files.
  const renders = job.result?.renders || job.result?.files || []
  const qa = Object.fromEntries(renders.filter((render) => render.qa).map((render) => [`${render.preset}-${render.language}`, render.qa]))
  const failing = Object.values(qa).filter((result) => !result.pass).length
  const exported = job.result?.destination === 'folder'
  return {
    delivery: { ...base, status: exported ? 'exported' : 'sent', result: job.result, qa },
    qaAnnouncement: renders.length ? `QA checked ${renders.length} file${renders.length === 1 ? '' : 's'}: ${failing ? `${failing} with issues` : 'all passed'}.` : state.qaAnnouncement,
  }
}

export function startStudioUiBridge({ api = globalThis.window?.electronAPI, store, startPullBridge = null, target = globalThis.window } = {}) {
  const studio = api?.studio
  if (!studio || !store) return () => {}
  const { patch } = store.getState()
  const stops = []
  if (typeof startPullBridge === 'function') stops.push(startPullBridge())

  stops.push(studio.onAuthChanged((auth) => patch({ auth: auth || { signedIn: false } })))
  stops.push(studio.onJobProgress((job) => patch((state) => {
    if (job.kind === 'deliver') return deliveryProgress(state, job)
    if (state.job && state.job.id !== job.id) return {}
    // The builder has opened the project once the pull is done: land in the editor.
    return job.status === 'done' ? { job, pickerOpen: false, openRequest: null } : { job }
  })))
  stops.push(studio.onOpenRequest((link) => patch({
    pickerOpen: true,
    openRequest: { episodeId: link.episodeId, api: link.api, signedIn: Boolean(link.signedIn) },
    apiOrigin: link.api || store.getState().apiOrigin,
  })))
  stops.push(studio.onPlanProposed((payload) => {
    const plan = normalizePlan(payload, { sceneHeadings: store.getState().sceneHeadings, receivedAt: new Date().toISOString() })
    if (!plan) return
    // "Approve scene" previews the plan again for one scene and applies that
    // preview; it belongs to the card the user approved, not a new plan.
    const { sceneApproval } = store.getState()
    if (sceneApproval && (plan.planId === sceneApproval.childPlanId || (!sceneApproval.childPlanId && plan.phase === 'proposed'))) {
      if (!sceneApproval.childPlanId) patch({ sceneApproval: { ...sceneApproval, childPlanId: plan.planId } })
      return
    }
    // The cards of the user's own request show the user's words.
    const { pending } = store.getState()
    const mine = pending && plan.phase === 'proposed' && (pending.planId === plan.planId || (!pending.planId && plan.source === 'agent'))
    if (mine && !payload.instruction) plan.instruction = pending.instruction
    store.getState().upsertPlan(plan)
    const stored = store.getState().planById(plan.planId)
    patch((state) => ({
      aiPanelOpen: true,
      announcement: plan.phase === 'applied'
        ? `Applied \u201c${stored?.instruction || plan.instruction}\u201d. Open Review to compare before and after.`
        : planAnnouncement(plan),
      pending: mine ? null : state.pending,
      updates: plan.source === 'resync' ? { ...state.updates, current: plan.planId } : state.updates,
    }))
  }))

  // App quit with work in flight: main holds the close until the user answers.
  if (studio.onCloseRequested) {
    stops.push(studio.onCloseRequested(() => {
      const state = store.getState()
      const prompt = pendingWorkPrompt({ plans: state.plans, delivery: state.delivery }, 'quit')
      if (!prompt) {
        studio.confirmQuit?.()
        return
      }
      patch({ prompt: { ...prompt, resolve: (confirmed) => {
        patch({ prompt: null })
        if (confirmed) studio.confirmQuit?.()
      } } })
    }))
  }
  // Tell main whether quitting now would lose anything.
  let pendingNow = false
  stops.push(store.subscribe((state) => {
    const pending = Boolean(pendingWorkPrompt({ plans: state.plans, delivery: state.delivery }))
    if (pending === pendingNow) return
    pendingNow = pending
    studio.setPendingWork?.({ pending })
  }))

  const online = () => studio.networkOnline?.()
  target?.addEventListener?.('online', online)

  let stopped = false
  Promise.resolve(studio.authStatus?.())
    .then((answer) => {
      if (stopped || !answer?.success) return
      patch({
        auth: answer.status || { signedIn: false },
        apiOrigin: answer.apiOrigin || '',
        allowedOrigins: answer.allowedOrigins || [],
        projectsRoot: answer.projectsRoot || null,
      })
    })
    .catch(() => {})
    .finally(() => {
      if (!stopped) studio.rendererReady?.()
    })

  return () => {
    stopped = true
    target?.removeEventListener?.('online', online)
    for (const stop of stops) {
      try {
        stop?.()
      } catch {
        // a listener that is already gone
      }
    }
  }
}
