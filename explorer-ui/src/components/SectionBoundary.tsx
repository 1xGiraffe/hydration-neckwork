import { Component, type ErrorInfo, type ReactNode } from 'react'
import { LoadError } from './ui'

// One detail-page section that throws while rendering (a payload of an
// unexpected shape, say) replaces only itself with the shared load-error state;
// without a boundary React unmounts the whole tree and the page goes blank.
// `resetKey` clears a caught error when the section's subject changes (another
// account, another tab), and "Try again" re-renders it in place.
// `passThrough` names errors this boundary must NOT keep (rethrown to the next
// boundary up): the route-level boundary passes chunk-load failures to the root,
// whose "A new version is live" card is the one that fixes them.
type Props = { label: string; resetKey?: unknown; passThrough?: (error: Error) => boolean; children: ReactNode }
type State = { error: Error | null; resetKey: unknown }

export class SectionBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { error: null, resetKey: props.resetKey }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.label} section failed to render`, error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    if (this.props.passThrough?.(this.state.error)) throw this.state.error
    return <LoadError title={`${this.props.label} failed to load`} onRetry={() => this.setState({ error: null })} />
  }
}
