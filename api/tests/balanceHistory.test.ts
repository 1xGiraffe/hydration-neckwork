import { describe, expect, it } from 'vitest'
import { alignBalanceHistoryDailyPoints, hasNonZeroVisibleBalance, reconstructATokenBalanceBuckets } from '../src/services/explorerService.ts'
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

describe('reconstructATokenBalanceBuckets', () => {
  it('applies signed scaled deltas and each historical RAY index with integer precision', () => {
    const ray = 10n ** 27n
    const scaled = 12_345_678_901_234_567_890n
    const history = reconstructATokenBalanceBuckets(
      2,
      5,
      scaled.toString(),
      [
        { b: 3, value: '1000000000000000000' },
        { b: 5, value: '-2000000000000000000' },
      ],
      [
        { b: 2, value: ray.toString() },
        { b: 4, value: (ray + ray / 10n).toString() },
      ],
    )

    expect(history).toEqual([
      { b: 2, value: scaled.toString() },
      { b: 3, value: (scaled + 10n ** 18n).toString() },
      { b: 4, value: ((scaled + 10n ** 18n) * 11n / 10n).toString() },
      { b: 5, value: ((scaled - 10n ** 18n) * 11n / 10n).toString() },
    ])
  })

  it('never exposes negative rounding dust as a negative balance', () => {
    expect(reconstructATokenBalanceBuckets(0, 1, '0', [{ b: 0, value: '-1' }], [{ b: 0, value: (10n ** 27n).toString() }]))
      .toEqual([{ b: 0, value: '0' }, { b: 1, value: '0' }])
  })
})
