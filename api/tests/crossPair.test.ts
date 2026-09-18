import { describe, expect, it, vi } from 'vitest'
import {
  CROSS_SCALE,
  CrossWindowTooWideError,
  MAX_CROSS_BLOCKS,
  queryCrossPairCandles,
} from '../src/services/crossPair.ts'

// One derivation of a cross-pair candle, for every surface that serves one.
//
// The rule it exists to enforce: a cross rate is the per-block ratio aggregated,
// never the two assets' stored candles divided. `ohlc_*` aggregates each ASSET on
// its own, so a bucket keeps max(base) and min(quote) with no record of which
// observation went with which — and their quotient is a rate assembled from two
// different moments. It only ever widens the candle, without bound on a pair whose
// ratio is near-constant: BIL quoted in HOLLAR measured a 0.0134 % hourly wick
// against a true range of exactly zero.

const ROWS = [{
  interval_start: '2026-06-24 00:00:00',
  open: '200.000000000000000000', high: '260.000000000000000000',
  low: '190.000000000000000000', close: '225.000000000000000000',
  volume_buy: '100', volume_sell: '50', volume_total: '150',
}]

function fakeClient(range: { from_block: number; to_block: number } | null = { from_block: 1, to_block: 1_000 }) {
  const seen: { query: string; params: Record<string, unknown>; settings?: Record<string, unknown> }[] = []
  const client = {
    seen,
    query: vi.fn(async ({ query, query_params, clickhouse_settings }: {
      query: string; query_params?: Record<string, unknown>; clickhouse_settings?: Record<string, unknown>
    }) => {
      seen.push({ query, params: query_params ?? {}, settings: clickhouse_settings })
      if (query.includes('min(block_height) AS from_block')) {
        return { json: async () => (range ? [range] : [{ from_block: null, to_block: null }]) }
      }
      return { json: async () => ROWS }
    }),
  }
  return client
}

const WINDOW = {
  baseId: 5, quoteId: 0,
  startTime: new Date('2026-06-24T00:00:00Z'),
  endTime: new Date('2026-06-24T02:00:00Z'),
  interval: '1h' as const,
}

