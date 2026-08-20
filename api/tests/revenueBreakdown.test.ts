import { describe, expect, it } from 'vitest'
import { foldRevenueBreakdown } from '../src/services/explorerService.ts'

const total = (stream: string, usd: number) => ({ stream, usd })
const row = (stream: string, asset_id: number, usd: number) => ({ stream, asset_id, usd })

describe('foldRevenueBreakdown', () => {
  it('stream totals come from account_revenue rows; assets attach per stream, both sorted by revenue', () => {
    const out = foldRevenueBreakdown(
      [total('network_fee', 7), total('omnipool_asset_fee', 140)],
      [
        row('network_fee', 0, 5),
        row('omnipool_asset_fee', 5, 100),
        row('omnipool_asset_fee', 10, 40),
        row('network_fee', 10, 2),
      ],
    )
    expect(out.streams.map(s => s.stream)).toEqual(['omnipool_asset_fee', 'network_fee'])
    expect(out.streams[0].assets.map(a => a.asset.assetId)).toEqual([5, 10])
    expect(out.streams[0].usd).toBe(140)
    // The header stat sums the same account_revenue rows, so the tab total is
    // exactly their sum — never the event rows' (which the borrow streams lack).
    expect(out.totalUsd).toBe(147)
  })

  it('folds the asset tail past the shown cap into one other bucket', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row('network_fee', i + 1, 20 - i))
    const out = foldRevenueBreakdown([total('network_fee', 210)], rows)
    const stream = out.streams[0]
    expect(stream.assets).toHaveLength(12)
    expect(stream.otherCount).toBe(8)
    // tail = the 8 smallest values 1..8
    expect(stream.otherUsd).toBe(36)
  })

  it('borrow streams have no event rows: hollar shows its one asset, asset_reserve stays a single line', () => {
    const out = foldRevenueBreakdown(
      [total('hollar_borrow', 3409.3), total('asset_reserve', 551.06), total('omnipool_asset_fee', 10)],
      [row('omnipool_asset_fee', 5, 10)],
    )
    expect(out.streams.map(s => s.stream)).toEqual(['hollar_borrow', 'asset_reserve', 'omnipool_asset_fee'])
    const hollar = out.streams[0]
    expect(hollar.assets).toHaveLength(1)
    expect(hollar.assets[0].asset.assetId).toBe(222)
    expect(hollar.assets[0].usd).toBe(3409.3)
    expect(out.streams[1].assets).toHaveLength(0)
    expect(out.totalUsd).toBeCloseTo(3970.36)
  })

  it('drops non-positive totals and rows, and is empty for no revenue', () => {
    const out = foldRevenueBreakdown(
      [total('omnipool_asset_fee', 10), total('liquidation_penalty', 0)],
      [row('omnipool_asset_fee', 9, 0), row('omnipool_asset_fee', 5, 10)],
    )
    expect(out.streams).toHaveLength(1)
    expect(out.streams[0].assets.map(a => a.asset.assetId)).toEqual([5])
    expect(foldRevenueBreakdown([], [])).toEqual({ totalUsd: 0, streams: [] })
  })
})
