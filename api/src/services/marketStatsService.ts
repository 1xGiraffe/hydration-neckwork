import type { ClickHouseClient } from '../db/client.ts'
import type { AssetMarketStats } from '../types.ts'
import { getAllAssets } from './assetsService.ts'
import { toClickHouseDateTime } from './ohlcvService.ts'
import { getVolume24h } from './volumeService.ts'

const CACHE_TTL_MS = 45_000

let cache: { data: AssetMarketStats[]; fetchedAt: number } | null = null

/**
 * Calculates percentage change between current and reference price.
 * Returns a decimal ratio (e.g. 0.05 = +5%).
 * Returns null if the reference price is falsy or zero.
 */
export function calcChange(current: string, ref: string): number | null {
  const refVal = parseFloat(ref)
  if (!ref || !refVal || refVal === 0) return null
  const curVal = parseFloat(current)
  return (curVal - refVal) / refVal
}

/**
 * Downsamples an array of closes to approximately targetPoints.
 * Always includes the last element (most recent close).
 * If input length <= targetPoints, returns the array as-is.
 */
export function downsample(closes: number[], targetPoints: number): number[] {
  if (closes.length <= targetPoints) return closes
  const step = Math.ceil(closes.length / targetPoints)
  const result: number[] = []
  for (let i = 0; i < closes.length; i++) {
    if (i % step === 0) {
      result.push(closes[i])
    }
  }
  // Ensure last element is always included — replace last entry if needed
  const lastVal = closes[closes.length - 1]
  if (result[result.length - 1] !== lastVal) {
    result[result.length - 1] = lastVal
  }
  return result
}

interface PriceRow {
  asset_id: number
  current_price: string
  price_1h_ago: string
  price_24h_ago: string
  price_7d_ago: string
  hops: string
}

interface SparklineRow {
  asset_id: number
  interval_start: string
  close: string
}

export async function getMarketStats(client: ClickHouseClient): Promise<AssetMarketStats[]> {
  // Cache check
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data
  }

  const assets = getAllAssets()
  if (assets.length === 0) return []

  const assetIds = assets.map(a => a.assetId)

  // Use latest indexed timestamp as "now" so stats work even when data lags behind real time
  const maxTsResult = await client.query({
    query: `SELECT max(block_timestamp) AS max_ts FROM price_data.blocks`,
    format: 'JSONEachRow',
  })
  const maxTsRows = await maxTsResult.json<{ max_ts: string }>()
  const dataHead = maxTsRows.length > 0 && maxTsRows[0].max_ts
    ? new Date(maxTsRows[0].max_ts + 'Z')
    : new Date()

  const cutoff7d = new Date(dataHead.getTime() - 7 * 24 * 60 * 60 * 1000)
  const start_7d = toClickHouseDateTime(cutoff7d)

  // Block-height based cutoffs assume ~12-second blocks. This avoids the expensive
  // JOIN against price_data.blocks for timestamp resolution.
  const BLOCKS_1H = 300
  const BLOCKS_24H = 7200
  const BLOCKS_7D = 50400
  const LOOKBACK_BLOCKS = BLOCKS_7D + 600  // small buffer for sparse-pricing assets

  try {
    const [pricesResult, sparklineResult, volumes] = await Promise.all([
      client.query({
        query: `
          WITH (SELECT max(block_height) FROM price_data.blocks) AS head
          SELECT
            asset_id,
            argMax(usd_price, block_height) AS current_price,
            argMaxIf(usd_price, block_height, block_height <= head - {blocks_1h:UInt32}) AS price_1h_ago,
            argMaxIf(usd_price, block_height, block_height <= head - {blocks_24h:UInt32}) AS price_24h_ago,
            argMaxIf(usd_price, block_height, block_height <= head - {blocks_7d:UInt32}) AS price_7d_ago,
            argMax(hops, block_height) AS hops
          FROM price_data.prices
          WHERE asset_id IN ({asset_ids:Array(UInt32)})
            AND block_height >= head - {lookback:UInt32}
          GROUP BY asset_id
        `,
        query_params: {
          asset_ids: assetIds,
          blocks_1h: BLOCKS_1H,
          blocks_24h: BLOCKS_24H,
          blocks_7d: BLOCKS_7D,
          lookback: LOOKBACK_BLOCKS,
        },
        format: 'JSONEachRow',
      }),
      client.query({
        query: `
          SELECT
            asset_id,
            interval_start,
            argMaxMerge(close_state) AS close
          FROM price_data.ohlc_1h
          WHERE asset_id IN ({asset_ids:Array(UInt32)})
            AND interval_start >= {start_7d:DateTime}
          GROUP BY asset_id, interval_start
          ORDER BY asset_id ASC, interval_start ASC
        `,
        query_params: { asset_ids: assetIds, start_7d },
        format: 'JSONEachRow',
      }),
      getVolume24h(client),
    ])

    const priceRows = await pricesResult.json<PriceRow>()
    const sparklineRows = await sparklineResult.json<SparklineRow>()
    const volumeMap = new Map(volumes.map(v => [v.assetId, v.volumeUsd24h]))

    // Build price map keyed by asset_id
    const priceMap = new Map<number, PriceRow>()
    for (const row of priceRows) {
      priceMap.set(Number(row.asset_id), row)
    }

    // Group sparkline rows by asset_id
    const sparklineMap = new Map<number, SparklineRow[]>()
    for (const row of sparklineRows) {
      const id = Number(row.asset_id)
      if (!sparklineMap.has(id)) sparklineMap.set(id, [])
      sparklineMap.get(id)!.push(row)
    }

    // Build results for each asset
    const data: AssetMarketStats[] = assets.map(asset => {
      const priceRow = priceMap.get(asset.assetId)
      const sparkRows = sparklineMap.get(asset.assetId) ?? []
      const sparklineCloses = downsample(sparkRows.map(r => parseFloat(r.close)), 42)

      if (!priceRow) {
        return {
          assetId: asset.assetId,
          symbol: asset.symbol,
          price: null,
          change1h: null,
          change24h: null,
          change7d: null,
          sparkline: [],
          hops: null,
          volumeUsd24h: volumeMap.get(asset.assetId) ?? 0,
        }
      }

      const currentPrice = parseFloat(priceRow.current_price)
      const price = (!priceRow.current_price || priceRow.current_price === '0' || currentPrice === 0)
        ? null
        : currentPrice

      return {
        assetId: asset.assetId,
        symbol: asset.symbol,
        price,
        change1h: calcChange(priceRow.current_price, priceRow.price_1h_ago),
        change24h: calcChange(priceRow.current_price, priceRow.price_24h_ago),
        change7d: calcChange(priceRow.current_price, priceRow.price_7d_ago),
        sparkline: sparklineCloses,
        hops: priceRow ? parseInt(priceRow.hops, 10) : null,
        volumeUsd24h: volumeMap.get(asset.assetId) ?? 0,
      }
    })

    cache = { data, fetchedAt: Date.now() }
    return data
  } catch (err) {
    console.error('[MarketStats] ClickHouse query failed:', err)
    if (cache) return cache.data
    return []
  }
}
