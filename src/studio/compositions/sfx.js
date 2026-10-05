// FILM-2018: StorybookStudio's built-in pop, the sound a counter or callout
// lands with when the project's library has no pop of its own
// (intents/add_graphic.js). Synthesised, not sampled: a 0.3 s sine whose
// pitch falls from 880 Hz to 220 Hz under a 2 ms attack and an exponential
// decay, written as a 48 kHz mono 16-bit WAV. Deterministic, so every
// project's pop is the same bytes. Pure.
export const POP_FILE = 'assets/audio/sfx/storybookstudio-pop.wav'
export const POP_DURATION_SECONDS = 0.3
const SAMPLE_RATE = 48000
const PEAK = 0.5

export function popSamples(sampleRate = SAMPLE_RATE) {
  const count = Math.round(POP_DURATION_SECONDS * sampleRate)
  const samples = new Float32Array(count)
  let phase = 0
  for (let index = 0; index < count; index += 1) {
    const t = index / sampleRate
    const frequency = 220 + 660 * Math.exp(-t / 0.03)
    phase += (2 * Math.PI * frequency) / sampleRate
    const envelope = Math.min(1, t / 0.002) * Math.exp(-t / 0.045)
    samples[index] = PEAK * envelope * Math.sin(phase)
  }
  return samples
}

export function popWavBytes(sampleRate = SAMPLE_RATE) {
  const samples = popSamples(sampleRate)
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((value, index) => view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, value)) * 32767), true))
  return bytes
}
