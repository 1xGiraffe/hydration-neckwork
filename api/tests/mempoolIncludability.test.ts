import { describe, expect, it } from 'vitest'
import {
  classifySuppressed, includabilityFromApply, rejectedNonceFloors, revocableSuppressions,
  type SuppressionCause,
} from '../src/services/pendingHeadService.ts'

// A transaction that cannot pay its fee still passes `validate_transaction` — the
// node keeps it and gossips it (propagate: true) — and only `apply_extrinsic`
// against the best block reveals `Invalid(Payment)`. So the pool can hold a
// transaction that can NEVER be included, indefinitely for an immortal one. This
// is the verdict the feed badges honestly and the pollution guard filters on.
//
// The shapes here mirror polkadot-js's decoded `ApplyExtrinsicResult`: Ok wraps a
// dispatch outcome (which may itself be a failed call), Err wraps a
// TransactionValidityError whose Invalid arm names the reason.
const ok = () => ({ isOk: true })
const invalid = (variant: string, isFuture = false) =>
  ({ isOk: false, asErr: { isInvalid: true, asInvalid: { isFuture, type: variant } } })
const unknown = () => ({ isOk: false, asErr: { isInvalid: false, asInvalid: { isFuture: false, type: '' } } })

describe('includabilityFromApply', () => {
  it('treats any Ok as includable — even a call the runtime would fail on dispatch', () => {
    // apply Ok means the transaction ENTERS a block; whether its own call then
    // succeeds is the dry run's separate concern.
    expect(includabilityFromApply(ok())).toEqual({ includability: 'includable', rejectReason: null })
  })

  it('reads Invalid(Future) as a transaction correctly queued behind an earlier nonce', () => {
    expect(includabilityFromApply(invalid('Future', true))).toEqual({ includability: 'queued', rejectReason: null })
  })

  it('reads Invalid(Payment) as a permanent rejection and keeps the reason', () => {
    expect(includabilityFromApply(invalid('Payment'))).toEqual({ includability: 'rejected', rejectReason: 'Payment' })
  })

  it('reads every other Invalid variant as rejected too', () => {
    for (const variant of ['Stale', 'BadProof', 'ExhaustsResources', 'Call']) {
      expect(includabilityFromApply(invalid(variant))).toEqual({ includability: 'rejected', rejectReason: variant })
    }
  })

  it('does not hide a transaction the runtime could not judge', () => {
    expect(includabilityFromApply(unknown())).toEqual({ includability: 'unknown', rejectReason: null })
  })
})

