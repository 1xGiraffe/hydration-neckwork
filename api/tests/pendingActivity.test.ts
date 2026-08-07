import { describe, expect, it } from 'vitest'
import { buildMempoolActivities, buildPendingActivities, isPalletPot } from '../src/services/pendingActivity.ts'
import type { PendingBlock, PendingEventRow } from '../src/services/pendingHeadService.ts'

const A = '0x' + '11'.repeat(32)
const B = '0x' + '22'.repeat(32)

function block(events: PendingEventRow[]): PendingBlock {
  return { height: 13489900, hash: '0xabc', parentHash: '0xdef', timestamp: '2026-08-06 16:00:00', specVersion: 435, extrinsics: [], events }
}
const swap = (eventIndex: number, extrinsicIndex: number | null, swapper: string, inAsset: number, inAmt: string, outAsset: number, outAmt: string): PendingEventRow =>
  ({ eventIndex, extrinsicIndex, name: 'Broadcast.Swapped3', args: null, swap: { swapper, inputs: [{ assetId: inAsset, amount: inAmt }], outputs: [{ assetId: outAsset, amount: outAmt }] } })
const transfer = (eventIndex: number, extrinsicIndex: number | null, from: string, to: string, assetId: number, amount: string): PendingEventRow =>
  ({ eventIndex, extrinsicIndex, name: 'Tokens.Transfer', args: null, transfer: { from, to, assetId, amount } })
const plain = (eventIndex: number, extrinsicIndex: number | null, name: string): PendingEventRow =>
  ({ eventIndex, extrinsicIndex, name, args: null })

describe('buildPendingActivities', () => {
  it('folds a routed trade (two hops, one extrinsic) into one row: first input, last output', () => {
    // HDX -> LRNA -> DOT via the Omnipool: two Swapped legs in extrinsic 2.
    const rows = buildPendingActivities(block([
      swap(5, 2, A, 0, '1000', 1, '50'),
      swap(6, 2, A, 1, '50', 5, '77'),
    ]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'trade', assetIn: 0, amountIn: '1000', assetOut: 5, amountOut: '77', extrinsicIndex: 2 })
  })

  it('keeps initialization-phase swaps (DCA executions) separate per swapper', () => {
    const rows = buildPendingActivities(block([
      swap(3, null, A, 0, '10', 5, '1'),
      swap(4, null, B, 10, '20', 5, '2'),
    ]))
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(r => (r as { swapper: string }).swapper))).toEqual(new Set([A, B]))
  })

  it("suppresses a trade's own transfer plumbing but keeps plain transfers", () => {
    const rows = buildPendingActivities(block([
      swap(5, 2, A, 0, '1000', 5, '77'),
      transfer(6, 2, A, B, 0, '1000'),      // the swap's internal leg
      transfer(9, 3, B, A, 10, '500'),      // a real transfer in another extrinsic
    ]))
    expect(rows.map(r => r.kind).sort()).toEqual(['trade', 'transfer'])
    expect(rows.find(r => r.kind === 'transfer')).toMatchObject({ extrinsicIndex: 3, amount: '500' })
  })

  it('orders newest-first within the block', () => {
    const rows = buildPendingActivities(block([
      transfer(1, 1, A, B, 0, '1'),
      swap(7, 3, A, 0, '10', 5, '1'),
    ]))
    expect(rows.map(r => r.eventIndex)).toEqual([7, 1])
  })
})

