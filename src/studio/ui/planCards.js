// FILM-2015: plan cards, the unit of approval in the AI panel. One card per
// scene names the scene, the duration change and each change with its reason.
// A plan reaches the renderer on studio:plan-proposed from the in-app agent,
// an external MCP client (FILM-2013 cards) or a StoryBook re-sync (FILM-2011
// steps without cards); both shapes normalise here. Pure module.

const MINUS = '−'
const ARROW = '→'

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function formatSeconds(value) {
  const seconds = finite(value)
  return seconds === null ? '—' : `${seconds.toFixed(1)} s`
}

export function formatDurationChange(before, after) {
  if (finite(before) === null && finite(after) === null) return null
  return `${formatSeconds(before)} ${ARROW} ${formatSeconds(after)}`
}

const formatDelta = (before, after) => {
  if (finite(before) === null || finite(after) === null) return null
  const delta = after - before
  if (Math.abs(delta) < 0.05) return '±0.0 s'
  return `${delta < 0 ? MINUS : '+'}${Math.abs(delta).toFixed(1)} s`
}

const sceneTitle = (scene, heading) => {
  if (!Number.isInteger(scene)) return 'Whole episode'
  return heading ? `Scene ${scene} · ${heading}` : `Scene ${scene}`
}

const stepScene = (step) => {
  const scene = step?.scene ?? step?.arguments?.studioMeta?.scene
  return Number.isInteger(scene) ? scene : null
}

const stepClipIds = (step) => {
  const args = step?.arguments || step?.args || {}
  const ids = [args.clipId, ...(Array.isArray(args.clipIds) ? args.clipIds : [])].filter((id) => typeof id === 'string')
  return [...new Set(ids)]
}

// Re-sync and other step-only proposals: group steps by scene, and steps that
// share a reason (import the new file, then replace the clip) into one change.
function cardsFromSteps(steps, sceneHeadings) {
  const byScene = new Map()
  for (const step of steps) {
    const scene = stepScene(step)
    if (!byScene.has(scene)) byScene.set(scene, new Map())
    const reason = String(step.reason || step.arguments?.studioMeta?.reason || step.tool || 'Change')
    const changes = byScene.get(scene)
    if (!changes.has(reason)) changes.set(reason, { text: reason, reason, clipIds: [] })
    const change = changes.get(reason)
    change.clipIds = [...new Set([...change.clipIds, ...stepClipIds(step)])]
  }
  const order = [...byScene.keys()].sort((a, b) => (a ?? Infinity) - (b ?? Infinity))
  return order.map((scene) => ({
    scene,
    heading: sceneHeadings.get(scene) ?? null,
    durationBefore: null,
    durationAfter: null,
    changes: [...byScene.get(scene).values()],
  }))
}

const normalizeChange = (change) => ({
  text: String(change?.text ?? change?.change ?? change?.target ?? 'Change'),
  reason: String(change?.reason ?? ''),
  clipIds: Array.isArray(change?.clipIds) ? change.clipIds.filter((id) => typeof id === 'string') : [],
})

// FILM-2013 names the in-app agent 'in-app' and plan-runner calls 'plan'.
const SOURCES = { agent: 'agent', 'in-app': 'agent', mcp: 'mcp', plan: 'mcp', resync: 'resync' }
const APPLY_UPDATES = 'apply_updates'

const intentWords = (intent, params) => {
  if (intent === APPLY_UPDATES) return 'Apply the StoryBook update'
  const words = String(intent).replace(/^(audio|captions):/, '').replace(/_/g, ' ')
  const target = Number.isFinite(params?.targetSeconds) ? ` (target ${params.targetSeconds} s)` : ''
  return `${words[0].toUpperCase()}${words.slice(1)}${target}`
}

