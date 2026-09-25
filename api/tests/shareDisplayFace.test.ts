import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SHARE_DISPLAY_FACE,
  assetDescriptor,
  displayDescriptor,
  isProductWrapperSymbol,
  loadExplorerAssets,
  registerShareWrapper,
  shareWrapperOf,
  stopExplorerAssetsRefresh,
} from '../src/services/explorerAssets.ts'

// The one display-name rule for pool shares: a stableswap share whose money-market
// wrapper is a named product (GDOT over 2-Pool-GDOT) shows under the wrapper's
// symbol and artwork while keeping its own id and decimals, and its on-chain name
// stays in `name`. A wrapper that merely restates its reserve (a3-Pool over 3-Pool,
// a2-Pool-PRIME over 2-Pool-PRIME) names nothing. The registry's own descriptor is
// untouched, so the frozen public and Data API surfaces keep the chain's symbols.

const GDOT = '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad'
const A3POOL = '0xc09cf2f85367f3c2ab66e094283de3a499cb9108'
const A2PRIME = '0xc2b44f574b8c8440c0d5665f0039b49523139851'

const asset = (assetId: number, symbol: string, opts: { name?: string; decimals?: number; evmAddress?: string } = {}) => ({
  asset_id: assetId,
  symbol,
  name: opts.name ?? symbol,
  decimals: opts.decimals ?? 18,
  parachain_id: null,
  origin_ecosystem: null,
  origin_chain_id: null,
  origin_asset_id: null,
  evm_address: opts.evmAddress ?? '',
})
const precompile = (assetId: number) => '0x' + '0'.repeat(31) + '1' + assetId.toString(16).padStart(8, '0')
const reserve = (shareId: number, atoken: string) => ({ asset_address: precompile(shareId), atoken, market_key: 'core' })

/** The registry read, the reserve-map read and the pool-member read from one fake. */
const clientWith = (assets: ReturnType<typeof asset>[], reserves: ReturnType<typeof reserve>[], pools: { pool_id: number; members: number[] }[]) => ({
  query: vi.fn(async ({ query }: { query: string }) => ({
    json: async () => (query.includes('atoken_reserve_map') ? reserves
      : query.includes('stableswap_pool_state_history') ? pools
        : query.includes('price_data.assets') ? assets : []),
  })),
}) as never

const REGISTRY = [
  asset(690, '2-Pool-GDOT'), asset(69, 'GDOT', { name: 'GIGADOT', evmAddress: GDOT }),
  asset(103, '3-Pool'), asset(1008, 'a3-Pool', { evmAddress: A3POOL }),
  asset(143, '2-Pool-PRIME'), asset(1143, 'a2-Pool-PRIME', { evmAddress: A2PRIME }), asset(43, 'PRIME', { decimals: 6 }),
]
const RESERVES = [reserve(690, GDOT), reserve(103, A3POOL), reserve(143, A2PRIME)]
const POOLS = [{ pool_id: 690, members: [15, 5] }, { pool_id: 103, members: [10, 22, 222] }, { pool_id: 143, members: [43, 222] }]

describe('a pool share under its product-named wrapper', () => {
  afterEach(() => {
    stopExplorerAssetsRefresh()
    vi.restoreAllMocks()
  })

  it('tells a product name from the aToken default spelling', () => {
    expect(isProductWrapperSymbol('GDOT', '2-Pool-GDOT')).toBe(true)
    expect(isProductWrapperSymbol('HUSDT', '2-Pool-HUSDT')).toBe(true)
    expect(isProductWrapperSymbol('a3-Pool', '3-Pool')).toBe(false)
    expect(isProductWrapperSymbol('a2-Pool-PRIME', '2-Pool-PRIME')).toBe(false)
    expect(isProductWrapperSymbol('A2-POOL-PRIME', '2-Pool-PRIME')).toBe(false)
  })

  it('shows the wrapper\'s symbol and artwork with its own id, decimals and on-chain name', async () => {
    await loadExplorerAssets(clientWith(REGISTRY, RESERVES, POOLS))
    expect(SHARE_DISPLAY_FACE).toEqual({ 690: 69 })
    const face = displayDescriptor(690)
    expect(face).toMatchObject({ assetId: 690, symbol: 'GDOT', name: '2-Pool-GDOT', decimals: 18, iconAssetId: 69 })
    // The registry's own descriptor is what the frozen APIs read: unchanged.
    expect(assetDescriptor(690)).toMatchObject({ assetId: 690, symbol: '2-Pool-GDOT', name: null })
    // The wrapper itself is not a share and reads as it is.
    expect(displayDescriptor(69)).toMatchObject({ assetId: 69, symbol: 'GDOT', name: 'GIGADOT' })
    expect(shareWrapperOf(690)).toEqual({ aTokenId: 69, marketKey: 'core', named: true })
  })

  it('leaves a share alone when its wrapper only restates it (a3-Pool over 3-Pool)', async () => {
    await loadExplorerAssets(clientWith(REGISTRY, RESERVES, POOLS))
    expect(displayDescriptor(103)).toMatchObject({ assetId: 103, symbol: '3-Pool' })
    expect(displayDescriptor(143)).toMatchObject({ assetId: 143, symbol: '2-Pool-PRIME', decimals: 18 })
    expect(shareWrapperOf(103)).toEqual({ aTokenId: 1008, marketKey: 'core', named: false })
    expect(shareWrapperOf(143)?.named).toBe(false)
  })

  it('names a pool wrapped tomorrow with no code change, and forgets a pairing that goes', async () => {
    await loadExplorerAssets(clientWith(
      [...REGISTRY.filter(a => a.asset_id !== 1008), asset(1008, 'H3POOL', { evmAddress: A3POOL })],
      RESERVES, POOLS,
    ))
    // A wrapper with no artwork of its own borrows its reserve's (iconAssetIdFor), and the share draws as the wrapper does.
    expect(displayDescriptor(103)).toMatchObject({ symbol: 'H3POOL', name: '3-Pool', iconAssetId: 103 })
    expect(shareWrapperOf(103)?.named).toBe(true)
    registerShareWrapper(103, null)
    expect(displayDescriptor(103)).toMatchObject({ symbol: '3-Pool' })
    expect(SHARE_DISPLAY_FACE[103]).toBeUndefined()
  })

  it('never names through a placeholder: both ends must be registry rows', async () => {
    await loadExplorerAssets(clientWith(REGISTRY, RESERVES, POOLS))
    registerShareWrapper(4200, { aTokenId: 420, marketKey: 'core' })
    expect(displayDescriptor(4200).symbol).toBe('#4200')
    expect(shareWrapperOf(4200)?.named).toBe(false)
    registerShareWrapper(4200, null)
  })
})
