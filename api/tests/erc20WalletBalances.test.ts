import { describe, expect, it, vi } from 'vitest'

// aDOT-HOLLAR (1001354) is the Gamma vault's share token, registered as an asset.
vi.mock('../src/services/explorerAssets.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/explorerAssets.ts')>(),
  v3VaultShareAssets: () => new Map([[1001354, { vault: '0xa206d0959813f17c17c87147271c49065438648a', members: [1001, 222] as [number, number] }]]),
}))

const { mergeErc20Balances } = await import('../src/services/explorerService.ts')
import type { AddressBalance, AssetRef } from '../src/services/explorerService.ts'

const asset = (assetId: number, symbol: string, decimals = 18): AssetRef => ({ assetId, iconAssetId: assetId, symbol, name: symbol, decimals, parachainId: null, origin: null })
const bal = (a: AssetRef, total: string): AddressBalance => ({ asset: a, total, free: total, reserved: '0', lastBlock: 1, valueUsd: null })
const prices = new Map([[222, { price: 1, change24h: 0 }]])

describe('mergeErc20Balances', () => {
  it('adds a new balance row for an ERC-20-only holding', () => {
    const out = mergeErc20Balances([bal(asset(0, 'HDX', 12), '5')], [{ asset: asset(222, 'HOLLAR'), raw: 15_000_000_000_000_000_000n }], prices)
    const hollar = out.find(b => b.asset.assetId === 222)!
    expect(hollar.total).toBe('15000000000000000000')
    expect(hollar.free).toBe('15000000000000000000')
    expect(hollar.valueUsd).toBeCloseTo(15)
  })

  it('sums onto an existing Tokens-side balance (the pots are separate on-chain)', () => {
    const out = mergeErc20Balances([bal(asset(222, 'HOLLAR'), '3000000000000000000')], [{ asset: asset(222, 'HOLLAR'), raw: 2_000_000_000_000_000_000n }], prices)
    expect(out).toHaveLength(1)
    expect(out[0].total).toBe('5000000000000000000')
    expect(out[0].valueUsd).toBeCloseTo(5)
  })

  it('skips zero ERC-20 balances and keeps sort by USD value', () => {
    const out = mergeErc20Balances([bal(asset(0, 'HDX', 12), '5')], [{ asset: asset(222, 'HOLLAR'), raw: 0n }], prices)
    expect(out.find(b => b.asset.assetId === 222)).toBeUndefined()
  })

  // The vault share is a liquidity position, valued once as the vault on the
  // Liquidity side: a priced balance row counted it twice in every account value.
  it('leaves a v3 vault share token out of the balance list', () => {
    const vaultShare = asset(1001354, 'aDOT-HOLLAR')
    const out = mergeErc20Balances([bal(asset(0, 'HDX', 12), '5')], [
      { asset: vaultShare, raw: 3_608_945_115_575_357_878_763n },
      { asset: asset(222, 'HOLLAR'), raw: 1_000_000_000_000_000_000n },
    ], new Map([...prices, [1001354, { price: 0.85, change24h: 0 }]]))
    expect(out.find(b => b.asset.assetId === 1001354)).toBeUndefined()
    expect(out.find(b => b.asset.assetId === 222)?.valueUsd).toBeCloseTo(1)
  })
})
