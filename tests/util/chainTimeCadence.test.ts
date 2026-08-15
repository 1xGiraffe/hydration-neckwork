import { describe, expect, it } from 'vitest'
import {
  crossedChainTimeBoundary,
  minutesForLegacyBlockInterval,
  MS_PER_MINUTE,
  shouldRunOnElapsedChainTime,
} from '../../src/util/chainTimeCadence.ts'

const HOUR = 60 * MS_PER_MINUTE
const TWELVE_HOURS = 12 * HOUR

// Chain time, not block count, is what makes these triggers survive a block-time
// change: the same wall-clock cadence comes out at 6s, 2s, or anything else.
describe('elapsed chain-time trigger (asset registry scan)', () => {
  const interval = 100 * MS_PER_MINUTE

  it('runs on the first evaluation, whatever the timestamp', () => {
    expect(shouldRunOnElapsedChainTime(null, Date.UTC(2026, 0, 1), interval)).toBe(true)
    expect(shouldRunOnElapsedChainTime(null, undefined, interval)).toBe(true)
  })

  it('waits until a full interval of chain time has passed', () => {
    const last = Date.UTC(2026, 0, 1, 0, 0, 0)
    expect(shouldRunOnElapsedChainTime(last, last + interval - 1, interval)).toBe(false)
    expect(shouldRunOnElapsedChainTime(last, last + interval, interval)).toBe(true)
  })

  // The point of the change: the same interval covers 3x the blocks at 2s and the
  // scan rate per unit of chain time does not move.
  it('fires at the same chain times whatever the block cadence', () => {
    const start = Date.UTC(2026, 0, 1)
    const runsAt = (blockMs: number): number[] => {
      const fired: number[] = []
      let last: number | null = null
      for (let t = start; t < start + 24 * HOUR; t += blockMs) {
        if (shouldRunOnElapsedChainTime(last, t, interval)) {
          fired.push(t)
          last = t
        }
      }
      return fired
    }

    const atSixSeconds = runsAt(6_000)
    const atTwoSeconds = runsAt(2_000)
    expect(atSixSeconds.length).toBe(atTwoSeconds.length)
    expect(atSixSeconds).toEqual(atTwoSeconds)
  })

  // Only genesis has no timestamp; it must not become a per-block scan trigger.
  it('does not trigger on a block with no chain clock', () => {
    const last = Date.UTC(2026, 0, 1)
    expect(shouldRunOnElapsedChainTime(last, undefined, interval)).toBe(false)
    expect(shouldRunOnElapsedChainTime(last, null, interval)).toBe(false)
  })
})

