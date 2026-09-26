import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assetIdsForToken,
  idsDisplayedAs,
  loadExplorerAssets,
  stopExplorerAssetsRefresh,
} from '../src/services/explorerAssets.ts'

// The one resolver behind every activity token filter (the explorer feeds, the MCP
// `token` pass-through) names an asset's DISPLAY face: a product-named Hydrated
// pool's name or wrapper id also names the share displayed under it, because that
// share's rows carry the product name — an add-liquidity on 2-Pool-GDOT says GDOT.
// The share's own symbol or id names the share alone, and an id is only ever the
// whole token.

const GDOT = '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad'
const A3POOL = '0xc09cf2f85367f3c2ab66e094283de3a499cb9108'

const asset = (assetId: number, symbol: string, opts: { name?: string; evmAddress?: string } = {}) => ({
  asset_id: assetId,
  symbol,
  name: opts.name ?? symbol,
  decimals: 18,
  parachain_id: null,
  origin_ecosystem: null,
  origin_chain_id: null,
  origin_asset_id: null,
  evm_address: opts.evmAddress ?? '',
})
const precompile = (assetId: number) => '0x' + '0'.repeat(31) + '1' + assetId.toString(16).padStart(8, '0')
const reserve = (shareId: number, atoken: string) => ({ asset_address: precompile(shareId), atoken, market_key: 'core' })

const clientWith = (assets: ReturnType<typeof asset>[], reserves: ReturnType<typeof reserve>[], pools: { pool_id: number; members: number[] }[]) => ({
  query: vi.fn(async ({ query }: { query: string }) => ({
    json: async () => (query.includes('atoken_reserve_map') ? reserves
      : query.includes('stableswap_pool_state_history') ? pools
        : query.includes('price_data.assets') ? assets : []),
  })),
}) as never

const REGISTRY = [
  asset(2, 'DAI'), asset(5, 'DOT'), asset(10, 'USDC', { name: 'USDC (Moonbeam)' }), asset(22, 'USDC', { name: 'USDC (Asset Hub)' }),
  asset(690, '2-Pool-GDOT'), asset(69, 'GDOT', { name: 'GIGADOT', evmAddress: GDOT }),
  asset(103, '3-Pool'), asset(1008, 'a3-Pool', { evmAddress: A3POOL }),
]
const RESERVES = [reserve(690, GDOT), reserve(103, A3POOL)]
const POOLS = [{ pool_id: 690, members: [15, 5] }, { pool_id: 103, members: [10, 22, 222] }]

describe('assetIdsForToken', () => {
  afterEach(() => {
    stopExplorerAssetsRefresh()
    vi.restoreAllMocks()
  })

  it('names a product wrapper and the share displayed under it, by symbol or by the wrapper id', async () => {
    await loadExplorerAssets(clientWith(REGISTRY, RESERVES, POOLS))
    expect(assetIdsForToken('GDOT')).toEqual([69, 690])
    expect(assetIdsForToken('gdot')).toEqual([69, 690])
    expect(assetIdsForToken(' 69 ')).toEqual([69, 690])
    expect(idsDisplayedAs(69)).toEqual([69, 690])
  })

  it('names the share alone by its own symbol or id', async () => {
    await loadExplorerAssets(clientWith(REGISTRY, RESERVES, POOLS))
    expect(assetIdsForToken('2-Pool-GDOT')).toEqual([690])
    expect(assetIdsForToken('690')).toEqual([690])
    expect(idsDisplayedAs(690)).toEqual([690])
  })

  it('leaves a share whose wrapper only restates it under its own name', async () => {
    await loadExplorerAssets(clientWith(REGISTRY, RESERVES, POOLS))
    expect(assetIdsForToken('3-Pool')).toEqual([103])
    expect(assetIdsForToken('a3-Pool')).toEqual([1008])
    expect(idsDisplayedAs(1008)).toEqual([1008])
  })

  it('reads an id only as the whole token, so a symbol with a leading digit never names that id', async () => {
    await loadExplorerAssets(clientWith(REGISTRY, RESERVES, POOLS))
    expect(assetIdsForToken('2-Pool-GDOT')).not.toContain(2)
    expect(assetIdsForToken('2')).toEqual([2])
    expect(assetIdsForToken('2x')).toEqual([])
  })

  it('keeps every asset sharing a symbol, and tells unfiltered from unsatisfiable', async () => {
    await loadExplorerAssets(clientWith(REGISTRY, RESERVES, POOLS))
    expect(assetIdsForToken('USDC')?.sort()).toEqual([10, 22])
    expect(assetIdsForToken(undefined)).toBeUndefined()
    expect(assetIdsForToken('  ')).toBeUndefined()
    expect(assetIdsForToken('NOPE')).toEqual([])
  })

  // A notification rule's asset is the same name: the alert form offers the
  // wrapper (shares stay out of the directory), and the rule must fire on the
  // rows the feed labels with that name.
  it('lets a notification rule on the wrapper fire on the share\'s rows, and not the reverse', async () => {
    await loadExplorerAssets(clientWith(REGISTRY, RESERVES, POOLS))
    const { activityReferencesAsset } = await import('../src/notifications/evaluator.ts')
    const onShare = { type: 'liquidity', assetRefs: [690] } as never
    const onWrapper = { type: 'trade', assetIn: { assetId: 69 }, assetOut: { assetId: 5 } } as never
    expect(activityReferencesAsset(onShare, 69)).toBe(true)
    expect(activityReferencesAsset(onShare, 690)).toBe(true)
    expect(activityReferencesAsset(onWrapper, 69)).toBe(true)
    expect(activityReferencesAsset(onWrapper, 690)).toBe(false)
    expect(activityReferencesAsset(onShare, 5)).toBe(false)
  })
})
