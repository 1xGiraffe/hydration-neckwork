import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mmReserveAddressForAsset, mmReserveScope, valueSingleUnpricedSupply, type MmReserve } from '../src/services/explorerService.ts'

describe('money-market reserve address mapping', () => {
  it('includes both precompile and deployed-token addresses for HOLLAR', () => {
    expect(mmReserveAddressForAsset(222)).toEqual(expect.arrayContaining([
      '0x00000000000000000000000000000001000000de',
      '0x531a654d1696ed52e7275a8cede955e82620f99a',
    ]))
  })

  it('keeps standard precompile reserves unchanged', () => {
    expect(mmReserveAddressForAsset(5)).toEqual([
      '0x0000000000000000000000000000000100000005',
    ])
  })
})

// The id a reader visits is often not the id the market holds, and every surface
// scoped to one asset — the liquidation history and the asset activity tab — needs
// the same set of reserve addresses to find anything at all.
describe('reserve scope reaches an asset through its aliases', () => {
  const keys = (assetId: number) => [...mmReserveScope(assetId).byAddress.keys()]

  // A main asset whose collateral is a pool share: GDOT's reserve is 2-Pool-GDOT
  // (690 = 0x2b2), GETH's is 2-Pool-GETH (4200 = 0x1068). Resolving only the direct
  // id left both pages with no money-market rows and no liquidations.
  it('reaches the pool-share reserve from the main asset the share displays as', () => {
    expect(keys(69)).toContain('0x00000000000000000000000000000001000002b2')
    expect(keys(420)).toContain('0x0000000000000000000000000000000100001068')
    expect(keys(1110)).toContain('0x000000000000000000000000000000010000006e')
  })

  // An aToken is a claim on its reserve, so it resolves to the underlying and to
  // nothing else — aDOT's money-market flow IS the flow on DOT's reserve.
  it('reaches the underlying reserve from an aToken, and only that', () => {
    expect(keys(1001)).toEqual(['0x0000000000000000000000000000000100000005'])
  })

  it('leaves a plain reserve pointing at itself', () => {
    expect(keys(5)).toEqual(['0x0000000000000000000000000000000100000005'])
  })

  // The share token is also a page of its own, and from there there is nothing
  // further to resolve.
  it('keeps a share-token page to its own reserve', () => {
    expect(keys(690)).toEqual(['0x00000000000000000000000000000001000002b2'])
  })
})

// An activity row displays the queried asset and carries one raw amount, so it can
// only include a reserve whose units are that asset's. 2-Pool-PRIME carries 18
// decimals where PRIME carries 6; admitting it would render an 18-decimal amount as
// PRIME, overstating it by 10^12.
describe('asset activity filters money-market rows by the alias scope', () => {
  const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

  it('builds the reserve filter from the scope, restricted to matching units', () => {
    expect(explorerService).toContain('const reserveAddrs = [...mmReserveScope(assetId).byAddress]')
    expect(explorerService).toContain('.filter(([, decimals]) => decimals === asset(assetId).decimals)')
  })
})

describe('unpriced supplied-reserve valuation', () => {
  const stHdx: MmReserve = {
    assetId: 670,
    symbol: 'stHDX',
    decimals: 12,
    supplied: '1000000000000',
    debt: '0',
    suppliedUsd: null,
    debtUsd: null,
    collateral: true,
    marketKey: 'gigahdx',
  }

  it('uses aggregate collateral when the unpriced reserve is the sole supply', () => {
    expect(valueSingleUnpricedSupply([stHdx], '4250000000')[0].suppliedUsd).toBe(42.5)
  })

  it('does not guess across a mixed supplied position', () => {
    const hollar: MmReserve = {
      ...stHdx,
      assetId: 222,
      symbol: 'HOLLAR',
      supplied: '1000000000000000000',
      suppliedUsd: 1,
      collateral: false,
    }
    expect(valueSingleUnpricedSupply([stHdx, hollar], '4250000000')[0].suppliedUsd).toBeNull()
  })
})