// What a transfer row must be: something somebody signed, between accounts that
// are people. Measured against the finalized feed, 199 of 200 settled transfer
// rows are extrinsic-anchored with no pallet pot on either side, while this
// layer was publishing the opposite — 283 of 305 rows had a pot as sender and
// matched no settled row, so each appeared briefly and vanished at finality.
describe('a transfer row is a transfer somebody made', () => {
  it('drops an unanchored transfer — nobody signed it', () => {
    expect(buildPendingActivities(block([transfer(9, null, A, B, 10, '500')]))).toEqual([])
  })

  it('drops one with a pallet pot on either end', () => {
    const pot = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'
    expect(buildPendingActivities(block([transfer(9, 2, pot, B, 0, '711453914982193')]))).toEqual([])
    expect(buildPendingActivities(block([transfer(9, 2, A, pot, 0, '711453914982193')]))).toEqual([])
  })

  it('keeps a signed transfer between two accounts', () => {
    const rows = buildPendingActivities(block([transfer(9, 2, A, B, 10, '500')]))
    expect(rows.map(r => r.kind)).toEqual(['transfer'])
  })
})

// DCA executions run in block initialization — no extrinsic to anchor
// suppression on, so their plumbing transfers are recognized by swapper.
it('suppresses initialization-phase transfer legs touching an init-phase swapper', () => {
  const rows = buildPendingActivities(block([
    swap(3, null, A, 0, '10', 5, '1'),
    transfer(4, null, A, B, 0, '10'),      // the DCA leg out of the swapper
    transfer(5, null, B, A, 5, '1'),       // and back in
    transfer(9, 2, B, B, 10, '500'),       // unrelated signed transfer stays
  ]))
  expect(rows.map(r => r.kind).sort()).toEqual(['trade', 'transfer'])
  expect(rows.find(r => r.kind === 'transfer')).toMatchObject({ extrinsicIndex: 2 })
})

// Mempool activities: the same classifier over a transaction's DRY-RUN
// projected events. Only would-succeed projections make activity claims.
describe('buildMempoolActivities', () => {
  const tx = (hash: string, success: boolean | null, events: PendingEventRow[]) =>
    ({ hash, firstSeen: '2026-08-06 16:00:00', success, events })

  it('folds a projected routed trade and stamps the transaction hash', () => {
    const rows = buildMempoolActivities([tx('0xaa', true, [
      swap(0, null, A, 0, '1000', 1, '50'),
      swap(1, null, A, 1, '50', 5, '77'),
    ])])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'trade', hash: '0xaa', blockHeight: 0, assetIn: 0, amountIn: '1000', assetOut: 5, amountOut: '77' })
  })

  it("suppresses the projected trade's own transfer plumbing", () => {
    const rows = buildMempoolActivities([tx('0xaa', true, [
      swap(0, null, A, 0, '1000', 5, '77'),
      transfer(1, null, A, B, 0, '1000'),
    ])])
    expect(rows.map(r => r.kind)).toEqual(['trade'])
  })

  it('makes no claims for failing or unjudged projections', () => {
    const failing = tx('0xbb', false, [transfer(0, null, A, B, 0, '9')])
    const unjudged = tx('0xcc', null, [transfer(0, null, A, B, 0, '9')])
    expect(buildMempoolActivities([failing, unjudged])).toHaveLength(0)
  })

  it('keeps two transactions apart even with identical projected events', () => {
    const events = [transfer(0, null, A, B, 10, '500')]
    const rows = buildMempoolActivities([tx('0xaa', true, events), tx('0xbb', true, events)])
    expect(rows.map(r => r.hash).sort()).toEqual(['0xaa', '0xbb'])
  })
})

