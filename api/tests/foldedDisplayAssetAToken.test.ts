import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ATOKEN_UNDERLYING_ID, SHARE_TOKEN_UNDERLYING_ID } from '../src/services/explorerAssets.ts'

const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// getHolders has two folds and they are mutually exclusive by ORDER: the
// display-asset branch runs first and returns, so an asset that is both a
// display asset and an aToken never reaches the aToken branch.
//
// BIL is exactly that — the bil market's aToken over uBIL, and the display asset
// of 2-Pool-BIL. Its holders came from the substrate balance table, where an
// aToken has none (its balances live in EVM storage), so the page showed 2
// holders against the 78 its own contract has, with no error anywhere.
describe('a display asset that is itself an aToken', () => {
  it('BIL is both, which is what makes the two folds collide', () => {
    expect(ATOKEN_UNDERLYING_ID[55]).toBe(550)
    expect(SHARE_TOKEN_UNDERLYING_ID[10055]).toBe(55)
  })

  // The two must not both claim it: a substrate read for an aToken is not a
  // smaller answer, it is a wrong one, and silently so.
  it('drops such an asset from the substrate read', () => {
    expect(src).toContain('const displayIsAToken = ATOKEN_UNDERLYING_ID[displayAssetId] != null')
    expect(src).toContain('const sourceIds = displayIsAToken ? normalizedShareIds : [displayAssetId, ...normalizedShareIds]')
  })

  // reserveTokens covers aTokens whose reserve is one of the SHARE ids; this is
  // the other direction and nothing reconstructed it before.
  it('reconstructs the display asset\'s own aToken instead', () => {
    expect(src).toContain('const displayToken = displayIsAToken ? tokens.find(token => displayReserves.has(token.asset.toLowerCase())) : undefined')
    expect(src).toContain('reconstructHolderScaled(displayToken.aToken, b0)')
    // Scaled balances are only balances once multiplied by the reserve's index.
    expect(src).toContain('const bal = (holder.scaled * displayLiquidityIndex) / ATOKEN_RAY')
  })

  // Same guards the plain aToken path uses: without an anchor block or a live
  // index the reconstruction is not attempted at all, rather than summing to a
  // confident wrong number.
  it('attempts nothing without an anchor block and a live liquidity index', () => {
    expect(src).toContain('displayToken && b0 > 0 && displayLiquidityIndex > 0n')
  })
})
