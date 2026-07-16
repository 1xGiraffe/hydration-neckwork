import { describe, expect, it } from 'vitest'
import { mergeErc20Balances, type AddressBalance, type AssetRef } from '../src/services/explorerService.ts'

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
})
