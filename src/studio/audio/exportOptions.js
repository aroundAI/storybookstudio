// FILM-2016: what the exporter adds to export:mixAudio for a StorybookStudio
// project. The export worker window has no currentProject, so ExportPanel
// (or FILM-2017's delivery batch) resolves the buses once into the job's
// options as `studioAudio`, and the exporter turns that into the IPC's
// `studio` block. A plain upstream project has no audioBuses: no block, and
// the mix is exactly what it was.
import { busForTrack, DIALOGUE_BUS, loudnessTargetFor, resolveAudioBuses } from './buses.js'

// project: the open project (project.studio.audioBuses); preset: a FILM-2017
// preset (name or object with audioLufs); stems: write stems beside the render.
export function studioAudioExportOptions(project, { preset = null, policy = null, stems = false } = {}) {
  const audioBuses = resolveAudioBuses(project?.studio?.audioBuses, { policy, preset })
  if (!audioBuses) return null
  const loudnessTargetLufs = preset ? loudnessTargetFor({ preset, policy }) : audioBuses.master.limiterLufs
  return { audioBuses, loudnessTargetLufs, stems: Boolean(stems) }
}

const splitPath = (filePath) => {
  const text = String(filePath || '')
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  const directory = cut >= 0 ? text.slice(0, cut) : ''
  const file = cut >= 0 ? text.slice(cut + 1) : text
  const dot = file.lastIndexOf('.')
  return { directory, baseName: dot > 0 ? file.slice(0, dot) : file }
}

// Dialogue tracks muted in this render (the other languages) still get a stem
// when stems are asked for; they never reach the mix or the ducking key.
export function stemOnlyTrackIds(studioAudio, tracks) {
  if (!studioAudio?.stems) return []
  return (tracks || [])
    .filter((track) => busForTrack(track) === DIALOGUE_BUS && (track.muted || track.visible === false))
    .map((track) => track.id)
}

// The `studio` field of the export:mixAudio request, or {} for a plain project.
export function studioMixRequest(studioAudio, { tracks, outputPath }) {
  if (!studioAudio?.audioBuses) return {}
  const stems = studioAudio.stems && outputPath ? splitPath(outputPath) : null
  return {
    studio: {
      audioBuses: studioAudio.audioBuses,
      loudnessTargetLufs: studioAudio.loudnessTargetLufs,
      stems: stems && stems.directory ? stems : null,
      stemOnlyTrackIds: stemOnlyTrackIds(studioAudio, tracks),
    },
  }
}
