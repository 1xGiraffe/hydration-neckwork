import { describe, expect, it, vi } from 'vitest'
import { createMarketStatsService } from '../src/services/marketStatsService.ts'

const asset = {
  assetId: 0,
  symbol: 'HDX',
  name: 'Hydration',
  decimals: 12,
  isStablecoin: false,
  parachainId: null,
}

function queryResult(rows: unknown[]) {
  return { json: async () => rows }
}

function createService(reportError = vi.fn()) {
  return {
    getMarketStats: createMarketStatsService({
      getAssets: () => [asset],
      getVolume: async () => [{ assetId: 0, volumeUsd24h: 12 }],
      reportError,
    }),
    reportError,
  }
}

describe('getMarketStats concurrency and failures', () => {
  it('shares a cold refresh across concurrent callers', async () => {
    const { getMarketStats } = createService()
    const query = vi.fn(async ({ query: sql }: { query: string }) => {
      if (sql.includes('FROM price_data.blocks')) {
        return queryResult([{
          data_head_str: '2026-07-11 12:00:00',
          head_block: '100',
          block_1h: '90',
          block_24h: '80',
          block_7d: '10',
        }])
      }
      if (sql.includes('FROM price_data.prices')) {
        return queryResult([{
          asset_id: 0,
          current_price: '0.02',
          price_1h_ago: '0.01',
          price_24h_ago: '0.01',
          price_7d_ago: '0.01',
          hops: '1',
        }])
      }
      if (sql.includes('FROM price_data.ohlc_4h')) {
        return queryResult([{ asset_id: 0, interval_start: '2026-07-11 08:00:00', close: '0.019' }])
      }
      throw new Error(`unexpected query: ${sql}`)
    })
    const client = { query } as never

    const [first, second] = await Promise.all([
      getMarketStats(client),
      getMarketStats(client),
    ])

    expect(query).toHaveBeenCalledTimes(3)
    expect(first).toBe(second)
    expect(first[0]).toMatchObject({ price: 0.02, change1h: 1, volumeUsd24h: 12 })
  })

  it('accepts numeric Decimal and integer values from ClickHouse JSONEachRow', async () => {
    const { getMarketStats } = createService()
    const query = vi.fn(async ({ query: sql }: { query: string }) => {
      if (sql.includes('FROM price_data.blocks')) {
        return queryResult([{
          data_head_str: '2026-07-11 12:00:00',
          head_block: 100,
          block_1h: 90,
          block_24h: 80,
          block_7d: 10,
        }])
      }
      if (sql.includes('FROM price_data.prices')) {
        return queryResult([{
          asset_id: 0,
          current_price: 0.02,
          price_1h_ago: 0.01,
          price_24h_ago: 0.016,
          price_7d_ago: 0.01,
          hops: 1,
        }])
      }
      if (sql.includes('FROM price_data.ohlc_4h')) {
        return queryResult([{ asset_id: 0, interval_start: '2026-07-11 08:00:00', close: 0.019 }])
      }
      throw new Error(`unexpected query: ${sql}`)
    })

    const result = await getMarketStats({ query } as never)

    expect(result[0]).toMatchObject({
      price: 0.02,
      change1h: 1,
      change24h: 0.25,
      change7d: 1,
      sparkline: [0.019, 0.02],
      hops: 1,
      volumeUsd24h: 12,
    })
  })

  it('returns an empty cold fallback when the head query fails', async () => {
    const { getMarketStats, reportError } = createService()
    const client = { query: vi.fn().mockRejectedValue(new Error('clickhouse unavailable')) } as never

    await expect(getMarketStats(client)).resolves.toEqual([])
    expect(reportError).toHaveBeenCalledOnce()
  })
})
