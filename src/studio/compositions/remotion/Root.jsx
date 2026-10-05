// FILM-2018: the Remotion entry the composition engine renders from. Every
// catalogue primitive is one <Composition>; its size, frame rate and length
// come from the render request (inputProps.render), so one registration
// serves every aspect. inputProps = {props, brand, render}, built by
// electron/studio/compositionEngines/remotion.js from the render key.
import React from 'react'
import { Composition } from 'remotion'

import { COMPOSITION_IDS } from '../catalogue.js'
import { Arrow } from './Arrow.jsx'
import { Callout } from './Callout.jsx'
import { Chart } from './Chart.jsx'
import { Counter } from './Counter.jsx'
import { Highlight } from './Highlight.jsx'
import { LowerThird } from './LowerThird.jsx'
import { MapMarker } from './MapMarker.jsx'
import { ProgressBar } from './ProgressBar.jsx'
import { Text } from './Text.jsx'
import { Timeline } from './Timeline.jsx'

// One component per catalogue id; a test checks the two lists agree.
export const COMPONENTS = {
  text: Text,
  counter: Counter,
  callout: Callout,
  arrow: Arrow,
  highlight: Highlight,
  'lower-third': LowerThird,
  chart: Chart,
  map: MapMarker,
  timeline: Timeline,
  'progress-bar': ProgressBar,
}

const calculateMetadata = ({ props }) => {
  const { durationSeconds, width, height, fps } = props.render
  return { durationInFrames: Math.max(1, Math.round(durationSeconds * fps)), width, height, fps }
}

const PLACEHOLDER_INPUT = { props: {}, brand: {}, render: { durationSeconds: 1, width: 1920, height: 1080, fps: 30 } }

export function Root() {
  return (
    <>
      {COMPOSITION_IDS.map((id) => (
        <Composition
          key={id}
          id={id}
          component={COMPONENTS[id]}
          width={1920}
          height={1080}
          fps={30}
          durationInFrames={30}
          defaultProps={PLACEHOLDER_INPUT}
          calculateMetadata={calculateMetadata}
        />
      ))}
    </>
  )
}
