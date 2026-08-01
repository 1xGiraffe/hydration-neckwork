import { useEffect, useState } from 'react'
import { hashKey } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'

// Whether the top of ONE list is still on screen, observed per list: a page with
// several live feeds (an account's Activity, Extrinsics and Events tabs) gates each
// on its own position rather than on one shared answer about the document.
//
// The anchor is a zero-height marker the list renders directly above its table, so
// it sits on the table's top edge: the top of the column headers on desktop, and
// below 720px — where `.tbl thead` is display:none and rows become cards — the top
// of the first row. Observing the header element itself would freeze every feed on
// a phone, because a display:none element never intersects.
function useListTopInView(): [boolean, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [observed, setObserved] = useState(true)
  useEffect(() => {
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setObserved(entry.isIntersecting))
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  // A list whose anchor is never attached stays live, read straight off `el` rather
  // than by resetting state when it detaches. Holding is the exception this hook
  // exists to make, so an unattached list degrades to the plain live feed;
  // defaulting the other way would freeze it silently, which is the failure a
  // reader cannot tell from a stalled chain.
  // setEl is stable, so the ref is never detached and re-attached across renders.
  return [el ? observed : true, setEl]
}

// A newest-first list only prepends while the top of that list is on screen.
//
// Once the list's top has scrolled away, a poll that lands new rows pushes
// everything the reader is looking at down by a row or more; every six seconds.
// Measured on /blocks that is the single largest layout-shift source in the app. So
// below that point the newly polled rows are HELD: the window rendered when the
// reader scrolled past stays exactly as it was, and the poll keeps running at its
// normal cadence — only the application of its result waits. Scrolling the top of
// the list back into view adopts the current window at once. That window is the
// server's own page-0 answer, so it is newest-first with each row once, and
// useNewRows then highlights everything that arrived while it was held.
//
// The gate is the list's own top edge rather than the document's, because a reader
// who can still see where an arrival lands is watching a live feed — holding there
// reads as a feed that stopped. Scrolled past its own headers, they are reading a
// window instead, and that window is what stays still.
//
// The reader gets no on-screen signal that rows are waiting. That is the chosen
// product trade-off, not an oversight: an "N new rows" affordance is itself a
// moving element on the surface this exists to hold still.
//
// `key` is the query's own key, so a page, tab or filter change — which is the
// reader asking for a different list, not the same list moving — is adopted
// immediately rather than held.
//
// `anchorRef` rides on the result so the ~20 call sites in useExplorerData/useUser
// stay untouched; each live table attaches it to the marker above its table.
export type HeldRowsResult<R> = R & { anchorRef: (el: HTMLElement | null) => void }

export function useHeldRows<T, R extends { data: T[] | undefined; isPlaceholderData: boolean }>(
  result: R,
  key: QueryKey,
  prepends: boolean,
): HeldRowsResult<R> {
  const [topInView, anchorRef] = useListTopInView()
  const [held, setHeld] = useState<{ key: string; rows: T[] } | null>(null)
  const rows = result.data
  // Placeholder rows are the outgoing page held in place by keepPreviousData while
  // the incoming one loads. They are already on screen and belong to the previous
  // key, so there is nothing to freeze yet — the real answer freezes when it lands.
  if (!prepends || topInView || rows === undefined || result.isPlaceholderData) {
    if (held) setHeld(null)
    return { ...result, anchorRef }
  }
  const identity = hashKey(key)
  if (held?.key !== identity) {
    // Freeze what is on screen right now. React re-runs this render with the
    // snapshot recorded, and it is these same rows, so nothing is painted twice.
    setHeld({ key: identity, rows })
    return { ...result, anchorRef }
  }
  return held.rows === rows ? { ...result, anchorRef } : { ...result, data: held.rows, anchorRef }
}
