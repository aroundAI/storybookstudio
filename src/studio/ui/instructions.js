// FILM-2015: the instruction box's plain-language requests that map to one
// FILM-2013 intent without a model. Anything else is not guessed: the user is
// asked to rephrase until the in-app LLM agent takes the text. Pure module.

const DURATION = /(?:^|\b)(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?)\b/i
const CLOCK = /\b(\d{1,2}):([0-5]\d)\b/

function targetSeconds(text) {
  const clock = CLOCK.exec(text)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2])
  const match = DURATION.exec(text)
  if (!match) return null
  const value = Number(match[1])
  return /^m/i.test(match[2]) ? Math.round(value * 60) : value
}

const RULES = [
  { intent: 'remove_dead_air', test: /dead air|silence|long pauses|pauses/i },
  { intent: 'open_with_strongest_line', test: /strongest line|open with|stronger (?:open|hook)|hook/i },
  { intent: 'keep_music_under_dialogue', test: /music.*(?:under|below|quieter|duck)|duck/i },
  { intent: 'tighten_pacing', test: /tighten|tighter|snappier|faster pac|pacing/i },
]

export function instructionToIntent(text) {
  const value = String(text || '').trim()
  if (!value) return null
  const seconds = targetSeconds(value)
  if (seconds && /\b(make|cut|trim|get|bring|shorten|hit|under|to|it)\b/i.test(value)) {
    return { intent: 'hit_duration', params: { targetSeconds: seconds } }
  }
  const rule = RULES.find((candidate) => candidate.test.test(value))
  return rule ? { intent: rule.intent, params: {} } : null
}

// FILM-2013's scope schema takes one form: scenes win over clip ids.
export function scopeArgument(scope) {
  if (scope?.scenes?.length) return { scenes: [...scope.scenes] }
  if (scope?.clipIds?.length) return { clipIds: [...scope.clipIds] }
  return {}
}

export const INSTRUCTION_EXAMPLES = ['make it 90 seconds', 'tighten this', 'remove the dead air', 'open with the strongest line', 'keep the music under the dialogue']
