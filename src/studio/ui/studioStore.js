// FILM-2015: the Studio UI's state, shared by the five surfaces. A vanilla
// zustand store so the bridge and the plan actions run under node --test;
// components read it with useStudioUi(). It never holds a token: auth is the
// status main reports (signed in, user, team), nothing more (contract S2).
import { createStore } from 'zustand/vanilla'

export const INITIAL_STUDIO_UI_STATE = Object.freeze({
  auth: { signedIn: false },
  apiOrigin: '',
  allowedOrigins: [],
  projectsRoot: null,
  pickerOpen: false,
  openRequest: null,
  job: null,
  plans: [],
  pending: null,
  panelError: null,
  aiPanelOpen: false,
  announcement: '',
  scope: null,
  sceneHeadings: new Map(),
  pkg: null,
  policy: null,
  link: null,
  review: null,
  deliverOpen: false,
  delivery: null,
  qaAnnouncement: '',
  prompt: null,
  recovery: null,
  sceneApproval: null,
  updates: {},
})

export function createStudioUiStore() {
  return createStore((set, get) => ({
    ...INITIAL_STUDIO_UI_STATE,
    sceneHeadings: new Map(),
    patch: (next) => set(typeof next === 'function' ? next(get()) : next),
    setScope: (scope) => set({ scope }),
    upsertPlan: (plan) => set((state) => {
      const index = state.plans.findIndex((candidate) => candidate.planId === plan.planId)
      const plans = [...state.plans]
      const applied = plan.phase === 'applied'
      if (index >= 0 && applied) {
        // An apply (here or by an MCP client) keeps the cards the user saw.
        plans[index] = { ...plans[index], status: 'applied', versionId: plan.versionId ?? plans[index].versionId, reportText: plan.reportText ?? plans[index].reportText, error: null }
      } else if (index >= 0) {
        plans[index] = { ...plans[index], ...plan, status: 'proposed', error: null }
      } else {
        plans.push({ ...plan, status: applied ? 'applied' : 'proposed', error: null, approvedScenes: [] })
      }
      return { plans }
    }),
    updatePlan: (planId, patch) => set((state) => ({
      plans: state.plans.map((plan) => (plan.planId === planId ? { ...plan, ...patch } : plan)),
    })),
    planById: (planId) => get().plans.find((plan) => plan.planId === planId) || null,
    reset: () => set({ ...INITIAL_STUDIO_UI_STATE, sceneHeadings: new Map() }),
  }))
}

export const studioUiStore = createStudioUiStore()
