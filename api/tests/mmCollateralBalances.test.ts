import { describe, expect, it } from 'vitest'
import { applyMmCollateralToBalances, foldShareBalances, type AddressBalance, type MmReserve } from '../src/services/explorerService.ts'
import { assetDescriptor } from '../src/services/explorerAssets.ts'

// An aToken's pallet row (Tokens.Accounts) has free 0 — an ERC-20 registry asset's
// balance lives in contract storage — and carries only what a named reserve holds:
// a DCA order selling the aToken reserves it through Tokens, which moves the aTokens
// out of the holder's balanceOf into the pallet's holding and mirrors the amount as
// `reserved`. The money-market reserve read (`supplied`) is that balanceOf, so it
// replaces the free side and must leave the reserve alone: a holder with 6 atBTC
// supplied and 1 atBTC reserved for a DCA owns 7.
const ATBTC = 1006
const HUSDC = 1110          // aToken over 2-Pool-HUSDC, not in ATOKEN_UNDERLYING_ID
const TWO_POOL_HUSDC = 110  // the reserve the money market actually keys by
const PRICE = 100_000
const prices = new Map([[ATBTC, { price: PRICE, change24h: 0 }], [HUSDC, { price: 1, change24h: 0 }], [TWO_POOL_HUSDC, { price: 1, change24h: 0 }]])

const units = (assetId: number, n: number) => (BigInt(n) * 10n ** BigInt(assetDescriptor(assetId).decimals)).toString()
const bal = (assetId: number, over: Partial<AddressBalance>): AddressBalance =>
  ({ asset: assetDescriptor(assetId), total: '0', free: '0', reserved: '0', lastBlock: 1, valueUsd: null, ...over })
const reserve = (assetId: number, supplied: string): MmReserve =>
  ({ assetId, symbol: assetDescriptor(assetId).symbol, decimals: assetDescriptor(assetId).decimals, supplied, debt: '0', suppliedUsd: null, debtUsd: null, collateral: true, marketKey: 'core' })

describe('applyMmCollateralToBalances', () => {
  it('keeps the pallet-side reserved slice when supplied collateral replaces the free side', () => {
    const balances = [bal(ATBTC, { total: units(ATBTC, 1), free: '0', reserved: units(ATBTC, 1) })]
    const folded = applyMmCollateralToBalances(balances, { blockHeight: 10, reserves: [reserve(ATBTC, units(ATBTC, 6))] }, prices)
    expect(balances).toHaveLength(1)
    expect(balances[0].total).toBe(units(ATBTC, 7))
    expect(balances[0].free).toBe(units(ATBTC, 6))
    expect(balances[0].reserved).toBe(units(ATBTC, 1))
    expect(balances[0].valueUsd).toBeCloseTo(7 * PRICE)
    // Only the supplied part is money-market collateral: the aggregate the
    // shortfall is measured against never covered the reserve.
    expect(folded).toBeCloseTo(6 * PRICE)
  })

  it('leaves a fully reserved aToken (nothing supplied) as the wallet row it already is', () => {
    const balances = [bal(ATBTC, { total: units(ATBTC, 1), free: '0', reserved: units(ATBTC, 1), valueUsd: PRICE })]
    const folded = applyMmCollateralToBalances(balances, { blockHeight: 10, reserves: [reserve(ATBTC, '0')] }, prices)
    expect(folded).toBe(0)
    expect(balances[0]).toMatchObject({ total: units(ATBTC, 1), free: '0', reserved: units(ATBTC, 1), valueUsd: PRICE })
  })

  it('adds a holding with no pallet row as a free balance', () => {
    const balances: AddressBalance[] = []
    applyMmCollateralToBalances(balances, { blockHeight: 10, reserves: [reserve(ATBTC, units(ATBTC, 6))] }, prices)
    expect(balances).toHaveLength(1)
    expect(balances[0]).toMatchObject({ total: units(ATBTC, 6), free: units(ATBTC, 6), reserved: '0', lastBlock: 10 })
    expect(balances[0].valueUsd).toBeCloseTo(6 * PRICE)
  })

  it('reaches the same row whether the reserve is keyed by the aToken or by its pool share', () => {
    // HUSDC's money-market reserve is the 2-Pool-HUSDC share, so the reserve row is
    // appended under the share id and the display fold merges it onto the wallet
    // row; atBTC's reserve is keyed by atBTC itself and edits the wallet row in
    // place. Both must end as free = supplied, reserved = the pallet's.
    const balances = [bal(HUSDC, { total: units(HUSDC, 1), free: '0', reserved: units(HUSDC, 1) })]
    applyMmCollateralToBalances(balances, { blockHeight: 10, reserves: [reserve(TWO_POOL_HUSDC, units(TWO_POOL_HUSDC, 6))] }, prices)
    const out = foldShareBalances(balances)
    expect(out).toHaveLength(1)
    expect(out[0].asset.assetId).toBe(HUSDC)
    expect(out[0]).toMatchObject({ total: units(HUSDC, 7), free: units(HUSDC, 6), reserved: units(HUSDC, 1) })
  })
})
