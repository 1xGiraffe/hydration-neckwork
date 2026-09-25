import { describe, expect, it } from 'vitest'
import { heightAtOrBefore, heightsForBoundaries, timeUpperBoundOfHeight, type BlockClock } from '../src/services/blockClock.ts'

const H = 3_600
// Three hours of chain, with the last height reached inside each hour.
const clock: BlockClock = {
  hours: [10 * H, 11 * H, 12 * H],
  heights: [100, 250, 400],
  builtAt: 0,
}

describe('heightAtOrBefore', () => {
  it('resolves an hour mark to that hour last block', () => {
    expect(heightAtOrBefore(clock, 11 * H)).toBe(250)
  })

  it('resolves an instant inside an hour to the same hour, not the next', () => {
    // A bucket ENDING at 11:59 is dated by the last block of hour 11.
    expect(heightAtOrBefore(clock, 11 * H + 3_599)).toBe(250)
  })

  it('resolves past the head to the newest height', () => {
    expect(heightAtOrBefore(clock, 99 * H)).toBe(400)
  })

  it('returns null before the chain existed, rather than a bogus first height', () => {
    expect(heightAtOrBefore(clock, 9 * H)).toBeNull()
    expect(heightAtOrBefore({ hours: [], heights: [], builtAt: 0 }, 10 * H)).toBeNull()
  })

  it('binary search agrees with a scan across the whole index', () => {
    const hours = Array.from({ length: 500 }, (_, i) => (i + 1) * H)
    const heights = hours.map((_, i) => i * 7 + 3)
    const c: BlockClock = { hours, heights, builtAt: 0 }
    for (let i = 0; i < hours.length; i++) {
      expect(heightAtOrBefore(c, hours[i] + 12)).toBe(heights[i])
    }
  })
})

describe('heightsForBoundaries', () => {
  it('keeps boundary order and falls back below the chain start', () => {
    expect(heightsForBoundaries(clock, [9 * H, 10 * H, 12 * H], 1)).toEqual([1, 100, 400])
  })
})

describe('blockClock refresh', () => {
  it('re-reads the newest hour from its mark inclusive, so the blocks stamped on it survive', async () => {
    const { vi } = await import('vitest')
    const { blockClock, heightAtOrBeforeExact } = await import('../src/services/blockClock.ts')
    const seen: Array<Record<string, unknown>> = []
    let rows: Array<Record<string, number>> = [{ h: 10 * H, top: 250, at_mark: 101 }, { h: 11 * H, top: 300, at_mark: 251 }]
    const client = { query: async (o: { query: string; query_params: Record<string, unknown> }) => { seen.push(o.query_params); expect(o.query).toContain('>= toDateTime({since:UInt32})'); return { json: async () => rows } } }
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000_000_000)
      await blockClock(client as never)
      // The newest hour kept filling; the re-read (which includes its mark) replaces it.
      rows = [{ h: 11 * H, top: 400, at_mark: 251 }, { h: 12 * H, top: 480, at_mark: 401 }]
      vi.setSystemTime(1_000_000_000_000 + 61_000)
      const c = await blockClock(client as never)
      expect(seen[1].since).toBe(11 * H)
      expect(c.hours).toEqual([10 * H, 11 * H, 12 * H])
      expect(c.heights).toEqual([250, 400, 480])
      expect(heightAtOrBeforeExact(c, 11 * H)).toBe(251)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('clock coverage', () => {
  it('covers up to the newest block time it has seen, carried across incremental refreshes', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const { blockClock, blockClockCovering, clockCoveredSec } = await import('../src/services/blockClock.ts')
    let rows: Array<Record<string, number>> = [{ h: 10 * H, top: 250, at_mark: 101, top_ts: 10 * H + 3_594 }, { h: 11 * H, top: 300, at_mark: 251, top_ts: 11 * H + 600 }]
    let reads = 0
    const client = { query: async () => { reads++; return { json: async () => rows } } }
    vi.useFakeTimers()
    try {
      vi.setSystemTime(2_000_000_000_000)
      const c = await blockClock(client as never)
      expect(c.lastTime).toBe(11 * H + 600)
      expect(clockCoveredSec(c)).toBe(11 * H + 600)
      // Covered: no read.
      expect(await blockClockCovering(client as never, 11 * H)).toBe(c)
      expect(reads).toBe(1)
      // Not covered, but the clock is under two seconds old: served as is.
      rows = [{ h: 11 * H, top: 400, at_mark: 251, top_ts: 11 * H + 3_594 }, { h: 12 * H, top: 480, at_mark: 401, top_ts: 12 * H + 30 }]
      expect(await blockClockCovering(client as never, 12 * H)).toBe(c)
      expect(reads).toBe(1)
      // Past the forced-refresh floor (and well inside the regular minute): refreshed now.
      vi.setSystemTime(2_000_000_000_000 + 3_000)
      const next = await blockClockCovering(client as never, 12 * H)
      expect(reads).toBe(2)
      expect(next.hours).toEqual([10 * H, 11 * H, 12 * H])
      expect(clockCoveredSec(next)).toBe(12 * H + 30)
      // A clock without block times (hand-built) is covered to its newest mark.
      expect(clockCoveredSec({ hours: [10 * H, 11 * H], heights: [1, 2], builtAt: 0 })).toBe(11 * H)
      expect(clockCoveredSec({ hours: [], heights: [], builtAt: 0 })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

// A window's end block dated from ABOVE, so a finality check on it closes the
// window late, never early.
describe('timeUpperBoundOfHeight', () => {
  const c: BlockClock = { hours: [3_600, 7_200, 10_800], heights: [100, 200, 300], builtAt: 0 }
  it('ends the first hour whose greatest height reaches the block', () => {
    expect(timeUpperBoundOfHeight(c, 50)).toBe(7_200)
    expect(timeUpperBoundOfHeight(c, 100)).toBe(7_200)
    expect(timeUpperBoundOfHeight(c, 101)).toBe(10_800)
    expect(timeUpperBoundOfHeight(c, 300)).toBe(14_400)
  })
  it('knows nothing of a block the clock has not seen', () => {
    expect(timeUpperBoundOfHeight(c, 301)).toBeNull()
    expect(timeUpperBoundOfHeight({ hours: [], heights: [], builtAt: 0 }, 1)).toBeNull()
  })
})
