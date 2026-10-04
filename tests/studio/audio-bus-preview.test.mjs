// FILM-2016 AC2: preview routing. Each bussed track feeds its bus's gain
// node; ducked buses carry a duck gain automated from the dialogue bus's
// analyser; the duck starts within one frame of dialogue appearing.
// Web Audio is faked: nodes record connections and AudioParam automation,
// and the analyser returns whatever signal level the test sets.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createStudioBusGraph, DUCK_TICK_MS, duckOnsetLatencyMs, paramValueAt } from '../../src/studio/audio/busGraph.js'
import { defaultAudioBuses, applyBusPatch, dbToGain } from '../../src/studio/audio/buses.js'
import { getStudioBusGraph, registerMixerGraph, registerStudioBusGraph, unregisterMixerGraph } from '../../src/services/audioMixerGraph.js'

class FakeParam {
  constructor(value) { this.value = value; this.events = [] }
  setValueAtTime(value, time) { this.events.push({ type: 'set', value, time }); this.value = value }
  setTargetAtTime(target, time, timeConstant) { this.events.push({ type: 'target', target, time, timeConstant }) }
  cancelScheduledValues(time) { this.events.push({ type: 'cancel', time }) }
}
class FakeNode {
  constructor(kind) { this.kind = kind; this.outputs = []; this.gain = new FakeParam(1) }
  connect(node) { this.outputs.push(node); return node }
  disconnect() { this.outputs = [] }
}
class FakeContext {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.level = 0 }
  createGain() { return new FakeNode('gain') }
  createAnalyser() {
    const node = new FakeNode('analyser')
    node.fftSize = 2048
    node.getFloatTimeDomainData = (array) => {
      for (let i = 0; i < array.length; i += 1) array[i] = this.level * Math.sin((2 * Math.PI * 220 * i) / this.sampleRate)
    }
    return node
  }
}

const reaches = (node, target, seen = new Set()) => {
  if (node === target) return true
  if (seen.has(node)) return false
  seen.add(node)
  return node.outputs.some((next) => reaches(next, target, seen))
}

test('every bus feeds the master through its gain node; the dialogue bus has a detector and no duck', () => {
  const context = new FakeContext()
  const master = new FakeNode('master')
  const graph = createStudioBusGraph(context, master)
  graph.update(defaultAudioBuses(null))
  for (const bus of ['dialogue', 'music', 'sfx', 'ambience', 'shotaudio']) {
    const input = graph.inputFor(bus)
    assert.ok(input, bus)
    assert.ok(reaches(input, graph.nodes[bus].gain), `${bus} input → gain`)
    assert.ok(reaches(input, master), `${bus} reaches master`)
  }
  assert.equal(graph.nodes.dialogue.duck, null, 'the dialogue bus is never ducked')
  assert.ok(reaches(graph.inputFor('dialogue'), graph.nodes.dialogue.detector))
  assert.equal(graph.inputFor(null), null, 'an unbussed track goes straight to master')
  assert.equal(graph.inputFor('choir'), null)
})

test('bus gain follows project.studio.audioBuses', () => {
  const context = new FakeContext()
  const graph = createStudioBusGraph(context, new FakeNode('master'))
  graph.update(applyBusPatch(defaultAudioBuses(null), { music: { gainDb: -6 }, sfx: { gainDb: 3 } }))
  assert.ok(Math.abs(graph.nodes.music.gain.gain.value - dbToGain(-6)) < 1e-9)
  assert.ok(Math.abs(graph.nodes.sfx.gain.gain.value - dbToGain(3)) < 1e-9)
  assert.equal(graph.nodes.dialogue.gain.gain.value, 1)
})

test('dialogue above the threshold ducks music and shot audio to duckDb with the attack time; silence releases with the release time', () => {
  const context = new FakeContext()
  const graph = createStudioBusGraph(context, new FakeNode('master'))
  graph.update(applyBusPatch(defaultAudioBuses(null), { music: { duckDb: -10 } }))
  context.level = 0
  graph.tick()
  assert.equal(graph.nodes.music.duck.gain.events.filter((event) => event.type === 'target').length, 0)

  context.currentTime = 1
  context.level = 0.2 // ≈ -17 dBFS RMS
  graph.tick()
  const attack = graph.nodes.music.duck.gain.events.filter((event) => event.type === 'target').at(-1)
  assert.equal(attack.time, 1)
  assert.ok(Math.abs(attack.target - dbToGain(-10)) < 1e-9)
  assert.ok(Math.abs(attack.timeConstant - 0.12 / 3) < 1e-9, 'reaches 95 % of the duck in the 120 ms attack')
  const shot = graph.nodes.shotaudio.duck.gain.events.filter((event) => event.type === 'target').at(-1)
  assert.ok(Math.abs(shot.target - dbToGain(-8)) < 1e-9, 'shot audio ducks at its own duckDb')
  assert.equal(graph.nodes.sfx.params, null, 'sfx is not ducked by default')
  assert.equal(graph.nodes.sfx.duck.gain.events.length, 0)

  context.currentTime = 1.6
  assert.ok(Math.abs(graph.reductionDb('music') - -10) < 0.05, `music reads ${graph.reductionDb('music')} dB after the attack`)
  context.currentTime = 2
  context.level = 0
  graph.tick()
  const release = graph.nodes.music.duck.gain.events.filter((event) => event.type === 'target').at(-1)
  assert.equal(release.target, 1)
  assert.ok(Math.abs(release.timeConstant - 0.4 / 3) < 1e-9, 'released over 400 ms')
  assert.equal(graph.reductionDb('dialogue'), 0)
})

