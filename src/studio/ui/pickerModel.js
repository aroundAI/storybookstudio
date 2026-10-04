// FILM-2015: the episode picker's model (R-11). list_episodes carries a
// seasonId but no season name, and StoryBook's MCP has no season tool, so
// seasons are numbered in the order their first episode appears ("Season 1"),
// with "No season" last. Size is known only for an episode already on this
// machine (its storybook/package.json); "On this machine" comes from local
// projects whose storybook/link.json names the episode. Pure module.
import { formatBytes } from './deliverySummary.js'

const STATUS_CHIPS = {
  draft: { label: 'Draft', tone: 'muted' },
  story: { label: 'Story', tone: 'muted' },
  storyboard: { label: 'Storyboard', tone: 'neutral' },
  generating: { label: 'Generating', tone: 'busy' },
  editing: { label: 'Editing', tone: 'busy' },
  ready: { label: 'Ready', tone: 'good' },
  published: { label: 'Published', tone: 'good' },
}

export function statusChip(status) {
  const chip = STATUS_CHIPS[status]
  return chip ? { key: status, ...chip } : { key: String(status), label: String(status), tone: 'muted' }
}

const clock = (value) => {
  const whole = Math.round(value)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function formatAgo(iso, now = Date.now()) {
  const at = Date.parse(iso || '')
  if (!Number.isFinite(at)) return '—'
  const minutes = Math.max(0, Math.round((now - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

const durationLabel = (episode) => {
  if (Number.isFinite(episode.durationSeconds) && episode.durationSeconds > 0) return clock(episode.durationSeconds)
  if (Number.isFinite(episode.targetDurationSeconds) && episode.targetDurationSeconds > 0) return `target ${clock(episode.targetDurationSeconds)}`
  return '—'
}

export function buildEpisodeTree({ episodes = [], localLinks = new Map(), now = Date.now() } = {}) {
  const sorted = [...episodes].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
  const seasons = new Map()
  for (const episode of sorted) {
    const key = episode.seasonId || null
    if (!seasons.has(key)) seasons.set(key, [])
    const local = localLinks.get(episode.id) || null
    seasons.get(key).push({
      id: episode.id,
      number: episode.number,
      title: `${episode.number}. ${episode.title || 'Untitled'}`,
      status: statusChip(episode.status),
      durationLabel: durationLabel(episode),
      changedLabel: formatAgo(episode.updatedAt, now),
      onThisMachine: Boolean(local),
      localPath: local?.projectPath ?? null,
      sizeLabel: Number.isFinite(local?.bytes) ? formatBytes(local.bytes) : null,
    })
  }
  const named = [...seasons.keys()].filter((key) => key !== null)
  const tree = named.map((key, index) => ({ seasonId: key, label: `Season ${index + 1}`, episodes: seasons.get(key) }))
  if (seasons.has(null)) tree.push({ seasonId: null, label: 'No season', episodes: seasons.get(null) })
  return tree
}

// Every media file an edit package names, counted once per key.
export function packageBytes(pkg) {
  if (!pkg || typeof pkg !== 'object') return null
  const seen = new Set()
  let total = 0
  const add = (media) => {
    if (!media?.key || !Number.isFinite(media.bytes) || seen.has(media.key)) return
    seen.add(media.key)
    total += media.bytes
  }
  for (const shot of pkg.shots || []) [shot.video, shot.firstFrame, shot.lastFrame].forEach(add)
  for (const line of pkg.dialogue || []) add(line.audio)
  for (const track of pkg.audioTracks || []) add(track.media)
  for (const dub of pkg.dubbed || []) for (const line of dub.lines || []) add(line.audio)
  for (const character of pkg.characters || []) for (const image of character.referenceImages || []) add(image)
  return total
}

const PHASE_LABELS = {
  queued: 'Queued',
  session: 'Opening the edit session',
  package: 'Reading the episode',
  download: 'Downloading media',
  probe: 'Checking media',
  build: 'Building the rough cut',
  done: 'Ready',
}

export function jobProgressView(job) {
  if (!job) return null
  if (job.status === 'failed') {
    return { label: 'Could not open the episode', percent: 0, detail: job.error || 'The pull failed.', failed: true, finished: true }
  }
  const finished = job.status === 'done'
  const percent = finished ? 100 : job.total ? Math.round((job.done / job.total) * 100) : 0
  const parts = []
  if (job.total) parts.push(`${job.done} of ${job.total} files`)
  if (job.bytes) parts.push(formatBytes(job.bytes))
  return { label: PHASE_LABELS[job.phase] || String(job.phase || 'Working'), percent, detail: parts.join(' · '), failed: false, finished }
}
