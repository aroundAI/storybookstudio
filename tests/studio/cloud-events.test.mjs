// FILM-2011 AC6: edit events are batched with a clientEventId each, sent
// every 60 s or on delivery, queued on disk while offline and flushed on
// reconnect; closing the project closes the session.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createEditEventQueue, FLUSH_INTERVAL_MS, MAX_EVENTS_PER_CALL } = require('../../electron/studio/events.js')

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbs-events-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'storybook', 'pending-events.json')
}

function timers() {
  const list = []
  return {
    list,
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false }; list.push(t); return t },
    clearInterval: (t) => { t.cleared = true },
  }
}

function client({ offline = () => false } = {}) {
  const sent = []
  const closed = []
  return {
    sent,
    closed,
    async recordEditEvents({ sessionId, events }) {
      if (offline()) throw Object.assign(new Error('fetch failed'), { code: 'NETWORK' })
      sent.push({ sessionId, events })
      return { accepted: events.length, duplicates: 0 }
    },
    async closeEditSession({ sessionId }) {
      closed.push(sessionId)
      return { status: 'closed' }
    },
  }
}

test('events get a clientEventId and a timestamp, and go out every 60 s in batches the server accepts', async (t) => {
  assert.equal(FLUSH_INTERVAL_MS, 60_000)
  const c = client()
  const tm = timers()
  const queue = createEditEventQueue({ client: c, sessionId: 's1', persistPath: tempFile(t), setInterval: tm.setInterval, clearInterval: tm.clearInterval })
  assert.equal(tm.list[0].ms, 60_000)
  for (let i = 0; i < MAX_EVENTS_PER_CALL + 3; i += 1) queue.push({ type: 'plan_proposed', data: { planId: `p${i}`, by: 'ai', steps: 1 } })
  assert.equal(c.sent.length, 0, 'nothing is sent before the tick')
  await tm.list[0].fn()
  assert.deepEqual(c.sent.map((b) => b.events.length), [MAX_EVENTS_PER_CALL, 3])
  const first = c.sent[0].events[0]
  assert.match(first.clientEventId, /^[0-9a-f-]{36}$/)
  assert.ok(!Number.isNaN(Date.parse(first.ts)))
  assert.deepEqual(first.data, { planId: 'p0', by: 'ai', steps: 1 })
  assert.equal(queue.pending(), 0)
})

test('a delivered event flushes at once', async (t) => {
  const c = client()
  const tm = timers()
  const queue = createEditEventQueue({ client: c, sessionId: 's1', persistPath: tempFile(t), setInterval: tm.setInterval, clearInterval: tm.clearInterval })
  queue.push({ type: 'version_created', data: { versionId: 'v1', durationSeconds: 60, aiOps: 2, userOps: 0 } })
  await queue.push({ type: 'delivered', data: { renderIds: ['r1'] } })
  assert.equal(c.sent.length, 1)
  assert.deepEqual(c.sent[0].events.map((e) => e.type), ['version_created', 'delivered'])
})

test('offline: events stay queued on disk with their ids and are flushed once on reconnect', async (t) => {
  let down = true
  const c = client({ offline: () => down })
  const tm = timers()
  const file = tempFile(t)
  const queue = createEditEventQueue({ client: c, sessionId: 's1', persistPath: file, setInterval: tm.setInterval, clearInterval: tm.clearInterval })
  queue.push({ type: 'plan_rejected', data: { planId: 'p1' } })
  await tm.list[0].fn()
  assert.equal(queue.pending(), 1)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.sessionId, 's1')
  const id = onDisk.events[0].clientEventId

  // The app restarts while offline: a new queue picks the file up.
  const again = createEditEventQueue({ client: c, sessionId: 's1', persistPath: file, setInterval: tm.setInterval, clearInterval: tm.clearInterval })
  assert.equal(again.pending(), 1)
  down = false
  await again.online()
  assert.equal(c.sent.length, 1)
  assert.equal(c.sent[0].events[0].clientEventId, id, 'the same id, so a retried batch is not stored twice')
  assert.equal(again.pending(), 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).events, [])
})

test('closing flushes, then closes the session, then stops the timer', async (t) => {
  const c = client()
  const tm = timers()
  const queue = createEditEventQueue({ client: c, sessionId: 's1', persistPath: tempFile(t), setInterval: tm.setInterval, clearInterval: tm.clearInterval })
  queue.push({ type: 'qa_run', data: { pass: true, issues: 0 } })
  await queue.close()
  assert.equal(c.sent.length, 1)
  assert.deepEqual(c.closed, ['s1'])
  assert.equal(tm.list[0].cleared, true)
})
