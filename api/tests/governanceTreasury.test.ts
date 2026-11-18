import { describe, expect, it } from 'vitest'
import { decodeStoredSpend, withStoredSpends } from '../src/services/governanceTreasury.ts'
import { foldTreasury, type TreasuryEventRow } from '../src/services/treasurySpends.ts'

// A payout re-dates a spend's expiry in storage with no event saying so: the stored
// Treasury.Spends value wins over the event fold wherever storage has the spend and
// no event after the snapshot's block moved it since.

const BEN = `0x${'ab'.repeat(32)}`
const ev = (event_name: string, block_height: number, args: Record<string, unknown>): TreasuryEventRow =>
  ({ event_name, block_height, event_index: 0, extrinsic_index: null, ts: '2026-01-01 00:00:00', args_json: JSON.stringify(args) })

describe('decodeStoredSpend', () => {
  it('reads spend #5 as storage holds it (live bytes: paid, expiry re-dated)', () => {
    expect(decodeStoredSpend('0x00006eb13d809b040000000000000000ee92a79760d0480aab1a940b0abab817dfcde83655e4d2c71682ce272b26ef0ac86cae0028a9b60001'))
      .toEqual({ validFrom: 11_431_112, expireAt: 11_970_856, status: 'attempted' })
    expect(decodeStoredSpend('0x00')).toBeNull()
  })
})

describe('withStoredSpends', () => {
  const rows = [
    ev('Treasury.AssetSpendApproved', 100, { index: 0, amount: '5', beneficiary: BEN, validFrom: 100, expireAt: 200 }),
    ev('Treasury.Paid', 150, { index: 0 }),
    ev('Treasury.PaymentFailed', 160, { index: 0 }),
  ]
  it('a failed payment stays payable until the expiry its payout re-dated, not the approved one', () => {
    const fold = foldTreasury(rows, 300).spends
    expect(fold[0]).toMatchObject({ state: 'expired', canPayout: false })
    const stored = { block: 170, spends: new Map([[0, { validFrom: 100, expireAt: 1150, status: 'failed' as const }]]) }
    expect(withStoredSpends(fold, stored, 300)[0]).toMatchObject({ state: 'failed', expireAt: 1150, canPayout: true, canCheckStatus: false })
    expect(withStoredSpends(fold, stored, 1200)[0]).toMatchObject({ state: 'expired', canPayout: false, canCheckStatus: true })
  })
  it('lets a payout indexed after the snapshot win over the older stored state', () => {
    const approved = [ev('Treasury.AssetSpendApproved', 100, { index: 0, amount: '5', beneficiary: BEN, validFrom: 100, expireAt: 900 })]
    const paid = foldTreasury([...approved, ev('Treasury.Paid', 250, { index: 0 })], 260).spends
    // Storage read at block 240 still held the spend unpaid (pending).
    const before = { block: 240, spends: new Map([[0, { validFrom: 100, expireAt: 900, status: 'pending' as const }]]) }
    expect(withStoredSpends(paid, before, 260)[0]).toMatchObject({ state: 'paid', canPayout: false, canCheckStatus: true })
    // A snapshot at or after the payout's block is the newer fact.
    const after = { block: 250, spends: new Map([[0, { validFrom: 100, expireAt: 1250, status: 'attempted' as const }]]) }
    expect(withStoredSpends(paid, after, 260)[0]).toMatchObject({ state: 'paid', expireAt: 1250, canPayout: false })
    // A failed payment after the snapshot stays failed (payable) rather than the stored 'attempted'.
    const failed = foldTreasury([...approved, ev('Treasury.Paid', 200, { index: 0 }), ev('Treasury.PaymentFailed', 255, { index: 0 })], 260).spends
    const attempted = { block: 220, spends: new Map([[0, { validFrom: 100, expireAt: 1200, status: 'attempted' as const }]]) }
    expect(withStoredSpends(failed, attempted, 260)[0]).toMatchObject({ state: 'failed', expireAt: 1200, canPayout: true })
    // …and keeps the expiry that earlier payout re-dated, past the approved one.
    expect(withStoredSpends(failed, attempted, 1000)[0]).toMatchObject({ state: 'failed', expireAt: 1200, canPayout: true })
  })
  it('leaves the fold alone without a stored read', () => {
    const fold = foldTreasury(rows, 300).spends
    expect(withStoredSpends(fold, null, 300)).toBe(fold)
  })
})
