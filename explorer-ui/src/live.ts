import { useSyncExternalStore } from 'react'

// Global Live/Paused state. When enabled, list views poll on LIVE_MS; when
// paused, they do not refetch. Persisted to
// localStorage so the choice survives reloads. The server-side single-flight
// cache keeps DB load O(1) regardless of how many clients poll.
// Hydration targets roughly one block every six seconds. Polling more often only
// re-fetched the same head while forcing the API cache to expire between clients.
export const LIVE_MS = 6000

let liveOn = (() => {
  try { return localStorage.getItem('explorer-live') !== '0' } catch { return true }
})()

const listeners = new Set<() => void>()
function emit() { listeners.forEach(l => l()) }

export function toggleLive(): void {
  liveOn = !liveOn
  try { localStorage.setItem('explorer-live', liveOn ? '1' : '0') } catch { /* ignore */ }
  if (liveOn) connectHead()
  else disconnectHead()
  emit()
}

// Push channel. The API streams the ingested chain head over SSE; when a new
// block lands, main.tsx invalidates exactly the global live feeds below, so
// they refetch the moment data exists instead of waiting out the poll timer.
// The LIVE_MS interval polling stays as the fallback — a closed stream (older
// browser, mocked test env, proxy hiccup) degrades to today's behavior.
export const LIVE_PUSH_KEYS = ['stats', 'blocks', 'extrinsics', 'events', 'activity'] as const

type HeadListener = (head: number) => void
const headListeners = new Set<HeadListener>()
let source: EventSource | null = null
let lastHead = 0
// A head that arrived while the tab was hidden: dispatch is deferred to the
// next visibilitychange, so a background tab does no work but catches up the
// moment it is looked at (interval polling is paused while streaming, so
// silently dropping the event would leave the tab stale until the NEXT head).
let pendingHiddenHead = 0

// The newest pushed head while the stream is healthy, or 0. The api client
// stamps this onto live-feed URLs (`h=`): the nginx micro-cache keys on the
// URI alone, so without it a push-triggered refetch can HIT the entry built
// for the PREVIOUS head — with polling paused, that staleness would persist
// until the next block rather than the next tick.
export function liveHeadTag(): number {
  return streamHealthy ? lastHead : 0
}

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

// Stream health drives the polling fallback: while the SSE channel is open the
// push-covered feeds stop interval-polling entirely (requests then happen only
// when a block actually lands); any error or disconnect flips this off and the
// LIVE_MS polling takes over until the stream reconnects.
let streamHealthy = false
const healthListeners = new Set<() => void>()
function setStreamHealthy(v: boolean): void {
  if (streamHealthy === v) return
  streamHealthy = v
  healthListeners.forEach(l => l())
}
export function useHeadStream(): boolean {
  return useSyncExternalStore(
    (cb) => { healthListeners.add(cb); return () => healthListeners.delete(cb) },
    () => streamHealthy,
    () => false,
  )
}

// A pushed head only counts when it advances — reconnect replays the current
// head, which must not trigger a redundant refetch storm.
export function parseHeadEvent(data: string, previousHead: number): number | null {
  try {
    const head = Number((JSON.parse(data) as { head?: unknown }).head)
    return Number.isSafeInteger(head) && head > previousHead ? head : null
  } catch { return null }
}

function connectHead(): void {
  if (source || !liveOn || headListeners.size === 0 || typeof EventSource === 'undefined') return
  source = new EventSource('/api/explorer/live')
  source.addEventListener('open', () => setStreamHealthy(true))
  source.addEventListener('head', e => {
    const head = parseHeadEvent((e as MessageEvent<string>).data, lastHead)
    if (head == null) return
    lastHead = head
    dispatchHead(head)
  })
  // Network drops auto-reconnect (server sends `retry:`); a non-200 response
  // (e.g. the mocked test API) closes the source for good. Either way the
  // stream is unhealthy until reopened and polling carries the feeds alone.
  source.addEventListener('error', () => setStreamHealthy(false))
}
function disconnectHead(): void {
  source?.close()
  source = null
  setStreamHealthy(false)
}

export function subscribeHead(cb: HeadListener): () => void {
  headListeners.add(cb)
  if (liveOn) connectHead()
  return () => {
    headListeners.delete(cb)
    if (headListeners.size === 0) disconnectHead()
  }
}
export function useLive(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    () => liveOn,
    () => liveOn,
  )
}