describe('the cross-pair candle', () => {
  it('divides in decimal arithmetic, never through a double', async () => {
    const client = fakeClient()
    await queryCrossPairCandles(client as never, WINDOW)
    const cross = client.seen.find(s => s.query.includes('INNER JOIN price_data.prices'))!
    // `toFloat64(a)/toFloat64(b)` would cap the quotient at a double's ~15-17
    // significant digits, and the pair route publishes 18. The dividend is widened
    // to CROSS_SCALE first because a decimal quotient takes the DIVIDEND's scale:
    // dividing the raw Decimal(38,12) columns would silently publish 12 digits.
    expect(cross.query).toContain(`(toDecimal256(base.usd_price, ${CROSS_SCALE}) / quote.usd_price)`)
    expect(cross.query).not.toContain('divideDecimal(')
    expect(cross.query).not.toContain('toFloat64')
    // ...and the result must reach the caller as text, or JSON.parse turns every
    // price back into the double the decimal division just avoided.
    expect(cross.settings?.output_format_json_quote_decimals).toBe(1)
  })

  it('takes its extremes from the ratio, not from each leg separately', async () => {
    const client = fakeClient()
    const [candle] = await queryCrossPairCandles(client as never, WINDOW)
    const cross = client.seen.find(s => s.query.includes('INNER JOIN price_data.prices'))!
    // min/max of the quotient, computed after the legs are paired at the block.
    expect(cross.query).toContain(`max((toDecimal256(base.usd_price, ${CROSS_SCALE}) / quote.usd_price))`)
    expect(cross.query).toContain(`min((toDecimal256(base.usd_price, ${CROSS_SCALE}) / quote.usd_price))`)
    expect(candle).toMatchObject({ open: '200.000000000000000000', high: '260.000000000000000000', low: '190.000000000000000000' })
    // The band always contains the two points it is a range for.
    expect(Number(candle.low)).toBeLessThanOrEqual(Number(candle.open))
    expect(Number(candle.high)).toBeGreaterThanOrEqual(Number(candle.close))
  })

  // Reading `prices` by timestamp alone scans every row the asset ever had: measured
  // on a 2 h window, 3.65 M rows against 78 k once the block range is applied to the
  // table's own sort key. The bound is what makes this affordable per request.
  it('bounds the read on block_height, the table sort key', async () => {
    const client = fakeClient({ from_block: 4_000, to_block: 4_500 })
    await queryCrossPairCandles(client as never, WINDOW)
    const cross = client.seen.find(s => s.query.includes('INNER JOIN price_data.prices'))!
    expect(cross.query).toContain('base.block_height BETWEEN {from_block:UInt32} AND {to_block:UInt32}')
    expect(cross.query).toContain('quote.block_height BETWEEN {from_block:UInt32} AND {to_block:UInt32}')
    expect(cross.params).toMatchObject({ from_block: 4_000, to_block: 4_500 })
    // A runaway query must fail rather than take the box down with it.
    expect(cross.settings?.max_memory_usage).toBeDefined()
    expect(cross.settings?.max_threads).toBeDefined()
  })

  // `prices.block_timestamp` is `DEFAULT toDateTime(0)` and was only populated from
  // block 13,067,140 (2026-07-10) on; 89 % of the table's 184 M rows still hold the
  // default. Bucketing or filtering on it drops nearly all history without an error
  // — HDX/DOT went from 142 weekly candles to 69, with holes through 2026-06 — so a
  // block's time may only ever come from `blocks`.
  it('never reads a block time from `prices`, only from `blocks`', async () => {
    const client = fakeClient({ from_block: 4_000, to_block: 4_500 })
    await queryCrossPairCandles(client as never, WINDOW)
    const cross = client.seen.find(s => s.query.includes('INNER JOIN price_data.prices'))!
    expect(cross.query).not.toContain('base.block_timestamp')
    expect(cross.query).not.toContain('quote.block_timestamp')
    expect(cross.query).toContain('FROM price_data.blocks')
  })

  // The grid is one row per candle, so the bucket lookup binary-searches a handful
  // of rows. Joining `blocks` per block instead hashes all 14.7 M of them and peaks
  // at 1.44 GiB over full history — above this module's own 1 GB ceiling, which
  // makes the cheap shape a correctness requirement, not just a fast one.
  it('resolves the bucket through a per-candle grid, not a per-block join', async () => {
    const client = fakeClient({ from_block: 4_000, to_block: 4_500 })
    await queryCrossPairCandles(client as never, WINDOW)
    const cross = client.seen.find(s => s.query.includes('INNER JOIN price_data.prices'))!
    expect(cross.query).toContain('min(block_height) AS bucket_first_block')
    expect(cross.query).toContain('ASOF INNER JOIN grid')
    expect(cross.query).toContain('base.block_height >= g.bucket_first_block')
    // The grid reads only the blocks the window already bounded.
    expect(cross.query).toContain('WHERE block_height BETWEEN {from_block:UInt32} AND {to_block:UInt32}')
  })

  it('refuses a window wider than the block budget instead of reading it', async () => {
    const client = fakeClient({ from_block: 1, to_block: MAX_CROSS_BLOCKS + 1 })
    await expect(queryCrossPairCandles(client as never, WINDOW)).rejects.toThrow(CrossWindowTooWideError)
    // Refused before the join, not during it.
    expect(client.seen.some(s => s.query.includes('INNER JOIN price_data.prices'))).toBe(false)
  })

  it('answers a window the chain has no blocks in with an empty series', async () => {
    const client = fakeClient(null)
    await expect(queryCrossPairCandles(client as never, WINDOW)).resolves.toEqual([])
    expect(client.seen.some(s => s.query.includes('INNER JOIN price_data.prices'))).toBe(false)
  })

  // The candle views drop a leading bucket that the window only partly covers, so
  // its open and volume cannot depend on where the request happened to start. Both
  // paths have to agree on the first candle or one request gets two answers.
  it('drops a leading bucket the window only partly covers', async () => {
    const client = fakeClient()
    await queryCrossPairCandles(client as never, WINDOW)
    const cross = client.seen.find(s => s.query.includes('INNER JOIN price_data.prices'))!
    expect(cross.query).toContain('HAVING interval_start >= {start_time:DateTime}')
  })
})