test('quiet dialogue under the -45 dB threshold does not duck', () => {
  const context = new FakeContext()
  const graph = createStudioBusGraph(context, new FakeNode('master'))
  graph.update(defaultAudioBuses(null))
  context.level = 0.004 // ≈ -51 dBFS RMS
  graph.tick()
  assert.equal(graph.nodes.music.duck.gain.events.filter((event) => event.type === 'target').length, 0)
})

test('turning ducking off returns the bus to unity and removes the duck from the follower', () => {
  const context = new FakeContext()
  const graph = createStudioBusGraph(context, new FakeNode('master'))
  const buses = defaultAudioBuses(null)
  graph.update(buses)
  context.level = 0.2
  graph.tick()
  graph.update(applyBusPatch(buses, { music: { duckUnder: null } }))
  assert.equal(graph.nodes.music.duck.gain.events.at(-1).type, 'set')
  assert.equal(graph.nodes.music.duck.gain.events.at(-1).value, 1)
  const before = graph.nodes.music.duck.gain.events.length
  context.currentTime = 3
  graph.tick()
  assert.equal(graph.nodes.music.duck.gain.events.length, before)
})

test('the duck is audible within one frame of dialogue starting (24 and 60 fps)', () => {
  // Dialogue starts at t0; the follower ticks every DUCK_TICK_MS; the
  // detector sees it after one analyser window. Worst case: it starts just
  // after a tick.
  const context = new FakeContext()
  const graph = createStudioBusGraph(context, new FakeNode('master'))
  graph.update(defaultAudioBuses(null))
  const latencyMs = duckOnsetLatencyMs(graph, context.sampleRate)
  assert.ok(DUCK_TICK_MS <= 10)
  for (const fps of [24, 60]) {
    const frameMs = 1000 / fps
    assert.ok(latencyMs < frameMs, `duck starts ${latencyMs.toFixed(1)} ms after dialogue, a frame is ${frameMs.toFixed(1)} ms`)
  }
  // Simulate the worst case: dialogue starts at 5.000 s, just after a tick;
  // the detector sees it once a full analyser window holds it. The first
  // tick after that starts the automation; one 24 fps frame after 5.000 s
  // the music is already ≥ 1 dB down (just-noticeable).
  const t0 = 5
  const windowSeconds = graph.nodes.dialogue.detector.fftSize / context.sampleRate
  let started = null
  for (let tick = 0; tick < 10 && started === null; tick += 1) {
    context.currentTime = t0 + 0.0001 + tick * (DUCK_TICK_MS / 1000)
    context.level = context.currentTime >= t0 + windowSeconds ? 0.2 : 0
    graph.tick()
    const event = graph.nodes.music.duck.gain.events.find((entry) => entry.type === 'target')
    if (event) started = event
  }
  assert.ok(started, 'the follower ducked')
  assert.ok(started.time - t0 <= latencyMs / 1000 + 1e-9)
  const atFrame = paramValueAt(graph.nodes.music.duck.gain, t0 + 1 / 24, 1)
  assert.ok(20 * Math.log10(atFrame) <= -1, `one frame in, music is ${(20 * Math.log10(atFrame)).toFixed(2)} dB`)
})

test('the mixer registry exposes the bus graph to meters and QA', () => {
  const context = new FakeContext()
  const graph = createStudioBusGraph(context, new FakeNode('master'))
  registerMixerGraph({ context, masterAnalyser: null })
  registerStudioBusGraph(context, graph)
  registerStudioBusGraph(new FakeContext(), {})
  assert.equal(getStudioBusGraph(), graph, 'a stale context cannot replace it')
  assert.equal(getStudioBusGraph(), graph)
  unregisterMixerGraph(context)
  assert.equal(getStudioBusGraph(), null)
})
