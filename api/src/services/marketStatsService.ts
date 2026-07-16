import type { ClickHouseClient } from '../db/client.ts'
import type { AssetMarketStats } from '../types.ts'
import { getAllAssets } from './assetsService.ts'
import { toClickHouseDateTime } from './ohlcvService.ts'
import { getVolume24h } from './volumeService.ts'

const CACHE_TTL_MS = 45_000

type NumericCell = string | number | null | undefined

function finiteNumber(value: NumericCell): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Calculates percentage change between current and reference price.
 * Returns a decimal ratio (e.g. 0.05 = +5%).
 * Returns null if either value is invalid or the reference price is zero.
 */
export function calcChange(current: NumericCell, ref: NumericCell): number | null {
  const refVal = finiteNumber(ref)
  const curVal = finiteNumber(current)
  if (refVal === null || refVal === 0 || curVal === null) return null
  return (curVal - refVal) / refVal
}

/**
 * Downsamples an array of closes to exactly targetPoints, evenly spanning the
 * source and including both endpoints (except targetPoints=1, which returns the
 * most recent close).
 * If input length <= targetPoints, returns the array as-is.
 */
export function downsample(closes: number[], targetPoints: number): number[] {
  if (!Number.isSafeInteger(targetPoints) || targetPoints < 0) {
    throw new RangeError('targetPoints must be a non-negative integer')
  }
  if (targetPoints === 0 || closes.length === 0) return []
  if (closes.length <= targetPoints) return closes
  if (targetPoints === 1) return [closes[closes.length - 1]]
  const lastIndex = closes.length - 1
  return Array.from({ length: targetPoints }, (_, index) =>
    closes[Math.round(index * lastIndex / (targetPoints - 1))])
}

interface PriceRow {
  asset_id: number | string
  current_price: string | number
  price_1h_ago: string | number
  price_24h_ago: string | number
  price_7d_ago: string | number
  hops: string | number
}

interface SparklineRow {
  asset_id: number | string
  interval_start: string
  close: string | number
}

interface MarketStatsDependencies {
  getAssets?: typeof getAllAssets
  getVolume?: typeof getVolume24h
  reportError?: (error: unknown) => void
}

export function createMarketStatsService(dependencies: MarketStatsDependencies = {}) {
  const getAssets = dependencies.getAssets ?? getAllAssets
  const getVolume = dependencies.getVolume ?? getVolume24h
  const reportError = dependencies.reportError
    ?? ((error: unknown) => console.error('[MarketStats] ClickHouse query failed:', error))
  let cache: { data: AssetMarketStats[]; fetchedAt: number } | null = null
  let inflight: Promise<AssetMarketStats[]> | null = null

  return async (client: ClickHouseClient): Promise<AssetMarketStats[]> => {
    if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.data
    if (inflight) return inflight

    const assets = getAssets()
    if (assets.length === 0) return []

    const request = loadMarketStats(client, assets, getVolume)
      .then(data => {
        cache = { data, fetchedAt: Date.now() }
        return data
      })
      .catch(error => {
        reportError(error)
        return cache?.data ?? []
      })
      .finally(() => {
        if (inflight === request) inflight = null
      })
    inflight = request
    return request
  }
}

export const getMarketStats = createMarketStatsService()

