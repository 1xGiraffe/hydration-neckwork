import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/services/omniwatchIdentity.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/omniwatchIdentity.ts')>()),
  ensureSnakewatchEmojiSourceLoaded: async () => undefined,
}))

const { queryTradeVolumeDetails } = await import('../src/services/tradeVolumeService.ts')

// The volume-details response carries the candle's own volume beside the
// accounts' figures, so a reader can state what no account explains — an ICE
// route hop no owner traded — or what the accounts traded beyond pool volume —
// an ICE intent matched peer-to-peer (src/blocks/icePotSettlement.ts).
describe('queryTradeVolumeDetails', () => {
  const fakeClient = (candle: Record<string, string>) => {
    const queries: string[] = []
    const client = {
      query: async ({ query }: { query: string }) => {
        queries.push(query)
        const rows = query.includes('FROM price_data.prices')
          ? [candle]
          : query.includes('LIMIT {limit:UInt32}')
            ? [{ account: '0x' + 'a1'.repeat(32), volume_buy: '40', volume_sell: '0', volume_total: '40', net_volume: '40', trade_count: '1', native_volume_buy: '4000', native_volume_sell: '0', native_volume_total: '4000', native_net_volume: '4000' }]
            : [{ account_count: '1', trade_count: '1', volume_buy: '40', volume_sell: '0', volume_total: '40', net_volume: '40', native_volume_buy: '4000', native_volume_sell: '0', native_volume_total: '4000', native_net_volume: '4000' }]
        return { json: async () => rows }
      },
    }
    return { client, queries }
  }

  it('reports the candle\'s own pool volume beside the accounts\' totals, natives exact', async () => {
    const { client, queries } = fakeClient({
      volume_buy: '60.5', volume_sell: '39.5',
      native_volume_buy: '123456789012345678901234567890', native_volume_sell: '1',
    })
    const details = await queryTradeVolumeDetails(client as never, { assetId: 5, intervalStart: new Date('2026-11-07T07:00:00Z'), interval: '5min' })

    expect(details).toMatchObject({
      volumeTotal: 40,
      candleVolumeBuy: 60.5,
      candleVolumeSell: 39.5,
      candleVolumeTotal: 100,
      candleNativeVolumeBuy: '123456789012345678901234567890',
      candleNativeVolumeSell: '1',
      candleNativeVolumeTotal: '123456789012345678901234567891',
    })
    // One price row per block before summing: a replayed block's unmerged copies
    // must not multiply the candle's volume (the candle rebuild's own rule).
    const candleQuery = queries.find(q => q.includes('FROM price_data.prices'))!
    expect(candleQuery).toMatch(/GROUP BY p\.block_height/)
    expect(candleQuery).toContain('p.asset_id = {asset_id:UInt32}')
  })
})
