import { describe, it, expect } from 'vitest'
import { foldShareBalances } from '../src/services/explorerService.ts'
import type { AddressBalance } from '../src/services/explorerService.ts'
import { assetDescriptor } from '../src/services/explorerAssets.ts'

// Per-account display fold: a held Stableswap pool-share token (2-Pool-GDOT id 690,
// 2-Pool-GETH 4200, 2-Pool-GSOL 90001) is shown as its underlying main asset
// (GDOT 69, GETH 420, GSOL 9001), mirroring preis-ui which hides "-Pool" tokens.
// Use assetDescriptor for the asset ref so the share token and its underlying carry
// the SAME decimals here (as the real Giga assets do), making foldShareBalances'
// decimal rescale a no-op — these cases test the merge/relabel logic, not rescaling.
const bal = (assetId: number, total: string, valueUsd: number | null): AddressBalance => {
  const d = assetDescriptor(assetId)
  return { asset: d, total, free: total, reserved: '0', lastBlock: 1, valueUsd }
}

describe('foldShareBalances', () => {
  it('relabels a lone pool-share holding as its underlying (2-Pool-GDOT → GDOT)', () => {
    const out = foldShareBalances([bal(690, '100', 100)])
    expect(out).toHaveLength(1)
    expect(out[0].asset.assetId).toBe(69)
    expect(out[0].total).toBe('100')
    expect(out[0].valueUsd).toBe(100)
  })

  it('merges a pool-share into an existing underlying row (sums total + value)', () => {
    const out = foldShareBalances([bal(69, '30', 30), bal(690, '100', 100)])
    expect(out).toHaveLength(1)
    expect(out[0].asset.assetId).toBe(69)
    expect(out[0].total).toBe('130')
    expect(out[0].valueUsd).toBe(130)
  })

  it('merges regardless of order and uses big-integer addition', () => {
    const big = '9490407169607873746'
    const out = foldShareBalances([bal(4200, big, 16000), bal(420, '33341836379303215', 56)])
    expect(out).toHaveLength(1)
    expect(out[0].asset.assetId).toBe(420)
    expect(out[0].total).toBe((BigInt(big) + 33341836379303215n).toString())
    expect(out[0].valueUsd).toBe(16056)
  })

  it('folds multiple share families independently and leaves other assets untouched', () => {
    const out = foldShareBalances([bal(690, '1', 1), bal(90001, '2', 2), bal(5, '3', 3)])
    const ids = out.map(b => b.asset.assetId).sort((a, b) => a - b)
    expect(ids).toEqual([5, 69, 9001])
  })

  it('is a no-op (same array reference) when no share tokens are held', () => {
    const input = [bal(5, '10', 10), bal(0, '20', 20)]
    expect(foldShareBalances(input)).toBe(input)
  })
})
