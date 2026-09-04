import { describe, expect, it } from 'vitest'
import { XCM_IN_WALK_EVENTS, XCM_WALK_CROSSABLE_EVENTS, xcmCreditRun } from '../src/services/explorerService.ts'

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

// A block given as the ordered event NAMES of one message, classified by the same two
// lists the walk's queries are built from — so which names the run may cross is pinned
// against real block shapes rather than against a hand-picked index set.
function runNames(names: string[]): number[] {
  const barrier = names.length - 1
  return xcmCreditRun(
    barrier, -1,
    i => XCM_IN_WALK_EVENTS.includes(names[i]),
    i => XCM_WALK_CROSSABLE_EVENTS.includes(names[i]),
  )
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

  // Hydration 13959494 — 12,300 HOLLAR from AssetHub. HOLLAR's balances live in an ERC20
  // contract, so the currency adapter mirrors every leg as an EVM.Log Transfer and emits
  // no Tokens.Deposited at all: the mirror sits between the treasury fee credit and the
  // beneficiary's. Stopping there ended the run one step short of the user and the whole
  // message decoded to nothing — 149 of the first 151 HOLLAR arrivals appeared nowhere.
  it('steps over the ERC20 mirror of an ERC20-backed asset', () => {
    expect(runNames([
      'EVM.Log', 'Currencies.Withdrawn', // the sending chain's sovereign account
      'EVM.Log', 'Currencies.Deposited', // the beneficiary
      'EVM.Log', 'Currencies.Deposited', // the XCM fee, to the treasury
      'MessageQueue.Processed',
    ])).toEqual([5, 3])
  })

  // The other half of that rule. Hydration 13045949 — a Moonbeam MRL message that runs a
  // Transact: EVM.Executed marks a program the message DISPATCHED, and what it moved is
  // not a credit this message made, so the run must still stop there. Crossing the log
  // without crossing the execution is what keeps the remote-execution cut intact.
  it('still stops at an EVM execution the message dispatched', () => {
    expect(runNames([
      'Tokens.Deposited', 'EVM.Log', 'EVM.Executed',
      'Balances.Deposit', 'Currencies.Deposited',
      'MessageQueue.Processed',
    ])).toEqual([4, 3])
  })
})
