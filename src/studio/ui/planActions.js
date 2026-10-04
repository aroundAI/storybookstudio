// FILM-2015: what the AI panel's buttons do. Ask (the instruction box),
// Approve all / Approve scene, Reject, and Fix with AI. Main's FILM-2013
// handlers (window.electronAPI.studio.proposePlan / applyPlan / rejectPlan /
// repair) are used when present. Until FILM-2013 lands, a plan that carries
// its steps (a re-sync proposal, or a plan an MCP client sent with steps) is
// applied here: a new version first, then each step through Velorn's MCP
// action runner with previewOnly:false, so every step is one op-log line with
// its reason (FILM-2012) and the version before the plan stays restorable.
import { stepsForScenes } from './planCards.js'
import { planJournalEntry } from './sessionGuard.js'
import { INSTRUCTION_EXAMPLES, instructionToIntent, scopeArgument } from './instructions.js'

const NOT_AVAILABLE = 'The in-app agent is not available yet (FILM-2013). Plans from an external MCP client still appear here.'

const messageOf = (answer, fallback) => {
  if (answer?.code === 'TARGET_CHANGED') return `${answer.error || 'The timeline changed since the plan was prepared.'} Ask again to re-plan on the current timeline.`
  return answer?.error || fallback
}

export async function proposeInstruction({ store, api = globalThis.window?.electronAPI, instruction }) {
  const text = String(instruction || '').trim()
  const { patch, scope } = store.getState()
  if (!text) return { ok: false }
  if (typeof api?.studio?.proposePlan !== 'function' && typeof api?.studio?.callCapability === 'function') {
    return previewThroughCapability({ store, api, text, scope })
  }
  if (typeof api?.studio?.proposePlan !== 'function') {
    patch({ panelError: NOT_AVAILABLE })
    return { ok: false, code: 'VALIDATION_FAILED' }
  }
  patch({ panelError: null, pending: { instruction: text, planId: null, startedAt: new Date().toISOString() } })
  try {
    const answer = await api.studio.proposePlan({ instruction: text, scope: scope ? { scenes: scope.scenes, clipIds: scope.clipIds } : null })
    if (!answer?.success) {
      patch({ pending: null, panelError: messageOf(answer, 'The plan could not be prepared.') })
      return { ok: false, code: answer?.code }
    }
    // The cards arrive on studio:plan-proposed; the editor stays usable meanwhile.
    patch((state) => (state.pending ? { pending: { ...state.pending, planId: answer.planId ?? null } } : {}))
    return { ok: true, planId: answer.planId ?? null }
  } catch (error) {
    patch({ pending: null, panelError: error?.message || String(error) })
    return { ok: false }
  }
}

// FILM-2013: studio_edit previewOnly:true compiles the intent on the live
// document and emits the cards on studio:plan-proposed (often before it
// answers); the pending entry carries the user's words onto them.
async function previewThroughCapability({ store, api, text, scope }) {
  const { patch } = store.getState()
  const mapped = instructionToIntent(text)
  if (!mapped) {
    patch({ panelError: `I can only turn a few requests into edits so far. Try \u201c${INSTRUCTION_EXAMPLES.join('\u201d, \u201c')}\u201d.` })
    return { ok: false, code: 'VALIDATION_FAILED' }
  }
  patch({ panelError: null, pending: { instruction: text, planId: null, startedAt: new Date().toISOString() } })
  // params.instruction: FILM-2013 keeps the user's words as the plan's and the version's prompt.
  const answer = parseCapabilityResult(await api.studio.callCapability('studio_edit', { intent: mapped.intent, scope: scopeArgument(scope), params: { ...mapped.params, instruction: text }, previewOnly: true }))
  if (!answer.success) {
    patch({ pending: null, panelError: messageOf(answer, 'The plan could not be prepared.') })
    return { ok: false, code: answer.code }
  }
  patch((state) => (state.pending ? { pending: { ...state.pending, planId: answer.planId ?? null } } : {}))
  return { ok: true, planId: answer.planId ?? null }
}

