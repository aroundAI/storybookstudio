// FILM-2014 QA fixtures: renders with one planted fault each, made with
// FFmpeg, and minimal project documents for the document checks.
import { ff } from './review-media.mjs'

// A moving test picture with a tone loudness-normalised to `lufs`, and the
// faults asked for: black, frozen (a flat grey frame), silent or clipped
// stretches, each as [start, end] seconds.
export async function makeRender(file, { duration = 10, width = 1920, height = 1080, fps = 24, lufs = -14, black = null, freeze = null, silence = null, clip = null, vcodec = 'libx264', acodec = 'aac', audio = true } = {}) {
  const video = [`testsrc2=s=${width}x${height}:r=${fps}:d=${duration}`]
  const vf = []
  if (black) vf.push(`drawbox=x=0:y=0:w=iw:h=ih:c=black:t=fill:enable='between(t,${black[0]},${black[1]})'`)
  if (freeze) vf.push(`drawbox=x=0:y=0:w=iw:h=ih:c=gray:t=fill:enable='between(t,${freeze[0]},${freeze[1]})'`)
  const af = [`loudnorm=I=${lufs}:TP=-2:LRA=7`, 'aresample=48000']
  if (silence) af.push(`volume=0:enable='between(t,${silence[0]},${silence[1]})'`)
  if (clip) af.push(`volume=30dB:enable='between(t,${clip[0]},${clip[1]})'`)
  const args = ['-f', 'lavfi', '-i', video[0]]
  if (audio) args.push('-f', 'lavfi', '-i', `sine=f=440:d=${duration}:sample_rate=48000`)
  if (vf.length) args.push('-vf', vf.join(','))
  args.push('-c:v', vcodec)
  if (vcodec === 'libx264') args.push('-preset', 'ultrafast', '-pix_fmt', 'yuv420p')
  if (audio) args.push('-af', af.join(','), '-ac', '2', '-c:a', acodec, '-b:a', '192k')
  args.push('-t', String(duration), file)
  await ff(args)
  return file
}

const FRAME = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] }

// One timeline: a picture clip per entry of `shots` ({assetId, start,
// duration, scene, offline?, path?}), optional captions clip, assets to match.
export function miniProject({ aspect = '16:9', shots = [], captions = null, extraClips = [], extraAssets = [], fps = 24 } = {}) {
  const [width, height] = FRAME[aspect]
  const assets = shots.map((shot, i) => ({
    id: shot.assetId || `asset-${i + 1}`,
    name: `Shot ${i + 1}`,
    type: 'video',
    role: 'generated_video',
    path: shot.offline ? null : shot.path ?? `assets/video/shot-${i + 1}.mp4`,
    offline: shot.offline ? { reason: 'not_generated' } : undefined,
    semantic: { scene: shot.scene ?? 1, shotId: `shot-${i + 1}`, characters: shot.characters || [] },
  }))
  const clips = shots.map((shot, i) => ({
    id: `clip-${i + 1}`,
    trackId: 'video-1',
    assetId: assets[i].id,
    name: `S${shot.scene ?? 1}.${i + 1} shot`,
    type: 'video',
    startTime: shot.start,
    duration: shot.duration,
    trimStart: 0,
    speed: 1,
    enabled: true,
    metadata: { semantic: { scene: shot.scene ?? 1, shotId: `shot-${i + 1}`, role: 'generated_video' }, origin: { versionId: null, opId: null, by: 'ai' }, storybook: shot.dialogueId ? { dialogueId: shot.dialogueId } : undefined },
  }))
  const tracks = [{ id: 'video-1', type: 'video', name: 'Shots', visible: true }]
  if (captions) {
    tracks.unshift({ id: 'video-2', type: 'video', name: 'Captions', role: 'captions', visible: true, language: 'en' })
    clips.push({
      id: 'clip-captions',
      trackId: 'video-2',
      assetId: null,
      type: 'captions',
      startTime: 0,
      duration: captions.duration,
      trimStart: 0,
      enabled: true,
      transform: { positionX: 0, positionY: captions.positionY ?? 0 },
      metadata: { semantic: { scene: null, role: 'caption' }, language: 'en', origin: { by: 'ai' } },
      captions: { preset: { id: captions.preset || 'kinetic-traditional' }, cues: captions.cues },
    })
  }
  return {
    name: 'QA fixture',
    version: '1.2',
    currentTimelineId: 'tl-1',
    settings: { width, height, fps },
    assets: [...assets, ...extraAssets],
    timelines: [{ id: 'tl-1', width, height, fps, tracks, clips: [...clips, ...extraClips], markers: [], studio: { kind: 'master', aspect, language: 'en' } }],
    studio: { schema: 'editgraph/1' },
  }
}
