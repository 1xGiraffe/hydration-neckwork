import { useCallback, useSyncExternalStore } from 'react'

// One MediaQueryList per query, shared by every caller. useSyncExternalStore
// tears the subscription down and re-adds it whenever `subscribe` changes
// identity, and it re-reads the snapshot on every render, so both the list and
// the closures have to be stable across renders.
const lists = new Map<string, MediaQueryList>()
function listFor(query: string): MediaQueryList {
  let m = lists.get(query)
  if (!m) { m = window.matchMedia(query); lists.set(query, m) }
  return m
}

// Reactive media-query flag, e.g. useMediaQuery('(max-width: 980px)'). State
// changes only when the breakpoint is actually crossed, so dragging a window
// edge does not re-render the tree on every resize event.
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const m = listFor(query)
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [query])
  const getSnapshot = useCallback(() => listFor(query).matches, [query])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
