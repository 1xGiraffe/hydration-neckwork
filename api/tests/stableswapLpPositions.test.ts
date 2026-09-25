import { afterEach, describe, it, expect } from 'vitest'
import { registerShareWrapper } from '../src/services/explorerAssets.ts'
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
    afterEach(() => { registerShareWrapper(111, null); registerShareWrapper(103, null) })

    it('carries the aToken and market, named when the share already displays as it', () => {
      registerShareWrapper(111, { aTokenId: 1111, marketKey: 'core' })  // 2-Pool-HUSDT displays as HUSDT
      registerShareWrapper(103, { aTokenId: 1008, marketKey: 'core' })  // 3-Pool stays 3-Pool
      const out = stableswapLpPositions([bal(ref(111, '2-Pool-HUSDT'), '7', 7), bal(ref(103, '3-Pool'), '3', 3)])
      expect(out.map(p => [p.asset.assetId, p.wrapper?.asset.assetId, p.wrapper?.marketKey, p.wrapper?.named]))
        .toEqual([[111, 1111, 'core', true], [103, 1008, 'core', false]])
      // The shares themselves are what the row holds — never relabelled.
      expect(out[0].asset.symbol).toBe('2-Pool-HUSDT')
      expect(out[0].positionId).toBe('share-111')
    })

    it('carries none for a share no reserve wraps', () => {
      expect(stableswapLpPositions([bal(ref(690, '2-Pool-GDOT'), '100', 42)])[0].wrapper).toBeUndefined()
    })
  })
})