// FILM-2013 applies a plan when called again with the arguments it was
// previewed with, plus previewOnly:false and the planId. Its proposal names
// the tool and its key {intent, scope, params}; each tool's own arguments
// come back from that key.
const toolForIntent = (intent) => {
  if (intent === APPLY_UPDATES) return 'studio_apply_updates'
  if (intent === 'repair') return 'studio_repair'
  if (intent.startsWith('audio:')) return 'studio_edit_audio'
  if (intent.startsWith('captions:')) return 'studio_add_captions'
  return 'studio_edit'
}

function capabilityOf(payload, intent) {
  const tool = typeof payload.tool === 'string' ? payload.tool : toolForIntent(intent)
  const scope = payload.scope ?? {}
  const params = payload.params ?? {}
  const args = tool === 'studio_edit' ? { intent, scope, params }
    : tool === 'studio_edit_audio' ? { intent: intent.replace(/^audio:/, ''), scope, params }
      : tool === 'studio_add_captions' ? { language: params.language, ...(params.style ? { style: params.style } : {}) }
        : tool === 'studio_repair' ? { issues: params.issues || [] }
          : {}
  // A scope can be narrowed to one scene for "Approve scene".
  return { tool, args, scoped: tool === 'studio_edit' || tool === 'studio_edit_audio' }
}

const normalizeTouch = (entry) => {
  if (typeof entry === 'string') return { clipId: entry, scene: null, text: `A clip you edited by hand (${entry}) is in this plan.` }
  if (!entry || typeof entry.clipId !== 'string') return null
  return { clipId: entry.clipId, scene: Number.isInteger(entry.scene) ? entry.scene : null, text: String(entry.text || `A clip you edited by hand (${entry.clipId}) is in this plan.`) }
}

// FILM-2013 hit_duration's second tier: lines it would drop to reach the
// target, proposed apart from the plan ("Needs your OK"); approving asks the
// compiler again with the drops included, as a new plan.
const normalizeProposal = (entry) => {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.lines) || !entry.approveWith?.tool) return null
  return {
    kind: String(entry.kind || 'proposal'),
    title: String(entry.title || 'Needs your OK'),
    why: typeof entry.why === 'string' ? entry.why : null,
    durationAfter: finite(entry.durationAfter),
    lines: entry.lines.map((line) => ({
      key: String(line.lineId ?? line.sequenceNumber),
      label: `Scene ${line.scene} · line ${line.sequenceNumber} · ${line.character}`,
      text: String(line.text || ''),
      reason: String(line.reason || ''),
      seconds: finite(line.seconds),
    })),
    approveWith: entry.approveWith,
  }
}