async function loadMarketStats(
  client: ClickHouseClient,
  assets: ReturnType<typeof getAllAssets>,
  getVolume: typeof getVolume24h,
): Promise<AssetMarketStats[]> {
  const assetIds = assets.map(a => a.assetId)

  // Anchor "now" to the latest indexed block timestamp so stats stay correct when
  // indexing lags real time. In the same scan, resolve the 1h/24h/7d wall-clock
  // cutoffs to the latest block at/<= each cutoff (Hydration block times vary, so
  // a fixed block-count offset would land on the wrong reference). maxIf returns 0
  // when no block is old enough (e.g. <7d of history during an active backfill).
  const headResult = await client.query({
    query: `
      WITH (SELECT max(block_timestamp) FROM price_data.blocks) AS data_head
      SELECT
        toString(data_head) AS data_head_str,
        max(block_height) AS head_block,
        maxIf(block_height, block_timestamp <= data_head - INTERVAL 1 HOUR)   AS block_1h,
        maxIf(block_height, block_timestamp <= data_head - INTERVAL 24 HOUR)  AS block_24h,
        maxIf(block_height, block_timestamp <= data_head - INTERVAL 168 HOUR) AS block_7d
      FROM price_data.blocks
    `,
    format: 'JSONEachRow',
  })
  const headRows = await headResult.json<{
    data_head_str: string
    head_block: string | number
    block_1h: string | number
    block_24h: string | number
    block_7d: string | number
  }>()
  const headRow = headRows[0]
  const parsedDataHead = headRow?.data_head_str ? new Date(`${headRow.data_head_str}Z`) : null
  const dataHead = parsedDataHead && Number.isFinite(parsedDataHead.getTime()) ? parsedDataHead : new Date()
  const uintValue = (value: string | number | undefined): number => {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
  }
  const headBlock = uintValue(headRow?.head_block)
  const block1h = uintValue(headRow?.block_1h)
  const block24h = uintValue(headRow?.block_24h)
  const block7d = uintValue(headRow?.block_7d)

  const cutoff7d = new Date(dataHead.getTime() - 7 * 24 * 60 * 60 * 1000)
  const start7d = toClickHouseDateTime(cutoff7d)

  // Bound the prices scan for performance, computing the lower bound in JS to avoid
  // UInt32 underflow if we did the subtraction in SQL. When <7d of history exists yet
  // (block7d === 0), fall back to a fixed window off the head — accuracy is unaffected
  // because the reference blocks themselves don't exist yet.
  const SCAN_BUFFER = 1000
  const scanFrom = block7d > 0
    ? Math.max(block7d - SCAN_BUFFER, 0)
    : Math.max(headBlock - 90_000, 0)

  const [pricesResult, sparklineResult, volumes] = await Promise.all([
    client.query({
      query: `
          SELECT
            asset_id,
            argMax(usd_price, block_height) AS current_price,
            argMaxIf(usd_price, block_height, block_height <= {block_1h:UInt32}) AS price_1h_ago,
            argMaxIf(usd_price, block_height, block_height <= {block_24h:UInt32}) AS price_24h_ago,
            argMaxIf(usd_price, block_height, block_height <= {block_7d:UInt32}) AS price_7d_ago,
            argMax(hops, block_height) AS hops
          FROM price_data.prices
          WHERE asset_id IN ({asset_ids:Array(UInt32)})
            AND block_height >= {scan_from:UInt32}
          GROUP BY asset_id
        `,
      query_params: {
        asset_ids: assetIds,
        block_1h: block1h,
        block_24h: block24h,
        block_7d: block7d,
        scan_from: scanFrom,
      },
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
          SELECT
            asset_id,
            interval_start,
            argMaxMerge(close_state) AS close
          FROM price_data.ohlc_4h
          WHERE asset_id IN ({asset_ids:Array(UInt32)})
            AND interval_start >= {start_7d:DateTime}
          GROUP BY asset_id, interval_start
          ORDER BY asset_id ASC, interval_start ASC
        `,
      query_params: { asset_ids: assetIds, start_7d: start7d },
      format: 'JSONEachRow',
    }),
    getVolume(client),
  ])

  const priceRows = await pricesResult.json<PriceRow>()
  const sparklineRows = await sparklineResult.json<SparklineRow>()
  const volumeMap = new Map(volumes.map(v => [v.assetId, v.volumeUsd24h]))

  const priceMap = new Map<number, PriceRow>()
  for (const row of priceRows) priceMap.set(Number(row.asset_id), row)

  const sparklineMap = new Map<number, SparklineRow[]>()
  for (const row of sparklineRows) {
    const id = Number(row.asset_id)
    const rows = sparklineMap.get(id) ?? []
    rows.push(row)
    sparklineMap.set(id, rows)
  }

  return assets.map(asset => {
    const priceRow = priceMap.get(asset.assetId)
    const sparkRows = sparklineMap.get(asset.assetId) ?? []

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

    const currentPrice = finiteNumber(priceRow.current_price)
    const price = currentPrice !== null && currentPrice !== 0 ? currentPrice : null

    // 7-day sparkline from 4h candles (~42 buckets). Anchor the end to the live
    // current price so the line always terminates at the latest (open) candle.
    const sparklineCloses = downsample(
      sparkRows
        .map(row => finiteNumber(row.close))
        .filter((value): value is number => value !== null),
      42,
    )
    if (price !== null && sparklineCloses[sparklineCloses.length - 1] !== price) {
      sparklineCloses.push(price)
    }

    const hops = finiteNumber(priceRow.hops)
    return {
      assetId: asset.assetId,
      symbol: asset.symbol,
      price,
      change1h: calcChange(priceRow.current_price, priceRow.price_1h_ago),
      change24h: calcChange(priceRow.current_price, priceRow.price_24h_ago),
      change7d: calcChange(priceRow.current_price, priceRow.price_7d_ago),
      sparkline: sparklineCloses,
      hops: hops !== null && hops >= 0 && Number.isSafeInteger(hops) ? hops : null,
      volumeUsd24h: volumeMap.get(asset.assetId) ?? 0,
    }
  })
}
