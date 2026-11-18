import { describe, expect, it } from 'vitest'
import { depositRefund, depositStateWord, heldAndKept, placeDecisionDeposit, preimageRefund, refundAll, shortHash, actionsTotal } from '../src/components/gov/deposits'
import { actionSummary, signatureBatches } from '../src/vote/actionLogic'
import { outcomeLines } from '../src/vote/chainWrite'
import type { AccountDeposits, PreimageDeposit, ReferendumDeposit } from '../src/governanceTypes'

const at = { blockHeight: 1, extrinsicIndex: 0, timestamp: '2026-01-01T00:00:00Z' }
const dep = (over: Partial<ReferendumDeposit>): ReferendumDeposit & { status: string } => ({
  index: 404, kind: 'submission', who: '0x' + '82'.repeat(32), amount: '100000000000000', placedAt: at, state: 'refundable', refundedAt: null, status: 'approved', ...over,
})
const pre = (over: Partial<PreimageDeposit>): PreimageDeposit => ({
  hash: '0x83e892ce7481986830f8b0ead67944e7fe0de6854a8aa9fa61be233a1ba20cb0', owner: '0x' + '82'.repeat(32), amount: '436690000000000', len: 1159,
  requested: false, usedBy: [{ index: 404, status: 'approved' }], refundable: true, blocked: null, ...over,
})

describe('governance deposits', () => {
  it('offers a refund only for a refundable deposit, of the right kind', () => {
    expect(depositRefund(dep({}))).toEqual({ kind: 'refund-submission-deposit', index: 404, label: 'Refund the submission deposit of #404', amount: '100000000000000' })
    expect(depositRefund(dep({ kind: 'decision' }))?.kind).toBe('refund-decision-deposit')
    for (const state of ['held', 'refunded', 'kept', 'slashed'] as const) expect(depositRefund(dep({ state }))).toBeNull()
  })

  it('says each state in words', () => {
    expect(depositStateWord({ state: 'kept' })).toBe('kept by the chain')
    expect(depositStateWord({ state: 'held' })).toBe('held until it concludes')
  })

  it('unnotes a preimage only when it is refundable, as its owner', () => {
    expect(preimageRefund(pre({}))).toMatchObject({ kind: 'unnote-preimage', owner: '0x' + '82'.repeat(32), label: 'Refund the preimage deposit 0x83e8…0cb0' })
    expect(preimageRefund(pre({ refundable: false, blocked: 'needed' }))).toBeNull()
    expect(shortHash('0xabc')).toBe('0xabc')
  })

  it('refunds everything at once, leaving out preimages of several owners', () => {
    const d: AccountDeposits = {
      referenda: [dep({}), dep({ index: 12, kind: 'decision', amount: '750000000000000000' }), dep({ index: 13, state: 'kept' })],
      preimages: [pre({})], preimagesAsOfBlock: 1, totals: { held: '0', refundable: '0' },
    }
    const all = refundAll(d)
    expect(all.map(a => a.kind)).toEqual(['refund-submission-deposit', 'refund-decision-deposit', 'unnote-preimage'])
    expect(actionsTotal(all)).toBe(100000000000000n + 750000000000000000n + 436690000000000n)
    const two = refundAll({ ...d, preimages: [pre({}), pre({ hash: '0x' + '11'.repeat(32), owner: '0x' + '99'.repeat(32) })] })
    expect(two.map(a => a.kind)).toEqual(['refund-submission-deposit', 'refund-decision-deposit'])
    expect(refundAll({ ...d, preimages: null }).length).toBe(2)
  })

  it('places a decision deposit for the referendum it names', () => {
    expect(placeDecisionDeposit(451, '750000000000000000')).toEqual({ kind: 'place-decision-deposit', index: 451, label: 'Place the decision deposit of #451', amount: '750000000000000000' })
  })

  it('keeps what the chain keeps out of the held total, with or without the api saying so', () => {
    const d: AccountDeposits = { referenda: [dep({}), dep({ index: 13, state: 'kept' })], preimages: [], preimagesAsOfBlock: 1, totals: { held: '200000000000000', refundable: '100000000000000' } }
    expect(heldAndKept(d)).toEqual({ held: 100000000000000n, kept: 100000000000000n })
    expect(heldAndKept({ ...d, totals: { held: '100000000000000', refundable: '0', kept: '100000000000000' } })).toEqual({ held: 100000000000000n, kept: 100000000000000n })
  })

  it('says a long list in one sentence and splits it past one signature', () => {
    const refunds = Array.from({ length: 280 }, (_, i) => depositRefund(dep({ index: i }))!)
    const pres = Array.from({ length: 12 }, (_, i) => preimageRefund(pre({ hash: `0x${String(i).padStart(64, '0')}`, amount: '400000000000000' }))!)
    expect(actionSummary([...refunds, ...pres])).toBe('Returns 280 submission deposits (28,000 HDX) and 12 preimage deposits (4,800 HDX) to their owners.')
    expect(signatureBatches([...refunds, ...pres]).map(b => b.length)).toEqual([292])
    expect(signatureBatches([...refunds, ...pres], 100).map(b => b.length)).toEqual([100, 100, 92])
  })

  it('sums a long batch’s outcome into one line per kind', () => {
    const ev = (name: string, index: number) => ({ pallet: 'Referenda', name, data: { index, who: '0x', amount: '100000000000000' } })
    expect(outcomeLines([ev('SubmissionDepositRefunded', 1), ev('SubmissionDepositRefunded', 2)])).toEqual([
      'Returns the submission deposit of #1 (100 HDX) to its depositor', 'returns the submission deposit of #2 (100 HDX) to its depositor',
    ])
    const many = Array.from({ length: 280 }, (_, i) => ev('SubmissionDepositRefunded', i))
    expect(outcomeLines([...many, ...Array.from({ length: 12 }, () => ({ pallet: 'Preimage', name: 'Cleared', data: { hash: '0x' } }))])).toEqual([
      'Returns 280 submission deposits (28,000 HDX) to their depositors', 'removes 12 preimages and returns their deposits',
    ])
  })
})