describe('absolute chain-time boundary (money-market re-snapshot)', () => {
  it('fires on the first block past a boundary and not again inside the bucket', () => {
    const boundary = Date.UTC(2026, 0, 1, 12, 0, 0)
    expect(crossedChainTimeBoundary(boundary - 6_000, boundary, TWELVE_HOURS)).toBe(true)
    expect(crossedChainTimeBoundary(boundary, boundary + 6_000, TWELVE_HOURS)).toBe(false)
    expect(crossedChainTimeBoundary(boundary + 6_000, boundary + 12_000, TWELVE_HOURS)).toBe(false)
  })

  it('fires once per boundary even when a single gap skips over it', () => {
    const boundary = Date.UTC(2026, 0, 1, 12, 0, 0)
    expect(crossedChainTimeBoundary(boundary - 60_000, boundary + 60_000, TWELVE_HOURS)).toBe(true)
  })

  // Determinism is the property the money-market snapshot depends on: its rows are
  // keyed by block height, so parallel range workers and replays must pick the same
  // blocks. This case pins LOCALITY — the answer depends only on the adjacent pair,
  // so overlapping splits that always have a predecessor agree with the whole run.
  // The worker-reset case (a split whose first block has NO predecessor) is the next
  // test, and it is the one that loses a boundary.
  it('picks the same blocks for any split that keeps each block its predecessor', () => {
    const start = Date.UTC(2026, 0, 1, 3, 0, 0)
    const blocks = Array.from({ length: 20_000 }, (_, i) => start + i * 6_000)

    const fireHeights = (from: number, to: number): number[] => {
      const fired: number[] = []
      for (let i = from + 1; i < to; i++) {
        if (crossedChainTimeBoundary(blocks[i - 1], blocks[i], TWELVE_HOURS)) fired.push(i)
      }
      return fired
    }

    const whole = fireHeights(0, blocks.length)
    const split = [...fireHeights(0, 7_000), ...fireHeights(6_999, 14_000), ...fireHeights(13_999, blocks.length)]
    expect(split).toEqual(whole)
    expect(whole.length).toBe(3) // 33.3h of chain time from 03:00 crosses 12:00, 00:00, 12:00
  })

  it('fires the same number of times per day of chain time at 6s and at 2s', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 3)
    const countOverADay = (blockMs: number): number => {
      let fired = 0
      for (let t = start + blockMs; t <= start + 24 * HOUR; t += blockMs) {
        if (crossedChainTimeBoundary(t - blockMs, t, TWELVE_HOURS)) fired++
      }
      return fired
    }

    expect(countOverADay(6_000)).toBe(2)
    expect(countOverADay(2_000)).toBe(2)
  })

  // A worker start (or the backward-replay reset in the raw indexer) clears the
  // previous timestamp, so its very first block cannot be compared with anything.
  // The documented cost: a boundary landing exactly on that block is lost — never
  // duplicated, never written at a height a replay would not reproduce. Restarting
  // one block earlier recovers it, which is what makes the loss bounded.
  it('loses exactly the boundary that lands on a worker restart, and nothing else', () => {
    const boundary = Date.UTC(2026, 0, 1, 12, 0, 0)
    const blocks = [boundary - 12_000, boundary - 6_000, boundary, boundary + 6_000, boundary + 12_000]

    const fireIndices = (startIndex: number): number[] => {
      let previous: number | null = null
      const fired: number[] = []
      for (let i = startIndex; i < blocks.length; i++) {
        if (crossedChainTimeBoundary(previous, blocks[i], TWELVE_HOURS)) fired.push(i)
        previous = blocks[i]
      }
      return fired
    }

    expect(fireIndices(0)).toEqual([2]) // uninterrupted: the boundary block fires
    expect(fireIndices(2)).toEqual([]) // restarted ON the boundary block: lost
    expect(fireIndices(1)).toEqual([2]) // restarted one block earlier: recovered
    expect(fireIndices(3)).toEqual([]) // restarted after it: no late duplicate
  })

  it('never fires without a previous block to compare against', () => {
    const boundary = Date.UTC(2026, 0, 1, 12, 0, 0)
    expect(crossedChainTimeBoundary(null, boundary, TWELVE_HOURS)).toBe(false)
    expect(crossedChainTimeBoundary(undefined, boundary, TWELVE_HOURS)).toBe(false)
    expect(crossedChainTimeBoundary(boundary - 6_000, undefined, TWELVE_HOURS)).toBe(false)
  })

  it('does not fire on a backward replay', () => {
    const boundary = Date.UTC(2026, 0, 1, 12, 0, 0)
    expect(crossedChainTimeBoundary(boundary + 6_000, boundary - 6_000, TWELVE_HOURS)).toBe(false)
  })
})

describe('legacy block-count intervals', () => {
  it('reads the deployed block counts as the durations they stood for at 6s', () => {
    expect(minutesForLegacyBlockInterval(7_200)).toBe(720) // 12h money-market snapshot
    expect(minutesForLegacyBlockInterval(1_000)).toBe(100) // asset registry, live
    expect(minutesForLegacyBlockInterval(10_000)).toBe(1_000) // asset registry, backfill
  })

  it('never collapses a positive interval to zero', () => {
    expect(minutesForLegacyBlockInterval(1)).toBe(1)
  })
})
