// Structural diff and patch over upstream project documents (FILM-2012). An
// array whose elements all carry a string `id` is a collection and is diffed
// item by item (timelines, assets, clips, tracks, markers, transitions); any
// other value is compared whole. diffDocuments(from, to) returns the patch
// that turns `from` into `to`, so diffDocuments(after, before) is an inverse.
// Collections are followed two levels deep: the timelines of a document, then
// the clips of a timeline. Pure module: no Electron, no stores.

const MAX_COLLECTION_DEPTH = 2

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isIdArray = (value) => Array.isArray(value) && value.every((item) => isPlainObject(item) && typeof item.id === 'string')
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const sameJson = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)
const hasNestedCollections = (item) => Object.values(item).some((value) => isIdArray(value) && value.length > 0)

const isEmptyPatch = (patch) => Object.keys(patch.fields).length === 0 && Object.keys(patch.collections).length === 0

const diffCollection = (from, to, depth) => {
  const toById = new Map(to.map((item, index) => [item.id, { item, index }]))
  const fromIds = new Set(from.map((item) => item.id))
  const patch = { restore: [], remove: [], revert: [] }

  from.forEach((item, index) => {
    const target = toById.get(item.id)
    if (!target) {
      patch.remove.push(item.id)
      return
    }
    if (target.item === item) return
    // A timeline is rebuilt on every read while its fields keep their
    // references, so diff it field by field rather than serialising it whole.
    if (depth < MAX_COLLECTION_DEPTH && hasNestedCollections(item)) {
      const nested = diffDocuments(item, target.item, depth)
      if (nested) patch.revert.push({ id: item.id, patch: nested })
    } else if (!sameJson(target.item, item)) {
      patch.revert.push({ id: item.id, item: clone(target.item) })
    }
  })
  to.forEach((item, index) => {
    if (!fromIds.has(item.id)) patch.restore.push({ index, item: clone(item) })
  })

  const commonInFrom = from.filter((item) => toById.has(item.id)).map((item) => item.id)
  const commonInTo = to.filter((item) => fromIds.has(item.id)).map((item) => item.id)
  if (commonInFrom.join('\u0000') !== commonInTo.join('\u0000')) patch.order = to.map((item) => item.id)

  for (const key of ['restore', 'remove', 'revert']) if (patch[key].length === 0) delete patch[key]
  return Object.keys(patch).length > 0 ? patch : null
}

export function diffDocuments(from, to, depth = 0) {
  if (from === to) return null
  const patch = { fields: {}, collections: {} }
  const keys = new Set([...Object.keys(from || {}), ...Object.keys(to || {})])
  for (const key of keys) {
    const a = from?.[key]
    const b = to?.[key]
    if (a === b) continue
    if (depth < MAX_COLLECTION_DEPTH && isIdArray(a) && isIdArray(b)) {
      const collection = diffCollection(a, b, depth + 1)
      if (collection) patch.collections[key] = collection
      continue
    }
    if (sameJson(a, b) && Object.hasOwn(from || {}, key) === Object.hasOwn(to || {}, key)) continue
    patch.fields[key] = Object.hasOwn(to || {}, key) ? { value: clone(b) } : { absent: true }
  }
  return isEmptyPatch(patch) ? null : patch
}

const applyCollectionPatch = (items, patch) => {
  const removeIds = new Set(patch.remove || [])
  const reverts = new Map((patch.revert || []).map((entry) => [entry.id, entry]))
  let next = (items || []).filter((item) => !removeIds.has(item.id)).map((item) => {
    const entry = reverts.get(item.id)
    if (!entry) return item
    return entry.patch ? applyPatch(item, entry.patch) : clone(entry.item)
  })
  for (const { index, item } of [...(patch.restore || [])].sort((a, b) => a.index - b.index)) {
    next.splice(Math.min(index, next.length), 0, clone(item))
  }
  if (patch.order) {
    const position = new Map(patch.order.map((id, index) => [id, index]))
    next = [...next].sort((a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity))
  }
  return next
}

export function applyPatch(document, patch) {
  if (!patch) return document
  const next = { ...document }
  for (const [key, field] of Object.entries(patch.fields || {})) {
    if (field.absent) delete next[key]
    else next[key] = clone(field.value)
  }
  for (const [key, collection] of Object.entries(patch.collections || {})) {
    next[key] = applyCollectionPatch(document?.[key], collection)
  }
  return next
}

// Clip ids a patch touches, in either direction: added, removed or changed,
// whether the patch is on a timeline document or a project document.
export function touchedClipIds(patch) {
  const ids = new Set()
  const addClipCollection = (collection) => {
    for (const id of collection?.remove || []) ids.add(id)
    for (const { item } of collection?.restore || []) ids.add(item.id)
    for (const { id } of collection?.revert || []) ids.add(id)
  }
  const visitTimelinePatch = (timelinePatch) => addClipCollection(timelinePatch?.collections?.clips)
  if (!patch) return ids
  visitTimelinePatch(patch)
  const timelines = patch.collections?.timelines
  for (const { item } of timelines?.restore || []) for (const clip of item.clips || []) ids.add(clip.id)
  for (const entry of timelines?.revert || []) {
    if (entry.patch) visitTimelinePatch(entry.patch)
    else for (const clip of entry.item?.clips || []) ids.add(clip.id)
  }
  return ids
}

// Every clip of a document by id, with its timeline, for project documents
// ({timelines}) and timeline documents ({clips}) alike.
export function clipsById(document) {
  const map = new Map()
  for (const clip of document?.clips || []) map.set(clip.id, { clip, timelineId: document.id ?? null })
  for (const timeline of document?.timelines || []) {
    for (const clip of timeline.clips || []) map.set(clip.id, { clip, timelineId: timeline.id })
  }
  return map
}
