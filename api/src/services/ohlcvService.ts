import type { ClickHouseClient } from '../db/client.ts'
import type { OHLCVCandle, ApiCandle } from '../types.ts'
import { chDateTime } from './clickhouseTime.ts'

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

/** Converts a JavaScript Date to a ClickHouse DateTime literal. */
export const toClickHouseDateTime = chDateTime

/**
 * How far back the window's own read looks for the close carried into its first
 * candle: within a monthly partition or two of the interval's table, so the common
 * case costs a granule or two (measured: an unbounded day-candle prefix read ~46k
 * rows on every request, the bounded one 8k).
 */
const PRIOR_LOOKBACK: Record<OHLCVInterval, string> = {
  '5min': 'INTERVAL 1 DAY', '15min': 'INTERVAL 1 DAY', '30min': 'INTERVAL 1 DAY', '1h': 'INTERVAL 1 DAY', '4h': 'INTERVAL 1 DAY',
  '1d': 'INTERVAL 31 DAY', '1w': 'INTERVAL 35 DAY', '1M': 'INTERVAL 62 DAY',
}

const tableOf = (interval: OHLCVInterval) => `price_data.${INTERVAL_VIEW_MAP[interval].replace(/_query$/, '')}`
const newestCloseSql = (table: string, where: string) =>
  `(SELECT argMaxOrNull(c, t) FROM (SELECT interval_start AS t, argMaxMerge(close_state) AS c FROM ${table} WHERE asset_id = {asset_id:UInt32} AND ${where} GROUP BY t))`

/**
 * The close carried into the first candle of a window: the close of the newest
 * candle that STARTS before `start_time` — i.e. the last price written before the
 * first bucket the view can return (a bucket straddling `start_time` is not
 * returned, and no bucket lies between its start and the next one's).
 *
 * This is the bounded first look, read beside the window in one query: the
 * interval's own table over PRIOR_LOOKBACK before `start_time`, on the asset-first
 * primary key, never a key-DESC LIMIT (AGENTS.md). Exact whenever it finds a candle
 * (the newest one before the window is the newest one, period); NULL when the asset
 * printed nothing in the lookback, and only then does priorCloseFallbackSql run.
 */
export function priorCloseSql(interval: OHLCVInterval): string {
  return newestCloseSql(tableOf(interval), `interval_start >= {start_time:DateTime} - ${PRIOR_LOOKBACK[interval]} AND interval_start < {start_time:DateTime}`)
}

/** Intervals that tile the day: no bucket of one of these straddles midnight. */
const SUB_DAY_INTERVALS: ReadonlySet<OHLCVInterval> = new Set(['5min', '15min', '30min', '1h', '4h'])

/**
 * The second look, for an asset that printed nothing in the lookback (a stale feed,
 * or a window starting before the asset's first price): the whole asset prefix
 * before the window, never a key-DESC LIMIT. Sub-day intervals read it from the day
 * candles before the start's own day — exact, because these intervals tile the day:
 * no candle in the 24 h before `start_time` means no price since the start's own
 * midnight either, so the newest day candle before that midnight closes on the last
 * price before the window. Longer intervals read their own table. NULL: the series
 * starts in the window.
 */
export function priorCloseFallbackSql(interval: OHLCVInterval): string {
  return SUB_DAY_INTERVALS.has(interval)
    ? `SELECT ${newestCloseSql('price_data.ohlc_1d', 'interval_start < toStartOfDay({start_time:DateTime})')} AS prior_close`
    : `SELECT ${newestCloseSql(tableOf(interval), 'interval_start < {start_time:DateTime}')} AS prior_close`
}

/** A view row plus the close carried into the window (see priorCloseSql); null at a series start. */
type OHLCVRow = OHLCVCandle & { prior_close: string | null }

