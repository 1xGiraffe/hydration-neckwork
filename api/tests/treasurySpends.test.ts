import { describe, expect, it } from 'vitest'
import { foldTreasury, type TreasuryEventRow } from '../src/services/treasurySpends.ts'

// The treasury's spends and proposals as their events leave them (pallet-treasury:
// payout needs validFrom ≤ now < expireAt; check_status clears a paid spend, or an
// unpaid one once expired).

const BEN = `0x${'ab'.repeat(32)}`
let n = 0
const ev = (event_name: string, block_height: number, args: Record<string, unknown>): TreasuryEventRow =>
  ({ event_name, block_height, event_index: n++, extrinsic_index: null, ts: '2026-01-01 00:00:00', args_json: JSON.stringify(args) })
const approved = (index: number, validFrom: number, expireAt: number, block = validFrom) =>
  ev('Treasury.AssetSpendApproved', block, { index, amount: '1000000000000000', beneficiary: BEN, validFrom, expireAt })

describe('foldTreasury spends', () => {
  it('is pending before validFrom, claimable inside the window, expired after it', () => {
    const rows = [approved(0, 100, 200, 50)]
    expect(foldTreasury(rows, 50).spends[0]).toMatchObject({ state: 'pending', canPayout: false, canCheckStatus: false })
    expect(foldTreasury(rows, 99).spends[0]).toMatchObject({ state: 'claimable', canPayout: true, canCheckStatus: false })
    expect(foldTreasury(rows, 198).spends[0]).toMatchObject({ state: 'claimable', canPayout: true })
    expect(foldTreasury(rows, 199).spends[0]).toMatchObject({ state: 'expired', canPayout: false, canCheckStatus: false })
    expect(foldTreasury(rows, 200).spends[0]).toMatchObject({ state: 'expired', canPayout: false, canCheckStatus: true })
  })
  it('a paid spend waits for check_status, which clears it', () => {
    const paid = [approved(1, 100, 200), ev('Treasury.Paid', 120, { index: 1 })]
    expect(foldTreasury(paid, 500).spends[0]).toMatchObject({ state: 'paid', canPayout: false, canCheckStatus: true })
    const cleared = [...paid, ev('Treasury.SpendProcessed', 130, { index: 1 })]
    expect(foldTreasury(cleared, 500).spends[0]).toMatchObject({ state: 'paid', canCheckStatus: false })
  })
  it('a failed payment can be paid out again until it expires; a voided spend can do nothing', () => {
    const failed = [approved(2, 100, 200), ev('Treasury.Paid', 120, { index: 2 }), ev('Treasury.PaymentFailed', 125, { index: 2 })]
    expect(foldTreasury(failed, 150).spends[0]).toMatchObject({ state: 'failed', canPayout: true })
    const voided = [approved(3, 100, 200), ev('Treasury.AssetSpendVoided', 110, { index: 3 })]
    expect(foldTreasury(voided, 150).spends[0]).toMatchObject({ state: 'voided', canPayout: false, canCheckStatus: false })
  })
  it('an expired spend cleared by check_status stays expired', () => {
    const rows = [approved(4, 100, 200), ev('Treasury.SpendProcessed', 300, { index: 4 })]
    expect(foldTreasury(rows, 400).spends[0]).toMatchObject({ state: 'expired', canCheckStatus: false })
  })
})

describe('foldTreasury proposals', () => {
  it('folds spend_local approvals and legacy proposals to their award', () => {
    const rows = [
      ev('Treasury.Proposed', 10, { proposalIndex: 0 }),
      ev('Treasury.Awarded', 20, { proposalIndex: 0, award: '5', account: BEN }),
      ev('Treasury.SpendApproved', 30, { proposalIndex: 1, amount: '7', beneficiary: BEN }),
      ev('Treasury.Proposed', 40, { proposalIndex: 2 }),
      ev('Treasury.Rejected', 45, { proposalIndex: 2, slashed: '1' }),
    ]
    const { proposals } = foldTreasury(rows, 50)
    expect(proposals.map(p => [p.index, p.origin, p.state, p.amount])).toEqual([
      [2, 'proposal', 'rejected', null], [1, 'spend_local', 'approved', '7'], [0, 'proposal', 'awarded', '5'],
    ])
  })
})
