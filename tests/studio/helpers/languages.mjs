// FILM-2019 integration fixture: a pulled episode with real media, its
// English dialogue, and StoryBook's Hindi and Spanish dubs arriving later by
// re-sync (in storybook/package.json, files under assets/dubbed/<lang>/, the
// master built before them). Each language speaks a tone of its own (en
// 440 Hz, hi 660 Hz, es 880 Hz), so a detector can tell from a render's mix
// which language's lane it carries without a speech model: `toneDetector`
// has languageCheck's detect() shape and stands in for whisper in CI.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { buildProject, packageForDisk } from '../../../src/studio/projectBuilder.js'
import { loadFixture, probesFor } from './rough-cut.mjs'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const { planDownloads } = require('../../../electron/studio/pull.js')

export const TONES = { en: 440, hi: 660, es: 880 }
export const TEXTS = {
  hi: ['हमें अभी चलना होगा।', 'क्या तुमने वह आवाज़ सुनी?', 'दरवाज़ा बंद करो, जल्दी!', 'यह क्षत्रिय की तलवार है।'],
  es: ['Tenemos que irnos ya.', '¿Oíste ese ruido?', '¡Cierra la puerta, rápido!', 'Es la espada del guardián.'],
}
const DUB_SECONDS = { hi: 1.8, es: 1.7 }

const ffmpeg = (args) => execFileSync(ffmpegPath, ['-v', 'error', '-y', ...args])
const tone = (file, frequency, seconds) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  ffmpeg(['-f', 'lavfi', '-i', `sine=f=${frequency}:d=${seconds}:sample_rate=48000`, '-af', 'volume=-6dB', '-c:a', 'libmp3lame', '-b:a', '96k', file])
}

// A uuid from a seed, so a fixture is the same on every run.
const uuidFrom = (seed) => {
  const hex = crypto.createHash('sha256').update(seed).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

// dubTones: the tone each dub language's files actually carry (a wrong dub
// is { hi: TONES.es }).
export function makeLanguageProject(t, { languages = ['hi', 'es'], dubTones = {}, sessionVersion = 9 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-languages-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const base = loadFixture(5)
  const shots = base.shots.slice(0, 2)
  const end = Math.max(...shots.map((shot) => shot.timelineStartSeconds + shot.durationSeconds))
  const dialogue = base.dialogue.filter((line) => line.audio.url && line.timelineStartSeconds + line.estimatedDurationSeconds <= end)
  const english = {
    ...base,
    shots,
    dialogue,
    // A quiet ambience bed under the whole cut: language-independent, heard in every render.
    audioTracks: base.audioTracks.filter((track) => track.type === 'ambience').map((track) => ({ ...track, timelineStartSeconds: 0, durationSeconds: end, loopable: false })),
    characters: [],
    shortsCandidates: [],
    scenes: base.scenes.filter((scene) => shots.some((shot) => shot.sceneNumber === scene.number)),
    captions: base.captions.map((track) => ({ ...track, segments: track.segments.filter((segment) => segment.endSeconds <= end) })),
    dubbed: [],
    episode: { ...base.episode, targetDurationSeconds: end, languages: ['en'] },
  }
  const dubbed = languages.map((language) => ({
    language,
    dubbedVersionId: uuidFrom(`version-${language}`),
    status: 'completed',
    lines: dialogue.map((line, index) => {
      const id = uuidFrom(`${language}-${line.id}`)
      const key = `audio/episodes/${base.episode.id}/dubbed/${language}/${id}.mp3`
      return { id, dialogueId: line.id, translatedText: TEXTS[language][index % TEXTS[language].length], timingAdjustment: 1, durationSeconds: DUB_SECONDS[language], status: 'voiced', audio: { url: `https://storybook-media.r2.example.test/${key}`, key, sha256: null, sha256Reason: 'not_recorded', bytes: 20000, mime: 'audio/mpeg' } }
    }),
  }))
  const pkg = { ...english, dubbed, episode: { ...english.episode, languages: ['en', ...languages] } }

  // The media the pull (and the re-sync) downloaded.
  const probes = probesFor(english)
  for (const shot of shots) {
    const probe = probes.get(shot.video.key)
    fs.mkdirSync(path.join(dir, path.dirname(probe.path)), { recursive: true })
    ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=640x360:r=24:d=${shot.sourceDurationSeconds}`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', path.join(dir, probe.path)])
    Object.assign(probe, { hasAudio: false, width: 640, height: 360, codecs: { video: 'h264', audio: null } })
    for (const frame of [shot.firstFrame, shot.lastFrame]) if (frame?.key) probes.delete(frame.key)
  }
  for (const line of dialogue) tone(path.join(dir, probes.get(line.audio.key).path), TONES.en, line.estimatedDurationSeconds)
  for (const track of english.audioTracks) {
    const probe = probes.get(track.media.key)
    fs.mkdirSync(path.join(dir, path.dirname(probe.path)), { recursive: true })
    ffmpeg(['-f', 'lavfi', '-i', `anoisesrc=c=pink:a=0.02:d=${end}:r=48000`, '-c:a', 'libmp3lame', '-b:a', '96k', path.join(dir, probe.path)])
    probe.duration = end
  }
  const downloads = new Map(planDownloads(pkg).map((item) => [item.key, item.relativePath]))
  for (const lane of dubbed) {
    for (const line of lane.lines) tone(path.join(dir, downloads.get(line.audio.key)), dubTones[lane.language] ?? TONES[lane.language], line.durationSeconds)
  }

  const { project } = buildProject({ package: english, probedAssets: probes })
  fs.writeFileSync(path.join(dir, 'project.storybookstudio'), JSON.stringify(project))
  fs.mkdirSync(path.join(dir, 'storybook'))
  fs.writeFileSync(path.join(dir, 'storybook', 'package.json'), JSON.stringify(packageForDisk(pkg)))
  fs.writeFileSync(path.join(dir, 'storybook', 'session.json'), JSON.stringify({ apiOrigin: 'http://storybook.test', episodeId: pkg.episode.id, sessionId: '0b9c5a43-6a3e-4c9e-9b8e-2f1d4c7a9e11', episodeVersion: sessionVersion }))
  fs.writeFileSync(path.join(dir, 'storybook', 'brand.json'), JSON.stringify(pkg.brand))
  fs.writeFileSync(path.join(dir, 'storybook', 'policy.json'), JSON.stringify(pkg.editPolicy))
  return { dir, pkg, project, end }
}

// detect() for the tone fixture: the language whose tone is loudest in the
// render's mix from `offsetSeconds` (FFmpeg bandpass + volumedetect).
export async function toneDetector(file, { offsetSeconds = 0 } = {}) {
  const levels = Object.entries(TONES).map(([language, frequency]) => {
    const run = spawnSync(ffmpegPath, ['-hide_banner', '-nostats', '-ss', String(offsetSeconds), '-t', '1.5', '-i', file, '-vn', '-af', `bandpass=f=${frequency}:width_type=h:w=30,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' })
    const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(run.stderr)?.[1]
    return { language, db: mean == null || mean === '-inf' ? -Infinity : Number(mean) }
  }).sort((a, b) => b.db - a.db)
  const [loudest, next] = levels
  if (!(loudest.db > -60)) return { available: true, language: 'und', probability: 0, model: 'tone' }
  return { available: true, language: loudest.language, probability: Math.round(Math.min(1, (loudest.db - next.db) / 30) * 1000) / 1000, model: 'tone' }
}
