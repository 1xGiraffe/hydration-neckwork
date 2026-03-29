import type { ClickHouseClient } from '../db/client.ts'
import type { ApiCandle } from '../types.ts'
import type { OHLCVInterval } from './ohlcvService.ts'
import { toClickHouseDateTime } from './ohlcvService.ts'

/**
 * Interval to ClickHouse time-bucketing expression.
 */
const INTERVAL_BUCKET: Record<OHLCVInterval, string> = {
  '5min':  'toStartOfFiveMinute(b.block_timestamp)',
  '15min': 'toStartOfInterval(b.block_timestamp, toIntervalMinute(15))',
  '30min': 'toStartOfInterval(b.block_timestamp, toIntervalMinute(30))',
  '1h':    'toStartOfHour(b.block_timestamp)',
  '4h':    'toStartOfInterval(b.block_timestamp, toIntervalHour(4))',
  '1d':    'toStartOfDay(b.block_timestamp)',
  '1w':    'toStartOfWeek(b.block_timestamp, 1)',
  '1M':    'toStartOfMonth(b.block_timestamp)',
}

/**
 * Compute cross-pair OHLCV candles directly from the prices table.
 *
 * Joins base and quote prices at the block level, computes the ratio per block,
 * then aggregates into OHLCV buckets. This gives the true high/low of the actual
 * ratio rather than worst-case bounds from independent OHLCV series.
 */
export async function queryCrossPairCandles(
  client: ClickHouseClient,
  options: {
    baseId: number
    quoteId: number
    startTime: Date
    endTime: Date
    interval: OHLCVInterval
  }
): Promise<ApiCandle[]> {
  const bucket = INTERVAL_BUCKET[options.interval]
  const startTime = toClickHouseDateTime(options.startTime)
  const endTime = toClickHouseDateTime(options.endTime)

  const result = await client.query({
    query: `
      SELECT
        ${bucket} AS interval_start,
        argMin(sub.ratio, b.block_timestamp) AS open,
        max(sub.ratio) AS high,
        min(sub.ratio) AS low,
        argMax(sub.ratio, b.block_timestamp) AS close,
        sum(sub.usd_volume_buy) AS volume_buy,
        sum(sub.usd_volume_sell) AS volume_sell,
        sum(sub.usd_volume_buy) + sum(sub.usd_volume_sell) AS volume_total
      FROM (
        SELECT
          base.block_height,
          toFloat64(base.usd_price) / toFloat64(quote.usd_price) AS ratio,
          base.usd_volume_buy,
          base.usd_volume_sell
        FROM price_data.prices base
        INNER JOIN price_data.prices quote ON base.block_height = quote.block_height
        WHERE base.asset_id = {base_id:UInt32}
          AND quote.asset_id = {quote_id:UInt32}
          AND toFloat64(quote.usd_price) > 0
      ) sub
      INNER JOIN price_data.blocks b ON sub.block_height = b.block_height
      WHERE b.block_timestamp >= {start_time:DateTime}
        AND b.block_timestamp < {end_time:DateTime}
      GROUP BY interval_start
      ORDER BY interval_start
    `,
    query_params: {
      base_id: options.baseId,
      quote_id: options.quoteId,
      start_time: startTime,
      end_time: endTime,
    },
    format: 'JSONEachRow',
  })

  const rows = await result.json<{
    interval_start: string
    open: number
    high: number
    low: number
    close: number
    volume_buy: string
    volume_sell: string
    volume_total: string
  }>()

  return rows.map(r => ({
    intervalStart: Math.floor(new Date(r.interval_start.replace(' ', 'T') + 'Z').getTime() / 1000),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volumeBuy: parseFloat(r.volume_buy),
    volumeSell: parseFloat(r.volume_sell),
    volumeTotal: parseFloat(r.volume_total),
  }))
}
