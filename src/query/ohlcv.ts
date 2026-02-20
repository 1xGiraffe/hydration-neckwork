import type { ClickHouseClient } from '../db/client.js'

/**
 * OHLCV candle data structure returned from ClickHouse query views.
 * All numeric values are returned as strings to preserve Decimal128(12) precision.
 */
export interface OHLCVCandle {
  asset_id: number
  interval_start: string // ISO datetime from ClickHouse
  open: string // Decimal128(12) as string
  high: string
  low: string
  close: string
  volume_buy: string
  volume_sell: string
  volume_total: string
}

/**
 * Available OHLCV time intervals matching ClickHouse materialized views
 */
export type OHLCVInterval = '5min' | '15min' | '1h' | '4h' | '1d'

/**
 * Options for querying OHLCV candle data
 */
export interface QueryOHLCVOptions {
  asset_id: number
  start_time: Date
  end_time: Date
  interval: OHLCVInterval
}

/**
 * Converts JavaScript Date to ClickHouse DateTime format.
 * Format: 'YYYY-MM-DD HH:MM:SS' (no T separator, no milliseconds)
 */
export function toClickHouseDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}

/**
 * Maps OHLCVInterval values to ClickHouse parameterized view names.
 * These views were created in Phase 11 (012_ohlc_query_views.sql).
 */
export const INTERVAL_VIEW_MAP: Record<OHLCVInterval, string> = {
  '5min': 'ohlc_5min_query',
  '15min': 'ohlc_15min_query',
  '1h': 'ohlc_1h_query',
  '4h': 'ohlc_4h_query',
  '1d': 'ohlc_1d_query',
}

/**
 * Query OHLCV candle data from ClickHouse parameterized views.
 *
 * @param client - ClickHouse client instance
 * @param options - Query parameters (asset_id, time range, interval)
 * @returns Array of OHLCV candles ordered by interval_start ASC
 *
 * @example
 * const candles = await queryOHLCV(client, {
 *   asset_id: 5,
 *   start_time: new Date('2024-01-01'),
 *   end_time: new Date('2024-01-07'),
 *   interval: '5min'
 * });
 */
export async function queryOHLCV(
  client: ClickHouseClient,
  options: QueryOHLCVOptions
): Promise<OHLCVCandle[]> {
  const viewName = INTERVAL_VIEW_MAP[options.interval]

  // View name comes from fixed constant map (safe for string interpolation)
  // User-controlled values passed via query_params (parameterized injection)
  const result = await client.query({
    query: `SELECT * FROM price_data.${viewName}`,
    query_params: {
      asset_id: options.asset_id,
      start_time: toClickHouseDateTime(options.start_time),
      end_time: toClickHouseDateTime(options.end_time),
    },
    format: 'JSONEachRow',
  })

  return result.json<OHLCVCandle>()
}

/**
 * Query 5-minute OHLCV candles
 */
export async function query5MinOHLCV(
  client: ClickHouseClient,
  assetId: number,
  startTime: Date,
  endTime: Date
): Promise<OHLCVCandle[]> {
  return queryOHLCV(client, {
    asset_id: assetId,
    start_time: startTime,
    end_time: endTime,
    interval: '5min',
  })
}

/**
 * Query 15-minute OHLCV candles
 */
export async function query15MinOHLCV(
  client: ClickHouseClient,
  assetId: number,
  startTime: Date,
  endTime: Date
): Promise<OHLCVCandle[]> {
  return queryOHLCV(client, {
    asset_id: assetId,
    start_time: startTime,
    end_time: endTime,
    interval: '15min',
  })
}

/**
 * Query 1-hour OHLCV candles
 */
export async function query1HourOHLCV(
  client: ClickHouseClient,
  assetId: number,
  startTime: Date,
  endTime: Date
): Promise<OHLCVCandle[]> {
  return queryOHLCV(client, {
    asset_id: assetId,
    start_time: startTime,
    end_time: endTime,
    interval: '1h',
  })
}

/**
 * Query 4-hour OHLCV candles
 */
export async function query4HourOHLCV(
  client: ClickHouseClient,
  assetId: number,
  startTime: Date,
  endTime: Date
): Promise<OHLCVCandle[]> {
  return queryOHLCV(client, {
    asset_id: assetId,
    start_time: startTime,
    end_time: endTime,
    interval: '4h',
  })
}

/**
 * Query 1-day OHLCV candles
 */
export async function query1DayOHLCV(
  client: ClickHouseClient,
  assetId: number,
  startTime: Date,
  endTime: Date
): Promise<OHLCVCandle[]> {
  return queryOHLCV(client, {
    asset_id: assetId,
    start_time: startTime,
    end_time: endTime,
    interval: '1d',
  })
}
