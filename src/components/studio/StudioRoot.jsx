// FILM-2015: what App.jsx mounts. useStudioApp() starts the studio:* bridge
// once (FILM-2011's pull builder included), guards project close, attaches a
// pulled project to its edit session and loads its StoryBook side files.
// <StudioOverlays/> renders the picker, Review, Deliver and the prompts over
// whichever screen is showing.
import { useEffect, useState } from 'react'
import useProjectStore from '../../stores/projectStore'
import { studioUiStore } from '../../studio/ui/studioStore'
import { startStudioUiBridge } from '../../studio/ui/studioBridge'
import { startCloudOpenBridge } from '../../studio/cloudOpen'
import { guardProjectClose, loadProjectContext } from '../../studio/ui/studioRuntime'
import EpisodePicker from './EpisodePicker'
import ReviewScreen from './ReviewScreen'
import DeliverScreen from './DeliverScreen'
import OpenSourceLicenses from './OpenSourceLicenses'
import StudioDialog, { StudioButton } from './StudioDialog'
import { studioApi, useStudioText, useStudioUi } from './studioUi'

export function useStudioApp() {
  const projectHandle = useProjectStore((state) => state.currentProjectHandle)

  // The IPC subscriptions live as long as the window.
  useEffect(() => {
    const stopBridge = startStudioUiBridge({ store: studioUiStore, startPullBridge: () => startCloudOpenBridge() })
    const unguard = guardProjectClose(useProjectStore, studioUiStore)
    return () => {
      unguard()
      stopBridge()
    }
  }, [])

  // A pulled project carries storybook/session.json (events, re-sync) and its
  // package, policy and plan journal (scene strip, Deliver, crash recovery).
  useEffect(() => {
    const studio = studioApi()
    let cancelled = false
    if (typeof projectHandle === 'string') {
      studio?.projectOpened({ projectPath: projectHandle })
      loadProjectContext(projectHandle).then((context) => {
        if (cancelled) return
        studioUiStore.getState().patch({
          pkg: context.pkg ?? null,
          link: context.link ?? null,
          policy: context.policy ?? null,
          sceneHeadings: context.sceneHeadings ?? new Map(),
          recovery: context.recovery ?? null,
          aiPanelOpen: Boolean(context.recovery) || studioUiStore.getState().aiPanelOpen,
        })
      })
    } else {
      studio?.projectClosed()
      studioUiStore.getState().patch({ pkg: null, link: null, policy: null, sceneHeadings: new Map(), recovery: null })
    }
    return () => { cancelled = true }
  }, [projectHandle])
}

function PendingWorkPrompt({ prompt }) {
  const t = useStudioText()
  return (
    <StudioDialog
      title={prompt.title}
      onClose={() => prompt.resolve(false)}
      testId="studio-pending-prompt"
      closeLabel={t('common.close')}
      footer={(
        <>
          <StudioButton onClick={() => prompt.resolve(false)} data-autofocus data-test="studio-prompt-keep">{prompt.cancelLabel}</StudioButton>
          <StudioButton tone="danger" onClick={() => prompt.resolve(true)} data-test="studio-prompt-confirm">{prompt.confirmLabel}</StudioButton>
        </>
      )}
    >
      <ul className="list-disc space-y-1.5 pl-5 text-sm">
        {prompt.reasons.map((reason) => <li key={reason}>{reason}</li>)}
      </ul>
    </StudioDialog>
  )
}

export function StudioOverlays() {
  const pickerOpen = useStudioUi((state) => state.pickerOpen)
  const review = useStudioUi((state) => state.review)
  const deliverOpen = useStudioUi((state) => state.deliverOpen)
  const prompt = useStudioUi((state) => state.prompt)
  const [licensesOpen, setLicensesOpen] = useState(false)
  // The app menu's Open-source licenses item arrives over IPC.
  useEffect(() => studioApi()?.onShowLicenses?.(() => setLicensesOpen(true)), [])
  return (
    <>
      {licensesOpen && <OpenSourceLicenses onClose={() => setLicensesOpen(false)} />}
      {pickerOpen && <EpisodePicker />}
      {review && <ReviewScreen />}
      {deliverOpen && <DeliverScreen />}
      {prompt && <PendingWorkPrompt prompt={prompt} />}
    </>
  )
}
