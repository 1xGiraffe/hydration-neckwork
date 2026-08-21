import { describe, expect, it } from 'vitest'
import { attachRevenue, revenueKey, type ActivityRevenue, type RevenueBearing } from '../src/services/explorerService.ts'

// Revenue is an EXTRINSIC-level fact, but an extrinsic can produce several activity
// rows. A liquidation is the case that matters: it seizes collateral AND swaps it, so
// the same extrinsic yields a LiquidationCall row and a trade row. Putting the figure on
// both showed every liquidation twice with its revenue duplicated, and made the internal
// collateral swap look like a swap that earned $1,037 on its own.
//
// So it is reported once, on the extrinsic's earliest row — which for every liquidation
// checked is the LiquidationCall itself, the thing that actually caused the revenue.
const rev = (protocolUsd: number): ActivityRevenue => ({ protocolUsd, lpUsd: 0, streams: [] })

describe('revenue on an extrinsic with several activity rows', () => {
  const map = new Map([[revenueKey(100, 9), rev(1037.64)]])

  it('reports it once, on the earliest row', () => {
    const rows: RevenueBearing[] = [
      { blockHeight: 100, extrinsicIndex: 9, eventIndex: 231 },
      { blockHeight: 100, extrinsicIndex: 9, eventIndex: 200 },
    ]

    attachRevenue(rows, map, 200)

    expect(rows[1].revenue?.protocolUsd).toBe(1037.64)
    expect(rows[0].revenue).toBeUndefined()
  })

  it('does not depend on the order the rows arrive in', () => {
    const rows: RevenueBearing[] = [
      { blockHeight: 100, extrinsicIndex: 9, eventIndex: 200 },
      { blockHeight: 100, extrinsicIndex: 9, eventIndex: 231 },
    ]

    attachRevenue(rows, map, 200)

    expect(rows[0].revenue?.protocolUsd).toBe(1037.64)
    expect(rows[1].revenue).toBeUndefined()
  })

  it('never counts one extrinsic’s revenue twice', () => {
    const rows: RevenueBearing[] = [
      { blockHeight: 100, extrinsicIndex: 9, eventIndex: 200 },
      { blockHeight: 100, extrinsicIndex: 9, eventIndex: 231 },
      { blockHeight: 100, extrinsicIndex: 9, eventIndex: 260 },
    ]

    attachRevenue(rows, map, 200)

    const total = rows.reduce((sum, r) => sum + (r.revenue?.protocolUsd ?? 0), 0)
    expect(total).toBe(1037.64)
  })

  it('keeps separate extrinsics separate', () => {
    const two = new Map([[revenueKey(100, 9), rev(10)], [revenueKey(100, 4), rev(20)]])
    const rows: RevenueBearing[] = [
      { blockHeight: 100, extrinsicIndex: 9, eventIndex: 231 },
      { blockHeight: 100, extrinsicIndex: 4, eventIndex: 73 },
    ]

    attachRevenue(rows, two, 200)

    expect(rows[0].revenue?.protocolUsd).toBe(10)
    expect(rows[1].revenue?.protocolUsd).toBe(20)
  })

  // A block-level row has no extrinsic to share, so it keeps its own figure.
  it('still reports a block-hook row', () => {
    const hook = new Map([[revenueKey(100, null), rev(0.34)]])
    const rows: RevenueBearing[] = [{ blockHeight: 100, extrinsicIndex: null, eventIndex: 28 }]

    attachRevenue(rows, hook, 200)

    expect(rows[0].revenue?.protocolUsd).toBe(0.34)
  })

  // A single row is the earliest row of its own extrinsic, so a detail page still
  // reports what the extrinsic earned.
  it('reports on a lone row, as a detail page shows', () => {
    const rows: RevenueBearing[] = [{ blockHeight: 100, extrinsicIndex: 9, eventIndex: 231 }]

    attachRevenue(rows, map, 200)

    expect(rows[0].revenue?.protocolUsd).toBe(1037.64)
  })
})