// The suppression rule, the heart of "show the fail, hide its followups, cap the
// flood". A rejected head stays; anything queued behind it from the same signer,
// and any failing head beyond the cap, is dropped from tracking.
describe('classifySuppressed', () => {
  const A = '0xaaa', B = '0xbbb'
  const tx = (hash: string, signerId: string | null, nonce: number | null, includability: string, firstSeenMs = 0) =>
    ({ hash, signerId, nonce, includability: includability as 'includable' | 'queued' | 'rejected' | 'unknown', firstSeenMs })

  it('keeps the rejected head and suppresses its same-signer followups', () => {
    // The live stuck pair: nonce 5 cannot pay the fee, nonce 6 queues behind it.
    const out = classifySuppressed([
      tx('0x5', A, 5, 'rejected'),
      tx('0x6', A, 6, 'queued'),
    ], 8)
    expect([...out.keys()]).toEqual(['0x6'])
  })

  it('suppresses a whole doomed nonce run but keeps its head', () => {
    const out = classifySuppressed([
      tx('0x5', A, 5, 'rejected'),
      tx('0x6', A, 6, 'queued'),
      tx('0x7', A, 7, 'rejected'),
      tx('0x8', A, 8, 'queued'),
    ], 8)
    expect([...out.keys()].sort()).toEqual(['0x6', '0x7', '0x8'])
  })

  it('leaves a normal nonce queue alone — nothing rejected, nothing suppressed', () => {
    // nonce 11 legitimately waits on nonce 10; both are fine.
    expect(classifySuppressed([
      tx('0xa', B, 10, 'includable'),
      tx('0xb', B, 11, 'queued'),
    ], 8).size).toBe(0)
  })

  it('caps the number of failing heads, keeping the longest-waiting', () => {
    // Five distinct signers each with one rejected head; a cap of 2 keeps the two
    // oldest (smallest firstSeenMs) and suppresses the three fresher ones.
    const heads = [0, 1, 2, 3, 4].map(i => tx(`0x${i}`, `0xsig${i}`, 0, 'rejected', i * 1000))
    const out = classifySuppressed(heads, 2)
    expect([...out.keys()].sort()).toEqual(['0x2', '0x3', '0x4'])
  })

  it('keeps a signer that has no rejected transaction at all', () => {
    expect(classifySuppressed([tx('0xz', B, 3, 'queued')], 8).size).toBe(0)
  })

  it('records WHY each hash was suppressed, so a followup can be released again', () => {
    const out = classifySuppressed([
      tx('0x5', A, 5, 'rejected'),
      tx('0x6', A, 6, 'queued'),
      tx('0xh1', B, 0, 'rejected', 1),
      tx('0xh2', '0xccc', 0, 'rejected', 2),
    ], 1)
    expect(out.get('0x6')).toEqual({ kind: 'followup', signerId: A, nonce: 6 })
    // Flood surplus is judged against a cap, not against another transaction.
    expect(out.get('0xh2')).toEqual({ kind: 'surplus' })
  })
})

// Suppressing a followup is condemning it for a TRANSIENT reason: another
// transaction from the same signer, at a lower nonce, that was rejected AT THAT
// MOMENT. Bump its tip and it is included; the followup is then the pool head.
// Remembering only the hash made that verdict permanent for the process
// lifetime — invisible in the pending feed and a 404 on its own page until a
// restart.
describe('revocableSuppressions', () => {
  const A = '0xaaa'
  const tx = (signerId: string | null, nonce: number | null, includability: string) =>
    ({ signerId, nonce, includability: includability as 'includable' | 'queued' | 'rejected' | 'unknown' })

  it('releases a followup once its blocker is gone', () => {
    const suppressed = new Map<string, SuppressionCause>([['0x6', { kind: 'followup', signerId: A, nonce: 6 }]])
    // Blocker still rejected at nonce 5: the followup stays condemned.
    expect(revocableSuppressions(suppressed, rejectedNonceFloors([tx(A, 5, 'rejected')]))).toEqual([])
    // The signer bumped the tip on nonce 5 and it went in — nothing of theirs is
    // rejected below 6 any more.
    expect(revocableSuppressions(suppressed, rejectedNonceFloors([tx(A, 5, 'includable')]))).toEqual(['0x6'])
    expect(revocableSuppressions(suppressed, rejectedNonceFloors([]))).toEqual(['0x6'])
  })

  it('keeps a followup condemned while a LOWER nonce of the same signer is rejected', () => {
    const suppressed = new Map<string, SuppressionCause>([['0x9', { kind: 'followup', signerId: A, nonce: 9 }]])
    expect(revocableSuppressions(suppressed, rejectedNonceFloors([tx(A, 2, 'rejected')]))).toEqual([])
    // A rejection AT or ABOVE its own nonce is not what condemned it.
    expect(revocableSuppressions(suppressed, rejectedNonceFloors([tx(A, 9, 'rejected')]))).toEqual(['0x9'])
  })

  it('never revokes flood surplus — its cap is not a transient condition', () => {
    const suppressed = new Map<string, SuppressionCause>([['0xh', { kind: 'surplus' }]])
    expect(revocableSuppressions(suppressed, rejectedNonceFloors([]))).toEqual([])
  })
})
