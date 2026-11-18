import { describe, expect, it } from 'vitest'
import { signGate } from '../src/vote/useReview'
import { actionAmounts } from '../src/vote/actionLogic'
import type { CartAction } from '../src/vote/voteBus'

describe('signing after an outcome', () => {
  it('keeps Sign off once the call is final or included, so the same call is never sent twice', () => {
    expect(signGate({ phase: 'finalized', blockNumber: 10, txIndex: 2, txHash: null, outcome: [] })).toEqual({ busy: false, done: true, recheck: false })
    expect(signGate({ phase: 'unconfirmed', blockNumber: 10, txIndex: 2, txHash: null, outcome: [] })).toEqual({ busy: false, done: true, recheck: false })
  })

  it('lets a call that failed on chain be signed again only after a fresh dry-run', () => {
    expect(signGate({ phase: 'failed', message: 'x', blockNumber: 10, txIndex: 2 })).toEqual({ busy: false, done: false, recheck: true })
  })

  it('leaves the review as it was when nothing reached a block', () => {
    expect(signGate({ phase: 'failed', message: 'declined', declined: true })).toEqual({ busy: false, done: false, recheck: false })
    expect(signGate(null)).toEqual({ busy: false, done: false, recheck: false })
  })

  it('is busy while the transaction is on its way', () => {
    for (const s of [{ phase: 'checking' }, { phase: 'wallet' }, { phase: 'submitted', txHash: null }, { phase: 'in-block', blockNumber: 1, txIndex: 0, txHash: null }] as const) {
      expect(signGate(s)).toEqual({ busy: true, done: false, recheck: false })
    }
  })
})

describe('what one signature moves', () => {
  const a = (kind: CartAction['kind'], amount: string | null, index = 1): CartAction => ({ kind, index, label: kind, amount })

  it('never sums a placement with a refund: only the placement is reserved from the signer', () => {
    const hdx = (n: number) => (BigInt(n) * 10n ** 12n).toString()
    expect(actionAmounts([a('place-decision-deposit', hdx(100)), a('refund-decision-deposit', hdx(100), 2)]))
      .toEqual({ reserved: 100n * 10n ** 12n, returned: 100n * 10n ** 12n })
  })

  it('counts refunds and unnotes as returned, and an unknown placement amount as nothing', () => {
    expect(actionAmounts([
      a('refund-submission-deposit', '5'), a('unnote-preimage', '7'), a('refund-decision-deposit', '11'),
      a('place-decision-deposit', null),
    ])).toEqual({ reserved: 0n, returned: 23n })
  })
})
