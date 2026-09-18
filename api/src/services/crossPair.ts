import type { ClickHouseClient } from '../db/client.ts'
import type { OHLCVInterval } from './ohlcvService.ts'
import { toClickHouseDateTime } from './ohlcvService.ts'

/**
 * Cross-pair OHLC, computed from the per-block ratio.
 *
 * The one place a pair's candles are derived, for every surface that serves them.
 *
 * WHY PER BLOCK, and not from the two assets' stored candles: min and max do not
 * survive division. `ohlc_*` aggregates each ASSET separately, so a bucket keeps
 * `max(base)` and `min(quote)` without any record of which observation went with
 * which — and `max(base)/min(quote)` is a rate formed from two different moments,
 * one that need never have existed. Given base 10→12 and quote 1→2 across two
 * blocks, the ratio truly ranged 10→6, while the stored aggregates imply 12/1 = 12
 * and 10/2 = 5. The error is not small and it is not symmetric: it only ever
 * widens the candle, without bound on a pair whose ratio is near-constant (BIL
 * quoted in HOLLAR measured a 0.0134 % hourly wick against a true range of zero).
 * Joining the legs at the block restores the pairing, which is the only way to get
 * a high and a low that were really quoted.
 *
 * WHY THE BUCKET COMES FROM `blocks`: `prices.block_timestamp` is declared
 * `DEFAULT toDateTime(0)` and is only populated from block 13,067,140
 * (2026-07-10) on, when the writer began refusing a price without one. 89 % of
 * the table's 184 M rows still carry the default, so bucketing or filtering on
 * that column silently drops nearly all history — measured on one 50 k-block
 * slice of HDX/DOT, 486 of 16,113 paired blocks survived it. `blocks` is the
 * only trustworthy source of a block's time, which is also why the `ohlc_*`
 * repair path joins it. Nothing here may read `prices.block_timestamp`.
 *
 * COST is bounded by four things, none of them optional:
 *  - the block range, resolved once and applied to `prices.block_height`, its sort
 *    key. Filtering on `block_timestamp` alone reads every row the asset ever had:
 *    measured on a 2 h window, 3.65 M rows against 78 k with the bound. It is also
 *    the window itself: block time is strictly monotonic in height (0 inversions
 *    over all 14.7 M blocks), so the height bound IS the time bound, and no
 *    timestamp predicate on `prices` is needed on top of it.
 *  - resolving the bucket through a GRID — one row per candle — rather than
 *    joining `blocks` per block. The per-block join hashes all 14.7 M blocks and
 *    peaks at 1.44 GiB over full history, above this module's own ceiling; the
 *    grid is at most one row per candle the route will return, so ASOF binary-
 *    searches a handful of rows: same candles to the digit, 746 MiB and 3.43 s.
 *  - MAX_CROSS_BLOCKS and the explicit per-query ceilings below, so a window wider
 *    than anything the chain holds is refused rather than read.
 */

/** Digits kept on the quotient — enough for a ratio of two 12-decimal prices. */
export const CROSS_SCALE = 18

/**
 * The per-block ratio: `base / quote` at CROSS_SCALE digits.
 *
 * Widening the DIVIDEND to CROSS_SCALE first is what lets the plain operator
 * stand in for `divideDecimal(base, quote, CROSS_SCALE)`. A decimal quotient takes
 * the dividend's scale, so dividing the raw Decimal(38,12) columns would answer at
 * 12 digits and quietly drop six; cast to scale 18 the operator computes
 * `base_raw × 10^18 ÷ quote_raw`, which is `divideDecimal`'s own integer
 * expression, truncated toward zero the same way. It matters because the
 * adaptive-scale function is a per-row path where the operator is vectorised:
 * MEASURED 2.99 → 0.52 CPU-seconds on the weekly HDX cross over 2.66 M blocks.
 *
 * Proved, not argued: 29.1 M block-paired ratios across six windows from 2023-01
 * to the live head produced 0 mismatches, identical sums, identical
 * `sum(cityHash64(toString(…)))` and the same `Decimal(76,18)` type. Prices are
 * never negative here, so the truncation direction was pinned separately —
 * `-1/3` gives `-0.333333333333333333` under both forms.
 *
 * `quote.usd_price > 0` in the WHERE is load-bearing for this: it is what keeps a
 * zero divisor out of either form.
 */
const crossRatioSql = `(toDecimal256(base.usd_price, ${CROSS_SCALE}) / quote.usd_price)`

/**
 * The widest block span a single cross request may read. Full chain history is
 * ~14.7 M blocks and costs 81 MiB, so this leaves roughly a doubling of headroom
 * and refuses only a window no data could fill. `max_memory_usage` below is the
 * hard backstop; this is the one that gives the caller a sentence instead of an
 * error.
 */
export const MAX_CROSS_BLOCKS = 25_000_000

/** Thrown when a request asks for a wider block span than MAX_CROSS_BLOCKS. */
export class CrossWindowTooWideError extends Error {
  constructor(readonly blocks: number) {
    super(`the requested window spans ${blocks} blocks; at most ${MAX_CROSS_BLOCKS} are read per cross-pair request`)
    this.name = 'CrossWindowTooWideError'
  }
}

/** Interval to the ClickHouse bucketing expression over a block's own timestamp. */
const INTERVAL_BUCKET: Record<OHLCVInterval, string> = {
  '5min': 'toStartOfFiveMinute(block_timestamp)',
  '15min': 'toStartOfInterval(block_timestamp, toIntervalMinute(15))',
  '30min': 'toStartOfInterval(block_timestamp, toIntervalMinute(30))',
  '1h': 'toStartOfHour(block_timestamp)',
  '4h': 'toStartOfInterval(block_timestamp, toIntervalHour(4))',
  '1d': 'toStartOfDay(block_timestamp)',
  '1w': 'toStartOfWeek(block_timestamp, 1)',
  '1M': 'toStartOfMonth(block_timestamp)',
}

