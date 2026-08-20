import { describe, expect, it } from 'vitest'
import { attachRevenue, revenueKey, type ActivityRevenue, type RevenueBearing } from '../src/services/explorerService.ts'

// `revenue_events` is derived, so it trails the raw head by ~1k blocks. That makes
// "no row in the map" ambiguous: the extrinsic either earned nothing, or its revenue
// is not booked yet. Rendering the second as $0.00 states a number we don't have.
//
// So the watermark decides: at or below it, absence IS zero; above it, the field
// stays absent and the UI shows a dash.
const map = new Map<string, ActivityRevenue>([
  [revenueKey(100, 3), { protocolUsd: 1.5, lpUsd: 0.5, streams: [{ stream: 'omnipool_asset_fee', usd: 1.5 }] }],
])

describe('attaching booked revenue to activity rows', () => {
  it('attaches the booked figure for a row the derivation has reached', () => {
    const rows: RevenueBearing[] = [{ blockHeight: 100, extrinsicIndex: 3 }]

    attachRevenue(rows, map, 200)

    expect(rows[0].revenue?.protocolUsd).toBe(1.5)
  })

  it('reports an explicit zero for a booked row that earned nothing', () => {
    const rows: RevenueBearing[] = [{ blockHeight: 101, extrinsicIndex: 7 }]

    attachRevenue(rows, map, 200)

    expect(rows[0].revenue).toEqual({ protocolUsd: 0, lpUsd: 0, streams: [] })
  })

  it('leaves revenue absent above the watermark, rather than claiming zero', () => {
    const rows: RevenueBearing[] = [{ blockHeight: 300, extrinsicIndex: 1 }]

    attachRevenue(rows, map, 200)

    expect(rows[0].revenue).toBeUndefined()
  })

  it('attaches nothing at all when the derivation has booked no blocks', () => {
    const rows: RevenueBearing[] = [{ blockHeight: 100, extrinsicIndex: 3 }]

    attachRevenue(rows, map, 0)

    expect(rows[0].revenue).toBeUndefined()
  })

  it('keys a block-level row (no extrinsic) apart from extrinsic 0', () => {
    expect(revenueKey(100, null)).not.toBe(revenueKey(100, 0))
  })
})
