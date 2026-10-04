// FILM-2015: what the Deliver screen shows before anything is rendered or
// leaves the machine (R-62, contract L8/S3): the episode, the destination,
// every file with its estimated size, and what blocks sending. It reads
// FILM-2017's summary (studio:deliverSummary / studio_deliver confirm:false);
// the user's confirmation of that exact summary is what FILM-2017's one-time
// token is issued for. Pure module.

const PRESET_LABELS = {
  youtube_16x9: 'YouTube 16:9',
  shorts_9x16: 'Shorts 9:16',
  tiktok_9x16: 'TikTok 9:16',
  reels_9x16: 'Reels 9:16',
  square_1x1: 'Square 1:1',
  master: 'Master',
}

export const presetLabel = (preset) => PRESET_LABELS[preset] || preset

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'size unknown'
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`
}

const clock = (value) => {
  if (!Number.isFinite(value)) return null
  const whole = Math.round(value)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

// Severity at or above this is an issue; below, a warning (FILM-2014 scale 0..1).
const ISSUE_SEVERITY = 0.5

export function qaBadge(qa) {
  // FILM-2017's lastQa before a render: {state: 'pass'|'fail'|'not_run', issues: n}.
  if (qa && typeof qa.state === 'string') {
    if (qa.state === 'pass') return { tone: 'pass', label: 'Preview QA passed' }
    if (qa.state === 'fail') return { tone: 'fail', label: `Preview QA: ${qa.issues} issue${qa.issues === 1 ? '' : 's'}` }
    return { tone: 'none', label: 'Not checked yet' }
  }
  if (!qa || !Array.isArray(qa.issues)) return { tone: 'none', label: 'Not checked yet' }
  const issues = qa.issues.filter((issue) => issue.severity >= ISSUE_SEVERITY).length
  const warnings = qa.issues.length - issues
  if (!qa.pass || issues > 0) return { tone: 'fail', label: `${Math.max(issues, 1)} issue${Math.max(issues, 1) === 1 ? '' : 's'}` }
  if (warnings > 0) return { tone: 'warn', label: `${warnings} warning${warnings === 1 ? '' : 's'}` }
  return { tone: 'pass', label: 'QA passed' }
}

export const renderFileName = (render) => `${render.preset}-${render.language}.mp4`

const hostOf = (origin) => {
  try {
    return new URL(origin).host
  } catch {
    return String(origin || 'StoryBook')
  }
}

export function buildDeliveryConfirmation({ summary, workspace = null, episodeNumber = null }) {
  const renders = summary?.renders || []
  const toStoryBook = summary?.destination?.kind !== 'folder'
  const warnings = []
  if (renders.length === 0) warnings.push({ text: 'Choose at least one format.', blocking: true })
  const failedPreview = renders.find((render) => render.lastQa?.state === 'fail')
  if (failedPreview) {
    const count = failedPreview.lastQa.issues
    warnings.push({ text: `The last preview QA found ${count} issue${count === 1 ? '' : 's'}; each file is checked again before it is sent.`, blocking: false })
  }
  for (const render of renders) {
    if (render.overMaxDuration) {
      warnings.push({ text: `${render.file} runs ${clock(render.estimatedDurationSeconds)}, over the ${presetLabel(render.preset)} limit of ${render.maxDuration} s. Make a Short first, or leave this format out.`, blocking: true })
    }
  }
  for (const note of new Set(renders.map((render) => render.note).filter(Boolean))) warnings.push({ text: note, blocking: false })

  const files = renders.map((render) => ({
    name: render.file || renderFileName(render),
    kind: 'render',
    detail: [presetLabel(render.preset), render.language, clock(render.estimatedDurationSeconds)].filter(Boolean).join(' \u00b7 '),
    sizeLabel: Number.isFinite(render.estimatedBytes) ? `about ${formatBytes(render.estimatedBytes)}` : formatBytes(null),
    bytes: Number.isFinite(render.estimatedBytes) ? render.estimatedBytes : null,
    qa: qaBadge(render.lastQa),
  }))
  if (renders.length > 0) {
    files.push(toStoryBook
      ? { name: 'explain-why report and QA results', kind: 'report', detail: 'What the AI changed and why, and the QA of each file', sizeLabel: 'with the delivery', bytes: null }
      : { name: 'QA report', kind: 'report', detail: 'The QA of each file, beside the files', sizeLabel: 'in the folder', bytes: null })
  }
  const total = Number.isFinite(summary?.totalEstimatedBytes) ? summary.totalEstimatedBytes : files.reduce((sum, file) => sum + (file.bytes || 0), 0)
  const title = summary?.episode?.title || 'Untitled'

  return {
    toStoryBook,
    episodeLine: Number.isInteger(episodeNumber) ? `Episode ${episodeNumber} \u00b7 ${title}` : title,
    destinationLine: toStoryBook ? `Workspace \u201c${workspace?.name || 'your team'}\u201d on ${hostOf(summary?.destination?.apiOrigin)}` : `The folder ${summary?.destination?.folder}`,
    statusLine: toStoryBook
      ? 'Each file is rendered, checked and uploaded; the episode is then set to Ready in StoryBook.'
      : 'Each file is rendered and checked, then written to the folder with the QA report beside it. Nothing leaves this machine.',
    files,
    totalBytes: total,
    totalLabel: `about ${formatBytes(total)}`,
    warnings,
    canSend: !warnings.some((warning) => warning.blocking),
  }
}
