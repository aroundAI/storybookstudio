// FILM-2016 AC2: the preview side of the buses. AudioLayerRenderer connects
// each bussed track's output to `inputFor(track.bus)` instead of the master
// bus input; tracks without a bus keep going straight to master.
//
//   track out → bus input → bus gain (gainDb) → duck gain → master input
//                                 └ dialogue only: detector (analyser)
//
// Ducking is gain automation on each ducked bus's duck node, driven by the
// dialogue bus's envelope as the detector reads it: above the threshold the
// duck node heads to duckDb with a time constant of attackMs / 3 (95 % in
// attackMs), below it back to unity over releaseMs. `tick()` runs every
// DUCK_TICK_MS while the editor is open, so the duck starts within one
// frame of a dialogue clip starting. The same rule drives the export's
// sidechain key (electron/studio/audioBusMix.mjs). Pure: takes a context.
import { AUDIO_BUSES, DIALOGUE_BUS, DUCK_THRESHOLD_DB, dbToGain, duckingParams, gainToDb } from './buses.js'

export const DUCK_TICK_MS = 10
// 256 samples at 48 kHz = 5.3 ms: the detector's window.
export const DETECTOR_FFT_SIZE = 256

export function createStudioBusGraph(context, destination) {
  const nodes = {}
  for (const bus of AUDIO_BUSES) {
    const input = context.createGain()
    const gain = context.createGain()
    input.connect(gain)
    let duck = null
    let detector = null
    if (bus === DIALOGUE_BUS) {
      detector = context.createAnalyser()
      detector.fftSize = DETECTOR_FFT_SIZE
      gain.connect(detector)
      detector.connect(destination)
    } else {
      duck = context.createGain()
      gain.connect(duck)
      duck.connect(destination)
    }
    nodes[bus] = { input, gain, duck, detector, params: null, ducking: false, automation: [] }
  }
  const buffer = new Float32Array(DETECTOR_FFT_SIZE)

  const dialogueLevelDb = () => {
    const { detector } = nodes[DIALOGUE_BUS]
    detector.getFloatTimeDomainData(buffer)
    let sum = 0
    for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i]
    return gainToDb(Math.sqrt(sum / buffer.length))
  }

  return {
    nodes,
    inputFor(bus) {
      return AUDIO_BUSES.includes(bus) ? nodes[bus].input : null
    },
    // buses: resolveAudioBuses(project.studio.audioBuses), or null for a
    // project without buses (every bus at unity, nothing ducked).
    update(buses) {
      for (const bus of AUDIO_BUSES) {
        const node = nodes[bus]
        node.gain.gain.value = dbToGain(Number(buses?.[bus]?.gainDb) || 0)
        if (!node.duck) continue
        const params = duckingParams(buses?.[bus])
        if (!params && (node.params || node.ducking)) {
          node.duck.gain.cancelScheduledValues(context.currentTime)
          node.duck.gain.setValueAtTime(1, context.currentTime)
          node.automation = [{ type: 'set', value: 1, time: context.currentTime }]
          node.ducking = false
        }
        node.params = params
      }
    },
    tick() {
      const ducked = AUDIO_BUSES.filter((bus) => nodes[bus].params)
      if (!ducked.length) return
      const level = dialogueLevelDb()
      const now = context.currentTime
      for (const bus of ducked) {
        const node = nodes[bus]
        const active = level > (node.params.thresholdDb ?? DUCK_THRESHOLD_DB)
        if (active === node.ducking) continue
        node.ducking = active
        const seconds = (active ? node.params.attackMs : node.params.releaseMs) / 1000
        node.duck.gain.cancelScheduledValues(now)
        const target = active ? dbToGain(node.params.duckDb) : 1
        node.duck.gain.setTargetAtTime(target, now, seconds / 3)
        // Keep only where the gain is now and where it is heading.
        const current = paramValueAt({ events: node.automation }, now, 1)
        node.automation = [{ type: 'set', value: current, time: now }, { type: 'target', target, time: now, timeConstant: seconds / 3 }]
      }
    },
    // The duck currently applied to a bus, in dB (0 when not ducked).
    reductionDb(bus) {
      const node = nodes[bus]
      if (!node?.duck) return 0
      return gainToDb(paramValueAt({ events: node.automation }, context.currentTime, 1))
    },
    dispose() {
      for (const bus of AUDIO_BUSES) {
        for (const key of ['input', 'gain', 'duck', 'detector']) {
          try { nodes[bus][key]?.disconnect() } catch { /* already gone */ }
        }
      }
    },
  }
}

// Worst-case delay between dialogue starting and the duck automation
// starting: one detector window plus one follower tick.
export const duckOnsetLatencyMs = (graph, sampleRate = 48000) => (
  (graph.nodes[DIALOGUE_BUS].detector.fftSize / sampleRate) * 1000 + DUCK_TICK_MS
)

// Value of an AudioParam whose automation is only setValueAtTime and
// setTargetAtTime events (what this module schedules), at `time`. Real
// AudioParams do not expose their timeline; the recorder in tests and the
// meter readout use this.
export function paramValueAt(param, time, initial = 1) {
  const events = (param.events || []).filter((event) => event.type !== 'cancel' && event.time <= time)
  let value = initial
  let curve = null
  let at = 0
  const valueOnCurve = (t) => (curve ? curve.target + (curve.from - curve.target) * Math.exp(-(t - curve.time) / curve.timeConstant) : value)
  for (const event of events) {
    value = valueOnCurve(event.time)
    if (event.type === 'set') {
      value = event.value
      curve = null
    } else {
      curve = { from: value, target: event.target, time: event.time, timeConstant: event.timeConstant }
    }
    at = event.time
  }
  return curve ? valueOnCurve(Math.max(time, at)) : value
}
