import { describe, expect, it, vi } from 'vitest'
import { loadExplorerAssets, assetDescriptor, iconAssetIdFor } from '../src/services/explorerAssets.ts'

// A pool share token has no artwork of its own under its own id. One with a single
// dominant asset borrows that asset's (iconAssetIdFor); a MULTI-asset pool has no
// asset it could honestly borrow from — 2-Pool is USDT+USDC — so it carries its
// members and is drawn as a cluster of them. Both come from the pool registry, so a
// pool added tomorrow is covered without touching a hand-kept list.

const ASSETS = [
  { asset_id: 10, symbol: 'USDT', name: 'Tether', decimals: 6, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 22, symbol: 'USDC', name: 'USD Coin', decimals: 6, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 102, symbol: '2-Pool', name: '2-Pool-Stbl', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1001, symbol: 'aDOT', name: 'aDOT', decimals: 10, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 690, symbol: '2-Pool-GDOT', name: '2-Pool-GDOT', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]
const POOLS = [
  { pool_id: 102, members: [10, 22] },
  { pool_id: 690, members: [15, 1001] },
]

function client() {
  let call = 0
  return {
    query: vi.fn(async () => {
      call += 1
      // The loader reads the registry first, then the pool members.
      return { json: async () => (call === 1 ? ASSETS : POOLS) }
    }),
  } as never
}

describe('pool share tokens carry their members', () => {
  it('gives a multi-asset pool its member ids', async () => {
    await loadExplorerAssets(client())
    expect(assetDescriptor(102).iconAssetIds).toEqual([10, 22])
  })

  it('resolves an aToken member to the artwork that member actually has', async () => {
    await loadExplorerAssets(client())
    // aDOT (1001) has no icon of its own; its reserve DOT (5) does.
    expect(iconAssetIdFor(1001)).toBe(5)
    expect(assetDescriptor(690).iconAssetIds).toEqual([15, 5])
  })

  it('leaves an ordinary asset without members, so it keeps the single-icon path', async () => {
    await loadExplorerAssets(client())
    expect(assetDescriptor(10).iconAssetIds).toBeUndefined()
    expect(assetDescriptor(22).iconAssetIds).toBeUndefined()
  })
})
