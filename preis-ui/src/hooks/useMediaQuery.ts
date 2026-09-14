import { useSyncExternalStore } from 'react'

// Reactive media-query flag, e.g. useMediaQuery('(max-width: 980px)'). State
// changes only when the breakpoint is actually crossed, so dragging a window
// edge does not re-render the tree on every resize event.
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    onChange => {
      const m = window.matchMedia(query)
      m.addEventListener('change', onChange)
      return () => m.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}
