// FILM-2018 AC6: choose_visual_representation {sceneOrPoint} ranks
// generated_video, stock_video, archival_image, chart, map, diagram,
// timeline and text_graphic with a one-line reason each, and leaves the
// choice to the agent; a drawn graphic is handed to studio_add_graphic.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { VISUAL_KINDS, chooseVisualRepresentation } from '../../src/studio/visualRepresentation.js'
import { contextFor } from './helpers/compile-fixture.mjs'

const top = (result) => result.ranked[0].kind

test('every kind is ranked once with a one-line reason; nothing is decided or changed', () => {
  const context = contextFor()
  const before = JSON.stringify(context.timeline)
  const result = chooseVisualRepresentation(context, { scene: 2 })
  assert.deepEqual([...result.ranked.map((entry) => entry.kind)].sort(), [...VISUAL_KINDS].sort())
  assert.ok(result.ranked.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0 && !entry.reason.includes('\n')))
  assert.ok(result.ranked.every((entry, index) => index === 0 || result.ranked[index - 1].score >= entry.score), 'ranked by score')
  assert.equal(result.decidedBy, 'agent')
  assert.equal(JSON.stringify(context.timeline), before)
  // The fixture's scene is people talking in a lab: its own footage first.
  assert.equal(top(result), 'generated_video')
  assert.match(result.ranked[0].reason, /The scene already has 4 generated shots/)
  assert.deepEqual(chooseVisualRepresentation(contextFor(), { scene: 2 }), result, 'deterministic')
})

test('a geographic point ranks map first, a comparison chart, dates timeline, one figure a counter; each hands off to studio_add_graphic', () => {
  const context = contextFor()
  const map = chooseVisualRepresentation(context, { text: 'The route ran across the border from the coast to the city in the north', scene: 3 })
  assert.equal(top(map), 'map')
  assert.match(map.ranked[0].reason, /Place words "route", "across", "border"/)
  assert.deepEqual(map.ranked[0].act.tool, 'studio_add_graphic')
  assert.equal(map.ranked[0].act.arguments.kind, 'map')
  assert.equal(map.ranked[0].act.arguments.at, 39, 'placed at the scene start')

  const chart = chooseVisualRepresentation(context, { text: 'Sales grew from 12% to 47% in a year, more than doubled' })
  assert.equal(top(chart), 'chart')
  assert.match(chart.ranked[0].reason, /Numbers to compare \(12%, 47%\)/)
  assert.equal(chart.ranked[0].act.arguments.kind, 'chart')

  const timeline = chooseVisualRepresentation(context, { text: 'Founded in 1998, sold in 2008, and relaunched in 2021' })
  assert.equal(top(timeline), 'timeline')
  assert.equal(timeline.ranked[0].act.arguments.text, '1998, 2008, 2021')

  const counter = chooseVisualRepresentation(context, { text: 'We reached 87 cities' })
  assert.equal(chooseVisualRepresentation(context, { text: 'We reached 87 of them' }).ranked[0].kind, 'text_graphic')
  assert.ok(counter.ranked.findIndex((entry) => entry.kind === 'map') < counter.ranked.findIndex((entry) => entry.kind === 'chart'))

  const diagram = chooseVisualRepresentation(context, { text: 'How the cooling system works, step by step through the network' })
  assert.equal(top(diagram), 'diagram')
  assert.equal(diagram.ranked[0].act.tool, null, 'no diagram primitive: the entry says so')
})

test('a line, a time or a scene can be the point; an unknown one is refused', () => {
  const context = contextFor()
  const line = chooseVisualRepresentation(context, { sequenceNumber: 18 })
  assert.equal(line.point.kind, 'line')
  assert.equal(line.point.scene, 3)
  const atTime = chooseVisualRepresentation(context, { atSeconds: line.point.at + 0.1 })
  assert.equal(atTime.point.lineId, line.point.lineId)
  assert.throws(() => chooseVisualRepresentation(context, { scene: 9 }), /scene 9 is not in this episode/)
  assert.throws(() => chooseVisualRepresentation(context, {}), /Pass sceneOrPoint/)
  assert.throws(() => chooseVisualRepresentation(context, { sequenceNumber: 999 }), /Line 999 is not in this episode/)
})

test('b-roll in the library that matches the point ranks stock_video and names the add_broll edit', () => {
  const context = contextFor({
    mutate: (project) => project.assets.push({ id: 'broll-1', name: 'Rain on the lab window', type: 'video', role: 'broll', duration: 6, semantic: { scene: null, purpose: 'rain on window, research lab', characters: [] } }),
  })
  const result = chooseVisualRepresentation(context, { text: 'rain against the window all night', scene: 2 })
  const stock = result.ranked.find((entry) => entry.kind === 'stock_video')
  assert.ok(stock.score >= 2, JSON.stringify(stock))
  assert.deepEqual(stock.act, { tool: 'studio_edit', arguments: { intent: 'add_broll', scope: { scene: 2 }, params: { query: 'rain against window night' } } })
})