export function normalizePlan(payload, { sceneHeadings = new Map(), receivedAt = null } = {}) {
  if (!payload || typeof payload !== 'object' || typeof payload.planId !== 'string' || !payload.planId) return null
  const intent = typeof payload.intent === 'string' && payload.intent ? payload.intent : null
  const source = intent === APPLY_UPDATES ? 'resync' : SOURCES[payload.source] || 'mcp'
  const capability = intent ? capabilityOf(payload, intent) : null
  const steps = Array.isArray(payload.steps) ? payload.steps : []
  const rawCards = Array.isArray(payload.cards) && payload.cards.length > 0 ? payload.cards : cardsFromSteps(steps, sceneHeadings)
  const touchesUserEdits = (Array.isArray(payload.touchesUserEdits) ? payload.touchesUserEdits : []).map(normalizeTouch).filter(Boolean)
  const touchedScenes = new Set(touchesUserEdits.map((entry) => entry.scene))

  const cards = rawCards.map((card, index) => {
    const scene = Number.isInteger(card?.scene) ? card.scene : null
    const heading = card?.heading ?? sceneHeadings.get(scene) ?? null
    const durationBefore = finite(card?.durationBefore)
    const durationAfter = finite(card?.durationAfter)
    return {
      key: `${scene ?? 'episode'}-${index}`,
      scene,
      heading,
      title: sceneTitle(scene, heading),
      durationBefore,
      durationAfter,
      durationLabel: formatDurationChange(durationBefore, durationAfter),
      deltaLabel: formatDelta(durationBefore, durationAfter),
      changes: (Array.isArray(card?.changes) ? card.changes : []).map(normalizeChange),
      touchesUserEdits: touchedScenes.has(scene),
    }
  })

  const expected = payload.expected && typeof payload.expected === 'object'
    ? { durationBefore: finite(payload.expected.durationBefore), durationAfter: finite(payload.expected.durationAfter) }
    : null
  const instruction = typeof payload.instruction === 'string' && payload.instruction.trim()
    ? payload.instruction.trim()
    : intent
      ? intentWords(intent, payload.params)
      : source === 'resync'
        ? `StoryBook changed: ${payload.summary || 'new material'}`
        : 'AI plan'

  return {
    planId: payload.planId,
    phase: payload.phase === 'applied' ? 'applied' : 'proposed',
    versionId: typeof payload.versionId === 'string' ? payload.versionId : null,
    capability,
    reportText: typeof payload.reportText === 'string' ? payload.reportText : null,
    source,
    instruction,
    summary: typeof payload.summary === 'string' ? payload.summary : null,
    scope: payload.scope && typeof payload.scope === 'object' ? payload.scope : null,
    baseVersionId: typeof payload.baseVersionId === 'string' ? payload.baseVersionId : null,
    expected,
    totalLabel: expected ? formatDurationChange(expected.durationBefore, expected.durationAfter) : null,
    cards,
    touchesUserEdits,
    proposals: (Array.isArray(payload.proposals) ? payload.proposals : []).map(normalizeProposal).filter(Boolean),
    // A card change is one step (FILM-2013 compile.js); step-only plans (re-sync) count their steps.
    hasChanges: cards.some((card) => card.changes.length > 0) || steps.length > 0,
    steps,
    unresolved: (Array.isArray(payload.unresolved) ? payload.unresolved : []).map((entry) => String(entry?.reason || entry)),
    report: payload.report ?? null,
    receivedAt,
  }
}

export function planAnnouncement(plan) {
  if (!plan) return ''
  const scenes = plan.cards.filter((card) => card.scene !== null).length
  const parts = [`${scenes} scene${scenes === 1 ? '' : 's'}`]
  if (plan.totalLabel) parts.push(plan.totalLabel)
  const touches = plan.touchesUserEdits.length > 0 ? ` It touches ${plan.touchesUserEdits.length} of your edits.` : ''
  return `Plan ready for “${plan.instruction}”: ${parts.join(', ')}.${touches} Review the cards to approve.`
}

// The steps to run for an approval: all of them, or those of the chosen
// scenes; previews become applies. The payload is never mutated.
export function stepsForScenes(plan, scenes) {
  const wanted = Array.isArray(scenes) ? new Set(scenes) : null
  return (plan?.steps || [])
    .filter((step) => !wanted || wanted.has(stepScene(step)))
    .map((step) => {
      const args = JSON.parse(JSON.stringify(step.arguments || step.args || {}))
      args.previewOnly = false
      args.studioMeta = { ...(args.studioMeta || {}), reason: args.studioMeta?.reason ?? step.reason ?? null, scene: args.studioMeta?.scene ?? stepScene(step), by: 'ai' }
      return { tool: step.tool, arguments: args }
    })
}

// Task #45: which approval controls a plan offers. A plan that changes
// nothing (a hit_duration "ask" preview whose cuts all need the creator's OK)
// has nothing for Approve all to apply: its "Needs your OK" group is the
// action instead, or, with no group either, the panel says nothing changes.
export function planButtons(plan) {
  const proposals = plan?.proposals || []
  if (plan?.hasChanges) return { approveAll: true, approveScene: true, primaryProposal: null, nothingToChange: false }
  return { approveAll: false, approveScene: false, primaryProposal: proposals[0]?.kind ?? null, nothingToChange: proposals.length === 0 }
}
