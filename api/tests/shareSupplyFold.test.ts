import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  displayAssetId,
  loadExplorerAssets,
  registerStableswapPoolMembers,
  shareFoldsIntoDisplaySupply,
  stopExplorerAssetsRefresh,
  supplyFoldedShareIds,
} from '../src/services/explorerAssets.ts'

// A share folds into its display asset's SUPPLY (directory total, holder count,
// holder list) only when it is that asset's substance — a money-market wrapper
// over the share (GDOT over 2-Pool-GDOT). When the share's pool holds the display
// asset itself (2-Pool-BIL holds BIL), that asset's supply already counts the
// pool's holding, so adding the shares counted the reserve twice: BIL read $3.14M
// against a $2.52M supply.

const asset = (assetId: number, symbol: string) => ({
  asset_id: assetId, symbol, name: symbol, decimals: 18, parachain_id: null,
  origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null, evm_address: '',
})
const POOLS = [
  { pool_id: 10055, members: [55, 222] },   // 2-Pool-BIL: BIL + HOLLAR
  { pool_id: 143, members: [43, 222] },     // 2-Pool-PRIME: PRIME + HOLLAR
  { pool_id: 104, members: [20, 1007] },    // 2-Pool-WETH: WETH + aETH (an aToken over ETH)
  { pool_id: 690, members: [15, 1001] },    // 2-Pool-GDOT: vDOT + aDOT, displayed as GDOT
  { pool_id: 111, members: [222, 1002] },   // 2-Pool-HUSDT: HOLLAR + aUSDT, displayed as HUSDT
]
const client = {
  query: vi.fn(async ({ query }: { query: string }) => ({
    json: async () => (query.includes('stableswap_pool_state_history') ? POOLS
      : query.includes('price_data.assets') ? [asset(55, 'BIL'), asset(10055, '2-Pool-BIL'), asset(69, 'GDOT'), asset(690, '2-Pool-GDOT')]
        : []),
  })),
} as never

describe('share holdings in a display asset\'s supply', () => {
  afterEach(() => stopExplorerAssetsRefresh())

  it('keeps a share out when its pool holds the display asset, directly or as an aToken claim', async () => {
    await loadExplorerAssets(client)
    expect(shareFoldsIntoDisplaySupply(10055)).toBe(false)
    expect(shareFoldsIntoDisplaySupply(143)).toBe(false)
    expect(shareFoldsIntoDisplaySupply(104)).toBe(false)
    expect(supplyFoldedShareIds(55)).toEqual([])
  })

  it('shows a share under its display asset exactly where it folds into its supply', async () => {
    await loadExplorerAssets(client)
    // 2-Pool-BIL is the BIL/HOLLAR pool, not BIL: a wallet's shares keep their own row.
    expect(displayAssetId(10055)).toBe(10055)
    expect(displayAssetId(143)).toBe(143)
    expect(displayAssetId(104)).toBe(104)
    expect(displayAssetId(690)).toBe(69)
    expect(displayAssetId(111)).toBe(1111)
    expect(displayAssetId(55)).toBe(55)
  })

  it('folds a share that a named product wraps', async () => {
    await loadExplorerAssets(client)
    expect(shareFoldsIntoDisplaySupply(690)).toBe(true)
    expect(shareFoldsIntoDisplaySupply(111)).toBe(true)
    expect(supplyFoldedShareIds(69)).toEqual([690])
  })

  it('never folds an id that displays as nothing, and keeps the fold while members are unknown', () => {
    expect(shareFoldsIntoDisplaySupply(55)).toBe(false)
    registerStableswapPoolMembers(90001, null)
    expect(shareFoldsIntoDisplaySupply(90001)).toBe(true)
    registerStableswapPoolMembers(90001, [40, 1009])
    expect(shareFoldsIntoDisplaySupply(90001)).toBe(true)
  })
})

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const body = (start: string, end: string) => {
  const at = explorerService.indexOf(start)
  expect(at, start).toBeGreaterThan(-1)
  return explorerService.slice(at, explorerService.indexOf(end, at + start.length))
}

// Every supply-side fold applies the same rule, so the directory total, its holder
// count and the asset page cannot disagree on which shares a display asset owns.
describe('every supply fold applies the rule', () => {
  it('the directory total, holder count, holder page and folded holder read', () => {
    expect(body('async function getAssetTotals', '\n}\n')).toContain('if (!shareFoldsIntoDisplaySupply(shareId)) continue')
    expect(body('async function foldedDisplayHolderCounts', '\n}\n')).toContain('if (!shareFoldsIntoDisplaySupply(Number(shareId))) continue')
    expect(body('export async function getHolders(', '\n}\n')).toContain('const foldedShareIds = supplyFoldedShareIds(assetId)')
    expect(body('async function getFoldedDisplayAssetHolders', '\n}\n')).toContain('&& shareFoldsIntoDisplaySupply(id)')
  })

  it('the money-market reserve aliases of an asset page, filter and row', () => {
    expect(body('export function mmReserveIdsForAsset', '\n}\n')).toContain('supplyFoldedShareIds(assetId)')
    expect(body('export function mmReserveAliasIds', '\n}\n')).toContain('displayAssetId(reserveId)')
  })
})

// aToken holders are every positive balance, pallet accounts included, so the
// holder page sums to the supply it is valued at and agrees with the directory count.
describe('aToken holder pages keep pallet accounts', () => {
  it('reconstructs holders without a module-account filter', () => {
    expect(body('async function getATokenHolders', '\n}\n')).not.toContain('6d6f646c')
  })
})
