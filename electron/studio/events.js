// FILM-2011: edit events for the open session (FILM-2002 record_edit_events).
// Each event gets a clientEventId when it is queued, so a batch re-sent
// after a lost response is stored once. The queue lives on disk in the
// project (<project>/storybook/pending-events.json) so an offline session,
// or a restart while offline, loses nothing.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const FLUSH_INTERVAL_MS = 60_000
// FILM-2002's MAX_EDIT_EVENTS_PER_CALL.
const MAX_EVENTS_PER_CALL = 500

function readQueue(file, sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed?.sessionId === sessionId && Array.isArray(parsed.events) ? parsed.events : []
  } catch {
    return []
  }
}

function createEditEventQueue({
  client,
  sessionId,
  persistPath,
  setInterval: arm = setInterval,
  clearInterval: disarm = clearInterval,
  intervalMs = FLUSH_INTERVAL_MS,
  log = () => {},
}) {
  let events = readQueue(persistPath, sessionId)
  let flushing = null
  let closed = false

  const persist = () => {
    fs.mkdirSync(path.dirname(persistPath), { recursive: true })
    const temp = `${persistPath}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ sessionId, events }, null, 2))
    fs.renameSync(temp, persistPath)
  }

  const flush = () => {
    if (flushing) return flushing
    flushing = (async () => {
      try {
        while (events.length) {
          const batch = events.slice(0, MAX_EVENTS_PER_CALL)
          try {
            await client.recordEditEvents({ sessionId, events: batch })
          } catch (error) {
            // Offline or refused: keep the batch (same ids) for the next tick.
            log(`[studio] edit events not sent (${events.length} queued): ${error?.code || error?.message || error}`)
            return { sent: false, pending: events.length }
          }
          const sent = new Set(batch.map((event) => event.clientEventId))
          events = events.filter((event) => !sent.has(event.clientEventId))
          persist()
        }
        return { sent: true, pending: 0 }
      } finally {
        flushing = null
      }
    })()
    return flushing
  }

  const timer = arm(() => flush(), intervalMs)
  timer?.unref?.()

  return {
    // Returns the flush promise for `delivered` (sent at once), else undefined.
    // clientEventId: FILM-2017 passes a stable one for an event a retry may
    // send again (delivered), so StoryBook stores it once.
    push({ type, data = {}, ts = new Date().toISOString(), clientEventId = null }) {
      if (closed) throw new Error('The edit session is closed.')
      if (clientEventId && events.some((event) => event.clientEventId === clientEventId)) return type === 'delivered' ? flush() : undefined
      events.push({ clientEventId: clientEventId || crypto.randomUUID(), ts, type, data })
      persist()
      return type === 'delivered' ? flush() : undefined
    },
    flush,
    // Call when the network comes back (the renderer's `online` event).
    online: () => flush(),
    pending: () => events.length,
    async close() {
      if (closed) return { closed: true }
      closed = true
      disarm(timer)
      await flush()
      return client.closeEditSession({ sessionId })
    },
    stop() {
      closed = true
      disarm(timer)
    },
  }
}

module.exports = { createEditEventQueue, FLUSH_INTERVAL_MS, MAX_EVENTS_PER_CALL }
