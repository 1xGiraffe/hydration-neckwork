import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mmReserveAddressForAsset, mmReserveAddressesForTokens, mmReserveAliasIds, mmReserveIdsForAsset, mmReserveScope, valueSingleUnpricedSupply, type MmReserve } from '../src/services/explorerService.ts'

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

// One resolution behind every asset-scoped surface: the per-asset scope below and
// the token filters further down both read it, so a filter and a page can never
// disagree about which rows are the asset's.
describe('reserve ids resolve an asset through its aliases', () => {
  it('reaches the aToken underlying and the share token that displays as the asset', () => {
    expect(mmReserveIdsForAsset(69)).toEqual([69, 690])          // GDOT → 2-Pool-GDOT
    expect(mmReserveIdsForAsset(420)).toEqual([420, 4200])       // GETH → 2-Pool-GETH
    expect(mmReserveIdsForAsset(1001)).toEqual([1001, 5])        // aDOT → DOT
    expect(mmReserveIdsForAsset(5)).toEqual([5])                 // a plain reserve
    expect(mmReserveIdsForAsset(690)).toEqual([690])             // the share token itself
  })
})

// A token filter asking for GDOT matched only GDOT's own precompile, where the market
// never files a supply, borrow, repay or liquidation — those all sit on the pool
// share — so the money-market feed returned reward claims and nothing else.
describe('token filters match every reserve a row can be filed under', () => {
  it('covers the pool-share reserve of the token asked for', () => {
    expect(mmReserveAddressesForTokens([69])).toEqual([
      '0x0000000000000000000000000000000100000045',   // GDOT itself (reward claims)
      '0x00000000000000000000000000000001000002b2',   // 2-Pool-GDOT (the reserve)
    ])
  })

  it('keeps a plain reserve to one address and dedupes an aToken onto its underlying', () => {
    expect(mmReserveAddressesForTokens([5])).toEqual(['0x0000000000000000000000000000000100000005'])
    expect(mmReserveAddressesForTokens([1001, 5])).toEqual(['0x0000000000000000000000000000000100000005'])
  })

  // A filter can name several tokens; every one of them contributes its aliases.
  it('unions the aliases of every token in the filter', () => {
    expect(mmReserveAddressesForTokens([69, 420])).toEqual(expect.arrayContaining([
      '0x00000000000000000000000000000001000002b2',
      '0x0000000000000000000000000000000100001068',
    ]))
    expect(mmReserveAddressesForTokens([])).toEqual([])
  })

  // HOLLAR's deployed token address must survive the widening.
  it('keeps deployed-token addresses', () => {
    expect(mmReserveAddressesForTokens([222])).toContain('0x531a654d1696ed52e7275a8cede955e82620f99a')
  })

  // The token filter runs twice — as the SQL reserve predicate and again per
  // assembled row — so a row has to answer to the same ids the address set was built
  // from. Widening only the SQL half selected rows the row test then discarded, which
  // left a filtered feed empty and its walker searching to the depth bound (503).
  it('lets a row answer to the ids whose filter selected it', () => {
    expect(mmReserveAliasIds(690)).toEqual([69])        // a 2-Pool-GDOT row answers to GDOT
    expect(mmReserveAliasIds(5)).toEqual([1001])        // a DOT row answers to aDOT
    expect(mmReserveAliasIds(4200)).toEqual([420])
    expect(mmReserveAliasIds(69)).toEqual([])           // nothing further to answer to
  })

  // Round trip: every id whose filter selects a reserve's address must be an id that
  // reserve's rows answer to, or the two halves of the filter disagree again.
  it('round-trips against the address resolution', () => {
    for (const [token, reserve] of [[69, 690], [420, 4200], [1110, 110], [1001, 5]] as const) {
      expect(mmReserveIdsForAsset(token)).toContain(reserve)
      expect([reserve, ...mmReserveAliasIds(reserve)]).toContain(token)
    }
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
