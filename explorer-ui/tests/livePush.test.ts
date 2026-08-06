import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { LIVE_PUSH_KEYS, parseHeadEvent } from '../src/live'

describe('parseHeadEvent', () => {
  it('accepts a head that advances', () => {
    expect(parseHeadEvent('{"head":13487500}', 13487499)).toBe(13487500)
  })

  it('ignores a replayed or regressed head — reconnects must not refetch-storm', () => {
    expect(parseHeadEvent('{"head":13487500}', 13487500)).toBeNull()
    expect(parseHeadEvent('{"head":13487499}', 13487500)).toBeNull()
  })

  it('ignores malformed frames', () => {
    expect(parseHeadEvent('not json', 0)).toBeNull()
    expect(parseHeadEvent('{"head":"soon"}', 0)).toBeNull()
    expect(parseHeadEvent('{}', 0)).toBeNull()
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
