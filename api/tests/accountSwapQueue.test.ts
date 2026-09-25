import { describe, expect, it } from 'vitest'
import { accountSwapDestinationRows, type AccountSwapQueueRow } from '../src/db/accountSwapQueue.ts'

const queued: AccountSwapQueueRow = {
  queued_at: '2026-07-16 12:00:00.000',
  block_height: 42,
  event_index: 7,
  extrinsic_index: 3,
  block_timestamp: '2026-07-16 11:59:59',
  event_name: 'Router.Executed',
  asset_in: 0,
  asset_out: 5,
  amount_in: '1000000000000',
  amount_out: '2000000',
  ingested_at: '2026-07-16 12:00:00',
}

describe('account swap queue', () => {
  it('resolves a queued event from only its exact extrinsic tuple', () => {
    const rows = accountSwapDestinationRows([queued], [
      { block_height: 41, extrinsic_index: 3, signer: 'wrong', effective_signer: null },
      { block_height: 42, extrinsic_index: 3, signer: 'alice', effective_signer: null },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ account: 'alice', signer: 'alice', block_height: 42, event_index: 7 })
  })

  it('deduplicates identical signer forms and retains an effective signer', () => {
    const duplicate = accountSwapDestinationRows([queued], [
      { block_height: 42, extrinsic_index: 3, signer: 'alice', effective_signer: 'alice' },
    ])
    const effective = accountSwapDestinationRows([queued], [
      { block_height: 42, extrinsic_index: 3, signer: null, effective_signer: 'evm-alice' },
    ])

    expect(duplicate.map(row => row.account)).toEqual(['alice'])
    expect(effective.map(row => [row.account, row.signer])).toEqual([['evm-alice', 'evm-alice']])
  })

  // A swap dispatched from a block hook has no extrinsic, so no signer: its actor
  // comes from the Broadcast event via swap_actor. Before this, such a row was
  // dropped for want of an extrinsic and the swap never reached its owner's page —
  // a $90k Treasury swap among them.
  it('attributes a hook swap to its Broadcast swapper instead of a signer', () => {
    const hook: AccountSwapQueueRow = { ...queued, extrinsic_index: null }
    const rows = accountSwapDestinationRows([hook], [], new Map([['42:7', 'treasury']]))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ account: 'treasury', extrinsic_index: null, block_height: 42, event_index: 7 })
    // No signer signed it; claiming one would name an actor that does not exist.
    expect(rows[0].signer).toBe('')
  })

  // Unresolved covers three cases that must all stay out rather than be attributed
  // to the router pallet: pre-Broadcast history, a placeholder swapper, and a DCA
  // execution (already rendered by the DCA path, so a second row would double it).
  it('drops a hook swap with no resolved swapper', () => {
    const hook: AccountSwapQueueRow = { ...queued, extrinsic_index: null }
    expect(accountSwapDestinationRows([hook], [], new Map())).toEqual([])
    // Keyed by the swap's own event, not merely its block.
    expect(accountSwapDestinationRows([hook], [], new Map([['42:9', 'someone-else']]))).toEqual([])
  })

  // An UNSIGNED extrinsic — ICE.submit_solution, the OCW's solution — has an extrinsic
  // index but no signer of any form, so the signer rule attributed its Router swaps to
  // nobody and the ICE pot's own page never saw them. The Broadcast event names the pot
  // as swapper, the same way it names a hook swap's actor.
  it('attributes an unsigned extrinsic\'s swap to its Broadcast swapper', () => {
    const rows = accountSwapDestinationRows([queued], [
      { block_height: 42, extrinsic_index: 3, signer: null, effective_signer: null },
    ], new Map([['42:7', 'ice-pot']]))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ account: 'ice-pot', extrinsic_index: 3, block_height: 42, event_index: 7, signer: '' })
  })

  it('drops an unsigned extrinsic\'s swap with no resolved swapper, and never overrides a signer', () => {
    const unsigned = [{ block_height: 42, extrinsic_index: 3, signer: null, effective_signer: null }]
    expect(accountSwapDestinationRows([queued], unsigned, new Map())).toEqual([])
    const signed = accountSwapDestinationRows([queued], [{ block_height: 42, extrinsic_index: 3, signer: 'alice', effective_signer: null }], new Map([['42:7', 'ice-pot']]))
    expect(signed.map(row => row.account)).toEqual(['alice'])
  })

  // A Proxy.proxy(real=X) or Multisig.as_multi dispatch moves X's funds, not the
  // signatory's: the block and extrinsic feeds already attribute its swaps to X
  // (actorsFor), and the account projection must key them the same way. Keyed on the
  // signatory, an account whose every trade ran through its proxy showed two incoming
  // transfers and no trades, while the proxy signer's page carried 348 trades of funds
  // it never held.
  it('keys an on-behalf dispatch\'s swap to the account it ran as, keeping the signatory as signer', () => {
    const signed = [{ block_height: 42, extrinsic_index: 3, signer: 'proxy-signer', effective_signer: null }]
    const rows = accountSwapDestinationRows([queued], signed, new Map(), new Map([['42:3', 'real']]))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ account: 'real', signer: 'proxy-signer', block_height: 42, event_index: 7, extrinsic_index: 3 })
    // The signatory gets no row of its own: the trade is not its economic action.
    expect(rows.map(row => row.account)).not.toContain('proxy-signer')
  })

  it('keys an on-behalf dispatch by its exact extrinsic tuple, never by block alone', () => {
    const signed = [{ block_height: 42, extrinsic_index: 3, signer: 'alice', effective_signer: null }]
    const other = accountSwapDestinationRows([queued], signed, new Map(), new Map([['42:4', 'real']]))
    expect(other.map(row => row.account)).toEqual(['alice'])
  })

  // An EVM dispatch (Ethereum.transact, dispatch_permit) has no substrate signer; its
  // effective signer is the actor unless the call itself ran on behalf of someone.
  it('lets an on-behalf actor override an effective signer too', () => {
    const evm = [{ block_height: 42, extrinsic_index: 3, signer: null, effective_signer: 'evm-alice' }]
    expect(accountSwapDestinationRows([queued], evm, new Map(), new Map([['42:3', 'real']])).map(row => [row.account, row.signer])).toEqual([['real', 'evm-alice']])
  })
})
