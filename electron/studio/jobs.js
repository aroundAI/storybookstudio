// FILM-2011: long jobs (pull, later render and deliver) run in the main
// process, never over the renderer MCP bridge (which times out at 60 s).
// Their status is what studio:jobStatus and FILM-2013's
// studio_get_job_status return: {phase, done, total, bytes, error?}. A job
// record never holds a token or a signed URL.
const crypto = require('crypto')

const KEEP_FINISHED = 50

function createJobRegistry({ emit = () => {}, now = () => new Date() } = {}) {
  const jobs = new Map()

  const snapshot = (record) => ({ ...record, result: record.result ? { ...record.result } : null })

  const prune = () => {
    const finished = [...jobs.values()].filter((job) => job.status !== 'running')
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(job.id)
  }

  function create(kind, meta = {}) {
    const record = {
      id: crypto.randomUUID(),
      kind,
      status: 'running',
      phase: 'queued',
      done: 0,
      total: 0,
      bytes: 0,
      error: null,
      ...meta,
      result: null,
      startedAt: now().toISOString(),
      finishedAt: null,
    }
    jobs.set(record.id, record)
    prune()

    const publish = () => emit(snapshot(record))
    return {
      id: record.id,
      get record() {
        return snapshot(record)
      },
      update(patch) {
        if (record.status !== 'running') return
        Object.assign(record, patch)
        publish()
      },
      addBytes(n) {
        record.bytes += n
      },
      publish,
      complete(result = null) {
        Object.assign(record, { status: 'done', phase: 'done', result, finishedAt: now().toISOString() })
        publish()
      },
      fail(error) {
        Object.assign(record, {
          status: 'failed',
          error: error?.message || String(error),
          errorCode: error?.code ?? null,
          finishedAt: now().toISOString(),
        })
        publish()
      },
    }
  }

  return {
    create,
    get(id) {
      const record = jobs.get(id)
      if (!record) return null
      const { errorCode, ...rest } = record
      return snapshot(rest)
    },
    list() {
      return [...jobs.values()].map((record) => {
        const { errorCode, ...rest } = record
        return snapshot(rest)
      })
    },
    running(kind) {
      return [...jobs.values()].filter((job) => job.status === 'running' && (!kind || job.kind === kind)).map(snapshot)
    },
  }
}

module.exports = { createJobRegistry }
