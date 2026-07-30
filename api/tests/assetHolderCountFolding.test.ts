import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SHARE_TOKEN_UNDERLYING_ID } from '../src/services/explorerAssets.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// A display asset (GDOT←690, HEURC←10044, …) holds its supply in hidden
// stableswap-share ids, and a money-market custody row stands in for its suppliers.
// getAssetTotals folds both into the display asset, so its holder count must come
// from the same folded identity the detail page pages — otherwise a $3.7M asset
// shows "—" holders, or names its vault as the only one.
describe('assets directory holder counts', () => {
  it('folds share-token and custody holders into every display asset', () => {
    const at = explorerService.indexOf('export async function getAssetHolderCounts')
    const body = explorerService.slice(at, explorerService.indexOf('\nexport function mergeATokenHolderCounts', at))

    // Every path that returns a count map carries the folded counts (the outer
    // `return cached(…)` wraps them).
    const returns = (body.match(/return [^\n]*/g) ?? []).filter(line => line.includes('mergeATokenHolderCounts'))
    expect(returns.length).toBeGreaterThan(2)
    for (const line of returns) {
      expect(line, line).toContain('withFolded(')
    }
  })

  it('groups every configured share token under its display asset', () => {
    const at = explorerService.indexOf('async function foldedDisplayHolderCounts')
    const fn = explorerService.slice(at, explorerService.indexOf('\n}', at))

    expect(fn).toContain('Object.entries(SHARE_TOKEN_UNDERLYING_ID)')
    expect(fn).toContain('getFoldedDisplayAssetHolders(displayId, shareIds)')
    // The mapping is non-empty, so the fold covers real assets.
    expect(Object.keys(SHARE_TOKEN_UNDERLYING_ID).length).toBeGreaterThan(0)
  })
})

// An aToken's TVL is its reconstructed total supply. Summing only the displayed
// holders drops whatever pallet accounts hold — 35% of aDOT sits in the Omnipool —
// so the asset detail page and the assets list disagreed on one asset's TVL, and
// every holder share was measured against the reduced denominator.
describe('aToken totals', () => {
  it('values the holder page at the reconstructed total supply', () => {
    const at = explorerService.indexOf('const [prices, all, supplies] = await Promise.all([ensurePrices(), getATokenHolders(')
    expect(at).toBeGreaterThan(-1)
    const branch = explorerService.slice(at, explorerService.indexOf('return { asset: a, holders: enrichShare(page, prices, totalUsd)', at))

    expect(branch).toContain('getATokenTotalSupplies()')
    expect(branch).toContain('const supply = supplies.get(assetId)')
  })
})
