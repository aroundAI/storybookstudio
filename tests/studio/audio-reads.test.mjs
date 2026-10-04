// FILM-2013: compile-time audio reads run in the main process with ffmpeg
// (electron/studio/audioReads.js), because Chromium's decodeAudioData
// segfaults the renderer on some macOS/Electron combinations and took the
// window and the MCP bridge down on the first studio_edit of a project with
// its media on disk. Real ffmpeg (ffmpeg-static), real files.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { connectSdkClient, loadRendererModules, parseToolResult, startStudioHarness } from './helpers/studio-harness.mjs'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const { createAudioReads, parseSilences } = require('../../electron/studio/audioReads.js')
const work = mkdtempSync(path.join(os.tmpdir(), 'studio-audio-reads-'))
after(() => rmSync(work, { recursive: true, force: true }))

// tone, silence, tone, silence... as a WAV: [['tone'|'silence', seconds], ...]
function writeAudio(file, parts) {
  const inputs = parts.flatMap(([kind, seconds]) => ['-f', 'lavfi', '-t', String(seconds), '-i', kind === 'tone' ? 'sine=frequency=440:sample_rate=22050' : 'anullsrc=r=22050:cl=mono'])
  const filter = `${parts.map((_, index) => `[${index}:a]`).join('')}concat=n=${parts.length}:v=0:a=1[out]`
  mkdirSync(path.dirname(file), { recursive: true })
  const run = spawnSync(ffmpegPath, ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-ac', '1', file])
  assert.equal(run.status, 0, String(run.stderr))
}

test('silencedetect output parses into spans, an unterminated one closed at the window end', () => {
  assert.deepEqual(parseSilences('[silencedetect @ 0x1] silence_start: 0.5\n[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1\n[silencedetect] silence_start: 2.2\n', 3), [{ start: 0.5, end: 1.5 }, { start: 2.2, end: 3 }])
})

test('a clip\'s silences come back in timeline seconds, through its trim and speed, with loudness when asked', async () => {
  const file = path.join(work, 'line.wav')
  writeAudio(file, [['tone', 1], ['silence', 1], ['tone', 1], ['silence', 1]])
  const reads = createAudioReads({ getFfmpegPath: () => ffmpegPath })
  const result = await reads.analyzeClip({ clipId: 'c1', file, trimStart: 0.5, trimEnd: 4, startTime: 10, timeScale: 2, loudness: true })
  assert.equal(result.success, true, result.warning)
  // Source 1.0-2.0 and 3.0-4.0 are silent; the window starts at 0.5 s and plays at 2x from 10 s.
  const spans = result.clip.silencesTimeline.map((span) => [Math.round(span.start * 10) / 10, Math.round(span.end * 10) / 10])
  assert.deepEqual(spans, [[10.3, 10.8], [11.3, 11.8]])
  assert.ok(Number.isFinite(result.loudness.integratedLufsApprox), JSON.stringify(result.analysis))
  const missing = await reads.analyzeClip({ clipId: 'c2', file: path.join(work, 'nope.wav'), trimStart: 0, trimEnd: 1, startTime: 0, timeScale: 1 })
  assert.equal(missing.success, false)
  assert.equal((await createAudioReads({ getFfmpegPath: () => null }).analyzeClip({ clipId: 'c3', file })).success, false)
})

test('studio_edit over MCP takes its silences from ffmpeg in the main process; the renderer never decodes audio', async () => {
  const m = await loadRendererModules()
  const rendererReads = []
  const reads = createAudioReads({ getFfmpegPath: () => ffmpegPath })
  // Every scene-3 line: 1.1 s of speech, then 0.5 s of silence inside the clip (silencedetect's minimum is 0.35 s).
  const harness = await startStudioHarness(m, {
    runRead: async (tool, args) => { rendererReads.push(args.clipId); throw new Error('the renderer must not decode audio') },
    analyzeAudio: (item) => reads.analyzeClip(item),
    beforeOpen: ({ dir, project }) => {
      const timeline = project.timelines[0]
      const assets = new Map(project.assets.map((asset) => [asset.id, asset]))
      for (const clip of timeline.clips.filter((candidate) => candidate.metadata?.semantic?.role === 'dialogue' && candidate.metadata.semantic.scene === 3)) {
        writeAudio(path.join(dir, assets.get(clip.assetId).path), [['tone', 1.1], ['silence', 0.5]])
      }
    },
  })
  const client = await connectSdkClient(harness)
  try {
    const result = await client.callTool({ name: 'studio_edit', arguments: { intent: 'tighten_pacing', scope: { scene: 3 }, params: { targetSeconds: 12 } } })
    const body = parseToolResult(result)
    assert.equal(result.isError, undefined, JSON.stringify(body.error))
    assert.deepEqual(rendererReads, [])
    assert.deepEqual([body.reads.requested, body.reads.failed.length], [8, 0])
    const card = body.cards.find((entry) => entry.scene === 3)
    // The silences inside the lines let the plan reach the target it could not reach on gaps alone (13.9 s).
    assert.ok(Math.abs(card.durationAfter - 12) <= 0.6, `scene 3 after ${card.durationAfter}`)
    assert.ok(card.notes.some((note) => /within 5% of the 12\.0 s target/.test(note)), JSON.stringify(card.notes))
  } finally {
    await client.close()
    await harness.close()
    await m.vite.close()
  }
})
