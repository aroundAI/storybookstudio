// FILM-2018: the Remotion engine behind compositionRenderer.js's engine
// interface. It renders a catalogue primitive from the prebuilt bundle
// (dist-compositions/, scripts/build-compositions.mjs) in Remotion's Chrome
// Headless Shell to a VP9 WebM with alpha (yuva420p).
//
// Licence (owner, 2026-10-05): Remotion's Free License, for a company of one;
// StorybookStudio is an internal tool and no build that contains Remotion is
// conveyed. No licence key is sent: renderMedia() with a key reports a usage
// event to remotion.pro on every render, and this engine makes no outbound
// request.
//
// One browser is opened on the first render and kept for the next ones (a
// cold start costs about a second); close() shuts it.
const fs = require('fs')
const path = require('path')

const ENGINE = 'remotion'

// Remotion's VP9 stitch uses libvpx's default (good) deadline: a 4 s 1080p
// counter took 24 s to encode on an M-series Mac, against 1.4 s to capture.
// Realtime at cpu-used 8 encodes it in under a second; flat graphics lose
// nothing visible (FILM-2018 measurement in the PR).
const VP9_FAST_ARGS = ['-deadline', 'realtime', '-cpu-used', '8']
const fastVp9 = ({ type, args }) => (type === 'stitcher' && args.includes('libvpx-vp9') ? [...args.slice(0, -1), ...VP9_FAST_ARGS, args.at(-1)] : args)

function createRemotionEngine({ serveUrl, browserExecutable = null, binariesDirectory = null, concurrency = null, renderer = null } = {}) {
  let browser = null
  const remotion = () => renderer || require('@remotion/renderer')

  async function ensureOpen() {
    if (browser) return browser
    browser = remotion().openBrowser('chrome', { browserExecutable, logLevel: 'error', chromeMode: 'headless-shell' })
    try {
      return await browser
    } catch (error) {
      browser = null
      throw error
    }
  }

  async function render({ compositionId, props, brand, durationSeconds, width, height, fps, fit = null, outputPath, signal = null }) {
    const bundle = typeof serveUrl === 'function' ? await serveUrl() : serveUrl
    if (!bundle || !fs.existsSync(path.join(bundle, 'index.html'))) {
      throw Object.assign(new Error('The composition bundle is missing; run npm run build:compositions.'), { code: 'ENGINE_UNAVAILABLE' })
    }
    const { selectComposition, renderMedia, makeCancelSignal } = remotion()
    const inputProps = { props, brand, render: { durationSeconds, width, height, fps }, ...(fit ? { fit } : {}) }
    const puppeteerInstance = await ensureOpen()
    const common = { serveUrl: bundle, inputProps, puppeteerInstance, browserExecutable, binariesDirectory, logLevel: 'error', chromeMode: 'headless-shell' }
    const composition = await selectComposition({ ...common, id: compositionId })
    const cancel = makeCancelSignal()
    const onAbort = () => cancel.cancel()
    signal?.addEventListener?.('abort', onAbort)
    try {
      await renderMedia({
        ...common,
        composition,
        codec: 'vp9',
        imageFormat: 'png',
        pixelFormat: 'yuva420p',
        muted: true,
        enforceAudioTrack: false,
        outputLocation: outputPath,
        overwrite: true,
        concurrency,
        cancelSignal: cancel.cancelSignal,
        ffmpegOverride: fastVp9,
      })
    } finally {
      signal?.removeEventListener?.('abort', onAbort)
    }
    return outputPath
  }

  async function close() {
    const open = browser
    browser = null
    if (open) await (await open).close({ silent: true }).catch(() => {})
  }

  return { name: ENGINE, render, close }
}

// Where the packaged app keeps what the engine reads (package.json "build":
// extraResources per platform, outside app.asar like the bundled FFmpeg);
// null paths fall back to Remotion's own lookup, which is right in
// development.
function packagedRemotionPaths({ isPackaged, resourcesPath, platform = process.platform, arch = process.arch }) {
  const bundle = isPackaged ? path.join(resourcesPath, 'compositions') : path.join(__dirname, '..', '..', '..', 'dist-compositions')
  if (!isPackaged) return { serveUrl: bundle, browserExecutable: null, binariesDirectory: null }
  const shell = platform === 'darwin' ? `chrome-headless-shell-mac-${arch === 'arm64' ? 'arm64' : 'x64'}` : platform === 'win32' ? 'chrome-headless-shell-win64' : 'chrome-headless-shell-linux64'
  const binary = platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'
  return {
    serveUrl: bundle,
    browserExecutable: path.join(resourcesPath, 'remotion-browser', shell, binary),
    binariesDirectory: path.join(resourcesPath, 'remotion-compositor'),
  }
}

module.exports = { createRemotionEngine, packagedRemotionPaths, fastVp9, ENGINE }