/**
 * One bucket's exact cross rate. Every price field is decimal TEXT at CROSS_SCALE
 * digits, never a double: the division happens in ClickHouse's decimal arithmetic
 * and the client quotes the result, so the value a caller receives is the value
 * that was computed. Callers that publish numbers narrow at their own edge.
 */
export interface CrossCandle {
  /** The bucket's opening instant, unix seconds. */
  intervalStart: number
  open: string
  high: string
  low: string
  close: string
  volumeBuy: string
  volumeSell: string
  volumeTotal: string
}

interface CrossRow {
  interval_start: string
  open: string
  high: string
  low: string
  close: string
  volume_buy: string
  volume_sell: string
  volume_total: string
}

/**
 * The block range a time window covers. Resolved separately so the main read can
 * prune on `prices`' sort key, and so a window that lies outside the chain's own
 * history is answered without reading `prices` at all.
 */
async function blockRange(
  client: ClickHouseClient,
  startTime: string,
  endTime: string,
): Promise<{ from: number; to: number } | null> {
  const res = await client.query({
    query: `SELECT min(block_height) AS from_block, max(block_height) AS to_block
            FROM price_data.blocks
            WHERE block_timestamp >= {start_time:DateTime} AND block_timestamp < {end_time:DateTime}`,
    query_params: { start_time: startTime, end_time: endTime },
    format: 'JSONEachRow',
  })
  const row = (await res.json<{ from_block: number | null; to_block: number | null }>())[0]
  if (row?.from_block == null || row.to_block == null || row.to_block < row.from_block) return null
  return { from: Number(row.from_block), to: Number(row.to_block) }
}

export async function queryCrossPairCandles(
  client: ClickHouseClient,
  options: { baseId: number; quoteId: number; startTime: Date; endTime: Date; interval: OHLCVInterval },
): Promise<CrossCandle[]> {
  const startTime = toClickHouseDateTime(options.startTime)
  const endTime = toClickHouseDateTime(options.endTime)
  const range = await blockRange(client, startTime, endTime)
  // A window the chain has no blocks in has no candles in it either — an empty
  // series, the same answer a pre-listing window gets, not an error.
  if (range == null) return []
  const blocks = range.to - range.from + 1
  if (blocks > MAX_CROSS_BLOCKS) throw new CrossWindowTooWideError(blocks)

  const result = await client.query({
    query: `
      WITH grid AS (
        -- One row per candle: the bucket, and the first block that falls in it.
        -- Block time is strictly monotonic in height, so the ASOF match below —
        -- the greatest bucket whose first block is at or before this one — names
        -- exactly the bucket the block belongs to.
        SELECT
          ${INTERVAL_BUCKET[options.interval]} AS bucket,
          {base_id:UInt32} AS anchor,
          min(block_height) AS bucket_first_block
        FROM price_data.blocks
        WHERE block_height BETWEEN {from_block:UInt32} AND {to_block:UInt32}
        GROUP BY bucket
      )
      SELECT
        g.bucket AS interval_start,
        argMin(${crossRatioSql}, base.block_height) AS open,
        max(${crossRatioSql}) AS high,
        min(${crossRatioSql}) AS low,
        argMax(${crossRatioSql}, base.block_height) AS close,
        sum(base.usd_volume_buy) AS volume_buy,
        sum(base.usd_volume_sell) AS volume_sell,
        sum(base.usd_volume_buy) + sum(base.usd_volume_sell) AS volume_total
      FROM price_data.prices AS base
      INNER JOIN price_data.prices AS quote ON base.block_height = quote.block_height
      -- ASOF needs one equality to key on; \`anchor\` is the base asset on both
      -- sides, constant, so the inequality does all the work.
      ASOF INNER JOIN grid AS g
        ON base.asset_id = g.anchor AND base.block_height >= g.bucket_first_block
      WHERE base.asset_id = {base_id:UInt32}
        AND quote.asset_id = {quote_id:UInt32}
        AND base.block_height BETWEEN {from_block:UInt32} AND {to_block:UInt32}
        AND quote.block_height BETWEEN {from_block:UInt32} AND {to_block:UInt32}
        AND quote.usd_price > 0
      GROUP BY interval_start
      -- A bucket straddling the window start would otherwise be emitted under its
      -- full bucket timestamp while holding only the part inside the window, so its
      -- open/low/volume would depend on the request. The USD candle views drop that
      -- leading partial bucket; match them so every path answers one request with
      -- the same first candle.
      HAVING interval_start >= {start_time:DateTime}
      ORDER BY interval_start
    `,
    query_params: {
      base_id: options.baseId,
      quote_id: options.quoteId,
      from_block: range.from,
      to_block: range.to,
      start_time: startTime,
    },
    // The decimal quotient must reach the caller as text; rendered as a JSON number
    // it would be parsed back as a double and lose the digits this path exists for.
    clickhouse_settings: {
      output_format_json_quote_decimals: 1,
      max_memory_usage: '1000000000',
      max_threads: 4,
    },
    format: 'JSONEachRow',
  })

  const rows = await result.json<CrossRow>()
  return rows.map(r => ({
    intervalStart: Math.floor(new Date(`${r.interval_start.replace(' ', 'T')}Z`).getTime() / 1000),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volumeBuy: r.volume_buy,
    volumeSell: r.volume_sell,
    volumeTotal: r.volume_total,
  }))
}
