import { describe, it, expect } from 'vitest'
import { foldShareReserves } from '../src/services/explorerService.ts'
import type { MmReserve } from '../src/services/explorerService.ts'
import { assetDescriptor } from '../src/services/explorerAssets.ts'

// Money-market reserves use the 2-Pool tokens (Hydration's MM reserves); the borrow
// card folds them to the underlying main asset (2-Pool-GETH→GETH, 2-Pool-GSOL→GSOL,
// 2-Pool-HUSDC→HUSDC, …) — same rule as wallet balances. Build reserves with
// assetDescriptor so share token and underlying share decimals (rescale = no-op).
const res = (assetId: number, supplied: string, debt: string, suppliedUsd: number | null, debtUsd: number | null): MmReserve => {
  const d = assetDescriptor(assetId)
  return { assetId: d.assetId, symbol: d.symbol, decimals: d.decimals, supplied, debt, suppliedUsd, debtUsd, collateral: supplied !== '0' }
}

describe('foldShareReserves', () => {
  it('relabels pool-share reserves to their underlying (2-Pool-GETH→GETH, 2-Pool-GSOL→GSOL)', () => {
    const out = foldShareReserves([res(4200, '100', '0', 16000, 0), res(90001, '50', '0', 56, 0)])
    expect(out.map(r => r.assetId).sort((a, b) => a - b)).toEqual([420, 9001])
    expect(out.every(r => !r.symbol.includes('-Pool'))).toBe(true)
  })

  it('preserves supplied/debt and USD for a lone pool reserve', () => {
    const [g] = foldShareReserves([res(690, '12345', '0', 99, 0)])
    expect(g.assetId).toBe(69)
    expect(g.supplied).toBe('12345')
    expect(g.suppliedUsd).toBe(99)
  })

  it('merges a pool reserve into an existing underlying reserve (sums amounts + USD)', () => {
    const out = foldShareReserves([res(420, '30', '0', 50, 0), res(4200, '100', '0', 160, 0)])
    expect(out).toHaveLength(1)
    expect(out[0].assetId).toBe(420)
    expect(out[0].supplied).toBe('130')
    expect(out[0].suppliedUsd).toBe(210)
  })

  it('leaves non-pool reserves (aTokens, plain assets) untouched and is a no-op without pools', () => {
    const input = [res(1001, '5', '0', 10, 0), res(15, '0', '7', 0, 20)] // aDOT, vDOT
    expect(foldShareReserves(input)).toBe(input)
  })
})
