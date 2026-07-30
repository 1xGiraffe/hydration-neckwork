import type { ClickHouseClient } from '../db/client.ts'
import type { OHLCVCandle, ApiCandle } from '../types.ts'

/**
 * Maps interval keys to ClickHouse parameterized query view names.
 * Capital M = month; lowercase min = minutes.
 */
export const INTERVAL_VIEW_MAP = {
  '5min':  'ohlc_5min_query',
  '15min': 'ohlc_15min_query',
  '30min': 'ohlc_30min_query',
  '1h':    'ohlc_1h_query',
  '4h':    'ohlc_4h_query',
  '1d':    'ohlc_1d_query',
  '1w':    'ohlc_1w_query',
  '1M':    'ohlc_1m_query',
} as const

export type OHLCVInterval = keyof typeof INTERVAL_VIEW_MAP

/**
 * Converts JavaScript Date to ClickHouse DateTime format.
 * Format: 'YYYY-MM-DD HH:MM:SS'
 */
export function toClickHouseDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}

export async function queryOHLCV(
  client: ClickHouseClient,
  options: { assetId: number; startTime: Date; endTime: Date; interval: OHLCVInterval }
): Promise<OHLCVCandle[]> {
  const viewName = INTERVAL_VIEW_MAP[options.interval]
  const startTime = toClickHouseDateTime(options.startTime)
  const endTime = toClickHouseDateTime(options.endTime)
  const result = await client.query({
    query: `SELECT * FROM price_data.${viewName}(asset_id={asset_id:UInt32}, start_time={start_time:DateTime}, end_time={end_time:DateTime})`,
    query_params: {
      asset_id: options.assetId,
      start_time: startTime,
      end_time: endTime,
    },
    format: 'JSONEachRow',
  })
  return result.json<OHLCVCandle>()
}

/**
 * Convert ClickHouse OHLCV candle (Decimal128 strings) to API response format (numbers).
 * This is the Decimal128 precision boundary — parseFloat is safe here because
 * we are converting to JSON-serializable numbers at the final step.
 */
export function candleToResponse(c: OHLCVCandle): ApiCandle {
  return {
    intervalStart: Math.floor(new Date(c.interval_start.replace(' ', 'T') + 'Z').getTime() / 1000),
    open:        parseFloat(c.open),
    high:        parseFloat(c.high),
    low:         parseFloat(c.low),
    close:       parseFloat(c.close),
    volumeBuy:   parseFloat(c.volume_buy),
    volumeSell:  parseFloat(c.volume_sell),
    volumeTotal: parseFloat(c.volume_total),
  }
}
