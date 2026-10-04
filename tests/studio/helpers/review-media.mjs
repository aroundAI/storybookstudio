// FILM-2014 test media: real files made with FFmpeg's testsrc2/sine/anoisesrc
// sources, and the 20-shot rough cut (FILM-2012 B's buildProject over the
// FILM-2001 fixture package) with every downloadable slot written to disk.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { buildProject } from '../../../src/studio/projectBuilder.js'
import { loadFixture, probesFor } from './rough-cut.mjs'

const require = createRequire(import.meta.url)
export const FFMPEG = require('ffmpeg-static')
export const FFPROBE = require('@derhuerst/ffprobe-static')
const run = promisify(execFile)

export async function ff(args) {
  try {
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`ffmpeg ${args.join(' ')}\n${error.stderr || error.message}`)
  }
}

export const tempDir = (label) => mkdtemp(path.join(os.tmpdir(), `sbs-2014-${label}-`))
export const removeDir = (dir) => rm(dir, { recursive: true, force: true })

// A moving test picture (hue-shifted per `hue`) with an optional tone.
export async function makeVideo(file, { duration, width = 320, height = 180, fps = 24, hue = 0, toneHz = 220, toneDb = -30, audio = true } = {}) {
  await mkdir(path.dirname(file), { recursive: true })
  const args = ['-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=${fps}:d=${duration}`]
  if (audio) args.push('-f', 'lavfi', '-i', `sine=f=${toneHz}:d=${duration}:sample_rate=48000`)
  args.push('-vf', `hue=h=${hue}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '12')
  if (audio) args.push('-af', `volume=${toneDb + 18}dB`, '-c:a', 'aac', '-b:a', '96k', '-ac', '2')
  args.push('-shortest', file)
  await ff(args)
}

// A tone (or pink noise) at roughly `db` dBFS RMS. FFmpeg's sine source is
// -18 dBFS peak, so the gain is relative to that.
export async function makeAudio(file, { duration, freq = 440, db = -20, noise = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true })
  const source = noise ? `anoisesrc=c=pink:d=${duration}:a=0.5:r=48000` : `sine=f=${freq}:d=${duration}:sample_rate=48000`
  const gain = noise ? db + 9 : db + 18 + 3
  const ext = path.extname(file).toLowerCase()
  const codec = ext === '.wav' ? ['-c:a', 'pcm_s16le'] : ext === '.mp3' ? ['-c:a', 'libmp3lame', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '128k']
  await ff(['-f', 'lavfi', '-i', source, '-af', `volume=${gain}dB`, '-ac', '2', ...codec, file])
}

export async function makeImage(file, { width = 320, height = 180, color = 'navy' } = {}) {
  await mkdir(path.dirname(file), { recursive: true })
  await ff(['-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:d=0.1`, '-frames:v', '1', file])
}

async function pool(tasks, limit = 8) {
  let next = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < tasks.length) {
      const index = next
      next += 1
      await tasks[index]()
    }
  }))
}

// Media for every downloadable asset of a built rough cut, written under
// `projectDir` at the asset's own path. Levels are a sensible mix: dialogue
// near -16 dBFS, music bed -30, ambience -45.
export async function writeMediaFor(project, projectDir, { levels = {}, width = 320, height = 180 } = {}) {
  const level = { dialogue: -16, music: -30, sfx: -24, ambience: -45, shotaudio: -34, ...levels }
  const tasks = []
  for (const asset of project.assets) {
    if (!asset.path || asset.offline) continue
    const file = path.join(projectDir, asset.path)
    const n = Number(/(\d+)/.exec(path.basename(asset.path))?.[1] || 1)
    if (asset.type === 'video') tasks.push(() => makeVideo(file, { duration: asset.duration, width, height, hue: (n * 37) % 360, toneDb: level.shotaudio }))
    else if (asset.type === 'image') tasks.push(() => makeImage(file, { width, height }))
    else if (asset.role === 'dialogue') tasks.push(() => makeAudio(file, { duration: asset.duration, freq: 300 + (n % 5) * 40, db: level.dialogue }))
    else if (asset.role === 'music') tasks.push(() => makeAudio(file, { duration: asset.duration, freq: 220, db: level.music }))
    else if (asset.role === 'ambience') tasks.push(() => makeAudio(file, { duration: asset.duration, noise: true, db: level.ambience }))
    else tasks.push(() => makeAudio(file, { duration: asset.duration, freq: 1000, db: level.sfx }))
  }
  await pool(tasks)
}

// The 20-shot rough cut with its media on disk under `projectDir`.
export async function buildMediaProject(projectDir, { shots = 20, levels = {}, width = 320, height = 180 } = {}) {
  const pkg = loadFixture(shots)
  const { project, files } = buildProject({ package: pkg, probedAssets: probesFor(pkg) })
  await writeMediaFor(project, projectDir, { levels, width, height })
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(projectDir, rel)), { recursive: true })
    await writeFile(path.join(projectDir, rel), text)
  }
  return { project, pkg, projectDir, policy: JSON.parse(files['storybook/policy.json']) }
}

// The offline clips of the fixture (shot 20 not generated, dialogue 3
// missing, two lines not generated) removed, as a user would before
// delivering: what is left is a cut QA can pass.
export function withoutOfflineClips(project) {
  const offline = new Set(project.assets.filter((asset) => asset.offline || !asset.path).map((asset) => asset.id))
  const timeline = project.timelines[0]
  return {
    ...project,
    timelines: [{ ...timeline, clips: timeline.clips.filter((clip) => !offline.has(clip.assetId)) }, ...project.timelines.slice(1)],
  }
}

export const clone = (value) => JSON.parse(JSON.stringify(value))
