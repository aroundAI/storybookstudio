// FILM-2016: the renderer side of the set_audio_buses MCP tool. Reads and
// writes project.studio.audioBuses through the project store the caller
// passes (mcpActions passes useProjectStore), so it runs under node --test.
// previewOnly (the default) returns the change without making it. Applying
// changes the project document the op log and versions snapshot
// (editLogRuntime timelineDocument carries audioBuses).
import { applyBusPatch, resolveAudioBuses, validateBusPatch } from './buses.js'

const flatten = (buses) => Object.entries(buses || {}).flatMap(([bus, config]) => (
  Object.entries(config || {}).map(([field, value]) => [`${bus}.${field}`, value])
))

export function diffBuses(before, after) {
  const was = new Map(flatten(before))
  const changes = []
  for (const [key, value] of flatten(after)) {
    if (JSON.stringify(was.get(key)) !== JSON.stringify(value)) {
      const [bus, field] = key.split('.')
      changes.push({ bus, field, from: was.has(key) ? was.get(key) : null, to: value })
    }
  }
  return changes
}

export function handleSetAudioBuses(payload = {}, { projectStore }) {
  const state = projectStore.getState()
  const project = state.currentProject
  if (!project) throw new Error('No project is open.')
  if (!project.studio?.audioBuses) {
    throw new Error('This project has no audio buses. Buses come with a StorybookStudio project (opened from a StoryBook episode).')
  }
  const patch = payload.buses
  const problems = validateBusPatch(patch)
  if (problems.length) throw new Error(`set_audio_buses refused: ${problems.join('; ')}`)
  const before = resolveAudioBuses(project.studio.audioBuses)
  const after = applyBusPatch(before, patch)
  const changes = diffBuses(before, after)
  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'set_audio_buses',
      message: changes.length ? `Bus change plan only (${changes.length} change${changes.length === 1 ? '' : 's'}). Nothing was changed.` : 'The buses already have these values.',
      changes,
      audioBuses: after,
    }
  }
  if (changes.length) {
    projectStore.setState((current) => ({
      currentProject: current.currentProject
        ? { ...current.currentProject, studio: { ...current.currentProject.studio, audioBuses: after } }
        : current.currentProject,
    }))
  }
  return {
    success: true,
    action: 'set_audio_buses',
    message: changes.length ? `Audio buses updated (${changes.length} change${changes.length === 1 ? '' : 's'}); preview and export use them now.` : 'The buses already have these values.',
    changes,
    audioBuses: after,
  }
}
