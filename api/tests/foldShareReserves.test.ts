import { describe, it, expect } from 'vitest'
import { foldShareHistoryReserves, foldShareReserves } from '../src/services/explorerService.ts'
import type { MmReserve, MoneyMarketHistoryReserveView } from '../src/services/explorerService.ts'
import { assetDescriptor } from '../src/services/explorerAssets.ts'

// Money-market reserves use the 2-Pool tokens (Hydration's MM reserves); the borrow
// card folds them to the underlying main asset (2-Pool-GETH→GETH, 2-Pool-GSOL→GSOL,
// 2-Pool-HUSDC→HUSDC, …) — same rule as wallet balances. Build reserves with
// assetDescriptor so share token and underlying share decimals (rescale = no-op).
const res = (assetId: number, supplied: string, debt: string, suppliedUsd: number | null, debtUsd: number | null): MmReserve => {
  const d = assetDescriptor(assetId)
  return { assetId: d.assetId, symbol: d.symbol, decimals: d.decimals, supplied, debt, suppliedUsd, debtUsd, collateral: supplied !== '0' }
}

describe('foldShareReserves', () => {
  it('relabels pool-share reserves to their underlying (2-Pool-GETH→GETH, 2-Pool-GSOL→GSOL)', () => {
    const out = foldShareReserves([res(4200, '100', '0', 16000, 0), res(90001, '50', '0', 56, 0)])
    expect(out.map(r => r.assetId).sort((a, b) => a - b)).toEqual([420, 9001])
    expect(out.every(r => !r.symbol.includes('-Pool'))).toBe(true)
  })

  it('preserves supplied/debt and USD for a lone pool reserve', () => {
    const [g] = foldShareReserves([res(690, '12345', '0', 99, 0)])
    expect(g.assetId).toBe(69)
    expect(g.supplied).toBe('12345')
    expect(g.suppliedUsd).toBe(99)
  })

  it('merges a pool reserve into an existing underlying reserve (sums amounts + USD)', () => {
    const out = foldShareReserves([res(420, '30', '0', 50, 0), res(4200, '100', '0', 160, 0)])
    expect(out).toHaveLength(1)
    expect(out[0].assetId).toBe(420)
    expect(out[0].supplied).toBe('130')
    expect(out[0].suppliedUsd).toBe(210)
  })

  it('leaves non-pool reserves (aTokens, plain assets) untouched and is a no-op without pools', () => {
    const input = [res(1001, '5', '0', 10, 0), res(15, '0', '7', 0, 20)] // aDOT, vDOT
    expect(foldShareReserves(input)).toBe(input)
  })
})

// The history's twin: a share reserve's history is filed under the id the Borrow
// tab shows its current balance as, so the tab matches the two on one key instead
// of listing the share as a second, "closed" reserve. Amounts and interest rescale
// to the display asset's decimals; two reserves folding onto one id merge per bucket.
describe('foldShareHistoryReserves', () => {
  const interest = (earned: string, earnedUsd: number | null): MoneyMarketHistoryReserveView['interest'] =>
    ({ interestEarned: earned, interestPaid: '0', interestEarnedUsd: earnedUsd, interestPaidUsd: 0, interestIncomplete: false })
  const point = (i: number, supplied: string, suppliedUsd: number | null, earned = '0', earnedUsd: number | null = 0): MoneyMarketHistoryReserveView['points'][number] =>
    ({ i, supplied, borrowed: '0', suppliedUsd, borrowedUsd: 0, collateral: true, ...interest(earned, earnedUsd) })
  const view = (assetId: number, decimals: number, points: MoneyMarketHistoryReserveView['points'], total = interest('0', 0)): MoneyMarketHistoryReserveView =>
    ({ asset: { ...assetDescriptor(assetId), decimals }, aToken: null, reserveAddress: `0x${assetId}`, points, interest: total })

  it('files a share reserve under its display id, rescaled to that asset\'s decimals (2-Pool-GETH → GETH)', () => {
    // The share carries 18 decimals here; the display asset is unknown to this test's registry, so it reads the 12-decimal placeholder.
    const [g] = foldShareHistoryReserves([view(4200, 18, [point(0, '1000000000000000000', 3, '2000000000000000000', 1)], interest('2000000000000000000', 1))])
    expect(g.asset.assetId).toBe(420)
    expect(g.points).toEqual([point(0, '1000000000000', 3, '2000000000000', 1)])
    expect(g.interest).toEqual(interest('2000000000000', 1))
  })

  it('merges onto an existing reserve bucket by bucket; a USD sum stays null once either side is', () => {
    const out = foldShareHistoryReserves([
      view(420, 12, [point(0, '10', 1), point(1, '10', null)], interest('4', 2)),
      view(4200, 12, [point(1, '5', 2), point(2, '5', 2)], interest('6', null)),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].asset.assetId).toBe(420)
    expect(out[0].points.map(p => [p.i, p.supplied, p.suppliedUsd])).toEqual([[0, '10', 1], [1, '15', null], [2, '5', 2]])
    expect(out[0].interest).toMatchObject({ interestEarned: '10', interestEarnedUsd: null })
  })

  it('is a no-op without share reserves', () => {
    const input = [view(1001, 10, [point(0, '5', 1)])]
    expect(foldShareHistoryReserves(input)).toBe(input)
  })
})
