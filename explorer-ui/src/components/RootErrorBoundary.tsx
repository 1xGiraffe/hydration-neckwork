import { Component, type ErrorInfo, type ReactNode } from 'react'
import { isChunkLoadError } from '../lazyWithReload'

// The app's last line of defence: anything a page throws while rendering, and
// every chunk failure lazyWithReload rethrows (a second failure on a page that
// was itself the product of a chunk reload, or one without usable storage),
// lands here instead of unmounting the whole tree to a blank page.
//
// A chunk failure means the tab is running an older build than the server now
// has — its content-hashed chunk names are gone — so the card says a new version
// is live and offers the reload that fixes it. Anything else is a real error and
// gets a generic card; reloading is still the only recovery a root boundary has.

interface State { error: unknown }

export class RootErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[explorer] render failed', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (error == null) return this.props.children
    return <RootErrorCard chunk={isChunkLoadError(error)} />
  }
}

export function RootErrorCard({ chunk }: { chunk: boolean }) {
  return (
    <div className="wrap" role="alert" style={{ paddingTop: 64 }}>
      <div className="panel" style={{ maxWidth: 520, margin: '0 auto', padding: 24, textAlign: 'center' }}>
        <div className="panel-head" style={{ justifyContent: 'center', borderBottom: 0, padding: '0 0 8px' }}>
          <span className="t">{chunk ? 'A new version is live' : 'Something went wrong'}</span>
        </div>
        <p style={{ color: 'var(--text-medium)', margin: '0 0 18px' }}>
          {chunk
            ? 'The explorer was updated while this page was open. Reload to get the current version.'
            : 'This page failed to render. Reloading usually fixes it; if it keeps happening, the page itself is broken.'}
        </p>
        <button type="button" className="btn primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    </div>
  )
}
