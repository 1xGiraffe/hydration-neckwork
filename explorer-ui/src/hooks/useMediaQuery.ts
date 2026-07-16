import { useSyncExternalStore } from 'react'

// Reactive media-query flag, e.g. useMediaQuery('(max-width: 720px)') — updates
// on viewport/orientation changes so charts can adapt their data density to the
// same breakpoint the stylesheet uses.
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
