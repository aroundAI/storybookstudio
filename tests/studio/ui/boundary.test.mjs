// FILM-2015: a studio surface that throws must not unmount App (and with it
// Velorn's MCP action bridge). StudioBoundary catches, logs, and renders its
// fallback; "Try again" clears the error. Exercised on the class directly:
// react-dom/server does not run error boundaries.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const outDir = path.join(root, 'node_modules', '.cache', 'studio-ui-tests')
mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, 'boundary.mjs')
await build({ entryPoints: [path.join(root, 'src/components/studio/StudioBoundary.jsx')], bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', outfile, logLevel: 'silent', external: ['react', 'react/jsx-runtime'] })
writeFileSync(path.join(outDir, 'package.json'), '{"type":"module"}')
const { default: StudioBoundary } = await import(pathToFileURL(outfile).href)

test('a thrown error switches the boundary to its fallback and is logged with the surface name', () => {
  const logged = []
  const original = console.error
  console.error = (...args) => logged.push(args.join(' '))
  try {
    const boundary = new StudioBoundary({ name: 'ai-panel', fallback: 'FALLBACK', children: 'CHILD' })
    assert.equal(boundary.render(), 'CHILD')
    boundary.state = { ...boundary.state, ...StudioBoundary.getDerivedStateFromError(new Error('bad payload')) }
    boundary.componentDidCatch(new Error('bad payload'), { componentStack: '' })
    const fallback = boundary.render()
    assert.notEqual(fallback, 'CHILD')
    assert.match(JSON.stringify(fallback.props), /FALLBACK/)
    assert.ok(logged.some((line) => /ai-panel/.test(line) && /bad payload/.test(line)))
  } finally {
    console.error = original
  }
})

test('without a fallback the boundary shows a small notice with Try again, which clears the error', () => {
  const boundary = new StudioBoundary({ name: 'scene-strip', children: 'CHILD' })
  let next = null
  boundary.setState = (patch) => { next = { ...boundary.state, ...patch } }
  boundary.state = { ...boundary.state, ...StudioBoundary.getDerivedStateFromError(new Error('x')) }
  const notice = boundary.render()
  assert.equal(notice.props['data-test'], 'studio-boundary')
  assert.equal(notice.props.role, 'alert')
  const retry = notice.props.children.find((child) => child?.props?.onClick)
  retry.props.onClick()
  assert.equal(next.error, null)
})
