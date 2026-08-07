import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { LIVE_PUSH_KEYS, POOL_PUSH_KEYS, parseHeadEvent } from '../src/live'
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
      expect(hooks, `queryKey prefix '${key}' missing from useExplorerData.ts`)
        .toMatch(new RegExp(`(queryKey: \\['${key}'|key = \\['${key}',)`))
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

