// KB-190: get_audio_analysis decoded audio in the renderer with Web Audio's
// decodeAudioData, which segfaults the Studio window's renderer on some
// macOS/Electron combinations (any input) and, on any machine, allocates a
// whole long file at its native rate in the window. The analysis now runs
// outside the window: ffmpeg decodes the analysed range and the same DSP runs
// on that PCM in a utility process (electron/studio/audioReads.js
// analyzeFile). Real ffmpeg (ffmpeg-static), real files.
import assert from 'node:assert/strict'
import { fork, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import vm from 'node:vm'

import { connectSdkClient, loadRendererModules, parseToolResult, startStudioHarness } from './helpers/studio-harness.mjs'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const { createAudioReads, utilityProcessAnalysis, MAX_ANALYSIS_SECONDS } = require('../../electron/studio/audioReads.js')
const work = mkdtempSync(path.join(os.tmpdir(), 'studio-audio-analysis-'))
after(() => rmSync(work, { recursive: true, force: true }))

const ffmpeg = (args) => {
  const run = spawnSync(ffmpegPath, ['-y', '-loglevel', 'error', ...args])
  assert.equal(run.status, 0, String(run.stderr))
}

// [['tone'|'silence', seconds], ...] at 44.1 kHz stereo, as the file's extension says.
function writeAudio(file, parts) {
  const inputs = parts.flatMap(([kind, seconds]) => ['-f', 'lavfi', '-t', String(seconds), '-i', kind === 'tone' ? 'sine=frequency=440:sample_rate=44100' : 'anullsrc=r=44100:cl=stereo'])
  const filter = `${parts.map((_, index) => `[${index}:a]`).join('')}concat=n=${parts.length}:v=0:a=1[out]`
  mkdirSync(path.dirname(file), { recursive: true })
  ffmpeg([...inputs, '-filter_complex', filter, '-map', '[out]', '-ac', '2', file])
}

const reads = createAudioReads({ getFfmpegPath: () => ffmpegPath })

test('get_audio_analysis over MCP answers from ffmpeg outside the window; the window never calls decodeAudioData', async () => {
  const m = await loadRendererModules()
  let clipId = null
  const harness = await startStudioHarness(m, {
    beforeOpen: ({ dir, project }) => {
      const clip = project.timelines[0].clips.find((candidate) => candidate.metadata?.semantic?.role === 'dialogue')
      clipId = clip.id
      const asset = project.assets.find((candidate) => candidate.id === clip.assetId)
      // The line is 1.6 s: speech, a 0.5 s pause at 0.4-0.9 s, speech.
      writeAudio(path.join(dir, asset.path), [['tone', 0.4], ['silence', 0.5], ['tone', 1]])
    },
  })
  // The desktop window: the preload's bridge, and a Web Audio whose decoder
  // stands in for the one that kills the renderer.
  const decodes = []
  const api = globalThis.window.electronAPI
  api.isElectron = true
  api.readFileAsBuffer = async (file) => {
    const bytes = await readFile(path.isAbsolute(file) ? file : path.join(harness.dir, file))
    return { success: true, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  }
  api.analyzeAudioFile = (file, options) => reads.analyzeFile(file, options)
  globalThis.window.AudioContext = class {
    decodeAudioData(bytes) {
      decodes.push(bytes.byteLength)
      return Promise.reject(new Error('renderer crashed: EXC_BAD_ACCESS in decodeAudioData'))
    }
  }
  const client = await connectSdkClient(harness, { profile: 'expert' })
  try {
    const result = await client.callTool({ name: 'get_audio_analysis', arguments: { clipId } })
    assert.deepEqual(decodes, [], `the renderer decoded audio: ${result.content[0].text}`)
    assert.equal(result.isError, undefined, result.content[0].text)
    const body = parseToolResult(result).result
    assert.equal(body.success, true, JSON.stringify(body))
    const clip = m.timelineStore.useTimelineStore.getState().clips.find((candidate) => candidate.id === clipId)
    assert.equal(Number(clip.trimStart) || 0, 0)
    assert.equal(body.analysis.silences.length, 1, JSON.stringify(body.analysis.silences))
    const [pause] = body.analysis.silences
    assert.ok(Math.abs(pause.start - 0.4) <= 0.06 && Math.abs(pause.end - 0.9) <= 0.06, JSON.stringify(pause))
    const [onTimeline] = body.clip.silencesTimeline
    assert.ok(Math.abs(onTimeline.start - (clip.startTime + pause.start)) < 0.01, JSON.stringify(body.clip))
    assert.ok(Number.isFinite(body.analysis.loudness.integratedLufsApprox), JSON.stringify(body.analysis.loudness))
    assert.equal(body.analysis.decodedBy, 'ffmpeg, outside the window')
  } finally {
    await client.close()
    await harness.close()
    await m.vite.close()
    delete globalThis.window.AudioContext
  }
})

test('analyzeFile returns analyzeAudioBuffer\'s full shape: a 120 BPM click has its tempo, beats, silences and loudness', async () => {
  const file = path.join(work, 'click.m4a')
  // 8 s of a 120 BPM click (a 30 ms 1 kHz burst every 0.5 s), then 2 s of silence.
  ffmpeg(['-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,0.5),0.03),0.8*sin(2*PI*1000*t),0)':s=48000:d=8", '-f', 'lavfi', '-t', '2', '-i', 'anullsrc=r=48000:cl=mono',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]', '-map', '[out]', '-c:a', 'aac', '-b:a', '128k', file])
  const result = await reads.analyzeFile(file, {})
  assert.equal(result.success, true, result.error)
  const { analysis } = result
  for (const key of ['duration', 'sampleRate', 'channels', 'loudness', 'bpm', 'beatConfidence', 'beats', 'beatsTruncated', 'onsets', 'onsetsTruncated', 'silences', 'loudnessCurve']) {
    assert.ok(key in analysis, key)
  }
  assert.ok(Math.abs(analysis.duration - 10) < 0.1, String(analysis.duration))
  assert.ok(Math.abs(analysis.bpm - 120) <= 2 || Math.abs(analysis.bpm - 60) <= 1 || Math.abs(analysis.bpm - 240) <= 4, `bpm ${analysis.bpm}`)
  assert.ok(analysis.beats.length >= 8, `${analysis.beats.length} beats`)
  assert.ok(analysis.silences.some((span) => span.start <= 8.2 && span.end >= 9.8), JSON.stringify(analysis.silences))
  assert.ok(analysis.loudness.peakDb > -6 && analysis.loudness.peakDb < 0.5, String(analysis.loudness.peakDb))
  assert.ok(Number.isFinite(analysis.loudness.integratedLufsApprox))
  // A range is decoded alone: 2-4 s of the click has no silence and is 2 s long.
  const range = await reads.analyzeFile(file, { startSeconds: 2, endSeconds: 4, includeLoudnessCurve: false })
  assert.equal(range.success, true, range.error)
  assert.ok(Math.abs(range.analysis.duration - 2) < 0.05, String(range.analysis.duration))
  assert.equal('loudnessCurve' in range.analysis, false)
})

test('a source longer than the limit is refused, not decoded whole; a range inside it is analysed', async () => {
  const file = path.join(work, 'long.m4a')
  const seconds = MAX_ANALYSIS_SECONDS + 60
  ffmpeg(['-f', 'lavfi', '-t', String(seconds), '-i', 'sine=frequency=220:sample_rate=8000', '-c:a', 'aac', '-b:a', '16k', file])
  const before = process.memoryUsage().arrayBuffers
  const whole = await reads.analyzeFile(file, {})
  assert.equal(whole.success, false)
  assert.match(whole.error, /longer than 30 minutes/)
  // Stopped at the limit: well under a whole decode of the file at the analysis rate.
  assert.ok(process.memoryUsage().arrayBuffers - before < 400 * 1024 * 1024)
  const tooLong = await reads.analyzeFile(file, { startSeconds: 0, endSeconds: seconds })
  assert.match(tooLong.error, /at most 30 minutes/)
  const clip = await reads.analyzeFile(file, { startSeconds: 1500, endSeconds: 1510 })
  assert.equal(clip.success, true, clip.error)
  assert.ok(Math.abs(clip.analysis.duration - 10) < 0.05)
  assert.equal(clip.analysis.silences.length, 0)
})

test('a file with no audio, or none at all, is an answer, not a crash', async () => {
  const video = path.join(work, 'silent-video.mp4')
  ffmpeg(['-f', 'lavfi', '-t', '1', '-i', 'color=c=black:s=64x64:r=10', '-pix_fmt', 'yuv420p', video])
  const noAudio = await reads.analyzeFile(video, {})
  assert.equal(noAudio.success, false)
  assert.ok(noAudio.error)
  const missing = await reads.analyzeFile(path.join(work, 'nope.wav'), {})
  assert.equal(missing.success, false)
  assert.equal((await createAudioReads({ getFfmpegPath: () => null }).analyzeFile(video, {})).success, false)
})

// Electron's utilityProcess, as Node's child_process.fork with process.parentPort
// shimmed: the real electron/studio/audioAnalysisProcess.js in a real child.
const shim = path.join(work, 'parent-port-shim.cjs')
writeFileSync(shim, "process.parentPort = { once: (event, fn) => process.once(event, (data) => fn({ data })), postMessage: (message) => process.send(message) }\n")
const fakeUtilityProcess = {
  forked: [],
  fork(modulePath, args, options) {
    this.forked.push({ modulePath: path.basename(modulePath), serviceName: options?.serviceName })
    const child = fork(modulePath, args, { execArgv: ['--require', shim], stdio: 'ignore' })
    child.postMessage = (message) => child.send(message)
    return child
  },
}

test('in the app the analysis runs in a utility process that answers and is ended', async () => {
  const file = path.join(work, 'utility.wav')
  writeAudio(file, [['tone', 0.5], ['silence', 0.6], ['tone', 0.5]])
  const utility = createAudioReads({ getFfmpegPath: () => ffmpegPath, runAnalysis: utilityProcessAnalysis(fakeUtilityProcess) })
  const [first, second] = await Promise.all([utility.analyzeFile(file, {}), utility.analyzeFile(file, { startSeconds: 0.5 })])
  assert.deepEqual(fakeUtilityProcess.forked, [{ modulePath: 'audioAnalysisProcess.js', serviceName: 'Audio analysis' }, { modulePath: 'audioAnalysisProcess.js', serviceName: 'Audio analysis' }])
  assert.equal(first.success, true, first.error)
  assert.ok(Math.abs(first.analysis.silences[0].start - 0.5) <= 0.06 && Math.abs(first.analysis.silences[0].end - 1.1) <= 0.06, JSON.stringify(first.analysis.silences))
  assert.ok(Math.abs(second.analysis.silences[0].start) <= 0.06, JSON.stringify(second.analysis.silences))
  const missing = await utility.analyzeFile(path.join(work, 'nope.wav'), {})
  assert.equal(missing.success, false)
})

test('the preload exposes analyzeAudioFile on the media:analyzeAudio channel', () => {
  const source = readFileSync(new URL('../../electron/preload.js', import.meta.url), 'utf8')
  const exposed = {}
  const invoked = []
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api } },
    ipcRenderer: { invoke: (...args) => { invoked.push(args); return Promise.resolve() }, on: () => {}, removeListener: () => {}, send: () => {} },
    webUtils: { getPathForFile: () => '' },
  }
  const sandbox = { require: (name) => (name === 'electron' ? electron : {}), process: { platform: 'darwin', versions: {}, env: {} }, console, module: {}, exports: {} }
  vm.runInNewContext(source, sandbox, { filename: 'preload.js' })
  exposed.electronAPI.analyzeAudioFile('/media/line.wav', { startSeconds: 1 })
  assert.deepEqual(invoked.at(-1), ['media:analyzeAudio', '/media/line.wav', { startSeconds: 1 }])
  assert.match(readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8'), /ipcMain\.handle\('media:analyzeAudio'[\s\S]{0,400}audioReads\.analyzeFile/)
})
