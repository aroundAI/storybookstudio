// FILM-2015: what closing a project or quitting must not lose. A plan waiting
// for approval, a plan being applied and a delivery in flight each prompt.
// While a plan is applied, a journal (edits/plan-journal.json) records it, so
// a crash mid-apply reopens at the last autosave with "Return to version
// before plan" offered: the version the apply created holds the document as
// it stood before the plan's first step (FILM-2012 versions). Pure module.

export const PLAN_JOURNAL_PATH = 'edits/plan-journal.json'

const DELIVERY_IN_FLIGHT = new Set(['confirming', 'rendering', 'uploading', 'sending'])

export function pendingWorkPrompt({ plans = [], delivery = null } = {}, intent = 'close') {
  const reasons = []
  for (const plan of plans) {
    if (plan.status === 'proposed') reasons.push(`The plan “${plan.instruction || 'AI plan'}” has not been approved. It will be discarded.`)
    if (plan.status === 'applying') reasons.push(`The plan “${plan.instruction || 'AI plan'}” is being applied. Stopping now leaves it half applied; you can return to the version before it.`)
  }
  if (delivery && DELIVERY_IN_FLIGHT.has(delivery.status)) {
    reasons.push(`A delivery to StoryBook is still ${delivery.status === 'rendering' ? 'rendering' : 'sending'}. ${intent === 'quit' ? 'Quitting' : 'Closing'} stops it; finished files are kept and you can send again.`)
  }
  if (reasons.length === 0) return null
  return {
    title: intent === 'quit' ? 'Quit with work in progress?' : 'Close the project with work in progress?',
    reasons,
    confirmLabel: intent === 'quit' ? 'Quit anyway' : 'Close anyway',
    cancelLabel: 'Keep working',
  }
}

export function planJournalEntry({ planId, instruction, parentVersionId = null, versionId = null, startedAt = new Date().toISOString(), status = 'applying' }) {
  return { planId, instruction: instruction ?? null, parentVersionId, versionId, startedAt, status }
}

export function recoveryOffer({ journal, versions = [] }) {
  if (!journal || journal.status !== 'applying') return null
  const started = Date.parse(journal.startedAt || '') || 0
  const version = journal.versionId
    ? versions.find((candidate) => candidate.id === journal.versionId)
    : versions.find((candidate) => candidate.createdBy === 'ai' && (Date.parse(candidate.createdAt || '') || 0) >= started)
  if (!version) return null
  return { planId: journal.planId, instruction: journal.instruction, versionId: version.id, versionName: version.name }
}