// "Plan with these lines dropped": the compiler's approveWith call (a new
// preview with the second tier included); its cards arrive as a new plan.
export async function askWithProposal({ store, api = globalThis.window?.electronAPI, plan, proposal }) {
  const { patch } = store.getState()
  const call = proposal?.approveWith
  if (!call?.tool || typeof api?.studio?.callCapability !== 'function') {
    patch({ panelError: NOT_AVAILABLE })
    return { ok: false, code: 'VALIDATION_FAILED' }
  }
  patch({ panelError: null, pending: { instruction: `${plan.instruction} (${proposal.title.replace(/^Needs your OK: /, '')})`, planId: null, startedAt: new Date().toISOString() } })
  const answer = parseCapabilityResult(await api.studio.callCapability(call.tool, call.arguments))
  if (!answer.success) {
    patch({ pending: null, panelError: messageOf(answer, 'The plan could not be prepared.') })
    return { ok: false, code: answer.code }
  }
  patch((state) => (state.pending ? { pending: { ...state.pending, planId: answer.planId ?? null } } : {}))
  return { ok: true, planId: answer.planId ?? null }
}

async function applyLocally({ plan, scenes, runner }) {
  const steps = stepsForScenes(plan, scenes)
  if (steps.length === 0) return { success: false, error: 'This plan has nothing to apply here.' }
  const journal = planJournalEntry({ planId: plan.planId, instruction: plan.instruction, parentVersionId: runner.currentVersionId?.() ?? null })
  await runner.writeJournal?.(journal)
  const version = await runner.createVersion(plan.instruction, { prompt: plan.instruction, by: 'ai' })
  await runner.writeJournal?.({ ...journal, versionId: version.id })
  for (const step of steps) {
    try {
      const result = await runner.runStep(step.tool, step.arguments)
      if (result && result.success === false) throw new Error(result.errors?.map((entry) => entry.error).join(' ') || `${step.tool} was refused.`)
    } catch (error) {
      return { success: false, error: `${step.tool} failed: ${error?.message || error}`, versionId: version.id, partial: true }
    }
  }
  await runner.writeJournal?.({ ...journal, versionId: version.id, status: 'done' })
  return { success: true, versionId: version.id }
}

// A capability tool's MCP result: {isError, content:[{type:'text', text: JSON}]}.
export function parseCapabilityResult(result) {
  let body = null
  try {
    body = JSON.parse(result?.content?.find((part) => part.type === 'text')?.text ?? 'null')
  } catch {
    body = null
  }
  if (result?.isError || body?.error) {
    return { success: false, code: body?.error?.code ?? 'INTERNAL', error: body?.error?.message ?? 'The AI tool failed.' }
  }
  return { success: body?.success !== false, ...body, versionId: body?.version?.id ?? body?.versionId ?? null, error: body?.success === false ? `The plan stopped at step ${body?.failedStep?.step ?? '?'}.` : undefined, partial: body?.applied === 'partial' }
}

// FILM-2013 creates the version and runs the steps in main; the journal
// around the call is what lets a crash in between offer the version before.
async function applyThroughCapability({ store, api, plan, scenes, runner }) {
  const { tool } = plan.capability
  let args = plan.capability.args
  let planId = plan.planId
  if (scenes) {
    // FILM-2013 applies a plan whole: preview it again narrowed to the
    // scenes, then apply that preview. The bridge folds the scoped preview
    // into this card rather than showing it as a second plan.
    if (!plan.capability.scoped) return { success: false, error: 'This plan applies as a whole; use Approve all.' }
    args = { ...args, scope: { scenes } }
    store.getState().patch({ sceneApproval: { parentPlanId: plan.planId, childPlanId: null } })
    const preview = parseCapabilityResult(await api.studio.callCapability(tool, { ...args, previewOnly: true }))
    if (!preview.success) return preview
    planId = preview.planId
    store.getState().patch({ sceneApproval: { parentPlanId: plan.planId, childPlanId: planId } })
  }
  const journal = planJournalEntry({ planId, instruction: plan.instruction, parentVersionId: runner?.currentVersionId?.() ?? null })
  await runner?.writeJournal?.(journal)
  const answer = parseCapabilityResult(await api.studio.callCapability(tool, { ...args, previewOnly: false, planId }))
  if (answer.success) await runner?.writeJournal?.({ ...journal, versionId: answer.versionId, status: 'done' })
  else if (!answer.partial) await runner?.writeJournal?.({ ...journal, status: 'refused' })
  return answer
}

