import { describe, expect, it } from 'vitest'
import { xcmCreditRun } from '../src/services/explorerService.ts'

// The beneficiaries of an inbound XCM message are not named by any XCM event, so they
// are reconstructed by walking BACK from the message's MessageQueue.Processed over the
// deposit events it emitted. Which indices that walk may cross decides whether a
// transfer appears at all, so the rule is pinned here rather than left to the query.
//
// A block is described as two predicates: which indices hold walk-family events (the
// deposits and their endow/mint siblings), and which hold XCM-executor bookkeeping the
// run may step over.
function run(barrier: number, previousBarrier: number, family: number[], crossable: number[]): number[] {
  return xcmCreditRun(barrier, previousBarrier, i => family.includes(i), i => crossable.includes(i))
}

describe('the inbound credit run', () => {
  it('walks a contiguous deposit run back to the start of the block', () => {
    // Hydration 13111975: deposits at 0-6, barrier at 7. The shape that always worked.
    expect(run(7, -1, [0, 1, 2, 3, 4, 5, 6], [])).toEqual([6, 5, 4, 3, 2, 1, 0])
  })

  // Hydration 13356159 — a Snowbridge USDC transfer whose DOT fee remainder could not
  // be delivered, so PolkadotXcm.AssetsTrapped landed at index 4, between the last
  // deposit and the barrier. Requiring contiguity ended the walk before its first step
  // and the transfer appeared nowhere: not on the account, not in the global feed.
  it('steps over XCM bookkeeping between the deposits and the barrier', () => {
    expect(run(5, -1, [0, 1, 2, 3], [4])).toEqual([3, 2, 1, 0])
  })

  it('steps over several such events in a row', () => {
    expect(run(6, -1, [0, 1], [2, 3, 4, 5])).toEqual([1, 0])
  })

  // The reason the run is not simply "everything below the barrier": the walk table
  // holds EVERY hook-context deposit, including the on_initialize credits of DCA,
  // staking and referral payouts, which belong to no message. Anything that is neither
  // a deposit nor XCM bookkeeping ends the run, leaving those where they are.
  it('stops at an event that belongs to neither the deposits nor the message', () => {
    expect(run(5, -1, [0, 1, 3, 4], [])).toEqual([4, 3])
  })

  // Several messages share a block. A run may never reach into the message before it,
  // whose own barrier is the floor — even when only crossable events separate them.
  it('never crosses the barrier of the preceding message', () => {
    expect(run(5, 2, [0, 1, 3, 4], [])).toEqual([4, 3])
    expect(run(4, 2, [0, 1], [3])).toEqual([])
    expect(run(2, -1, [0, 1], [])).toEqual([1, 0])
  })

  it('credits nothing when the barrier is the block\'s first event', () => {
    expect(run(0, -1, [], [])).toEqual([])
    expect(run(1, 0, [], [])).toEqual([])
  })

  // Structural siblings (Tokens.Endowed, System.NewAccount, Balances.Minted) are in the
  // family so they keep the run alive; the caller decides which of the walked indices
  // are actual credits.
  it('returns every walked family index, credit or sibling', () => {
    expect(run(4, -1, [0, 1, 2, 3], [])).toEqual([3, 2, 1, 0])
  })
})
