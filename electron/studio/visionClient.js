// FILM-2014: the vision model behind the visual critic, chosen by env so the
// owner decides which model (README open question 2) without a code change:
//
//   STUDIO_VISION_PROVIDER   'anthropic' (the only adapter today) or unset
//   STUDIO_VISION_MODEL      a model id; anthropic defaults to claude-opus-5-5
//   key                      secrets.js 'vision.anthropic.apiKey', else ANTHROPIC_API_KEY
//
// Unset provider or missing key = not configured: the visual analyser is
// skipped and says so. The key lives in the main process only and is never
// returned, logged or put in a result. Imports nothing from Electron.
const fs = require('fs')

// USD per million tokens (input, output), for the op log's cost line. A model
// not listed records tokens with costUsd null rather than a guess.
const PRICES_PER_MTOK = {
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-4-5': [1, 5],
}
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'
const SECRET_KEY = 'vision.anthropic.apiKey'

function costUsd(model, inputTokens, outputTokens) {
  const price = PRICES_PER_MTOK[model]
  if (!price) return null
  return Math.round(((inputTokens * price[0] + outputTokens * price[1]) / 1e6) * 10000) / 10000
}

// `createAnthropic` is injectable for tests; production loads the SDK.
function createVisionClient({ env = process.env, getSecret = () => null, createAnthropic = null } = {}) {
  const provider = String(env.STUDIO_VISION_PROVIDER || '').trim().toLowerCase()
  if (!provider || provider === 'none') {
    return { configured: false, reason: 'No hosted vision model is configured (STUDIO_VISION_PROVIDER is unset); framing, caption overlap and continuity were not checked.' }
  }
  if (provider !== 'anthropic') {
    return { configured: false, reason: `Vision provider "${provider}" has no adapter (supported: anthropic); the visual analyser was skipped.` }
  }
  let apiKey = null
  try { apiKey = getSecret(SECRET_KEY) } catch { apiKey = null }
  apiKey = apiKey || env.ANTHROPIC_API_KEY || null
  if (!apiKey) {
    return { configured: false, reason: 'STUDIO_VISION_PROVIDER is anthropic but no API key is stored; the visual analyser was skipped.' }
  }
  const model = String(env.STUDIO_VISION_MODEL || DEFAULT_ANTHROPIC_MODEL).trim()
  const make = createAnthropic || ((key) => {
    const sdk = require('@anthropic-ai/sdk')
    const Anthropic = sdk.default || sdk.Anthropic || sdk
    return new Anthropic({ apiKey: key })
  })
  const anthropic = make(apiKey)

  async function describe({ system, text, images = [] }) {
    const content = images.map((file) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(file).toString('base64') },
    }))
    content.push({ type: 'text', text })
    const request = { model, max_tokens: 16000, system, messages: [{ role: 'user', content }] }
    const response = FALLBACK_MODELS.has(model)
      ? await anthropic.beta.messages.create({ ...request, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await anthropic.messages.create(request)
    if (response.stop_reason === 'refusal') {
      return { text: '[]', usage: usageOf(response), refused: true }
    }
    const reply = (response.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    return { text: reply, usage: usageOf(response) }
  }

  function usageOf(response) {
    const inputTokens = response.usage?.input_tokens ?? 0
    const outputTokens = response.usage?.output_tokens ?? 0
    const served = response.model || model
    return { model: served, inputTokens, outputTokens, costUsd: costUsd(served, inputTokens, outputTokens) }
  }

  return { configured: true, name: 'anthropic', model, describe }
}

module.exports = { createVisionClient, costUsd, PRICES_PER_MTOK, SECRET_KEY, DEFAULT_ANTHROPIC_MODEL }
