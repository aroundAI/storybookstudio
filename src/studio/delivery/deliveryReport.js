// FILM-2017: the explain-why report that goes to StoryBook with a delivery,
// and the version_created event of the delivered version. Pure module.
//
// A delivery creates a version ("Delivered") so the delivered cut has a name
// and a snapshot. The report covers the whole session, not only the ops of
// that last version: it is FILM-2012's buildExplainWhyReport over one range
// that runs from the first version (the rough cut) to the delivered one, so
// every change the episode got in the Studio is listed with its reason.
import { buildExplainWhyReport } from '../report.js'
import { CREATE_VERSION_TOOL } from '../oplog.js'

const round = (value) => Math.round(value * 1000) / 1000
const endOf = (clip) => (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)

export function documentDuration(document, timelineId = null) {
  const timelines = Array.isArray(document?.timelines) ? document.timelines : [document]
  const timeline = timelines.find((entry) => entry?.id === (timelineId ?? document?.currentTimelineId)) || timelines[0]
  const picture = (timeline?.clips || []).filter((clip) => clip.type === 'video' || clip.type === 'image')
  return round(Math.max(0, ...picture.map(endOf)))
}

// versions: the version store's list (oldest first), the delivered version
// last. before: the first version's snapshot; after: the document now.
export function buildDeliveryReport({ log, versions, deliveredVersionId, before, after, qa = null, target = null, hookType = null }) {
  if (!versions.length) throw Object.assign(new Error('The project has no version to report on.'), { code: 'VALIDATION_FAILED' })
  const delivered = versions.find((version) => version.id === deliveredVersionId) || versions.at(-1)
  const first = versions[0]
  const span = {
    ...delivered,
    parent: delivered.id === first.id ? null : first.id,
    opRange: [first.opRange?.[0] ?? 1, null],
  }
  const list = versions.map((version) => (version.id === span.id ? span : version))
  const report = buildExplainWhyReport({ log, versions: list, versionId: span.id, before: before ?? after, after, qa, target })
  // The real parent chain, not the synthetic span, is what StoryBook shows.
  report.versions = report.versions.map((version) => {
    const real = versions.find((entry) => entry.id === version.id)
    return { ...version, parentId: real?.parent ?? null, opRange: [...(real?.opRange ?? version.opRange)] }
  })
  if (report.style && hookType) report.style.hookType = hookType
  return report
}

// FILM-2002's version_created data: ops since the previous version. Pass the
// report's finalDuration as durationSeconds so the event and the report
// StoryBook stores agree (FILM-2012 counts every non-audio clip, captions
// included); without it, the picture's end.
export function versionCreatedData({ version, versions, log, document, durationSeconds = null }) {
  const index = versions.findIndex((entry) => entry.id === version.id)
  const previous = index > 0 ? versions[index - 1] : null
  const from = previous ? previous.opRange?.[0] ?? 0 : 0
  const to = version.opRange?.[0] ?? Infinity
  const ops = log.filter((entry) => entry.op > from && entry.op < to && entry.tool !== CREATE_VERSION_TOOL)
  return {
    versionId: version.id,
    name: String(version.name || version.id).slice(0, 200),
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : documentDuration(document),
    aiOps: ops.filter((entry) => entry.by === 'ai').length,
    userOps: ops.filter((entry) => entry.by === 'user').length,
  }
}
