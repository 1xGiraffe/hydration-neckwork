import { describe, expect, it } from 'vitest'
import { activityRowMatchesFilters } from '../src/services/explorerService.ts'
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
describe('the minimum protocol revenue filter', () => {
  it('keeps a row at or above the floor', () => {
    expect(activityRowMatchesFilters(row({ revenue: rev(10) }), { minRevenue: 10 })).toBe(true)
    expect(activityRowMatchesFilters(row({ revenue: rev(458) }), { minRevenue: 10 })).toBe(true)
  })

  it('drops a row below the floor', () => {
    expect(activityRowMatchesFilters(row({ revenue: rev(9.99) }), { minRevenue: 10 })).toBe(false)
  })

  // Absent means nobody computed it — a block whose events are not queryable yet.
  // Treating that as 0 would silently hide rows that may well qualify, so an
  // unknown row is excluded from a filtered view rather than asserted to be under.
  it('drops a row whose revenue is not known yet', () => {
    expect(activityRowMatchesFilters(row(), { minRevenue: 10 })).toBe(false)
  })

  it('judges the protocol share, not the LP share', () => {
    const lpHeavy = { protocolUsd: 1, lpUsd: 900, streams: [] }
    expect(activityRowMatchesFilters(row({ revenue: lpHeavy }), { minRevenue: 10 })).toBe(false)
  })

  it('ignores revenue entirely when no floor is set', () => {
    expect(activityRowMatchesFilters(row(), {})).toBe(true)
    expect(activityRowMatchesFilters(row({ revenue: rev(0) }), {})).toBe(true)
  })

  // The two floors are independent questions and compose as an AND.
  it('applies alongside a value floor rather than replacing it', () => {
    const r = row({ valueUsd: 50, revenue: rev(100) })
    expect(activityRowMatchesFilters(r, { minRevenue: 10 })).toBe(true)
    expect(activityRowMatchesFilters(r, { minRevenue: 10, min: 1000, unit: 'usd' })).toBe(false)
  })
})
