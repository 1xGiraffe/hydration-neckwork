import { describe, expect, it } from 'vitest'
import { buildPendingActivities } from '../src/services/pendingActivity.ts'
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
