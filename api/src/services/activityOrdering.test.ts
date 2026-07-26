import { describe, expect, it } from 'vitest'
import { adjacencyClaimIndex, compareActivityRowsNewestFirst } from './explorerService.ts'
import type { ActivityRow } from './explorerService.ts'

const row = (r: Partial<ActivityRow>): ActivityRow => ({
  type: 'trade', blockHeight: 1, timestamp: '', eventIndex: null, extrinsicIndex: null,
  who: null, to: null, asset: null, assetIn: null, assetOut: null,
  amount: null, amountIn: null, amountOut: null, valueUsd: null, ...r,
} as ActivityRow)

// DCA.TradeExecuted is emitted right after the swap it settles, and one block
// routinely settles several schedules of the same size. Keying only on
// (block, amountIn) hands every one of them the same leg; claiming consumes it.
describe('adjacencyClaimIndex', () => {
  // Block 12335028: two executions of amountIn 7407407, at events 33 and 70, whose
  // own Router.Executed legs sit at 32 and 69 (confirmed by matching amountOut).
  const legs = [
    { event_index: 13, name: 'Stableswap.SellExecuted' },
    { event_index: 32, name: 'Router.Executed' },
    { event_index: 50, name: 'Stableswap.SellExecuted' },
    { event_index: 69, name: 'Router.Executed' },
  ]

  it('gives each execution its own leg, newest-last, never the same one twice', () => {
    const index = adjacencyClaimIndex(legs, () => 'k', l => l.event_index)
    // Executions are claimed in event order, each taking the nearest leg before it.
    expect(index.claimBefore('k', 33)?.event_index).toBe(32)
    expect(index.claimBefore('k', 70)?.event_index).toBe(69)
  })

  it('never hands one candidate to two claimants', () => {
    const index = adjacencyClaimIndex([{ event_index: 5 }], () => 'k', l => l.event_index)
    expect(index.claimBefore('k', 9)?.event_index).toBe(5)
    expect(index.claimBefore('k', 9)).toBeUndefined()
  })

  it('claims forward for the swap-led direction the global trade feed uses', () => {
    const index = adjacencyClaimIndex([{ event_index: 33 }, { event_index: 70 }], () => 'k', l => l.event_index)
    expect(index.claimAfter('k', 32)?.event_index).toBe(33)
    expect(index.claimAfter('k', 69)?.event_index).toBe(70)
  })

  it('falls back to the last remaining candidate rather than dropping the pairing', () => {
    const index = adjacencyClaimIndex([{ event_index: 40 }], () => 'k', l => l.event_index)
    expect(index.claimBefore('k', 10)?.event_index).toBe(40)
  })

  it('keeps separate keys independent', () => {
    const index = adjacencyClaimIndex([{ event_index: 1 }], () => 'a', l => l.event_index)
    expect(index.claimBefore('b', 9)).toBeUndefined()
  })
})

// Offset paging slices arrays built from different candidate sets, so the order has
// to be TOTAL: any two distinct rows must compare non-zero, or a page boundary can
// duplicate one row and drop another.
describe('compareActivityRowsNewestFirst', () => {
  it('orders newest block first, then the later event inside a block', () => {
    expect(compareActivityRowsNewestFirst(row({ blockHeight: 2 }), row({ blockHeight: 1 }))).toBeLessThan(0)
    expect(compareActivityRowsNewestFirst(row({ eventIndex: 9 }), row({ eventIndex: 3 }))).toBeLessThan(0)
  })

  it('sorts hook rows after real events inside their block', () => {
    expect(compareActivityRowsNewestFirst(row({ eventIndex: 0 }), row({ eventIndex: null }))).toBeLessThan(0)
  })

  it('separates two rows that share a block and an event index', () => {
    const a = row({ blockHeight: 7, eventIndex: 4, type: 'trade' })
    const b = row({ blockHeight: 7, eventIndex: 4, type: 'transfer' })
    expect(compareActivityRowsNewestFirst(a, b)).not.toBe(0)
    // and antisymmetrically, so the order does not depend on input order
    expect(Math.sign(compareActivityRowsNewestFirst(a, b))).toBe(-Math.sign(compareActivityRowsNewestFirst(b, a)))
  })

  it('separates two DCA executions that resolved to the same leg', () => {
    const a = row({ blockHeight: 7, eventIndex: 4, dca: true, dcaScheduleId: 31106 })
    const b = row({ blockHeight: 7, eventIndex: 4, dca: true, dcaScheduleId: 31109 })
    expect(compareActivityRowsNewestFirst(a, b)).not.toBe(0)
  })

  it('is a total order over a feed of distinct rows', () => {
    const rows = [
      row({ blockHeight: 7, eventIndex: 4, type: 'trade', dcaScheduleId: 1 }),
      row({ blockHeight: 7, eventIndex: 4, type: 'trade', dcaScheduleId: 2 }),
      row({ blockHeight: 7, eventIndex: 4, type: 'transfer' }),
      row({ blockHeight: 7, eventIndex: null, type: 'trade' }),
      row({ blockHeight: 7, eventIndex: 4, extrinsicIndex: 2, type: 'trade' }),
      row({ blockHeight: 8, eventIndex: 0, type: 'vote' }),
    ]
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        expect(compareActivityRowsNewestFirst(rows[i], rows[j])).not.toBe(0)
      }
    }
  })

  it('sorts identically regardless of the order the feed was assembled in', () => {
    const rows = [
      row({ blockHeight: 7, eventIndex: 4, dca: true, dcaScheduleId: 31109 }),
      row({ blockHeight: 7, eventIndex: 4, dca: true, dcaScheduleId: 31106 }),
      row({ blockHeight: 9, eventIndex: 1 }),
      row({ blockHeight: 7, eventIndex: 12, type: 'transfer' }),
    ]
    const key = (r: ActivityRow) => `${r.blockHeight}:${r.eventIndex}:${r.type}:${r.dcaScheduleId ?? ''}`
    const forward = [...rows].sort(compareActivityRowsNewestFirst).map(key)
    const reversed = [...rows].reverse().sort(compareActivityRowsNewestFirst).map(key)
    expect(forward).toEqual(reversed)
  })
})
