// FILM-2018: renders a composition clip to an alpha WebM once, and finds it
// again after that.
//
//   resolve(request)  the render key: {propsHash, renderPath, cached}
//   render(request)   the file: a cache hit returns at once; a miss joins a
//                     queue that renders one composition at a time, in the
//                     order asked, and two asks for the same key share one
//                     render
//
// request = {projectDir, engine, compositionId, props, durationSeconds,
// width, height, fps}. The brand is read here, from the project's
// storybook/brand.json, so it is part of every key (src/studio/compositions/key.js):
// a brand change gives a new key, and the clip renders again.
//
// The engine draws the picture. Its interface is one call:
//
//   engine.render({compositionId, props, brand, durationSeconds, width,
//                  height, fps, outputPath, signal}) -> outputPath
//
// writing a WebM with an alpha channel (VP9, yuva420p) to outputPath. This
// module writes to a temporary name and renames it into place, so a file at
// compositions/<id>-<hash>.webm is always a finished render. The app's
// engine is Remotion (compositionEngines/remotion.js, Chrome Headless Shell);
// the tests also pass a test-card engine (tests/studio/helpers/testcard-engine.mjs).
//
// Imports nothing from Electron; runs under `node --test`.
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const { pathToFileURL } = require('url')

const studioModule = (relative) => import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'studio', relative)).href)
const BRAND_FILE = path.join('storybook', 'brand.json')

const failure = (code, message) => Object.assign(new Error(message), { code })

async function readProjectBrand(projectDir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(projectDir, BRAND_FILE), 'utf8'))
  } catch {
    return {}
  }
}

async function finishedFile(file) {
  try {
    const stat = await fsp.stat(file)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

function createCompositionRenderer({ engines = {}, readBrand = readProjectBrand, log = () => {} } = {}) {
  const engineMap = new Map(Object.entries(engines))
  let tail = Promise.resolve()
  let waiting = 0
  let modules = null
  const load = () => (modules ||= Promise.all([studioModule('compositions/key.js'), studioModule('compositions/catalogue.js')]).then(([key, catalogue]) => ({ key, catalogue })))

  async function resolve(request = {}) {
    const { projectDir, engine, compositionId, props, durationSeconds, width, height, fps } = request
    if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) throw failure('VALIDATION_FAILED', 'A composition render needs the open project folder.')
    if (!engineMap.has(engine)) throw failure('ENGINE_UNAVAILABLE', `No composition engine "${engine}" is installed.`)
    const { key, catalogue } = await load()
    const projectBrand = await readBrand(projectDir)
    const brand = catalogue.brandTokensFor(compositionId, projectBrand)
    const material = key.compositionKeyMaterial({ engine, compositionId, props, brand: projectBrand, durationSeconds, width, height, fps })
    // node:crypto, not key.sha256Hex: Electron 28's main process is Node 18,
    // which has no global Web Crypto. Same digest (a test checks it).
    const propsHash = crypto.createHash('sha256').update(material).digest('hex')
    const renderPath = key.compositionRenderPath(compositionId, propsHash)
    const file = path.join(projectDir, ...renderPath.split('/'))
    return {
      propsHash,
      renderPath,
      file,
      cached: await finishedFile(file),
      job: { engine, compositionId, props: catalogue.resolveCompositionProps(compositionId, props), brand, durationSeconds: Number(durationSeconds), width: Math.round(width), height: Math.round(height), fps: Number(fps) },
    }
  }

  async function runOne(resolved, signal) {
    const { file, job } = resolved
    if (await finishedFile(file)) return { cached: true, ms: 0 }
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const temporary = path.join(path.dirname(file), `.${path.basename(file, '.webm')}.${crypto.randomUUID()}.partial.webm`)
    const started = Date.now()
    try {
      await engineMap.get(job.engine).render({ ...job, outputPath: temporary, signal })
      if (!(await finishedFile(temporary))) throw failure('RENDER_FAILED', `The ${job.engine} engine wrote no file for ${job.compositionId}.`)
      await fsp.rename(temporary, file)
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => {})
    }
    return { cached: false, ms: Date.now() - started }
  }

  // The queue place is taken when render() is called, before the key is
  // worked out (that reads the brand and the disk), so renders run in the
  // order asked. A cache hit answers at once; a second ask for a key being
  // rendered waits its turn and then finds the file.
  function render(request = {}, { signal = null } = {}) {
    const resolving = resolve(request)
    waiting += 1
    const turn = tail.then(() => resolving).then((resolved) => runOne(resolved, signal)).finally(() => { waiting -= 1 })
    tail = turn.catch((error) => log(`[compositions] ${error?.message || error}`))
    return resolving.then((resolved) => {
      const result = (extra) => ({ propsHash: resolved.propsHash, renderPath: resolved.renderPath, file: resolved.file, ...extra })
      return resolved.cached ? result({ cached: true, ms: 0 }) : turn.then(result)
    })
  }

  return {
    resolve: async (request) => {
      const { propsHash, renderPath, cached } = await resolve(request)
      return { propsHash, renderPath, cached }
    },
    render,
    engines: () => [...engineMap.keys()],
    pending: () => waiting,
  }
}

module.exports = { createCompositionRenderer, readProjectBrand, BRAND_FILE }
