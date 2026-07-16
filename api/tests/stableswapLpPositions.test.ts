import { describe, it, expect } from 'vitest'
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
})