export async function approvePlan({ store, api = globalThis.window?.electronAPI, runner, planId, scenes = null }) {
  const state = store.getState()
  const plan = state.planById(planId)
  if (!plan || plan.status !== 'proposed') return { ok: false }
  state.updatePlan(planId, { status: 'applying', error: null })
  let answer
  try {
    if (plan.capability && typeof api?.studio?.callCapability === 'function') {
      try {
        answer = await applyThroughCapability({ store, api, plan, scenes, runner })
      } finally {
        state.patch({ sceneApproval: null })
      }
    } else if (typeof api?.studio?.applyPlan === 'function') {
      answer = await api.studio.applyPlan({ planId, ...(scenes ? { scenes } : {}) })
    } else {
      answer = await applyLocally({ plan, scenes, runner })
    }
  } catch (error) {
    answer = { success: false, error: error?.message || String(error) }
  }
  if (!answer?.success) {
    if (answer?.partial) {
      state.updatePlan(planId, { status: 'failed', error: answer.error, versionId: answer.versionId })
      state.patch({ recovery: { planId, instruction: plan.instruction, versionId: answer.versionId, versionName: plan.instruction } })
    } else {
      state.updatePlan(planId, { status: 'proposed', error: messageOf(answer, 'The plan could not be applied.') })
    }
    return { ok: false, code: answer?.code }
  }
  const approvedScenes = scenes || plan.cards.map((card) => card.scene).filter((scene) => scene !== null)
  state.updatePlan(planId, { status: 'applied', versionId: answer.versionId ?? null, approvedScenes, report: answer.report ?? plan.report })
  state.patch({ announcement: `Applied “${plan.instruction}”${scenes ? ` to scene ${scenes.join(', ')}` : ''}. Open Review to compare before and after.` })
  return { ok: true, versionId: answer.versionId ?? null }
}

export async function rejectPlan({ store, api = globalThis.window?.electronAPI, planId }) {
  const state = store.getState()
  const plan = state.planById(planId)
  if (!plan || plan.status !== 'proposed') return { ok: false }
  state.updatePlan(planId, { status: 'rejected' })
  state.patch({ announcement: `Rejected “${plan.instruction}”. Nothing was changed.` })
  try {
    await api?.studio?.rejectPlan?.({ planId })
  } catch {
    // Rejecting is local: nothing was applied, whatever main answers.
  }
  return { ok: true }
}

// "Fix with AI" on a QA issue: studio_repair (FILM-2014) previews one plan
// for the issues; its cards arrive on studio:plan-proposed like any other.
export async function repairIssues({ store, api = globalThis.window?.electronAPI, issues }) {
  const { patch } = store.getState()
  if (typeof api?.studio?.callCapability !== 'function') {
    patch({ panelError: 'Fix with AI needs the agent tools, which this window cannot reach.', aiPanelOpen: true })
    return { ok: false, code: 'VALIDATION_FAILED' }
  }
  patch({ panelError: null, aiPanelOpen: true, pending: { instruction: `Fix: ${issues.map((issue) => issue.type).join(', ')}`, planId: null, startedAt: new Date().toISOString() } })
  const answer = parseCapabilityResult(await api.studio.callCapability('studio_repair', { issues, previewOnly: true }))
  if (!answer.success) patch({ pending: null, panelError: messageOf(answer, 'The repair could not be planned.') })
  return { ok: answer.success, planId: answer.planId ?? null }
}
