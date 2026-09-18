import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { LIVE_MS, LIVE_PUSH_KEYS, POOL_PUSH_KEYS, POOL_PUSH_THROTTLE_MS, createPoolThrottle, parseHeadEvent } from '../src/live'
import { pendingRefetchMs } from '../src/hooks/useExplorerData'

describe('parseHeadEvent', () => {
  it('accepts a frame when either height watermark advances', () => {
    expect(parseHeadEvent('{"head":13487500,"best":13487507,"pool":3}', { head: 13487499, best: 13487507, pool: 3 }))
      .toEqual({ head: 13487500, best: 13487507, pool: 3 })
    // a new unfinalized best block alone must refetch the feeds too
    expect(parseHeadEvent('{"head":13487500,"best":13487508,"pool":3}', { head: 13487500, best: 13487507, pool: 3 }))
      .toEqual({ head: 13487500, best: 13487508, pool: 3 })
  })

  it('accepts a frame when only the pool generation CHANGES — up or down (api restarts reset it)', () => {
    expect(parseHeadEvent('{"head":13487500,"best":13487507,"pool":4}', { head: 13487500, best: 13487507, pool: 3 }))
      .toEqual({ head: 13487500, best: 13487507, pool: 4 })
    expect(parseHeadEvent('{"head":13487500,"best":13487507,"pool":0}', { head: 13487500, best: 13487507, pool: 3 }))
      .toEqual({ head: 13487500, best: 13487507, pool: 0 })
  })

  it('ignores a replayed or regressed frame — reconnects must not refetch-storm', () => {
    expect(parseHeadEvent('{"head":13487500,"best":13487507,"pool":3}', { head: 13487500, best: 13487507, pool: 3 })).toBeNull()
    expect(parseHeadEvent('{"head":13487499,"best":13487506,"pool":3}', { head: 13487500, best: 13487507, pool: 3 })).toBeNull()
  })

  it('tolerates frames without best/pool (older api) and malformed data', () => {
    expect(parseHeadEvent('{"head":13487500}', { head: 13487499, best: 0, pool: 0 })).toEqual({ head: 13487500, best: 0, pool: 0 })
    expect(parseHeadEvent('{"head":13487500,"best":13487507}', { head: 13487499, best: 13487507, pool: 5 }))
      .toEqual({ head: 13487500, best: 13487507, pool: 5 })
    expect(parseHeadEvent('not json', { head: 0, best: 0, pool: 0 })).toBeNull()
    expect(parseHeadEvent('{"head":"soon"}', { head: 0, best: 0, pool: 0 })).toBeNull()
  })
})

// A detail page served from the pending layer keeps refetching until the
// finalized row replaces it — then stops.
describe('pendingRefetchMs', () => {
  it('polls only while the response says unfinalized', () => {
    expect(pendingRefetchMs({ finalized: false })).toBe(2500)
    expect(pendingRefetchMs({ finalized: true })).toBe(false)
    expect(pendingRefetchMs({})).toBe(false)
    expect(pendingRefetchMs(undefined)).toBe(false)
  })
})

// The push channel invalidates exactly the global live feeds. Each pushed key
// must actually be a feed hook's queryKey prefix in useExplorerData.ts — a
// renamed key would silently drop that feed back to interval-only freshness.
describe('LIVE_PUSH_KEYS', () => {
  it('every pushed key exists as a query key prefix in the data hooks', () => {
    const hooks = readFileSync(new URL('../src/hooks/useExplorerData.ts', import.meta.url), 'utf8')
    for (const key of LIVE_PUSH_KEYS) {
      // Match the ARRAY LITERAL rather than how it is assigned: a feed whose
      // key is chosen by a ternary (the viewer-scoped variants) still starts
      // with the pushed key, which is what react-query's prefix invalidation
      // matches on.
      expect(hooks, `queryKey prefix '${key}' missing from useExplorerData.ts`)
        .toMatch(new RegExp(`\\['${key}'[,\\]]`))
    }
  })

  it('covers the five global feeds', () => {
    expect([...LIVE_PUSH_KEYS]).toEqual(['stats', 'blocks', 'extrinsics', 'events', 'activity'])
  })

  // Pool-only frames arrive many times per block, so they must refetch only the
  // feeds that merge transaction-pool rows — and each of those must still be a
  // real query key, or that feed silently stops following the pool.
  it('pool pushes cover exactly the pool-carrying feeds, and each is a live key', () => {
    expect([...POOL_PUSH_KEYS]).toEqual(['extrinsics', 'events', 'activity'])
    for (const key of POOL_PUSH_KEYS) expect([...LIVE_PUSH_KEYS]).toContain(key)
  })
})

// Narrowing WHICH feeds a pool frame refetches (above) bounds the blast radius;
// this bounds the RATE. The generation rides in `liveHeadTag`, so every pool
// frame is a distinct cache key and a full feed rebuild: measured on /activity,
// 19 refetches in 15 s against 7-8 blocks. The window is the lever, so the
// arithmetic is pinned here rather than left to inspection.
describe('createPoolThrottle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is half a block — pending rows still surface between blocks', () => {
    expect(POOL_PUSH_THROTTLE_MS).toBe(Math.round(LIVE_MS / 2))
    expect(POOL_PUSH_THROTTLE_MS).toBeLessThan(LIVE_MS)
  })

  it('dispatches the first frame at once, so a mempool row is never delayed', () => {
    const seen: number[] = []
    createPoolThrottle(h => seen.push(h), 1000).push(10)
    expect(seen).toEqual([10])
  })

  it('collapses a burst into one trailing dispatch carrying the newest head', () => {
    const seen: number[] = []
    const t = createPoolThrottle(h => seen.push(h), 1000)
    t.push(10)
    for (const h of [11, 12, 13]) t.push(h)
    expect(seen).toEqual([10])          // still inside the window
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([10, 13])      // newest, not each
  })

  it('caps a continuous stream at one dispatch per window', () => {
    const seen: number[] = []
    const t = createPoolThrottle(h => seen.push(h), 1000)
    // A frame every 100ms for 5s: 50 frames, and without the re-arm on flush
    // each post-flush frame would be a fresh leading edge.
    for (let i = 1; i <= 50; i++) { t.push(i); vi.advanceTimersByTime(100) }
    expect(seen.length).toBeLessThanOrEqual(6)
    expect(seen[0]).toBe(1)
  })

  it('stays quiet when nothing collapsed into the window', () => {
    const seen: number[] = []
    const t = createPoolThrottle(h => seen.push(h), 1000)
    t.push(10)
    vi.advanceTimersByTime(5000)
    expect(seen).toEqual([10])          // no phantom trailing dispatch
  })

  it('reset drops a collapsed frame — a block refetch subsumes it', () => {
    const seen: number[] = []
    const t = createPoolThrottle(h => seen.push(h), 1000)
    t.push(10)
    t.push(11)
    t.reset()
    vi.advanceTimersByTime(5000)
    expect(seen).toEqual([10])
    t.push(12)                          // and the gate is usable again after
    expect(seen).toEqual([10, 12])
  })
})

