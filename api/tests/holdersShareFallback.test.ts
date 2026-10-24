import { describe, it, expect } from 'vitest'
import { valueHoldersPage } from '../src/services/explorerService.ts'

const page = (totalBasis: { amount: string | null } | { each: string[] }) => ({
  asset: { assetId: 1001354, iconAssetId: 1001354, symbol: 'aDOT-HOLLAR', name: null, decimals: 18, parachainId: null, origin: null },
  rows: [{ rank: 1, balance: '750', lastBlock: 0 }, { rank: 2, balance: '250', lastBlock: 0 }],
  total: 2, holderCount: 2, totalBasis,
}) as unknown as Parameters<typeof valueHoldersPage>[2]

describe('valueHoldersPage share', () => {
  // aDOT-HOLLAR (a vault share) had no price, and every holder read a 0% share.
  it('falls back to balance over supply when the asset has no price', () => {
    const out = valueHoldersPage(1001354, 18, page({ amount: '1000' }), new Map())
    expect(out.holders.map(h => h.share)).toEqual([0.75, 0.25])
    expect(out.holders.every(h => h.valueUsd == null)).toBe(true)
  })

  it('sums the holders when the supply is only known as their balances', () => {
    const out = valueHoldersPage(1001354, 18, page({ each: ['750', '250'] }), new Map())
    expect(out.holders.map(h => h.share)).toEqual([0.75, 0.25])
  })

  it('keeps the value share when there is a price', () => {
    const prices = new Map([[1001354, { price: 2, priceRaw: '2', change24h: 0 }]])
    const out = valueHoldersPage(1001354, 0, page({ amount: '1000' }), prices as never)
    expect(out.holders.map(h => h.share)).toEqual([0.75, 0.25])
    expect(out.holders[0].valueUsd).toBe(1500)
  })
})
