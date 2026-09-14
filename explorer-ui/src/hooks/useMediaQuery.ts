import { useCallback, useSyncExternalStore } from 'react'

// One MediaQueryList per query, shared by every caller. useSyncExternalStore
// tears the subscription down and re-adds it whenever `subscribe` changes
// identity, and callers re-render on a 1s clock (or a rAF loop), so both the
// list and the closure have to be stable across renders.
const lists = new Map<string, MediaQueryList>()
function listFor(query: string): MediaQueryList {
  let m = lists.get(query)
  if (!m) { m = window.matchMedia(query); lists.set(query, m) }
  return m
}

// Reactive media-query flag, e.g. useMediaQuery('(max-width: 720px)') — updates
// on viewport/orientation changes so charts can adapt their data density to the
// same breakpoint the stylesheet uses.
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const m = listFor(query)
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [query])
  const getSnapshot = useCallback(() => listFor(query).matches, [query])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
