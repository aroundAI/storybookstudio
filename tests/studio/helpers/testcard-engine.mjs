// FILM-2018 tests: a composition engine that needs no browser. It draws the
// brand's primary colour as a box (40% x 30% of the frame, centred) on a
// transparent frame and encodes it as the Remotion engine does: VP9,
// yuva420p, in a WebM. Tests only; the app's engine is Remotion.
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
export const FFMPEG = require('ffmpeg-static')
const run = promisify(execFile)

export const BOX = { x: 0.3, y: 0.35, w: 0.4, h: 0.3 }

// `boxFrom`: the box appears that many seconds into the render (a render
// that changes over time, for trim checks).
export function createTestcardEngine({ onStart = () => {}, onEnd = () => {}, delayMs = 0, fail = () => false, boxFrom = 0 } = {}) {
  const calls = []
  return {
    calls,
    async render(job) {
      calls.push(job)
      onStart(job)
      try {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
        if (fail(job)) throw Object.assign(new Error('testcard failure'), { code: 'RENDER_FAILED' })
        const colour = String(job.brand['colors.primary'] || '#2563EB').slice(1, 7)
        const { width: W, height: H } = job
        // drawbox leaves alpha alone on a yuva frame, so the box is a second
        // (opaque) source overlaid on the transparent one.
        const graph = `color=c=black@0.0:s=${W}x${H}:r=${job.fps}:d=${job.durationSeconds},format=rgba[bg];`
          + `color=c=0x${colour}:s=${Math.round(W * BOX.w)}x${Math.round(H * BOX.h)}:r=${job.fps}:d=${job.durationSeconds},format=rgba[box];`
          + `[bg][box]overlay=x=${Math.round(W * BOX.x)}:y=${Math.round(H * BOX.y)}:format=auto:enable='gte(t,${boxFrom})',format=yuva420p[out]`
        await run(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-filter_complex', graph, '-map', '[out]',
          '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '0', '-crf', '30', job.outputPath])
        return job.outputPath
      } finally {
        onEnd(job)
      }
    },
  }
}
