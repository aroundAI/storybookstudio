// KB-190: one audio analysis in an Electron utility process
// (utilityProcess.fork from electron/studio/audioReads.js
// utilityProcessAnalysis). Decoding and the DSP stay out of the window, whose
// decodeAudioData crashed it, and out of the main process, which a long file
// would otherwise block for seconds. It answers once; the parent then ends it.
const { analyzeFileInProcess } = require('./audioReads')

process.parentPort.once('message', async ({ data }) => {
  let result
  try {
    result = await analyzeFileInProcess(data.ffmpegPath, data.file, data.options || {})
  } catch (error) {
    result = { success: false, error: error?.message || String(error) }
  }
  process.parentPort.postMessage(result)
})
