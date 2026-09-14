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

// One nominal block: ~6s today, 2s planned.
const NOMINAL_BLOCK_MS = 6_000
// Healthy means the socket is open AND still delivering. EventSource fires
// `error` when the socket DROPS, never when it stays open and goes silent
// (laptop suspend/resume, an idle proxy holding the connection) — and this flag
// is the one thing deciding whether anything polls at all, so a half-open
// socket would freeze every live surface with no error. A head arrives every
// block, so silence across several blocks hands the surfaces back to their
// timers; the window is wide enough that a quiet stretch does not flap and
// narrow enough that nothing stays frozen for long.
export const HEAD_SILENCE_LIMIT_MS = NOMINAL_BLOCK_MS * 5

let streamOpen = false
let lastHeadAt = 0
let publishedHealthy = false
let watchdogTimer: number | null = null
const healthListeners = new Set<() => void>()

/** The health predicate itself: open, heard from, and heard from recently. */
export function headStreamFresh(open: boolean, headAt: number, now: number): boolean {
  return open && headAt > 0 && now - headAt < HEAD_SILENCE_LIMIT_MS
}

function publishHealth(): void {
  const next = headStreamFresh(streamOpen, lastHeadAt, Date.now())
  if (next === publishedHealthy) return
  publishedHealthy = next
  healthListeners.forEach(l => l())
}

// Synchronous check for plain-timer callers (the chart's fallback interval).
// Evaluated against the clock rather than the published flag, so a tick that
// lands between watchdog runs still sees a stalled stream.
export function headStreamHealthy(): boolean {
  return headStreamFresh(streamOpen, lastHeadAt, Date.now())
}
// Reactive variant for hooks that pause their refetchInterval while streaming.
// Module-level callbacks: a fresh `subscribe` identity per render would tear the
// listener down and re-add it on every one.
const subscribeHealth = (cb: () => void) => { healthListeners.add(cb); return () => { healthListeners.delete(cb) } }
const getHealthSnapshot = () => publishedHealthy
const getHealthServerSnapshot = () => false
export function useHeadStream(): boolean {
  return useSyncExternalStore(subscribeHealth, getHealthSnapshot, getHealthServerSnapshot)
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
  source.addEventListener('open', () => { streamOpen = true; publishHealth() })
  source.addEventListener('head', e => {
    // Every frame is proof the socket is alive, including a replayed head that
    // does not advance and so dispatches nothing.
    lastHeadAt = Date.now()
    publishHealth()
    const head = parseHeadEvent((e as MessageEvent<string>).data, lastHead)
    if (head == null) return
    lastHead = head
    dispatchHead(head)
  })
  // Network drops auto-reconnect (server sends `retry:`); a non-200 response
  // closes the source for good. Either way the stream is unhealthy until
  // reopened and the poll timers carry the surfaces alone.
  source.addEventListener('error', () => { streamOpen = false; publishHealth() })
  // Silence never raises an event of its own, so the reactive flag needs a tick
  // to fall on. `headStreamHealthy` does not wait for it.
  watchdogTimer ??= window.setInterval(publishHealth, NOMINAL_BLOCK_MS)
}
function disconnectHead(): void {
  source?.close()
  source = null
  streamOpen = false
  lastHeadAt = 0
  if (watchdogTimer != null) {
    window.clearInterval(watchdogTimer)
    watchdogTimer = null
  }
  publishHealth()
}

export function subscribeHead(cb: HeadListener): () => void {
  headListeners.add(cb)
  connectHead()
  return () => {
    headListeners.delete(cb)
    if (headListeners.size === 0) disconnectHead()
  }
}
