import { describe, expect, it } from 'vitest'
import { decodeRequestStatus, depositStates } from '../src/services/governanceDeposits.ts'

// What happens to a referendum's two deposits follows pallet-referenda's
// take_decision_deposit / take_submission_deposit; preimage deposits are decoded from
// Preimage.RequestStatusFor exactly as the chain stores them.

describe('depositStates', () => {
  it('returns both deposits of an approved or cancelled referendum', () => {
    for (const s of ['approved', 'executed', 'cancelled']) expect(depositStates(s)).toEqual({ decision: 'refundable', submission: 'refundable' })
  })
  it('keeps the submission deposit of a rejected or timed-out referendum, refunds its decision deposit', () => {
    for (const s of ['rejected', 'timed out']) expect(depositStates(s)).toEqual({ decision: 'refundable', submission: 'kept' })
  })
  it('slashes both of a killed referendum', () => {
    expect(depositStates('killed')).toEqual({ decision: 'slashed', submission: 'slashed' })
  })
  it('holds both while it runs', () => {
    for (const s of ['submitted', 'deciding', 'confirming']) expect(depositStates(s)).toEqual({ decision: 'held', submission: 'held' })
  })
})

describe('decodeRequestStatus', () => {
  it('reads an unrequested preimage’s ticket (live bytes of #450’s preimage: 410.5 HDX for 286 bytes)', () => {
    const v = decodeRequestStatus('0x0082fb02afe02fe5d6c793145a75e6860c4e206682c3ab395a9d2a941eb7c0d30d0028aefa5875010000000000000000001e010000')
    expect(v).toEqual({ owner: '0x82fb02afe02fe5d6c793145a75e6860c4e206682c3ab395a9d2a941eb7c0d30d', amount: 410_500_000_000_000n, len: 286, requested: false })
  })
  it('reads a requested preimage that still carries its depositor’s ticket', () => {
    const owner = '11'.repeat(32)
    const amount = (436_690_000_000_000n).toString(16).padStart(32, '0').match(/../g)!.reverse().join('')
    const hex = `0x0101${owner}${amount}02000000011e010000`
    expect(decodeRequestStatus(hex)).toEqual({ owner: `0x${owner}`, amount: 436_690_000_000_000n, len: 286, requested: true })
  })
  it('has no deposit for a requested preimage without a ticket, and refuses unknown shapes', () => {
    expect(decodeRequestStatus('0x01000100000000')).toBeNull()
    expect(decodeRequestStatus('0x02')).toBeNull()
    expect(decodeRequestStatus('0x00ff')).toBeNull()
  })
})

describe('decodeRequestStatus on the old Preimage.StatusFor map', () => {
  it('reads a reserved deposit stored in the old format (live bytes: 402.1 HDX for a 6-byte preimage)', () => {
    expect(decodeRequestStatus('0x0042a237d8f0850c44635e67ea4589dfbd3b81d8ddd106ae6cbd42a61c313a5b5d0008aa33b56d0100000000000000000006000000')).toEqual({
      owner: '0x42a237d8f0850c44635e67ea4589dfbd3b81d8ddd106ae6cbd42a61c313a5b5d', amount: 402_100_000_000_000n, len: 6, requested: false,
    })
  })
})
