import { describe, it, expect } from 'vitest'
import {
  ATOKEN_UNDERLYING_ID,
  SHARE_TOKEN_UNDERLYING_ID,
  iconAssetIdFor,
} from '../src/services/explorerAssets.ts'

// Which asset's artwork a given asset renders with. A wrapper that ships no icon of
// its own borrows its underlying's; only assets with their own CDN art keep their id.

describe('iconAssetIdFor', () => {
  it('leaves an ordinary asset on its own id', () => {
    expect(iconAssetIdFor(0)).toBe(0)      // HDX
    expect(iconAssetIdFor(5)).toBe(5)      // DOT
  })

  it('folds an aToken onto its reserve asset', () => {
    expect(iconAssetIdFor(1001)).toBe(5)   // aDOT  → DOT
    expect(iconAssetIdFor(1007)).toBe(34)  // aETH  → ETH
  })

  it('folds a pool share token onto its main underlying', () => {
    // The regression: these resolved to themselves, and no CDN artwork exists under
    // a share token's own id, so every one of them rendered the letter placeholder.
    expect(iconAssetIdFor(690)).toBe(69)     // 2-Pool-GDOT  → GDOT
    expect(iconAssetIdFor(104)).toBe(34)     // 2-Pool-WETH  → ETH
    expect(iconAssetIdFor(110)).toBe(1110)   // 2-Pool-HUSDC → HUSDC (composite in the UI)
    expect(iconAssetIdFor(4200)).toBe(420)   // 2-Pool-GETH  → GETH
    expect(iconAssetIdFor(90001)).toBe(9001) // 2-Pool-GSOL  → GSOL
  })

  it('keeps branded product tokens on their own artwork', () => {
    // Both are aTokens, so the fold would otherwise take their underlying's icon —
    // stHDX has none at all, and uBIL's marks the wrapped receivable, not the brand.
    expect(iconAssetIdFor(67)).toBe(67)    // GIGAHDX, not stHDX
    expect(iconAssetIdFor(55)).toBe(55)    // BIL, not uBIL
  })

  it('resolves every wrapper in one hop', () => {
    // The fold is single-hop, so it is only correct while no underlying is itself a
    // key of either map — otherwise an icon would resolve to a still-iconless id.
    for (const target of [
      ...Object.values(ATOKEN_UNDERLYING_ID),
      ...Object.values(SHARE_TOKEN_UNDERLYING_ID),
    ]) {
      expect(iconAssetIdFor(target)).toBe(target)
    }
  })
})