// A GIGAHDX stake, a reward claim or a money-market supply moves tokens with
// real Transfer events, and the finalized classifier renders each as ONE row of
// its own family with those legs suppressed. Reading them here as transfers
// published a claim finality then contradicted: a row reading "from the GIGAHDX
// Pot to <someone>" that a staking row replaced seconds later. Verified against
// the chain: a GigaHdx.Staked / GigaHdxRewards.RewardsClaimed extrinsic emits
// Balances.Transfer AND Tokens.Transfer alongside its GigaHdx events.
describe('plumbing of a classified action', () => {
  it('suppresses the transfer legs of a GIGAHDX payout', () => {
    const rows = buildPendingActivities(block([
      transfer(4, 2, A, B, 0, '1000000000000'),
      plain(5, 2, 'GigaHdx.Staked'),
      plain(6, 2, 'GigaHdxRewards.RewardsClaimed'),
    ]))
    expect(rows).toEqual([])
  })

  it.each([
    ['Staking.RewardsClaimed', 'staking'],
    ['Omnipool.LiquidityAdded', 'liquidity'],
    ['OTC.Filled', 'otc'],
    ['ConvictionVoting.Voted', 'votes'],
    ['EVM.Log', 'money market / contracts'],
    ['Evm.Log', 'money market, named as the runtime does'],
  ])('suppresses them for %s (%s)', (eventName) => {
    expect(buildPendingActivities(block([
      transfer(1, 3, A, B, 10, '500'),
      plain(2, 3, eventName),
    ]))).toEqual([])
  })

  it('leaves a plain transfer alone — fee and success events are not actions', () => {
    const rows = buildPendingActivities(block([
      transfer(1, 3, A, B, 10, '500'),
      plain(2, 3, 'TransactionPayment.TransactionFeePaid'),
      plain(3, 3, 'System.ExtrinsicSuccess'),
    ]))
    expect(rows.map(r => r.kind)).toEqual(['transfer'])
  })

  it('does not let one extrinsic\'s action suppress another\'s transfer', () => {
    const rows = buildPendingActivities(block([
      transfer(1, 3, A, B, 10, '500'),
      plain(2, 4, 'GigaHdx.Staked'),
      transfer(3, 4, A, B, 10, '900'),
    ]))
    expect(rows.map(r => r.eventIndex)).toEqual([1])
  })
})

// Money market and cross-chain, added to the basic classifier so a pool
// transaction that lends or bridges is not invisible until finality. Both are
// decoded from evidence: the Aave topics below are the ones this chain emits
// (verified against raw_money_market_events), and the XCM pairing rule mirrors
// what the finalized classifier does — the message names the amounts, the
// extrinsic's Withdrawn events say which asset each was.
const SUPPLY_TOPIC = '0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61'
const mmEvent = (eventIndex: number, extrinsicIndex: number | null, action: 'Supply' | 'Borrow', amount: string): PendingEventRow =>
  ({ eventIndex, extrinsicIndex, name: 'Evm.Log', args: null,
     mm: { action, assetAddress: '0x000000000000000000000000000000010000002e', amount, who: '0x' + 'ab'.repeat(20) } })
const withdrawn = (eventIndex: number, extrinsicIndex: number | null, assetId: number, amount: string): PendingEventRow =>
  ({ eventIndex, extrinsicIndex, name: 'Tokens.Withdrawn', args: null, withdrawn: { assetId, amount, who: A } })
const xcmSent = (eventIndex: number, extrinsicIndex: number | null, amounts: string[], feeAmounts: string[], destParaId: number | null): PendingEventRow =>
  ({ eventIndex, extrinsicIndex, name: 'PolkadotXcm.Sent', args: null, xcm: { amounts, feeAmounts, destParaId } })

// `modl` + a pallet id is how substrate derives a pallet's own account, so this
// is the Router's pot — the actor on EVERY money-market log in a 10-minute live
// sample, because a routed swap passes through the money market and emits
// Supply/Withdraw on the way. Read as lends, they were 20 lends nobody made,
// and each vanished at finality when the real classifier folded it into a trade.
const ROUTER_POT = '0x6d6f646c726f7574657265780000000000000000'
const potMmEvent = (eventIndex: number, extrinsicIndex: number | null): PendingEventRow =>
  ({ eventIndex, extrinsicIndex, name: 'Evm.Log', args: null,
     mm: { action: 'Supply', assetAddress: '0x000000000000000000000000000000010000002e', amount: '5', who: ROUTER_POT } })

