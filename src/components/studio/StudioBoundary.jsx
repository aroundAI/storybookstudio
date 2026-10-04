// FILM-2015: an error boundary around every studio surface. A surface that
// throws (an unexpected payload on studio:plan-proposed, say) must not
// unmount App, because App also runs Velorn's MCP action bridge; without the
// boundary every MCP call then times out. The surface is replaced by its
// fallback (Velorn's own screen for Welcome) or a small notice with Try again.
import { Component } from 'react'

export default class StudioBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error(`[studio] ${this.props.name || 'studio surface'} failed: ${error?.message || error}`, info?.componentStack || '')
  }

  render() {
    if (!this.state.error) return this.props.children
    if (this.props.fallback !== undefined) return <>{this.props.fallback}</>
    return (
      <div role="alert" data-test="studio-boundary" className="flex items-center gap-2 border border-sf-error/40 bg-sf-error/10 px-2 py-1 text-[11px] text-sf-error">
        <span>{`This part of the Studio hit an error: ${this.state.error?.message || this.state.error}`}</span>
        <button type="button" className="rounded bg-sf-dark-700 px-2 py-0.5 text-sf-text-primary hover:bg-sf-dark-600" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    )
  }
}
