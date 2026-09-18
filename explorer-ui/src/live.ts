import { useSyncExternalStore } from 'react'
import { NOMINAL_BLOCK_SECONDS } from './utils/dca'

// The explorer is always live. A block lands every ~6s today (2s planned) and
// the pages follow it: the SSE head stream drives the refetches, and LIVE_MS is
// the fallback interval for whenever that stream is unavailable (older browser,
// proxy hiccup, mocked test API). Polling faster than the chain only re-fetches
// the same head while forcing the API cache to expire between clients; the
// server's single-flight cache keeps DB load O(1) however many clients watch.
//
// These two timers are the only block-time knowledge in the UI that does not
// come from the chain, because neither is a value anyone reads: one is a poll
// interval, the other a cache-freshness window, and both are needed BEFORE the
// stats payload carrying the chain's own rates has been fetched at all. They
// ride on the fallback constant instead. A faster chain therefore keeps the same
// fallback cadence until someone moves that constant — a degraded-mode poll a
// block or two behind, never a wrong number on screen.
export const LIVE_MS = NOMINAL_BLOCK_SECONDS * 1000
// One nominal block of freshness for the live feeds: a poll that lands inside
// the block already on screen serves it from cache instead of asking again.
// Feeds with a rate of their own (block/extrinsic/event lists at 2-5s, detail
// pages at 20-120s) keep their own value; this is the shared "as fresh as the
// chain" default.
export const BLOCK_STALE_MS = NOMINAL_BLOCK_SECONDS * 1000

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
// Pool-only frames arrive many times per block — every mempool entry that
// appears, drops or is judged bumps the generation — and the generation rides
// in `liveHeadTag`, so each one is a DIFFERENT cache key and therefore a full
// rebuild of the three pool-carrying feeds rather than a cache hit. Measured on
// /activity: 19 refetches in 15 s against 7-8 blocks, ~3.7 s of api time for a
// viewer who did nothing.
//
// So pool pushes are throttled on the LEADING edge: the first one after a quiet
// stretch dispatches at once (a mempool row still appears the moment it is
// seen), and any that follow inside the window collapse into a single trailing
// dispatch. A block frame is never throttled, and it cancels a pending pool
// dispatch because the block refetch already subsumes it.
//
// The window is half a block: pending rows still surface BETWEEN blocks, which
// is the whole point of the pool generation, but the feed can no longer be
// asked to rebuild faster than the chain produces it.
export const POOL_PUSH_THROTTLE_MS = Math.round(LIVE_MS / 2)

export interface PoolThrottle {
  /** A pool-only frame. Dispatches now, or collapses into the open window. */
  push(head: number): void
  /** A block frame or a dropped stream: drop whatever was collapsed. */
  reset(): void
}
// A factory rather than module state so the behaviour is testable on fake
// timers without an EventSource harness — the rate is the whole point of this
// code, so it has to be pinned by a test rather than inspected by eye.
export function createPoolThrottle(dispatch: (head: number) => void, windowMs = POOL_PUSH_THROTTLE_MS): PoolThrottle {
  let timer: ReturnType<typeof setTimeout> | null = null
  let collapsed = 0
  // Re-arming on flush (rather than only while frames arrive) is what bounds a
  // continuous stream: without it, the frame that lands just after a flush
  // would be a fresh leading edge and the window would never actually cap.
  const arm = (): void => {
    timer = setTimeout(() => {
      timer = null
      if (!collapsed) return
      const head = collapsed
      collapsed = 0
      arm()
      dispatch(head)
    }, windowMs)
  }
  return {
    push(head) {
      if (timer) { collapsed = Math.max(collapsed, head); return }
      arm()
      dispatch(head)
    },
    reset() {
      if (timer) clearTimeout(timer)
      timer = null
      collapsed = 0
    },
  }
}
const poolThrottle = createPoolThrottle(head => dispatchHead(head, true))
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
  // A dropped stream hands the feeds back to LIVE_MS polling, and `liveHeadTag`
  // goes empty while it is down — a throttled dispatch left armed would fire
  // into that gap for a generation no longer in any URL.
  if (!v) poolThrottle.reset()
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
    // Always current, even for a throttled frame: whenever a dispatch does go
    // out it must carry the newest generation, or the refetch it triggers would
    // be keyed to a pool state already superseded.
    lastPool = frame.pool
    const head = Math.max(frame.head, frame.best)
    if (poolOnly) { poolThrottle.push(head); return }
    // A block refetch already subsumes any pool change collapsed behind it.
    poolThrottle.reset()
    dispatchHead(head, false)
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
