// FILM-2019 AC5: the QA language check. A render of a language must speak
// that language: whisper.cpp's language detection (the local caption
// engine, electron/captionWhisper.js) runs on the render's audio mix, from
// the first line of the language's dialogue lane, and a mismatch is a
// failing QA issue. Without the engine the check cannot run, and says so (a
// non-failing `language_unchecked`), rather than passing.
//
//   createLanguageDetector({ getEngine, getFfmpegPath }) → detect(file, {offsetSeconds})
//     → { available: true, language, probability, model } | { available: false, reason }
//   checkSpokenLanguage({ file, language, detect, offsetSeconds }) → { check, issue }
//
// Imports nothing from Electron; runs under `node --test`.
const fs = require('fs')
const fsp = fs.promises
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { run, resolveBinaries } = require('./ffmpegTools')

const loadPlan = () => import('../../src/studio/review/renderPlan.js')

const DETECT_SECONDS = 30
const FAIL_SEVERITY = 1

// whisper-cli logs "whisper_full_with_state: auto-detected language: hi (p = 0.981234)".
function parseDetectedLanguage(text) {
  const match = /auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/i.exec(String(text || ''))
  return match ? { language: match[1].toLowerCase(), probability: Math.round(Number(match[2]) * 1000) / 1000 } : null
}

// The language part of a tag: whisper detects hi, not hi-IN.
const baseLanguage = (tag) => String(tag || '').toLowerCase().split('-')[0]

// Detection reads `seconds` of audio from `offsetSeconds` (16 kHz mono, as whisper needs).
function createLanguageDetector({ getEngine = () => null, getFfmpegPath = () => null, seconds = DETECT_SECONDS, timeoutMs = 5 * 60 * 1000 } = {}) {
  return async function detect(file, { offsetSeconds = 0, signal } = {}) {
    const engine = getEngine() || {}
    if (!engine.binaryPath || !engine.modelPath) {
      return { available: false, reason: 'The local caption engine (whisper) is not installed: install it from Captions to check the spoken language.' }
    }
    const wav = path.join(os.tmpdir(), `studio-language-${crypto.randomUUID()}.wav`)
    try {
      const extracted = await run(resolveBinaries({ ffmpegPath: getFfmpegPath() }).ffmpegPath, ['-loglevel', 'error', '-ss', String(Math.max(0, offsetSeconds)), '-t', String(seconds), '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav], { signal })
      if (extracted.code !== 0) throw Object.assign(new Error(`Could not read the render's audio: ${extracted.stderr.trim().split('\n').pop()}`), { code: 'QA_FAILED' })
      const threads = Math.max(2, Math.min(8, (os.cpus()?.length || 4) - 2))
      const detected = await run(engine.binaryPath, ['-m', engine.modelPath, '-f', wav, '-l', 'auto', '--detect-language', '-t', String(threads)], { signal, timeoutMs })
      const parsed = parseDetectedLanguage(`${detected.stderr}\n${detected.stdout}`)
      if (!parsed) throw Object.assign(new Error(`whisper did not report a language (exit ${detected.code}): ${detected.stderr.trim().split('\n').slice(-2).join(' ')}`), { code: 'QA_FAILED' })
      return { available: true, ...parsed, model: path.basename(engine.modelPath) }
    } finally {
      await fsp.rm(wav, { force: true }).catch(() => {})
    }
  }
}

// Where the language is spoken: the first clip of its own dialogue lane (a
// render opens on music or shot audio as often as on a line).
async function languageOffset({ project, timelineId = null, language }) {
  if (!project || !language) return 0
  const plan = await loadPlan()
  const first = plan.audioClips(project, { timelineId, language }).find((clip) => clip.bus === 'dialogue' && clip.language === language)
  return first ? Math.max(0, first.start - 0.25) : 0
}

async function checkSpokenLanguage({ file, language, detect = null, offsetSeconds = null, project = null, timelineId = null, signal } = {}) {
  if (!language) return { check: null, issue: null }
  if (offsetSeconds == null) offsetSeconds = await languageOffset({ project, timelineId, language })
  const expected = baseLanguage(language)
  const result = detect ? await detect(file, { offsetSeconds, signal }) : { available: false, reason: 'No language detector in this build.' }
  if (!result.available) {
    return {
      check: { language, state: 'unchecked', reason: result.reason },
      issue: { type: 'language_unchecked', severity: 0.2, timeRange: null, scene: null, detail: `The spoken language of the ${language} render was not checked. ${result.reason}` },
    }
  }
  const pass = result.language === expected
  const check = { language, state: pass ? 'pass' : 'fail', detected: result.language, probability: result.probability, model: result.model ?? null, fromSeconds: offsetSeconds }
  if (pass) return { check, issue: null }
  return {
    check,
    issue: {
      type: 'language_mismatch',
      severity: FAIL_SEVERITY,
      timeRange: null,
      scene: null,
      detail: `The ${language} render speaks ${result.language} (detected by ${result.model || 'whisper'}, p = ${result.probability}, from ${offsetSeconds.toFixed(1)} s): the ${language} dialogue lane is missing, muted or not the dub.`,
    },
  }
}

module.exports = { createLanguageDetector, checkSpokenLanguage, languageOffset, parseDetectedLanguage, baseLanguage, DETECT_SECONDS }
