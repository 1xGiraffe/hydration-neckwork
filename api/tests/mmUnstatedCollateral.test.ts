import { describe, expect, it } from 'vitest'
import {
  attachMmReserves, mmReserveAddressForAsset, mmUnstatedCollateralUsd, mmUnstatedReserves,
  type MmReserve, type MmReserveToken, type MoneyMarketPosition,
} from '../src/services/explorerService.ts'
import { assetDescriptor } from '../src/services/explorerAssets.ts'

// A money-market position has two statements of its collateral: the per-reserve
// fold (anchor + indexed aToken deltas × index, at our prices, as of the head) and
// the chain's own aggregate (getUserAccountData's totalCollateralBase, at the
// oracle's prices, as of its 6-hourly or event-driven observation). The fold is
// exact wherever it can see, so an aggregate above it is staleness or the oracle's
// gap — never collateral — EXCEPT for a reserve the fold cannot state: one the
// holder's usage-as-collateral bit names while the fold holds nothing of it (an
// aToken that reached the holder Substrate-side, outside the aToken logs), or a
// supplied one without a price. Only then does the aggregate's remainder count.
const RAY = 10n ** 27n
const POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const DOT = 5, ADOT = 1001, WBTC = 19, AWBTC = 1004
const token = (asset: number, tag: string): MmReserveToken =>
  ({ asset: mmReserveAddressForAsset(asset)[0], aToken: `0x${tag.repeat(20)}`, vDebt: `0x${tag.repeat(19)}ff`, poolProxy: POOL, marketKey: 'core' })
const dot = token(DOT, 'a1')
const wbtc = token(WBTC, 'b2')
const key = (t: MmReserveToken) => `${POOL}:${t.asset.toLowerCase()}`
const indices = new Map([[key(dot), { liq: RAY, vbi: RAY }], [key(wbtc), { liq: RAY, vbi: RAY }]])
// DOT priced — and, as the live map after its alias pass, aDOT under its own id,
// which is the entry the wallet fold reads (usdOfRaw takes no alias walk); WBTC's
// feed is gone (the Moonbeam route ended), so aWBTC is unpriced.
const prices = new Map([[DOT, { price: 4, change24h: 0 }], [ADOT, { price: 4, change24h: 0 }]])
const units = (assetId: number, n: number) => BigInt(n) * 10n ** BigInt(assetDescriptor(assetId).decimals)

describe('mmUnstatedReserves', () => {
  it('names a collateral-flagged reserve the fold holds nothing of, by its aToken', () => {
    const out = mmUnstatedReserves([dot, wbtc], new Map(), indices, prices, new Map([[key(dot), true]]))
    expect(out).toEqual([{ assetId: ADOT, marketKey: 'core', reason: 'unreconstructed' }])
  })

  it('is satisfied by a reconstructed supply, and names nothing without the flag', () => {
    const held = new Map([[dot.aToken, units(DOT, 100)]])
    expect(mmUnstatedReserves([dot], held, indices, prices, new Map([[key(dot), true]]))).toEqual([])
    expect(mmUnstatedReserves([dot], new Map(), indices, prices, new Map([[key(dot), false]]))).toEqual([])
    expect(mmUnstatedReserves([dot], new Map(), indices, prices, new Map())).toEqual([])
  })

  it('treats a flagged reserve without a live index as unstated', () => {
    const held = new Map([[dot.aToken, units(DOT, 100)]])
    expect(mmUnstatedReserves([dot], held, new Map(), prices, new Map([[key(dot), true]])))
      .toEqual([{ assetId: ADOT, marketKey: 'core', reason: 'unreconstructed' }])
  })

  it('names a supplied reserve our prices cannot value, flagged or not', () => {
    const held = new Map([[wbtc.aToken, units(WBTC, 1)]])
    expect(mmUnstatedReserves([wbtc], held, indices, prices, new Map())).toEqual([{ assetId: AWBTC, marketKey: 'core', reason: 'unpriced' }])
    // A debt-only unpriced reserve is not collateral the fold failed to value.
    expect(mmUnstatedReserves([wbtc], new Map([[wbtc.vDebt, units(WBTC, 1)]]), indices, prices, new Map())).toEqual([])
  })
})

const position = (over: Partial<MoneyMarketPosition> = {}): MoneyMarketPosition => ({
  marketKey: 'core', market: 'Money Market', role: 'primary', defiSimSupported: true, stakingBacked: false,
  blockHeight: 100, timestamp: '2026-09-26 00:00:00',
  totalCollateralBase: '1000000000000', totalSuppliedBase: '1000000000000', totalDebtBase: '0', availableBorrowsBase: '0',
  liquidationThreshold: '8000', ltv: '7000', healthFactor: 'inf', ...over,
})
const aDotRow: MmReserve = {
  assetId: ADOT, symbol: 'aDOT', decimals: assetDescriptor(DOT).decimals, supplied: units(DOT, 2000).toString(), debt: '0',
  suppliedUsd: 8000, debtUsd: 0, collateral: true, marketKey: 'core',
}

describe('mmUnstatedCollateralUsd', () => {
  it('counts nothing for a market whose reserves are all stated, whatever the aggregate says', () => {
    // A $10,000 aggregate observed before a DCA reserved part of the aDOT beside an
    // $8,000 fold: the $2,000 is a stale observation, not collateral.
    expect(mmUnstatedCollateralUsd(position(), 8000)).toBe(0)
  })

  it('counts the aggregate above the fold for a market naming an unstated reserve, floored at zero', () => {
    const p = position({ unstatedCollateral: [assetDescriptor(69)] })
    expect(mmUnstatedCollateralUsd(p, 8000)).toBe(2000)
    expect(mmUnstatedCollateralUsd(p, 0)).toBe(10000)
    expect(mmUnstatedCollateralUsd(p, 12000)).toBe(0)
    expect(mmUnstatedCollateralUsd(position({ unstatedCollateral: [], totalCollateralBase: '0' }), 0)).toBe(0)
  })
})

describe('attachMmReserves', () => {
  it('states the supplied total from the reserves, not the higher aggregate, when every reserve is stated', () => {
    const out = attachMmReserves(position(), [aDotRow], prices)
    expect(out.totalSuppliedBase).toBe('800000000000')
    expect(out.unstatedCollateral).toBeUndefined()
    expect(out.reserves).toHaveLength(1)
  })

  it('lets the aggregate stand in, and names the reserve, when one is unstated in this market', () => {
    const out = attachMmReserves(position(), [aDotRow], prices, [{ assetId: 69, marketKey: 'core', reason: 'unreconstructed' }])
    expect(out.totalSuppliedBase).toBe('1000000000000')
    expect(out.unstatedCollateral?.map(a => a.assetId)).toEqual([69])
    // A position the fold has no row for at all keeps the aggregate the same way.
    const bare = attachMmReserves(position(), [], prices, [{ assetId: 69, marketKey: 'core', reason: 'unreconstructed' }])
    expect(bare.totalSuppliedBase).toBe('1000000000000')
    expect(bare.reserves).toEqual([])
  })

  it('ignores an unstated reserve of another isolated market', () => {
    const out = attachMmReserves(position(), [aDotRow], prices, [{ assetId: 69, marketKey: 'bil', reason: 'unreconstructed' }])
    expect(out.totalSuppliedBase).toBe('800000000000')
    expect(out.unstatedCollateral).toBeUndefined()
  })
})
