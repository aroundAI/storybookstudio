// FILM-2011: the Studio's MCP client of StoryBook. Main process only.
//
// One @modelcontextprotocol/sdk Client over Streamable HTTP to
// <api>/api/mcp (FILM-1904), the same client Claude Desktop uses, so every
// Phase 19 guarantee (RLS JWT per call, scopes, audit rows, rate limits)
// applies with no new server code. The bearer is read from auth.js on every
// request, so a refresh never needs a reconnect.
//
// Errors follow StoryBook's contract (structuredContent {code, message,
// retryable, details}):
// - an HTTP 401 refreshes the token once and repeats the request; a second
//   401 is UNAUTHORIZED "Sign in again" and asks auth.js to forget the token;
// - FORBIDDEN keeps StoryBook's message (it names the role) and exposes
//   details.role when the server sends one;
// - RATE_LIMITED waits details.retry_after_s and tries again (three times).
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')

const CLIENT_INFO = { name: 'StorybookStudio', version: '0.3.36' }
const MAX_RATE_LIMIT_RETRIES = 3

// Every tool the Studio calls. The last five belong to StoryBook specs that
// have not landed (FILM-2003, FILM-2007); their argument shapes are those
// specs' field lists, and a server without them answers VALIDATION_FAILED.
const TOOLS = {
  whoami: 'whoami',
  listProjects: 'list_projects',
  listEpisodes: 'list_episodes',
  getEditPackage: 'get_edit_package',
  openEditSession: 'open_edit_session',
  recordEditEvents: 'record_edit_events',
  closeEditSession: 'close_edit_session',
  // FILM-2003: ({sessionId, preset, language, aspect, bytes, contentType}) → {renderId, uploadUrl, …}
  requestRenderUpload: 'request_render_upload',
  // FILM-2003: ({renderId, durationSeconds, qa, captionsKey?, thumbnailKey?})
  finalizeRender: 'finalize_render',
  // FILM-2003: ({sessionId, episodeVersion, renders: [{renderId, primary?}], report, qa})
  deliverEdit: 'deliver_edit',
  // FILM-2007: ({episodeId, shotIds[], reason})
  regenerateShots: 'regenerate_shots',
  // FILM-2007: ({episodeId, languages[]})
  localizeEpisode: 'localize_episode',
}
const TOOL_NAMES = Object.values(TOOLS)
const PENDING_TOOLS = new Set(['request_render_upload', 'finalize_render', 'deliver_edit', 'regenerate_shots', 'localize_episode'])

class StudioClientError extends Error {
  constructor(code, message, { details = null, retryable = false, role = null, tool = null } = {}) {
    super(message)
    this.name = 'StudioClientError'
    this.code = code
    this.details = details
    this.retryable = retryable
    this.role = role
    this.tool = tool
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details, role: this.role, tool: this.tool }
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createStoryBookClient({ apiOrigin, auth, fetchFn = fetch, sleep = defaultSleep, clientInfo = CLIENT_INFO }) {
  const origin = new URL(apiOrigin).origin
  const endpoint = new URL('/api/mcp', origin)
  let connection = null
  let signInRequired = false

  // Adds the bearer to every request; on 401 refreshes once and repeats.
  const authorizedFetch = async (input, init = {}) => {
    const send = async () => {
      const token = await auth.getAccessToken(origin)
      const headers = new Headers(init.headers || {})
      if (token) headers.set('Authorization', `Bearer ${token}`)
      return fetchFn(input, { ...init, headers })
    }
    let response = await send()
    if (response.status !== 401) return response
    await response.body?.cancel?.()
    const refreshed = await auth.refresh(origin)
    if (refreshed?.ok) {
      response = await send()
      if (response.status !== 401) return response
    }
    signInRequired = true
    return response
  }

  async function connect() {
    if (connection) return connection
    const client = new Client(clientInfo)
    const transport = new StreamableHTTPClientTransport(endpoint, { fetch: authorizedFetch })
    connection = client.connect(transport).then(
      () => client,
      (error) => {
        connection = null
        throw error
      },
    )
    return connection
  }

  function unauthorized(tool) {
    auth.onSignInRequired?.(origin)
    return new StudioClientError('UNAUTHORIZED', 'Sign in again', { tool })
  }

  async function call(tool, args = {}) {
    for (let attempt = 0; ; attempt += 1) {
      signInRequired = false
      let result
      try {
        const client = await connect()
        result = await client.callTool({ name: tool, arguments: args })
      } catch (error) {
        if (signInRequired || error?.code === 401) {
          connection = null
          throw unauthorized(tool)
        }
        // The SDK server answers an unknown tool with a JSON-RPC error.
        if (/tool .* not found|unknown tool/i.test(error?.message || '')) {
          throw new StudioClientError(
            'VALIDATION_FAILED',
            PENDING_TOOLS.has(tool) ? `${tool} is not available yet on this StoryBook.` : `${tool} is not available on this StoryBook.`,
            { tool },
          )
        }
        connection = null
        // An HTTP error's message carries the whole response body (a dev
        // server's 500 page is kilobytes of HTML): keep the first line, short.
        const reason = String(error?.message || error).split('\n')[0].replace(/<[^>]*>/g, ' ').slice(0, 200)
        throw new StudioClientError('NETWORK', `StoryBook could not be reached: ${reason}`, { retryable: true, tool })
      }

      if (!result?.isError) return result?.structuredContent ?? { text: result?.content?.find((c) => c.type === 'text')?.text ?? null }

      const body = result.structuredContent || {}
      const text = result.content?.find((c) => c.type === 'text')?.text || ''
      const code = body.code || (/not found/i.test(text) && PENDING_TOOLS.has(tool) ? 'VALIDATION_FAILED' : 'INTERNAL')
      const details = body.details ?? null

      if (code === 'RATE_LIMITED' && attempt < MAX_RATE_LIMIT_RETRIES) {
        const seconds = Number(details?.retry_after_s)
        await sleep((Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000)
        continue
      }
      if (code === 'UNAUTHORIZED') throw unauthorized(tool)
      const message = body.message || (code === 'VALIDATION_FAILED' && PENDING_TOOLS.has(tool) ? `${tool} is not available yet on this StoryBook.` : text || code)
      throw new StudioClientError(code, message, {
        details,
        retryable: Boolean(body.retryable),
        role: code === 'FORBIDDEN' ? details?.role ?? (/(?:you are|your role is) (\w+)/i.exec(message)?.[1] ?? null) : null,
        tool,
      })
    }
  }

  const callers = Object.fromEntries(Object.entries(TOOLS).map(([method, tool]) => [method, (args = {}) => call(tool, args)]))

  return {
    apiOrigin: origin,
    call,
    ...callers,
    async close() {
      const pending = connection
      connection = null
      if (!pending) return
      try {
        await (await pending).close()
      } catch {
        // already closed
      }
    },
  }
}

module.exports = { createStoryBookClient, StudioClientError, TOOLS, TOOL_NAMES, PENDING_TOOLS }
