import { describe, expect, it } from 'vitest'
import { ConcludedTurnout, type TurnoutRow } from '../src/services/governanceStats.ts'

// A concluded referendum's turnout is remembered across rebuilds — but a vote indexed
// late into its window (a backfill, a repair) must correct it, not wait for a restart.

const row = (index: number, voters: number): TurnoutRow => ({
  index, track: 0, status: 'approved', concludedAt: '2026-01-01T00:00:00Z', submittedAt: '2025-12-01T00:00:00Z',
  voters, ayeVoters: voters, nayVoters: 0, splitVoters: 0, ayeCapital: '0', nayCapital: '0', support: '0',
})

describe('concluded turnout memo', () => {
  const windows = [{ index: 1, from: 100, to: 200 }, { index: 2, from: 150, to: 300 }]

  it('drops a referendum whose window gains a late vote, keeps the others', () => {
    const m = new ConcludedTurnout(90_000)
    expect(m.remember(1, row(1, 10), 0)).toBe(true)
    expect(m.remember(2, row(2, 20), 0)).toBe(true)
    m.touched([{ block: 250, ingestedMs: 1_000_000 }], windows)
    expect(m.get(1)?.voters).toBe(10)
    expect(m.get(2)).toBeUndefined()
  })

  it('does not remember a re-read that may have gone through a cache older than the late vote', () => {
    const m = new ConcludedTurnout(90_000)
    m.remember(1, row(1, 10), 0)
    m.touched([{ block: 120, ingestedMs: 1_000_000 }], windows)
    // Read 30 s after the late row: the page's cached answer may still predate it.
    expect(m.remember(1, row(1, 11), 1_030_000)).toBe(false)
    expect(m.get(1)).toBeUndefined()
    // Read once the settle window has passed: kept.
    expect(m.remember(1, row(1, 11), 1_091_000)).toBe(true)
    expect(m.get(1)?.voters).toBe(11)
  })

  it('ignores rows outside every concluded window and an empty read', () => {
    const m = new ConcludedTurnout(90_000)
    m.remember(1, row(1, 10), 0)
    m.touched([], windows)
    m.touched([{ block: 99, ingestedMs: 5 }, { block: 301, ingestedMs: 5 }], windows)
    expect(m.get(1)?.voters).toBe(10)
  })
})
