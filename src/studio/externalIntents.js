// Registers FILM-2016's compilers (src/studio/intents/audio.js and
// captions.js) into compile.js's registry when the build has them, as
// studio_edit_audio's `audio:<intent>` and studio_add_captions'
// `captions:add_captions`, and adapts their results to the plan shape every
// capability tool uses (contract A1): steps without studioMeta (the runner
// adds it), reasons, scenes and change texts aligned, expected from the
// simulator, notes. capabilityRuntime.js passes the modules it finds with
// import.meta.glob, so neither merge order breaks the other. Pure module.
import { CompileError, registerIntentCompiler } from './compile.js'
import { finishPlan, shotLabel } from './intents/shared.js'

export const AUDIO_MODULE = './intents/audio.js'
export const CAPTIONS_MODULE = './intents/captions.js'

// FILM-2016's context: audioBuses at the top, user edits as a Set, the brand
// and the preset loudness; its scope: 'episode' or {scenes, clipIds, range:{start, end}}.
export const externalContext = (context) => ({
  ...context,
  audioBuses: context.project?.audioBuses ?? null,
  userEditedClipIds: new Set(context.userEditedClipIds || []),
  presetLufs: context.policy?.loudnessTargetLufs,
  width: context.timeline?.width,
  height: context.timeline?.height,
})

export function externalScope(scope = {}) {
  const scenes = [...(Array.isArray(scope.scenes) ? scope.scenes : []), ...(scope.scene != null ? [scope.scene] : [])].map(Number)
  const range = Array.isArray(scope.range) ? { start: Number(scope.range[0]), end: Number(scope.range[1]) } : null
  const clipIds = Array.isArray(scope.clipIds) ? scope.clipIds : []
  if (!scenes.length && !range && !clipIds.length) return 'episode'
  return { ...(scenes.length ? { scenes } : {}), ...(range ? { range } : {}), ...(clipIds.length ? { clipIds } : {}) }
}

function describe(tool, args, clips) {
  switch (tool) {
    case 'set_audio_buses':
      return `Buses ${Object.entries(args.buses || {}).map(([bus, patch]) => `${bus} ${Object.entries(patch || {}).map(([key, value]) => `${key} ${value}`).join(', ')}`).join('; ')}`
    case 'set_clip_audio': {
      const ids = args.clipIds || (args.clipId ? [args.clipId] : [])
      const fade = (value) => `${Number(value).toFixed(2)} s`
      const parts = [args.gainDb != null ? `gain ${args.gainDb} dB` : null, args.fadeInSeconds != null ? `fade in ${fade(args.fadeInSeconds)}` : null, args.fadeOutSeconds != null ? `fade out ${fade(args.fadeOutSeconds)}` : null].filter(Boolean)
      return `${ids.length === 1 ? shotLabel(clips.get(ids[0])) : `${ids.length} clips`}: ${parts.join(', ')}`
    }
    case 'set_master_audio':
      return `Master ${Object.entries(args).map(([key, value]) => `${key} ${JSON.stringify(value)}`).join(', ')}`
    case 'update_caption_cues':
      return `Styled ${Array.isArray(args.cues) ? args.cues.length : 0} caption cues`
    case 'generate_captions':
      return 'Placed a live captions clip'
    default:
      return tool
  }
}

export function adaptExternalResult(intent, result, context) {
  if (!result || result.refused) {
    throw new CompileError(result?.refused?.reason || `${intent} returned no plan.`, result?.refused?.code || 'VALIDATION_FAILED')
  }
  const clips = new Map((context.timeline?.clips || []).map((clip) => [clip.id, clip]))
  const touches = new Set(result.touchesUserEdits || [])
  const entries = (result.steps || []).map((step, index) => {
    const { studioMeta = null, previewOnly, ...args } = step.arguments || {}
    const targets = args.clipIds || (args.clipId ? [args.clipId] : [])
    return {
      step: { tool: step.tool, arguments: args },
      reason: result.reasons?.[index] ?? studioMeta?.reason ?? null,
      scene: Number.isInteger(studioMeta?.scene) ? studioMeta.scene : null,
      text: describe(step.tool, args, clips),
      touches: targets.filter((id) => touches.has(id)),
    }
  })
  const notes = [
    ...(result.notes || []).map((note) => (typeof note === 'string' ? { scene: null, text: note } : note)),
    ...(entries.length === 0 ? [{ scene: null, text: `The ${intent} compiler proposed no change${result.expected ? ` (${JSON.stringify(result.expected).slice(0, 300)})` : ''}` }] : []),
  ]
  const plan = finishPlan(context, { intent, entries, notes })
  plan.compilerExpected = result.expected ?? null
  if (result.qa) plan.qa = result.qa
  return plan
}

// Registers what the build has; returns the intents it registered.
export function registerExternalIntents(modules = {}) {
  const registered = []
  const audio = modules[AUDIO_MODULE]
  if (typeof audio?.compileAudioIntent === 'function') {
    for (const intent of audio.AUDIO_INTENTS || ['balance', 'duck', 'normalize', 'fade']) {
      registerIntentCompiler(`audio:${intent}`, {
        owner: 'FILM-2016',
        reads: (context, scope, params) => (typeof audio.reads === 'function' ? audio.reads(externalContext(context), externalScope(scope), { ...params, intent }) : []),
        compile: (context, scope, params, policy) => adaptExternalResult(`audio:${intent}`, audio.compileAudioIntent(intent, externalContext(context), externalScope(scope), params, policy), context),
      })
      registered.push(`audio:${intent}`)
    }
  }
  const captions = modules[CAPTIONS_MODULE]
  if (typeof captions?.compileCaptionsPlacement === 'function') {
    registerIntentCompiler('captions:add_captions', {
      owner: 'FILM-2016',
      compile: (context, scope, params, policy) => {
        const external = externalContext(context)
        const clip = captions.captionsClipFor?.(external, params.language)
        const cues = clip?.captions?.cues || []
        if (!cues.length) {
          // Transcription is a job (contract E6): it cannot be a plan step.
          throw new CompileError(`There are no ${params.language} cues to style. Transcribe first (transcribe_captions, then get_caption_status), then call studio_add_captions again.`, 'VALIDATION_FAILED')
        }
        return adaptExternalResult('captions:add_captions', captions.compileCaptionsPlacement(external, cues, params, policy), context)
      },
    })
    registered.push('captions:add_captions')
  }
  return registered
}
