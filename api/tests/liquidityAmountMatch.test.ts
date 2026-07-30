import { describe, it, expect } from 'vitest'
import { matchLiquidityAmounts, type LiquidityAmountCandidate, type LiquidityTransferLeg } from '../src/services/explorerService.ts'

// Omnipool.LiquidityRemoved/LiquidityAdded carry only sharesRemoved/shares, never
// the underlying token amount — that lives on the paired pool↔who transfer leg.
// matchLiquidityAmounts recovers it by dispatch scope + event-index adjacency.
const POOL = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'
const TREASURY_POT = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
const ALICE = `0x${'a1'.repeat(32)}`
const BOB = `0x${'b0'.repeat(32)}`
const SOL = 1000752

function removal(over: Partial<LiquidityAmountCandidate>): LiquidityAmountCandidate {
  return { block_height: 100, event_index: 0, extrinsic_index: null, event_name: 'Omnipool.LiquidityRemoved', who: ALICE, asset_id: SOL, amount: '', ...over }
}
function leg(over: Partial<LiquidityTransferLeg>): LiquidityTransferLeg {
  return { block_height: 100, event_index: 0, extrinsic_index: null, asset_id: SOL, from_account: POOL, to_account: ALICE, amount: '0', ...over }
}

describe('matchLiquidityAmounts', () => {
  it('fills an extrinsic-scoped removal from its extrinsic transfer leg', () => {
    const rows = [removal({ event_index: 9, extrinsic_index: 2 })]
    matchLiquidityAmounts(rows, [leg({ event_index: 5, extrinsic_index: 2, amount: '4200' })])
    expect(rows[0].amount).toBe('4200')
  })

  it('fills an offboarding (extrinsic-less) removal from the block null-extrinsic leg', () => {
    const rows = [removal({ event_index: 9, extrinsic_index: null })]
    matchLiquidityAmounts(rows, [leg({ event_index: 1, extrinsic_index: null, amount: '40815636' })])
    expect(rows[0].amount).toBe('40815636')
  })

  it('does not borrow a same-block SIGNED transfer leg for an extrinsic-less removal', () => {
    // A signed transfer of the same asset to the same account in the same block
    // must not satisfy a scheduler-dispatched removal — scopes are isolated.
    const rows = [removal({ event_index: 9, extrinsic_index: null })]
    matchLiquidityAmounts(rows, [leg({ event_index: 5, extrinsic_index: 7, amount: '999' })])
    expect(rows[0].amount).toBe('')
  })

  it('pairs two same-account removals in one block by adjacency, consuming each leg once', () => {
    // The observed SOL case: 0x10e6 has two removals (ev9, ev43) and two legs
    // (ev1=40815636 before ev9, ev35=40362548 before ev43).
    const rows = [
      removal({ event_index: 9, extrinsic_index: null }),
      removal({ event_index: 43, extrinsic_index: null }),
    ]
    matchLiquidityAmounts(rows, [
      leg({ event_index: 1, amount: '40815636' }),
      leg({ event_index: 35, amount: '40362548' }),
    ])
    expect(rows.map(r => r.amount)).toEqual(['40815636', '40362548'])
  })

  it('tolerates the Tokens.Transfer + Currencies.Transferred double emission', () => {
    // The same movement is emitted twice (adjacent, identical amount); adjacency
    // keeps the pairing correct without double-counting.
    const rows = [
      removal({ who: ALICE, event_index: 9, extrinsic_index: null }),
      removal({ who: BOB, event_index: 20, extrinsic_index: null }),
    ]
    matchLiquidityAmounts(rows, [
      leg({ to_account: ALICE, event_index: 1, amount: '40815636' }),
      leg({ to_account: ALICE, event_index: 2, amount: '40815636' }),
      leg({ to_account: BOB, event_index: 12, amount: '420957264' }),
      leg({ to_account: BOB, event_index: 13, amount: '420957264' }),
    ])
    expect(rows.map(r => r.amount)).toEqual(['40815636', '420957264'])
  })

  it('ignores the Treasury pool-deposit refund on a final XYK removal', () => {
    // The last LP out destroys the pool, so the Treasury refunds the 1 HDX
    // creation deposit AFTER the pool's own HDX payout. Adjacency alone would
    // report the deposit as the withdrawn amount.
    const rows = [removal({ event_name: 'XYK.LiquidityRemoved', asset_id: 0, event_index: 15, extrinsic_index: 2 })]
    matchLiquidityAmounts(rows, [
      leg({ asset_id: 0, event_index: 7, extrinsic_index: 2, amount: '496652773590136308' }),
      leg({ asset_id: 0, event_index: 13, extrinsic_index: 2, from_account: TREASURY_POT, amount: '1000000000000' }),
    ])
    expect(rows[0].amount).toBe('496652773590136308')
  })

  it('matches XYK.PoolCreated from the sender side (who→pool)', () => {
    const rows = [removal({ event_name: 'XYK.PoolCreated', who: ALICE, event_index: 4, extrinsic_index: 3 })]
    matchLiquidityAmounts(rows, [leg({ from_account: ALICE, to_account: POOL, event_index: 2, extrinsic_index: 3, amount: '5000' })])
    expect(rows[0].amount).toBe('5000')
  })

  it('leaves rows with an existing amount and rows with no matching leg untouched', () => {
    const rows = [
      removal({ event_index: 9, extrinsic_index: null, amount: '111' }),
      removal({ event_index: 20, extrinsic_index: null, who: BOB }),
    ]
    matchLiquidityAmounts(rows, [leg({ to_account: ALICE, event_index: 1, amount: '40815636' })])
    expect(rows.map(r => r.amount)).toEqual(['111', ''])
  })
})
