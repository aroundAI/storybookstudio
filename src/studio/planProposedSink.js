// Where studio:plan-proposed lands until FILM-2015's AI panel renders it:
// the last plans proposed or applied, from an MCP client or the in-app agent
// alike, kept for the panel to read and logged to the console.
const MAX_KEPT = 20
const proposals = []
const listeners = new Set()

export const getRecentPlanProposals = () => [...proposals]

export function subscribePlanProposals(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function recordPlanProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') return
  proposals.unshift(proposal)
  proposals.length = Math.min(proposals.length, MAX_KEPT)
  for (const listener of listeners) {
    try { listener(proposal) } catch { /* a broken listener does not stop the others */ }
  }
  const scenes = (proposal.cards || []).map((card) => (card.scene === null ? 'timeline' : `scene ${card.scene}`)).join(', ')
  console.info(`[Studio] plan ${proposal.phase} by ${proposal.source}: ${proposal.intent} (${scenes || 'no changes'})`)
}

export function startPlanProposedSink(api = globalThis.window?.electronAPI?.studio) {
  if (!api?.onPlanProposed) return () => {}
  return api.onPlanProposed(recordPlanProposal)
}
