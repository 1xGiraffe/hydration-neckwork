import type { ClickHouseClient } from '../db/client.ts'
import type { AssetMarketStats } from '../types.ts'
import { getAllAssets } from './assetsService.ts'
import { toClickHouseDateTime } from './ohlcvService.ts'

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

  const cutoff1h = new Date(dataHead.getTime() - 60 * 60 * 1000)
  const cutoff24h = new Date(dataHead.getTime() - 24 * 60 * 60 * 1000)
  const cutoff7d = new Date(dataHead.getTime() - 7 * 24 * 60 * 60 * 1000)

  const cutoff_1h = toClickHouseDateTime(cutoff1h)
  const cutoff_24h = toClickHouseDateTime(cutoff24h)
  const cutoff_7d = toClickHouseDateTime(cutoff7d)
  const start_7d = cutoff_7d

  try {
    const [pricesResult, sparklineResult] = await Promise.all([
      client.query({
        query: `
          SELECT
            p.asset_id,
            argMax(p.usd_price, b.block_timestamp) AS current_price,
            argMaxIf(p.usd_price, b.block_timestamp, b.block_timestamp <= {cutoff_1h:DateTime}) AS price_1h_ago,
            argMaxIf(p.usd_price, b.block_timestamp, b.block_timestamp <= {cutoff_24h:DateTime}) AS price_24h_ago,
            argMaxIf(p.usd_price, b.block_timestamp, b.block_timestamp <= {cutoff_7d:DateTime}) AS price_7d_ago,
            argMax(p.hops, b.block_timestamp) AS hops
          FROM price_data.prices p FINAL
          INNER JOIN price_data.blocks b ON p.block_height = b.block_height
          WHERE p.asset_id IN ({asset_ids:Array(UInt32)})
          GROUP BY p.asset_id
        `,
        query_params: { asset_ids: assetIds, cutoff_1h, cutoff_24h, cutoff_7d },
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
    ])

    const priceRows = await pricesResult.json<PriceRow>()
    const sparklineRows = await sparklineResult.json<SparklineRow>()

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
