// Shared by the rough-cut builder tests: the FILM-2001 fixture packages and
// the probes FILM-2011's pull job would hand the builder for them.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const FIXTURE_SIZES = [5, 20, 60]

export const fixturePath = (shots) => new URL(`../fixtures/edit-package/${shots}-shots.json`, import.meta.url)
export const loadFixture = (shots) => JSON.parse(readFileSync(fixturePath(shots), 'utf8'))
export const snapshotPath = (shots) => new URL(`../fixtures/rough-cut/${shots}-shots.snapshot.json`, import.meta.url)

const folderFor = (mime) => (mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'images')

// Every downloadable slot probed at the length StoryBook planned, unless the
// caller leaves its key out (a download that has not happened).
export function probesFor(pkg, { skip = new Set(), duration = new Map() } = {}) {
  const probes = new Map()
  const add = (media, seconds) => {
    if (!media?.url || skip.has(media.key)) return
    const kind = folderFor(media.mime)
    probes.set(media.key, {
      path: `assets/${kind}/${media.key.split('/').pop()}`,
      duration: duration.get(media.key) ?? (kind === 'images' ? null : seconds),
      fps: kind === 'video' ? 24 : null,
      width: kind === 'audio' ? null : 1920,
      height: kind === 'audio' ? null : 1080,
      codecs: kind === 'video' ? { video: 'h264', audio: 'aac' } : kind === 'audio' ? { audio: 'mp3' } : null,
      hasAudio: kind !== 'images',
    })
  }
  for (const shot of pkg.shots) {
    add(shot.video, shot.sourceDurationSeconds)
    add(shot.firstFrame, null)
    add(shot.lastFrame, null)
  }
  for (const line of pkg.dialogue) add(line.audio, line.estimatedDurationSeconds)
  for (const dub of pkg.dubbed) for (const line of dub.lines) add(line.audio, line.durationSeconds)
  for (const track of pkg.audioTracks) add(track.media, track.durationSeconds)
  for (const character of pkg.characters) for (const image of character.referenceImages) add(image, null)
  return probes
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// What a snapshot holds: the whole project and warnings, the side files by hash.
export const snapshotOf = ({ project, files, warnings }) => ({
  project,
  warnings,
  files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, { bytes: Buffer.byteLength(text), sha256: sha256(text) }])),
})

export const clipsOn = (project, predicate) => project.timelines[0].clips.filter(predicate)
export const trackById = (project, id) => project.timelines[0].tracks.find((track) => track.id === id)
export const tracksWhere = (project, predicate) => project.timelines[0].tracks.filter(predicate)
