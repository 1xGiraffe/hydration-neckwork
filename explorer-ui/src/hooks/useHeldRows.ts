import { useState, useSyncExternalStore } from 'react'
import { hashKey } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'

// Whether the document sits at its very top, as one shared subscription: every
// live list on a page asks the same question of the same scroller. Negative
// offsets (rubber-band overscroll) still count as the top.
let atTop = typeof window === 'undefined' || window.scrollY <= 0
const listeners = new Set<() => void>()

function readScroll(): void {
  const next = window.scrollY <= 0
  if (next === atTop) return
  atTop = next
  listeners.forEach(listener => listener())
}
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  if (listeners.size === 1) window.addEventListener('scroll', readScroll, { passive: true })
  readScroll()
  return () => {
    listeners.delete(onChange)
    if (!listeners.size) window.removeEventListener('scroll', readScroll)
  }
}
export function useAtTop(): boolean {
  return useSyncExternalStore(subscribe, () => atTop, () => true)
}

// A newest-first list only prepends while the reader is at the top of the page.
//
// Below the top, a poll that lands new rows pushes everything the reader is
// looking at down by a row or more; every six seconds. Measured on /blocks that
// is the single largest layout-shift source in the app. So below the top the
// newly polled rows are HELD: the window rendered when the reader scrolled away
// stays exactly as it was, and the poll keeps running at its normal cadence —
// only the application of its result waits. Returning to the top adopts the
// current window at once. That window is the server's own page-0 answer, so it
// is newest-first with each row once, and useNewRows then highlights everything
// that arrived while it was held.
//
// The reader gets no on-screen signal that rows are waiting. That is the chosen
// product trade-off, not an oversight: an "N new rows" affordance is itself a
// moving element on the surface this exists to hold still.
//
// `key` is the query's own key, so a page, tab or filter change — which is the
// reader asking for a different list, not the same list moving — is adopted
// immediately rather than held.
export function useHeldRows<T, R extends { data: T[] | undefined; isPlaceholderData: boolean }>(
  result: R,
  key: QueryKey,
  prepends: boolean,
): R {
  const top = useAtTop()
  const [held, setHeld] = useState<{ key: string; rows: T[] } | null>(null)
  const rows = result.data
  // Placeholder rows are the outgoing page held in place by keepPreviousData while
  // the incoming one loads. They are already on screen and belong to the previous
  // key, so there is nothing to freeze yet — the real answer freezes when it lands.
  if (!prepends || top || rows === undefined || result.isPlaceholderData) {
    if (held) setHeld(null)
    return result
  }
  const identity = hashKey(key)
  if (held?.key !== identity) {
    // Freeze what is on screen right now. React re-runs this render with the
    // snapshot recorded, and it is these same rows, so nothing is painted twice.
    setHeld({ key: identity, rows })
    return result
  }
  // Same array while nothing is actually held back: hand the result straight back
  // so the query's own change tracking is untouched.
  return held.rows === rows ? result : { ...result, data: held.rows } as R
}
