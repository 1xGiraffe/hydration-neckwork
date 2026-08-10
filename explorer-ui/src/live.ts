import { useSyncExternalStore } from 'react'

// The explorer is always live. A block lands every ~6 seconds and the pages
// follow it: the SSE head stream drives the refetches, and LIVE_MS is the
// fallback interval for whenever that stream is unavailable (older browser,
// proxy hiccup, mocked test API). Polling faster than the chain only re-fetches
// the same head while forcing the API cache to expire between clients; the
// server's single-flight cache keeps DB load O(1) however many clients watch.
export const LIVE_MS = 6000

// Push channel. The API streams the ingested chain head over SSE; when a new
// block lands, main.tsx invalidates exactly the global live feeds below, so
// they refetch the moment data exists instead of waiting out the poll timer.
// The LIVE_MS interval polling stays as the fallback — a closed stream (older
// browser, mocked test env, proxy hiccup) degrades to today's behavior.
export const LIVE_PUSH_KEYS = ['stats', 'blocks', 'extrinsics', 'events', 'activity'] as const
// A pool-only frame moves no block, so only the two feeds that merge
// transaction-pool rows have anything new to show. Refetching all five on a
// pool that churns several times a second would be most of a refetch storm for
// data that did not change.
export const POOL_PUSH_KEYS = ['extrinsics', 'events', 'activity'] as const

// `poolOnly` — the frame carried a transaction-pool change and no new block.
export interface HeadPush { head: number; poolOnly: boolean }
type HeadListener = (push: HeadPush) => void
const headListeners = new Set<HeadListener>()
let source: EventSource | null = null
let lastHead = 0
// The newest UNFINALIZED block the api's pending layer can show. Feeds merge
// pending rows, so a best-head advance must refetch them just like a newly
// ingested finalized block.
let lastBest = 0
// The api's transaction-pool generation: it changes whenever a pool entry
// appears, drops or gets judged, so mempool rows surface and update between
// blocks. A counter, not a height — compared for difference, not order (an api
// restart resets it).
let lastPool = 0
// A head that arrived while the tab was hidden: dispatch is deferred to the
// next visibilitychange, so a background tab does no work but catches up the
// moment it is looked at (interval polling is paused while streaming, so
// silently dropping the event would leave the tab stale until the NEXT head).
let pendingHiddenHead = 0
// ...and whether everything deferred so far was pool-only. One real block among
// them makes the catch-up a full refetch.
let pendingHiddenPoolOnly = true

// The newest pushed heads while the stream is healthy, or ''. The api client
// stamps this onto live-feed URLs (`h=`): the nginx micro-cache keys on the
// URI alone, so without it a push-triggered refetch can HIT the entry built
// for the PREVIOUS head — with polling paused, that staleness would persist
// until the next block rather than the next tick. The unfinalized best rides
// along so pending-row updates bust the cache too.
export function liveHeadTag(): string {
  if (!streamHealthy || lastHead === 0) return ''
  const heads = lastBest > lastHead ? `${lastHead}-${lastBest}` : `${lastHead}`
  return lastPool > 0 ? `${heads}.p${lastPool}` : heads
}

function dispatchHead(head: number, poolOnly: boolean): void {
  if (typeof document !== 'undefined' && document.hidden) {
    pendingHiddenHead = head
    pendingHiddenPoolOnly = pendingHiddenPoolOnly && poolOnly
    return
  }
  pendingHiddenHead = 0
  pendingHiddenPoolOnly = true
  headListeners.forEach(l => l({ head, poolOnly }))
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || pendingHiddenHead === 0) return
    const push = { head: pendingHiddenHead, poolOnly: pendingHiddenPoolOnly }
    pendingHiddenHead = 0
    pendingHiddenPoolOnly = true
    headListeners.forEach(l => l(push))
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

// A pushed frame only counts when a watermark moves — reconnect replays the
// current frame, which must not trigger a redundant refetch storm. `head` is
// the finalized-ingested checkpoint, `best` the newest unfinalized block; both
// only ever advance. `pool` is the transaction-pool generation and merely
// CHANGES (an api restart resets it), so it compares for difference.
export interface HeadFrame { head: number; best: number; pool: number }
export function parseHeadEvent(data: string, prev: HeadFrame): HeadFrame | null {
  try {
    const raw = JSON.parse(data) as { head?: unknown; best?: unknown; pool?: unknown }
    const head = Number.isSafeInteger(Number(raw.head)) ? Number(raw.head) : 0
    const best = Number.isSafeInteger(Number(raw.best)) ? Number(raw.best) : 0
    const pool = Number.isSafeInteger(Number(raw.pool)) ? Number(raw.pool) : prev.pool
    if (head <= prev.head && best <= prev.best && pool === prev.pool) return null
    return { head: Math.max(head, prev.head), best: Math.max(best, prev.best), pool }
  } catch { return null }
}

function connectHead(): void {
  if (source || headListeners.size === 0 || typeof EventSource === 'undefined') return
  source = new EventSource('/api/explorer/live')
  source.addEventListener('open', () => setStreamHealthy(true))
  source.addEventListener('head', e => {
    const frame = parseHeadEvent((e as MessageEvent<string>).data, { head: lastHead, best: lastBest, pool: lastPool })
    if (frame == null) return
    const poolOnly = frame.head === lastHead && frame.best === lastBest
    lastHead = frame.head
    lastBest = frame.best
    lastPool = frame.pool
    dispatchHead(Math.max(frame.head, frame.best), poolOnly)
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
  connectHead()
  return () => {
    headListeners.delete(cb)
    if (headListeners.size === 0) disconnectHead()
  }
}
