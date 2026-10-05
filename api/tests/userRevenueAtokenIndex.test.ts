import { describe, expect, it } from 'vitest'
import { aTokenClaimsCustody } from '../src/services/userRevenueWindow.ts'
import type { MmContract } from '../src/services/userRevenueMm.ts'
import type { FoldWindow, Ledger } from '../src/services/userRevenueFold.ts'
import { MM_COVERAGE_FROM_BLOCK } from '../src/services/userRevenueStreams.ts'

const RAY = 10n ** 27n
const B = MM_COVERAGE_FROM_BLOCK + 1_000
const w = {
  openBlock: B, openTs: 1_000,
  hourBlocks: [{ last: B + 600, lastTs: 4_600 }, { last: B + 1_200, lastTs: 8_200 }, { last: B + 1_800, lastTs: 11_800 }],
} as unknown as FoldWindow
const supply: MmContract = { contract: '0xa', side: 'supply', reserve: '0xr', pool: '0xp', market: 'core', reserveAsset: 5, aTokenAsset: 1005 }
const debt: MmContract = { contract: '0xd', side: 'debt', reserve: '0xr', pool: '0xp', market: 'core', reserveAsset: 5, aTokenAsset: null }
const ledger = (): Ledger => ({ holder: 'x', stream: 'lp_fees', pot: 'p', via: '', asset: 1005, held: null, price: 'spot' as never, amounts: [100n, 100n, 100n] })

// A reserve whose first indexed update lands at the second hour's start block: the supply index is unknown
// before it, the debt index unknown throughout.
function book(debtKnown: boolean) {
  return {
    indexAt: (_p: string, _r: string, side: 'supply' | 'debt', block: number) =>
      side === 'supply' ? (block >= B + 600 ? RAY : null) : debtKnown ? (12n * RAY) / 10n : null,
  } as never
}
const holders = (withDebt: boolean) => (contract: string): ReadonlyArray<readonly [string, bigint]> =>
  contract === '0xa' ? [['s1', 60n], ['s2', 40n]] : withDebt ? [['b1', 10n]] : []

describe('aToken claims custody before an index is known', () => {
  it('books the income unattributed (mm-index-unknown) until every needed index is known, never at RAY', async () => {
    const r = await aTokenClaimsCustody(w, supply, debt, book(true), holders(false), a => a).resolve(ledger())
    const unknown = r.more!.find(m => m.via === 'mm-index-unknown')!
    expect(unknown.amounts).toEqual([100n, 0n, 0n])
    // Hours 1 and 2 split over the suppliers (no borrower holds debt, so the debt index is not needed).
    expect(Object.fromEntries(r.parts.map(p => [p.holder, p.amounts]))).toEqual({ s1: [0n, 60n, 60n], s2: [0n, 40n, 40n] })
    expect(r.remainder).toEqual([0n, 0n, 0n])
  })

  it('waits for the debt index too when a borrower holds debt', async () => {
    const r = await aTokenClaimsCustody(w, supply, debt, book(false), holders(true), a => a).resolve(ledger())
    expect(r.more!.find(m => m.via === 'mm-index-unknown')!.amounts).toEqual([100n, 100n, 100n])
    expect(r.parts).toEqual([])
  })
})
