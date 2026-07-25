import { describe, expect, it } from 'vitest'
import { orderVoters } from '../src/utils/referendumVotes'
import type { ReferendumVoter } from '../src/types'

const voter = (over: Partial<ReferendumVoter>): ReferendumVoter => ({
  account: null, kind: 'Standard', side: 'Aye', conviction: 'Locked1x', convictionIndex: 1,
  balance: '0', ayeBalance: '0', nayBalance: '0', abstainBalance: '0',
  weightedAye: '0', weightedNay: '0', weighted: '0', valueUsd: null,
  blockHeight: 1, eventIndex: 0, extrinsicIndex: 0, timestamp: '', removed: false, ...over,
})

describe('orderVoters', () => {
  const aye = voter({ blockHeight: 100, weighted: '10', weightedAye: '10' })
  const bigAye = voter({ blockHeight: 50, weighted: '324720460268124120655', weightedAye: '324720460268124120655' })
  const nay = voter({ blockHeight: 200, weighted: '20', weightedNay: '20' })
  const split = voter({ kind: 'Split', side: 'Split', blockHeight: 150, weighted: '30', weightedAye: '10', weightedNay: '20' })
  const all = [aye, bigAye, nay, split]

  it('sorts newest first by default', () => {
    expect(orderVoters(all, 'time', 'all').map(v => v.blockHeight)).toEqual([200, 150, 100, 50])
  })

  it('breaks a same-block tie on event index', () => {
    const a = voter({ blockHeight: 10, eventIndex: 1 }), b = voter({ blockHeight: 10, eventIndex: 7 })

    expect(orderVoters([a, b], 'time', 'all').map(v => v.eventIndex)).toEqual([7, 1])
  })

  // Weights are 21-digit planck values, so they are compared as BigInt: subtracting
  // them as doubles silently ties values that differ in their low digits.
  it('sorts by votes without losing precision', () => {
    const near = voter({ weighted: '324720460268124120654', weightedAye: '324720460268124120654' })

    expect(orderVoters([near, bigAye], 'votes', 'all').map(v => v.weighted))
      .toEqual(['324720460268124120655', '324720460268124120654'])
  })

  it('filters to one side', () => {
    expect(orderVoters(all, 'time', 'aye').map(v => v.blockHeight)).toEqual([150, 100, 50])
    expect(orderVoters(all, 'time', 'nay').map(v => v.blockHeight)).toEqual([200, 150])
  })

  // A Split vote backs both sides at once, so it belongs under either filter.
  it('keeps a split vote on both sides', () => {
    expect(orderVoters([split], 'time', 'aye')).toHaveLength(1)
    expect(orderVoters([split], 'time', 'nay')).toHaveLength(1)
  })

  it('does not mutate its input', () => {
    const input = [aye, nay]
    orderVoters(input, 'votes', 'all')

    expect(input).toEqual([aye, nay])
  })
})
