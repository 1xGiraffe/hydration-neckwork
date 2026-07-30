import { describe, it, expect } from 'vitest'
import { balanceChartSeries } from '../src/utils/balanceHistory'
import type { AssetBalanceHistory } from '../src/types'

// The account's per-asset balance graph must always start at the earliest observed
// balance across ALL the account's assets, so switching the selected asset never
// shifts the x-axis start. Regression for the aToken `availableFrom` axis-trim that
// jumped the start ~3 years (e.g. HDX from 2022-07-19, avDOT from 2025-07-08).
const TS = ['2022-07-19 00:00:00', '2023-01-01 00:00:00', '2025-07-08 00:00:00', '2026-07-17 00:00:00']

function hist(symbol: string, assetId: number, balances: number[], availableFrom?: string): AssetBalanceHistory {
  return {
    asset: { assetId, iconAssetId: assetId, symbol, name: symbol, decimals: 12, parachainId: null, origin: null },
    current: balances[balances.length - 1],
    points: balances.map((balance, i) => ({ ts: TS[i], blockHeight: 1000 + i, balance })),
    ...(availableFrom ? { availableFrom } : {}),
  } as AssetBalanceHistory
}

describe('balanceChartSeries', () => {
  // HDX held from the start; avDOT is an aToken only authoritative from a later node
  // anchor — the API still aligns it to the shared axis (0 before it was held).
  const HDX = hist('HDX', 0, [10, 12, 14, 16])
  const avDOT = hist('avDOT', 1001, [0, 0, 5, 7], '2025-07-08 00:00:00')
  const all = [HDX, avDOT]

  it('anchors every asset to the shared earliest date — aToken does not shift the start', () => {
    const a = balanceChartSeries(HDX, all)
    const b = balanceChartSeries(avDOT, all)
    expect(a.dates[0]).toBe(TS[0])
    expect(b.dates[0]).toBe(TS[0]) // was availableFrom (2025-07-08) before the fix
    expect(b.dates).toEqual(a.dates) // identical axis regardless of which asset is selected
  })

  it('forward-fills the selected asset over the shared axis (0 before first held)', () => {
    expect(balanceChartSeries(avDOT, all).series).toEqual([0, 0, 5, 7])
  })

  it('falls back to the asset own points when it is not on the shared axis', () => {
    const off = hist('OFF', 2, [3, 4])
    off.points = [{ ts: '2020-01-01 00:00:00', blockHeight: 1, balance: 3 }, { ts: '2020-06-01 00:00:00', blockHeight: 2, balance: 4 }]
    const res = balanceChartSeries(off, [HDX, off])
    expect(res.dates).toEqual(['2020-01-01 00:00:00', '2020-06-01 00:00:00'])
    expect(res.series).toEqual([3, 4])
  })
})
