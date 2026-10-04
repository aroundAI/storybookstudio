import { useState } from 'react'
import { Copy, Eye, EyeOff } from 'lucide-react'

// FILM-2010: Settings > Agents (MCP). The local MCP server needs
// `Authorization: Bearer <secret>`; the main process hands the ready-made
// commands over only when this panel asks (studio:getMcpConnectCommand).
const MASK = '••••••••••••••••'

function maskSecret(text, commands) {
  if (!text || !commands?.header) return text || ''
  const secret = commands.header.replace(/^Authorization: Bearer /, '')
  return text.split(secret).join(MASK)
}

function CommandRow({ id, label, display, copiedId, onCopy }) {
  return (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
      <div className="mb-2 text-xs font-semibold text-sf-text-primary">{label}</div>
      <div className="flex items-center gap-2">
        <code data-test={`mcp-command-${id}`} className="min-w-0 flex-1 truncate rounded bg-black/30 px-2 py-1.5 text-[11px] text-sf-text-secondary">{display}</code>
        <button
          type="button"
          data-test={`mcp-copy-${id}`}
          onClick={() => { void onCopy(id) }}
          className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-sf-dark-700 px-2 py-1.5 text-[11px] text-sf-text-secondary hover:bg-sf-dark-600"
        >
          <Copy className="h-3 w-3" />
          {copiedId === id ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

export default function McpConnectCommands({ copiedId, onCopy }) {
  const [state, setState] = useState({ commands: null, revealed: false, error: '' })
  const api = typeof window !== 'undefined' ? window.electronAPI?.mcp : null

  const loadCommands = async () => {
    if (state.commands) return state.commands
    if (!api?.getConnectCommand) {
      setState((current) => ({ ...current, error: 'Connect commands are only available in the desktop app.' }))
      return null
    }
    const result = await api.getConnectCommand()
    if (!result?.success) {
      setState((current) => ({ ...current, error: result?.error || 'Could not read the MCP secret.' }))
      return null
    }
    setState((current) => ({ ...current, commands: result, error: '' }))
    return result
  }

  const handleCopy = async (id) => {
    const commands = await loadCommands()
    if (commands?.[id]) await onCopy(id, commands[id])
  }

  const handleToggleReveal = async () => {
    if (!state.revealed) await loadCommands()
    setState((current) => ({ ...current, revealed: !current.revealed }))
  }

  const { commands, revealed } = state
  const show = (key, fallback) => {
    const text = commands?.[key]
    if (!text) return fallback
    return revealed ? text : maskSecret(text, commands)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] text-sf-text-muted">
          The server needs this machine&apos;s secret as a bearer token. Copy a command below; keep the secret private.
        </p>
        <button
          type="button"
          data-test="mcp-reveal-secret"
          onClick={() => { void handleToggleReveal() }}
          className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-sf-dark-700 px-2 py-1 text-[11px] text-sf-text-secondary hover:bg-sf-dark-600"
        >
          {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          {revealed ? 'Hide' : 'Show'}
        </button>
      </div>
      {state.error && <p className="text-[11px] text-red-300">{state.error}</p>}
      <CommandRow
        id="claudeCommand"
        label="Claude Code"
        display={show('claudeCommand', `claude mcp add --transport http storybookstudio … --header "Authorization: Bearer ${MASK}"`)}
        copiedId={copiedId}
        onCopy={handleCopy}
      />
      <CommandRow
        id="codexEnvLine"
        label="Codex: put the token in your shell profile"
        display={show('codexEnvLine', `export STORYBOOKSTUDIO_MCP_TOKEN=${MASK}`)}
        copiedId={copiedId}
        onCopy={handleCopy}
      />
      <CommandRow
        id="codexCommand"
        label="Codex: add the server"
        display={show('codexCommand', 'codex mcp add storybookstudio --url … --bearer-token-env-var STORYBOOKSTUDIO_MCP_TOKEN')}
        copiedId={copiedId}
        onCopy={handleCopy}
      />
    </div>
  )
}
