import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { LIVE_PUSH_KEYS, parseHeadEvent } from '../src/live'
import { pendingRefetchMs } from '../src/hooks/useExplorerData'

describe('parseHeadEvent', () => {
  it('accepts a frame when either watermark advances', () => {
    expect(parseHeadEvent('{"head":13487500,"best":13487507}', { head: 13487499, best: 13487507 }))
      .toEqual({ head: 13487500, best: 13487507 })
    // a new unfinalized best block alone must refetch the feeds too
    expect(parseHeadEvent('{"head":13487500,"best":13487508}', { head: 13487500, best: 13487507 }))
      .toEqual({ head: 13487500, best: 13487508 })
  })

  it('ignores a replayed or regressed frame — reconnects must not refetch-storm', () => {
    expect(parseHeadEvent('{"head":13487500,"best":13487507}', { head: 13487500, best: 13487507 })).toBeNull()
    expect(parseHeadEvent('{"head":13487499,"best":13487506}', { head: 13487500, best: 13487507 })).toBeNull()
  })

  it('tolerates frames without best (older api) and malformed data', () => {
    expect(parseHeadEvent('{"head":13487500}', { head: 13487499, best: 0 })).toEqual({ head: 13487500, best: 0 })
    expect(parseHeadEvent('not json', { head: 0, best: 0 })).toBeNull()
    expect(parseHeadEvent('{"head":"soon"}', { head: 0, best: 0 })).toBeNull()
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
})