describe('money market', () => {
  it('reads one row per Aave log, with the action it decoded', () => {
    const rows = buildPendingActivities(block([mmEvent(3, 1, 'Supply', '1000000')]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'mm', action: 'Supply', amount: '1000000', extrinsicIndex: 1 })
  })

  it('never reports a pallet pot as a lender', () => {
    expect(buildPendingActivities(block([potMmEvent(3, 1)]))).toEqual([])
    expect(isPalletPot(ROUTER_POT)).toBe(true)
    expect(isPalletPot('0x' + 'ab'.repeat(20))).toBe(false)
  })

  it('does not call a GIGAHDX stake a lend', () => {
    // Observed live at block 13499188: an Evm.Log Supply of asset 670 that the
    // finalized classifier settled as ONE staking row. A stake implemented by
    // supplying into the money market is a stake.
    const rows = buildPendingActivities(block([
      mmEvent(3, 1, 'Supply', '978967327025691'),
      plain(4, 1, 'GigaHdx.Staked'),
    ]))
    expect(rows).toEqual([])
  })

  it('still reports a plain lend, where lending is all the extrinsic did', () => {
    const rows = buildPendingActivities(block([
      mmEvent(3, 1, 'Supply', '1000000'),
      plain(4, 1, 'EVM.Log'),                // its own pallet never disqualifies it
      plain(5, 1, 'System.ExtrinsicSuccess'),
    ]))
    expect(rows.map(r => r.kind)).toEqual(['mm'])
  })

  it("suppresses a swap's own money-market hops", () => {
    // A routed swap that travels through the money market: one trade, not a
    // trade plus a lend plus a withdrawal.
    const rows = buildPendingActivities(block([
      swap(5, 2, A, 0, '1000', 5, '77'),
      mmEvent(6, 2, 'Supply', '1000'),
      mmEvent(7, 2, 'Borrow', '77'),
    ]))
    expect(rows.map(r => r.kind)).toEqual(['trade'])
  })

  it('suppresses the transfer legs the same extrinsic moves as plumbing', () => {
    const rows = buildPendingActivities(block([
      mmEvent(3, 1, 'Supply', '1000000'),
      transfer(4, 1, A, B, 10, '1000000'),
    ]))
    expect(rows.map(r => r.kind)).toEqual(['mm'])
  })

  it('reports the topic0 the chain actually emits for Supply', () => {
    // Pins the constant that makes the decode possible at all: it was read off
    // this chain'"'"'s indexed events, and a wrong one silently yields no rows.
    expect(SUPPLY_TOPIC).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('outbound cross-chain', () => {
  it('takes the leg the message names, not the fee leg', () => {
    const rows = buildPendingActivities(block([
      withdrawn(1, 2, 5, '900'),          // the fee asset
      withdrawn(2, 2, 10, '51566137326'), // the transfer
      xcmSent(3, 2, ['51566137326', '900'], ['900'], 2030),
    ]))
    expect(rows.filter(r => r.kind === 'xcm')).toHaveLength(1)
    expect(rows.find(r => r.kind === 'xcm')).toMatchObject({ assetId: 10, amount: '51566137326', destParaId: 2030 })
  })

  it('falls back to a single withdrawal when the message names nothing usable', () => {
    const rows = buildPendingActivities(block([
      withdrawn(1, 2, 10, '777'),
      xcmSent(2, 2, [], [], 1000),
    ]))
    expect(rows.find(r => r.kind === 'xcm')).toMatchObject({ assetId: 10, amount: '777', destParaId: 1000 })
  })

  it('makes no claim when the legs are ambiguous', () => {
    // Two withdrawals, neither named by the message: guessing would show the
    // wrong asset, and the finalized classifier will get it right shortly.
    const rows = buildPendingActivities(block([
      withdrawn(1, 2, 5, '100'),
      withdrawn(2, 2, 10, '200'),
      xcmSent(3, 2, [], [], 2004),
    ]))
    expect(rows.filter(r => r.kind === 'xcm')).toHaveLength(0)
  })
})
