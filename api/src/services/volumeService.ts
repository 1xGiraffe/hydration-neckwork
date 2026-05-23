import type { ClickHouseClient } from '../db/client.ts'
import { getAllAssets } from './assetsService.ts'

const VOLUME_CACHE_TTL_MS = 30_000

export interface AssetVolume24h {
  assetId: number
  volumeUsd24h: number
}

let volumeCache: { data: AssetVolume24h[]; fetchedAt: number } | null = null

export async function getVolume24h(client: ClickHouseClient): Promise<AssetVolume24h[]> {
  if (volumeCache && Date.now() - volumeCache.fetchedAt < VOLUME_CACHE_TTL_MS) return volumeCache.data
  const assets = getAllAssets()
  const ids = assets.map(a => a.assetId)
  if (ids.length === 0) return []
  const res = await client.query({
    query: `
      WITH (SELECT max(interval_start) FROM price_data.ohlc_1h) AS head
      SELECT
        asset_id,
        sumMerge(volume_buy_state) + sumMerge(volume_sell_state) AS volume_usd
      FROM price_data.ohlc_1h
      WHERE asset_id IN ({ids:Array(UInt32)})
        AND interval_start > head - INTERVAL 24 HOUR
        AND interval_start <= head
      GROUP BY asset_id
    `,
    query_params: { ids },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ asset_id: number; volume_usd: string }>()
  const out = rows.map(r => ({ assetId: Number(r.asset_id), volumeUsd24h: parseFloat(r.volume_usd) || 0 }))
  out.sort((a, b) => b.volumeUsd24h - a.volumeUsd24h)
  volumeCache = { data: out, fetchedAt: Date.now() }
  return out
}