export async function queryOHLCV(
  client: ClickHouseClient,
  // `tag` is the calling surface's own SQL marker (the `-- data:…` convention), so
  // sharing this reader does not cost the ability to tell whose query a row in
  // system.query_log belongs to.
  options: { assetId: number; startTime: Date; endTime: Date; interval: OHLCVInterval; tag?: string }
): Promise<OHLCVCandle[]> {
  const viewName = INTERVAL_VIEW_MAP[options.interval]
  const startTime = toClickHouseDateTime(options.startTime)
  const endTime = toClickHouseDateTime(options.endTime)
  const result = await client.query({
    // The carried close rides on every row as one scalar subquery, so the window
    // and the price in force before it are one read (and one query_log row).
    query: `${options.tag ? `-- ${options.tag}\n` : ''}SELECT *, ${priorCloseSql(options.interval)} AS prior_close FROM price_data.${viewName}(asset_id={asset_id:UInt32}, start_time={start_time:DateTime}, end_time={end_time:DateTime})`,
    query_params: {
      asset_id: options.assetId,
      start_time: startTime,
      end_time: endTime,
    },
    // The OHLCV columns are Decimal(38,12). ClickHouse renders decimals as bare JSON
    // numbers by default, so JSON.parse turns each one into a double and OHLCVCandle's
    // `string` fields are a lie at runtime — a 16-17 significant-digit volume can lose
    // its last digit before any consumer sees it. Quoting them makes the declared type
    // true and keeps the exact value available to callers that do integer arithmetic
    // on it; candleToResponse's parseFloat is unaffected.
    clickhouse_settings: { output_format_json_quote_decimals: 1 },
    format: 'JSONEachRow',
  })
  const rows = await result.json<OHLCVRow>()
  const candles = rows.map(({ prior_close: _prior, ...candle }) => candle)
  let prior = rows[0]?.prior_close ?? null
  // Nothing in the bounded lookback: one more read, only for a window that has
  // candles to carry into (see priorCloseFallbackSql).
  if (rows.length && prior == null) {
    const res = await client.query({
      query: `${options.tag ? `-- ${options.tag}:prior\n` : ''}${priorCloseFallbackSql(options.interval)}`,
      query_params: { asset_id: options.assetId, start_time: startTime },
      clickhouse_settings: { output_format_json_quote_decimals: 1 },
      format: 'JSONEachRow',
    })
    prior = (await res.json<{ prior_close: string | null }>())[0]?.prior_close ?? null
  }
  return carryCandleOpens(candles, prior)
}

/* ---------------- the carried open ---------------- */

/** The price fields of a candle as exact decimal text. */
export interface CandlePriceText { open: string; high: string; low: string; close: string }

/** Decimal text as (integer, scale), or null when it is not plain decimal text. */
function parseDecimal(text: string): { v: bigint; scale: number } | null {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text.trim())
  if (!m || (!m[2] && !m[3])) return null
  const frac = m[3] ?? ''
  const v = BigInt(`${m[2] || '0'}${frac}`)
  return { v: m[1] === '-' ? -v : v, scale: frac.length }
}

/** Compares two decimal texts exactly, whatever their scales (`1.5` = `1.500`). */
export function compareDecimalText(a: string, b: string): number {
  const x = parseDecimal(a), y = parseDecimal(b)
  if (!x || !y) {
    const d = Number(a) - Number(b)
    return d > 0 ? 1 : d < 0 ? -1 : 0
  }
  const scale = Math.max(x.scale, y.scale)
  const xv = x.v * 10n ** BigInt(scale - x.scale), yv = y.v * 10n ** BigInt(scale - y.scale)
  return xv > yv ? 1 : xv < yv ? -1 : 0
}

/**
 * THE CARRY RULE, one definition for every candle surface.
 *
 * Prices are written only in blocks where they CHANGE, so a bucket's stored open is
 * its first change, not the price in force when it opened: a bucket whose first
 * change came 42 s in opened at the previous close all the same (apyUSD,
 * 2026-10-05 19:00: stored open 1.409095, price at 19:00:00 still 1.407545). Every
 * candle therefore opens at the close of the candle before it in the same series —
 * across empty buckets too, since nothing changed in between — and only the first
 * candle of a series with no earlier price keeps its own first price. `high` and
 * `low` widen to include that open, so the body never leaves the wick.
 *
 * `candles` are one series in ascending bucket order; `priorClose` is the close in
 * force before the first of them (null/undefined at a series start). Applied once,
 * at read time — stored candles are not rewritten — and idempotent: carrying an
 * already-carried series with the same prior changes nothing. A non-positive close
 * (a defective price row) is never carried. Values stay the exact text they were.
 */
export function carryCandleOpens<T extends CandlePriceText>(candles: readonly T[], priorClose?: string | null): T[] {
  let prev = priorClose ?? null
  return candles.map(c => {
    const carried = prev != null && compareDecimalText(prev, '0') > 0 ? prev : null
    prev = c.close
    if (carried == null) return c
    const high = compareDecimalText(carried, c.high) > 0 ? carried : c.high
    const low = compareDecimalText(carried, c.low) < 0 ? carried : c.low
    if (carried === c.open && high === c.high && low === c.low) return c
    return { ...c, open: carried, high, low }
  })
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
