import { useSyncExternalStore } from 'react'

// Push channel: the API streams the ingested chain head over SSE
// (/api/explorer/live — shared with the explorer). The chart's live poll and
// the indexer-status chip refetch the moment a block is fully ingested instead
// of waiting out their poll timers; the timers stay as the fallback whenever
// the stream is unavailable (older browser, mocked test API, proxy hiccup).

type HeadListener = (head: number) => void
const headListeners = new Set<HeadListener>()
let source: EventSource | null = null
let lastHead = 0

let streamHealthy = false
const healthListeners = new Set<() => void>()
function setStreamHealthy(v: boolean): void {
  if (streamHealthy === v) return
  streamHealthy = v
  healthListeners.forEach(l => l())
}
// Synchronous check for plain-timer callers (the chart's fallback interval).
export function headStreamHealthy(): boolean { return streamHealthy }
// Reactive variant for hooks that pause their refetchInterval while streaming.
export function useHeadStream(): boolean {
  return useSyncExternalStore(
    (cb) => { healthListeners.add(cb); return () => healthListeners.delete(cb) },
    () => streamHealthy,
    () => false,
  )
}

// Frames carry two watermarks; preis follows `main` — the price indexer's
// newest block. Candles and the indexer-status chip are produced by the main
// pipeline, which trails the raw head by its own processing: triggering on the
// raw head would refetch candles before they can exist. A head only counts
// when it advances — reconnect replays the current one, which must not
// trigger a redundant refetch.
export function parseHeadEvent(data: string, previousHead: number): number | null {
  try {
    const frame = JSON.parse(data) as { head?: unknown; main?: unknown }
    const head = Number(frame.main ?? frame.head)
    return Number.isSafeInteger(head) && head > previousHead ? head : null
  } catch { return null }
}

// A head that arrived while the tab was hidden defers to the next
// visibilitychange: a background tab does no work, but catches up the moment
// it is looked at (the poll timers pause while streaming, so dropping the
// event would leave the tab stale until the NEXT block).
let pendingHiddenHead = 0
function dispatchHead(head: number): void {
  if (typeof document !== 'undefined' && document.hidden) { pendingHiddenHead = head; return }
  pendingHiddenHead = 0
  headListeners.forEach(l => l(head))
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || pendingHiddenHead === 0) return
    const head = pendingHiddenHead
    pendingHiddenHead = 0
    headListeners.forEach(l => l(head))
  })
}

function connectHead(): void {
  if (source || headListeners.size === 0 || typeof EventSource === 'undefined') return
  source = new EventSource('/api/explorer/live')
  source.addEventListener('open', () => setStreamHealthy(true))
  source.addEventListener('head', e => {
    const head = parseHeadEvent((e as MessageEvent<string>).data, lastHead)
    if (head == null) return
    lastHead = head
    dispatchHead(head)
  })
  // Network drops auto-reconnect (server sends `retry:`); a non-200 response
  // closes the source for good. Either way the stream is unhealthy until
  // reopened and the poll timers carry the surfaces alone.
  source.addEventListener('error', () => setStreamHealthy(false))
}
function disconnectHead(): void {
  source?.close()
  source = null
  setStreamHealthy(false)
}

export function subscribeHead(cb: HeadListener): () => void {
  headListeners.add(cb)
  connectHead()
  return () => {
    headListeners.delete(cb)
    if (headListeners.size === 0) disconnectHead()
  }
}
