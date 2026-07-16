import { describe, expect, it } from 'vitest'
import { alignBalanceHistoryDailyPoints, hasNonZeroVisibleBalance } from '../src/services/explorerService.ts'
import type { AssetBalanceHistory, AssetBalancePoint, AssetRef } from '../src/services/explorerService.ts'

const point = (balance: number): AssetBalancePoint => ({ ts: '2026-07-07 00:00:00', blockHeight: 1, balance })
const datedPoint = (ts: string, balance: number): AssetBalancePoint => ({ ts, blockHeight: Number(ts.slice(8, 10)), balance })
const testAsset = (assetId: number, symbol: string): AssetRef => ({ assetId, iconAssetId: assetId, symbol, name: symbol, decimals: 12, parachainId: null, origin: null })
const history = (assetId: number, symbol: string, points: AssetBalancePoint[]): AssetBalanceHistory => ({
  asset: testAsset(assetId, symbol),
  current: points.at(-1)?.balance ?? 0,
  points,
})

describe('hasNonZeroVisibleBalance', () => {
  it('drops balance histories whose visible daily points are all zero', () => {
    expect(hasNonZeroVisibleBalance([point(0), point(0)])).toBe(false)
  })

  it('keeps balance histories with any non-zero visible daily point', () => {
    expect(hasNonZeroVisibleBalance([point(0), point(0.000001)])).toBe(true)
  })
})

describe('alignBalanceHistoryDailyPoints', () => {
  it('uses one shared daily axis across all account asset histories', () => {
    const aligned = alignBalanceHistoryDailyPoints([
      history(1, 'AAA', [
        datedPoint('2026-07-01 23:59:00', 0),
        datedPoint('2026-07-02 23:59:00', 5),
        datedPoint('2026-07-04 23:59:00', 7),
      ]),
      history(2, 'BBB', [
        datedPoint('2026-07-03 23:59:00', 2),
        datedPoint('2026-07-04 23:59:00', 0),
      ]),
    ])

    expect(aligned.map(h => h.points.map(p => p.ts))).toEqual([
      ['2026-07-02 23:59:00', '2026-07-03 23:59:00', '2026-07-04 23:59:00'],
      ['2026-07-02 23:59:00', '2026-07-03 23:59:00', '2026-07-04 23:59:00'],
    ])
    expect(aligned[0].points.map(p => p.balance)).toEqual([5, 5, 7])
    expect(aligned[1].points.map(p => p.balance)).toEqual([0, 2, 0])
  })

  it('drops histories that have no non-zero daily balance', () => {
    const aligned = alignBalanceHistoryDailyPoints([
      history(1, 'AAA', [datedPoint('2026-07-02 23:59:00', 0)]),
      history(2, 'BBB', [datedPoint('2026-07-02 23:59:00', 1)]),
    ])

    expect(aligned.map(h => h.asset.symbol)).toEqual(['BBB'])
  })
})
