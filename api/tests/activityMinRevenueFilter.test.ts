import { describe, expect, it } from 'vitest'
import { activityRowMatchesFilters, revenueFloorPasses } from '../src/services/explorerService.ts'
import type { ActivityRow } from '../src/services/explorerService.ts'

const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  type: 'trade', blockHeight: 100, timestamp: '2026-08-20 12:00:00', eventIndex: 1,
  extrinsicIndex: 2, who: null, to: null, asset: null, assetIn: null, assetOut: null,
  amount: null, amountIn: null, amountOut: null, valueUsd: 1000, ...over,
} as ActivityRow)

const rev = (protocolUsd: number) => ({ protocolUsd, lpUsd: 0, streams: [] })

// A protocol-revenue floor asks "what did the protocol earn here", which is a
// different question from the row's own value: a $13.7k liquidation earned $458
// while a $13.7k stablecoin swap earns cents.
//
// It is NOT part of activityRowMatchesFilters, which runs inside ~25 per-source
// builders BEFORE revenue is attached: there every row's revenue is absent, so the
// floor dropped everything. An account list filtered at $1 came back empty while its
// rows carried $1.25. The floor is applied where the figure exists instead.
describe('the shared row predicate', () => {
  it('does not judge revenue, because it runs before revenue is attached', () => {
    expect(activityRowMatchesFilters(row(), { minRevenue: 10 })).toBe(true)
    expect(activityRowMatchesFilters(row({ revenue: rev(1) }), { minRevenue: 10 })).toBe(true)
  })
})

describe('the minimum protocol revenue filter', () => {
  it('keeps a row at or above the floor', () => {
    expect(revenueFloorPasses(row({ revenue: rev(10) }), 10)).toBe(true)
    expect(revenueFloorPasses(row({ revenue: rev(458) }), 10)).toBe(true)
  })

  it('drops a row below the floor', () => {
    expect(revenueFloorPasses(row({ revenue: rev(9.99) }), 10)).toBe(false)
  })

  // Absent means nobody computed it — a block whose events are not queryable yet.
  // Treating that as 0 would silently hide rows that may well qualify, so an
  // unknown row is excluded from a filtered view rather than asserted to be under.
  it('drops a row whose revenue is not known yet', () => {
    expect(revenueFloorPasses(row(), 10)).toBe(false)
  })

  it('judges the protocol share, not the LP share', () => {
    const lpHeavy = { protocolUsd: 1, lpUsd: 900, streams: [] }
    expect(revenueFloorPasses(row({ revenue: lpHeavy }), 10)).toBe(false)
  })

  it('passes everything when no floor is set', () => {
    expect(revenueFloorPasses(row(), undefined)).toBe(true)
    expect(revenueFloorPasses(row({ revenue: rev(0) }), undefined)).toBe(true)
  })

  // The two floors are independent questions and compose as an AND at the call site.
  it('is independent of the value floor', () => {
    const r = row({ valueUsd: 50, revenue: rev(100) })
    expect(revenueFloorPasses(r, 10)).toBe(true)
    expect(activityRowMatchesFilters(r, { min: 1000, unit: 'usd' })).toBe(false)
  })
})
