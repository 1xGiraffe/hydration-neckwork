import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  displayAssetId,
  loadExplorerAssets,
  priceAssetId,
  shareFoldsIntoDisplaySupply,
  stopExplorerAssetsRefresh,
  supplyFoldedShareIds,
} from '../src/services/explorerAssets.ts'

// A share folds into its display asset's SUPPLY (directory total, holder count,
// holder list), shows under its row and prices through it exactly when the share IS
// that asset: the one share/wrapper rule — the named aToken Aave minted over the
// share (GDOT over 2-Pool-GDOT, HUSDT over 2-Pool-HUSDT). A share whose pool holds
// the asset it resembles (2-Pool-BIL holds BIL) is a pool position of its own:
// folding it counted BIL's pool reserve twice ($3.14M against a $2.52M supply), and
// pricing it as the asset read 2-Pool-apyUSD at apyUSD's $1.41 against a redeemable
// $1.009 (2026-09-29).

const asset = (assetId: number, symbol: string, evmAddress = '') => ({
  asset_id: assetId, symbol, name: symbol, decimals: 18, parachain_id: null,
  origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null, evm_address: evmAddress,
})
const precompile = (assetId: number) => '0x' + '0'.repeat(31) + '1' + assetId.toString(16).padStart(8, '0')
const GDOT = '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad'
const HUSDT = '0x1806860d27ee903c1ec7586d4f7d598d7591f124'
const BIL = '0x8184e2f7c477d165772c21f7a2dbbb61a76e7fc4'
const A2PRIME = '0xc2b44f574b8c8440c0d5665f0039b49523139851'
const ASSETS = [
  asset(55, 'BIL', BIL), asset(550, 'uBIL'), asset(10055, '2-Pool-BIL'),
  asset(43, 'PRIME'), asset(143, '2-Pool-PRIME'), asset(1143, 'a2-Pool-PRIME', A2PRIME),
  asset(34, 'ETH'), asset(104, '2-Pool-WETH'),
  asset(69, 'GDOT', GDOT), asset(690, '2-Pool-GDOT'),
  asset(1111, 'HUSDT', HUSDT), asset(111, '2-Pool-HUSDT'),
]
const RESERVES = [
  { asset_address: precompile(690), atoken: GDOT, market_key: 'core' },
  { asset_address: precompile(111), atoken: HUSDT, market_key: 'core' },
  { asset_address: precompile(143), atoken: A2PRIME, market_key: 'core' },
  { asset_address: precompile(550), atoken: BIL, market_key: 'bil' },
]
const POOLS = [
  { pool_id: 10055, members: [55, 222] }, { pool_id: 143, members: [43, 222] },
  { pool_id: 104, members: [20, 1007] }, { pool_id: 690, members: [15, 1001] }, { pool_id: 111, members: [222, 1002] },
]
const clientWith = (reserves: unknown[]) => ({
  query: vi.fn(async ({ query }: { query: string }) => ({
    json: async () => (query.includes('atoken_reserve_map') ? reserves
      : query.includes('stableswap_pool_state_history') ? POOLS
        : query.includes('price_data.assets') ? ASSETS : []),
  })),
}) as never

describe('the share/wrapper rule', () => {
  afterEach(() => stopExplorerAssetsRefresh())

  it('folds, displays and prices a share as the named wrapper minted over it', async () => {
    await loadExplorerAssets(clientWith(RESERVES))
    for (const [share, wrapper] of [[690, 69], [111, 1111]]) {
      expect(shareFoldsIntoDisplaySupply(share)).toBe(true)
      expect(displayAssetId(share)).toBe(wrapper)
      expect(priceAssetId(share)).toBe(wrapper)
      expect(supplyFoldedShareIds(wrapper)).toEqual([share])
    }
  })

  it('keeps every other share its own asset, priced at its own series', async () => {
    await loadExplorerAssets(clientWith(RESERVES))
    for (const share of [10055, 143, 104]) {
      expect(shareFoldsIntoDisplaySupply(share)).toBe(false)
      expect(displayAssetId(share)).toBe(share)
      expect(priceAssetId(share)).toBe(share)
    }
    expect(supplyFoldedShareIds(55)).toEqual([])
    // An unnamed aToken over a share is an ordinary aToken, priced THROUGH the share.
    expect(priceAssetId(1143)).toBe(143)
    // No cycle: a named wrapper prices as itself.
    expect(priceAssetId(69)).toBe(69)
  })

  it('never folds an id that is no share', async () => {
    await loadExplorerAssets(clientWith(RESERVES))
    expect(shareFoldsIntoDisplaySupply(55)).toBe(false)
    expect(displayAssetId(55)).toBe(55)
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
    expect(body('async function getAssetTotals', '\n}\n')).toContain('of foldedShareEntries()')
    expect(body('async function foldedDisplayHolderCounts', '\n}\n')).toContain('of foldedShareEntries()')
    expect(body('async function holdersPageUnvalued(', '\n}\n')).toContain('const foldedShareIds = supplyFoldedShareIds(assetId)')
    expect(body('async function getFoldedDisplayAssetHolders', '\n}\n')).toContain('namedShareWrapperOf(id) === displayAssetId')
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
