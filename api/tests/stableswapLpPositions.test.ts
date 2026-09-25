import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { loadExplorerAssets, registerShareWrapper, stopExplorerAssetsRefresh } from '../src/services/explorerAssets.ts'
import { stableswapLpPositions } from '../src/services/explorerService.ts'
import type { AddressBalance, AssetRef } from '../src/services/explorerService.ts'

// Wallet-held stableswap pool-share tokens (2-Pool-GDOT 690, 4-Pool, …) are
// surfaced as LP positions (venue 'Stablepool') from the RAW balance rows —
// before foldShareBalances relabels them into their underlying. Display-only:
// their USD value stays counted via the folded wallet balances.
const ref = (assetId: number, symbol: string): AssetRef => ({ assetId, iconAssetId: assetId, symbol, name: null, decimals: 12, parachainId: null, origin: null })
const bal = (asset: AssetRef, total: string, valueUsd: number | null): AddressBalance =>
  ({ asset, total, free: total, reserved: '0', lastBlock: 1, valueUsd })

describe('stableswapLpPositions', () => {
  it('maps a mapped share token (2-Pool-GDOT) to a Stablepool LP row', () => {
    const out = stableswapLpPositions([bal(ref(690, '2-Pool-GDOT'), '100', 42)])
    expect(out).toHaveLength(1)
    expect(out[0].venue).toBe('Stablepool')
    expect(out[0].asset.assetId).toBe(690)
    expect(out[0].amount).toBe('100')
    expect(out[0].shares).toBe('100')
    expect(out[0].valueUsd).toBe(42)
  })

  it('recognises plain n-Pool share symbols not in the underlying map', () => {
    const out = stableswapLpPositions([bal(ref(102, '4-Pool'), '5', 5)])
    expect(out).toHaveLength(1)
    expect(out[0].venue).toBe('Stablepool')
  })

  it('excludes ordinary assets, a-tokens and zero balances', () => {
    const out = stableswapLpPositions([
      bal(ref(5, 'DOT'), '10', 10),
      bal(ref(1008, 'a3-Pool'), '10', 10),   // MM supply — belongs on the money-market card
      bal(ref(690, '2-Pool-GDOT'), '0', 0),  // dust-cleared position
    ])
    expect(out).toHaveLength(0)
  })

  describe('a share that is a money-market reserve names its wrapper', () => {
    const HUSDT = '0x1806860d27ee903c1ec7586d4f7d598d7591f124'
    const A3POOL = '0xc09cf2f85367f3c2ab66e094283de3a499cb9108'
    const row = (assetId: number, symbol: string, evmAddress = '') => ({
      asset_id: assetId, symbol, name: symbol, decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null, evm_address: evmAddress,
    })
    const precompile = (assetId: number) => '0x' + '0'.repeat(31) + '1' + assetId.toString(16).padStart(8, '0')
    // The pairing and the name come from a registry load: the reserve map pairs
    // the share with its aToken, the aToken's symbol says whether it is a product.
    beforeAll(() => loadExplorerAssets({
      query: async ({ query }: { query: string }) => ({
        json: async () => (query.includes('atoken_reserve_map')
          ? [{ asset_address: precompile(111), atoken: HUSDT, market_key: 'core' }, { asset_address: precompile(103), atoken: A3POOL, market_key: 'core' }]
          : query.includes('stableswap_pool_state_history') ? [{ pool_id: 111, members: [10, 222] }, { pool_id: 103, members: [10, 22, 222] }]
            : query.includes('price_data.assets') ? [row(111, '2-Pool-HUSDT'), row(1111, 'HUSDT', HUSDT), row(103, '3-Pool'), row(1008, 'a3-Pool', A3POOL)] : []),
      }),
    } as never))
    afterAll(() => { stopExplorerAssetsRefresh(); registerShareWrapper(111, null); registerShareWrapper(103, null) })

    it('carries the aToken and market, named when the wrapper is a product (HUSDT), not when it restates the share (a3-Pool)', () => {
      const out = stableswapLpPositions([bal(ref(111, '2-Pool-HUSDT'), '7', 7), bal(ref(103, '3-Pool'), '3', 3)])
      expect(out.map(p => [p.asset.assetId, p.wrapper?.asset.assetId, p.wrapper?.marketKey, p.wrapper?.named]))
        .toEqual([[111, 1111, 'core', true], [103, 1008, 'core', false]])
      expect(out[0].wrapper?.asset.symbol).toBe('HUSDT')
      // The row holds the share it was given — its id, its balance ref — never the wrapper.
      expect(out[0].asset.assetId).toBe(111)
      expect(out[0].positionId).toBe('share-111')
    })

    it('carries none for a share no reserve wraps', () => {
      expect(stableswapLpPositions([bal(ref(690, '2-Pool-GDOT'), '100', 42)])[0].wrapper).toBeUndefined()
    })
  })
})
