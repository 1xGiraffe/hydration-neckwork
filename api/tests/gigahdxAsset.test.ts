import { describe, it, expect } from 'vitest'
import { ATOKEN_UNDERLYING_ID, PRICE_ALIAS_ID, priceAssetId, NAME_OVERRIDES } from '../src/services/explorerAssets.ts'

// GIGAHDX (67) is the gigahdx market's aToken over stHDX (670), which is
// staked HDX (rate floored at 1:1) — see pallets/gigahdx in hydration-node.
// Pricing must resolve TRANSITIVELY: 67 → 670 → 0 (HDX).
describe('GIGAHDX asset wiring', () => {
  it('maps GIGAHDX to its stHDX reserve like any other aToken', () => {
    expect(ATOKEN_UNDERLYING_ID[67]).toBe(670)
  })

  it('resolves the price alias chain down to HDX', () => {
    expect(PRICE_ALIAS_ID[670]).toBe(0)
    expect(priceAssetId(67)).toBe(0)
    expect(priceAssetId(670)).toBe(0)
    // single-hop aliases and unaliased assets are unchanged
    expect(priceAssetId(1001)).toBe(5)
    expect(priceAssetId(5)).toBe(5)
  })

  it('carries curated names for registry entries without one', () => {
    expect(NAME_OVERRIDES[67]).toBe('Giga HDX')
    expect(NAME_OVERRIDES[670]).toBe('Staked HDX')
  })
})
