import { describe, expect, it, vi } from 'vitest'
import { carryCandleOpens, compareDecimalText, priorCloseFallbackSql, priorCloseSql, queryOHLCV, INTERVAL_VIEW_MAP, type OHLCVInterval } from '../src/services/ohlcvService.ts'
import { carryReadStart, queryPairCandles, queryUsdQuotedRouteCandles } from '../src/services/crossPair.ts'

// THE CARRY RULE (ohlcvService.carryCandleOpens): prices are written only in blocks
// where they change, so a stored open is the bucket's first CHANGE. Every candle opens
// at the close before it in the same series instead, and high/low widen to that open.

const c = (open: string, high: string, low: string, close: string) => ({ open, high, low, close })

describe('carryCandleOpens', () => {
  it('opens a bucket whose first change came late at the close before it (gap at bucket start)', () => {
    const out = carryCandleOpens([c('1.0', '1.0', '1.0', '1.0'), c('1.2', '1.3', '1.2', '1.25')])
    expect(out[1]).toEqual(c('1.0', '1.3', '1.0', '1.25'))
  })

  it('keeps the first candle\'s own open at a series start (no earlier price)', () => {
    const first = c('2', '3', '1.5', '2.5')
    expect(carryCandleOpens([first], null)[0]).toBe(first)
    expect(carryCandleOpens([first])[0]).toBe(first)
  })

  it('opens the first candle of a range at the close before the range', () => {
    expect(carryCandleOpens([c('2', '3', '1.5', '2.5')], '1.8')[0]).toEqual(c('1.8', '3', '1.5', '2.5'))
  })

  it('carries across empty buckets: the next existing candle opens at the last existing close', () => {
    // 10:00 and 10:25 exist, nothing in between changed the price.
    const out = carryCandleOpens([
      { t: 36_000, ...c('5', '5.5', '4.9', '5.1') },
      { t: 37_500, ...c('5.4', '5.6', '5.3', '5.5') },
    ])
    expect(out[1]).toEqual({ t: 37_500, ...c('5.1', '5.6', '5.1', '5.5') })
  })

  it('widens high and low to include the carried open, so the body never leaves the wick', () => {
    expect(carryCandleOpens([c('10', '11', '10', '10.5')], '12')[0]).toEqual(c('12', '12', '10', '10.5'))
    expect(carryCandleOpens([c('10', '11', '10', '10.5')], '9')[0]).toEqual(c('9', '11', '9', '10.5'))
  })

  it('applies the same rule to the live (still filling) bucket at the end of the series', () => {
    const out = carryCandleOpens([c('1', '1.1', '0.9', '1.05'), c('1.07', '1.07', '1.07', '1.07')])
    expect(out.at(-1)).toEqual(c('1.05', '1.07', '1.05', '1.07'))
  })

  it('is idempotent and returns an untouched candle when it already opened at the close', () => {
    const series = [c('1', '1.2', '0.9', '1.1'), c('1.1', '1.3', '1.0', '1.2')]
    const once = carryCandleOpens(series, '1')
    expect(once[1]).toBe(series[1])
    expect(carryCandleOpens(once, '1')).toEqual(once)
  })

  it('never carries a non-positive close (a defective price row)', () => {
    const second = c('2', '2', '2', '2')
    expect(carryCandleOpens([c('1', '1', '0', '0'), second])[1]).toBe(second)
    expect(carryCandleOpens([second], '0')[0]).toBe(second)
  })

  it('compares decimal text exactly across scales (ClickHouse drops trailing zeros)', () => {
    expect(compareDecimalText('1.40911131616', '1.409111316160')).toBe(0)
    expect(compareDecimalText('1.409111316161', '1.40911131616')).toBe(1)
    expect(compareDecimalText('0.000000000000000001', '0')).toBe(1)
    // Beyond a double's precision: the 18-digit cross scale.
    expect(compareDecimalText('1.000000000000000001', '1.000000000000000002')).toBe(-1)
    // Widening keeps the exact text of whichever value wins.
    expect(carryCandleOpens([c('1.5', '1.500000000001', '1.5', '1.5')], '1.5000000000020')[0].high).toBe('1.5000000000020')
    // An equal value keeps the candle's own text.
    expect(carryCandleOpens([c('1.5', '1.500000000001', '1.5', '1.5')], '1.5000000000010')[0].high).toBe('1.500000000001')
  })
})

/* ------------------------------ queryOHLCV ------------------------------ */

function fakeClient(rows: unknown[]) {
  const seen: { query: string; params: Record<string, unknown> }[] = []
  return {
    seen,
    query: vi.fn(async ({ query, query_params }: { query: string; query_params: Record<string, unknown> }) => {
      seen.push({ query, params: query_params })
      return { json: async () => rows }
    }),
  }
}

// Live rows of apyUSD (asset 46), 2026-10-05: no price change from 19:00:00 to
// 19:00:41; a buy at 19:00:42 (block 15,437,388) moved it to 1.409095. The 18:55
// candle closed at 1.407545022713, which is the price at 19:00:00.
const APYUSD_VIEW = [
  { asset_id: 46, interval_start: '2026-10-05 19:00:00', open: '1.409094503961', high: '1.409104507633', low: '1.409094503961', close: '1.409104507633', volume_buy: '3330.648444662454', volume_sell: '0', volume_total: '3330.648444662454', prior_close: '1.407545022713' },
  { asset_id: 46, interval_start: '2026-10-05 19:05:00', open: '1.409104507719', high: '1.409112331069', low: '1.409102364388', close: '1.40911131616', volume_buy: '0', volume_sell: '0', volume_total: '0', prior_close: '1.407545022713' },
  { asset_id: 46, interval_start: '2026-10-05 19:10:00', open: '1.40911131629', high: '1.409122674728', low: '1.409110937532', close: '1.409120777151', volume_buy: '0', volume_sell: '0', volume_total: '0', prior_close: '1.407545022713' },
]

describe('queryOHLCV (every USD candle surface)', () => {
  it('regression: apyUSD 2026-10-05 19:00 opens at the 18:55 close, not at the 19:00:42 change', async () => {
    const client = fakeClient(APYUSD_VIEW)
    const out = await queryOHLCV(client as never, { assetId: 46, startTime: new Date('2026-10-05T19:00:00Z'), endTime: new Date('2026-10-05T19:10:00Z'), interval: '5min' })
    expect(out.map(r => [r.interval_start, r.open, r.high, r.low, r.close])).toEqual([
      ['2026-10-05 19:00:00', '1.407545022713', '1.409104507633', '1.407545022713', '1.409104507633'],
      ['2026-10-05 19:05:00', '1.409104507633', '1.409112331069', '1.409102364388', '1.40911131616'],
      ['2026-10-05 19:10:00', '1.40911131616', '1.409122674728', '1.409110937532', '1.409120777151'],
    ])
    // The carried close is the read's own business: it never reaches a caller's row.
    expect(out.every(r => !('prior_close' in r))).toBe(true)
    // Volumes are untouched.
    expect(out[0].volume_total).toBe('3330.648444662454')
  })

  it('reads the window and the close before it in ONE query, keyed on the asset prefix', async () => {
    const client = fakeClient([])
    await queryOHLCV(client as never, { assetId: 46, startTime: new Date('2026-10-05T19:00:00Z'), endTime: new Date('2026-10-05T19:10:00Z'), interval: '5min', tag: 'data:assets:candles' })
    expect(client.seen).toHaveLength(1)
    const { query, params } = client.seen[0]!
    expect(query.startsWith('-- data:assets:candles\n')).toBe(true)
    expect(query).toContain('FROM price_data.ohlc_5min_query(asset_id={asset_id:UInt32}')
    expect(query).toContain(' AS prior_close FROM ')
    expect(params).toEqual({ asset_id: 46, start_time: '2026-10-05 19:00:00', end_time: '2026-10-05 19:10:00' })
  })

  it('keeps the first candle\'s own open when the asset has no price before the window', async () => {
    const client = fakeClient([{ ...APYUSD_VIEW[0], prior_close: null }])
    const [first] = await queryOHLCV(client as never, { assetId: 46, startTime: new Date('2026-10-05T19:00:00Z'), endTime: new Date('2026-10-05T19:00:00Z'), interval: '5min' })
    expect(first.open).toBe('1.409094503961')
  })
})

describe('priorCloseSql / priorCloseFallbackSql', () => {
  const tableOf = (iv: OHLCVInterval) => `price_data.${INTERVAL_VIEW_MAP[iv].replace(/_query$/, '')}`
  it('first look: the interval\'s own table over a bounded lookback before the window', () => {
    const lookback: Record<OHLCVInterval, string> = { '5min': '1 DAY', '15min': '1 DAY', '30min': '1 DAY', '1h': '1 DAY', '4h': '1 DAY', '1d': '31 DAY', '1w': '35 DAY', '1M': '62 DAY' }
    for (const iv of Object.keys(INTERVAL_VIEW_MAP) as OHLCVInterval[]) {
      expect(priorCloseSql(iv)).toBe(`(SELECT argMaxOrNull(c, t) FROM (SELECT interval_start AS t, argMaxMerge(close_state) AS c FROM ${tableOf(iv)} WHERE asset_id = {asset_id:UInt32} AND interval_start >= {start_time:DateTime} - INTERVAL ${lookback[iv]} AND interval_start < {start_time:DateTime} GROUP BY t))`)
    }
  })

  it('second look: sub-day reads the day candles before the start\'s day; longer intervals their own prefix', () => {
    for (const iv of ['5min', '15min', '30min', '1h', '4h'] as const) {
      expect(priorCloseFallbackSql(iv)).toContain('FROM price_data.ohlc_1d WHERE asset_id = {asset_id:UInt32} AND interval_start < toStartOfDay({start_time:DateTime}) GROUP BY t')
    }
    for (const iv of ['1d', '1w', '1M'] as const) {
      expect(priorCloseFallbackSql(iv)).toContain(`FROM ${tableOf(iv)} WHERE asset_id = {asset_id:UInt32} AND interval_start < {start_time:DateTime} GROUP BY t`)
    }
  })

  it('never walks the key backwards with ORDER BY … DESC LIMIT (AGENTS.md)', () => {
    for (const iv of Object.keys(INTERVAL_VIEW_MAP) as OHLCVInterval[]) {
      expect(priorCloseSql(iv)).not.toMatch(/ORDER BY|LIMIT/i)
      expect(priorCloseFallbackSql(iv)).not.toMatch(/ORDER BY|LIMIT/i)
    }
  })

  it('runs the second look only when the lookback found nothing and there is a candle to carry into', async () => {
    const seen: string[] = []
    const client = {
      query: vi.fn(async ({ query }: { query: string }) => {
        seen.push(query)
        if (query.includes('AS prior_close FROM price_data.ohlc_5min_query(')) return { json: async () => APYUSD_VIEW.map(r => ({ ...r, prior_close: null })) }
        return { json: async () => [{ prior_close: '1.4' }] }
      }),
    }
    const [first] = await queryOHLCV(client as never, { assetId: 46, startTime: new Date('2026-10-05T19:00:00Z'), endTime: new Date('2026-10-05T19:10:00Z'), interval: '5min', tag: 'x' })
    expect(first.open).toBe('1.4')
    expect(seen).toHaveLength(2)
    expect(seen[1]!.startsWith('-- x:prior\n')).toBe(true)
    // Found in the lookback: one read. An empty window: one read.
    const one = fakeClient(APYUSD_VIEW)
    await queryOHLCV(one as never, { assetId: 46, startTime: new Date('2026-10-05T19:00:00Z'), endTime: new Date('2026-10-05T19:10:00Z'), interval: '5min' })
    const none = fakeClient([])
    await queryOHLCV(none as never, { assetId: 46, startTime: new Date('2026-10-05T19:00:00Z'), endTime: new Date('2026-10-05T19:10:00Z'), interval: '5min' })
    expect([one.seen.length, none.seen.length]).toEqual([1, 1])
  })
})

/* ------------------------------ pair series ------------------------------ */

describe('pair candles carry over the finished series', () => {
  it('reads from a bounded, bucket-aligned lookback', () => {
    const at = Date.UTC(2026, 9, 5, 19, 0) / 1000
    expect(carryReadStart('5min', at)).toBe(at - 86_400)
    expect(carryReadStart('1h', at + 600)).toBe(at - 86_400)
    expect(carryReadStart('1d', Date.UTC(2026, 9, 5) / 1000)).toBe(Date.UTC(2026, 8, 28) / 1000)
    // Monday-anchored weeks, calendar months.
    expect(new Date(carryReadStart('1w', Date.UTC(2026, 9, 5) / 1000) * 1000).getUTCDay()).toBe(1)
    expect(carryReadStart('1M', Date.UTC(2026, 9, 1) / 1000)).toBe(Date.UTC(2026, 6, 1) / 1000)
  })

  // A cross pair: the stored per-block ratio candles, the window starting at 19:00.
  const T0 = Date.UTC(2026, 9, 5, 19, 0) / 1000
  const crossRow = (t: number, open: string, high: string, low: string, close: string) => ({
    interval_start: new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' '), open, high, low, close, volume_buy: '1', volume_sell: '0', volume_total: '1',
  })
  function pairClient(cross: unknown[], usd: unknown[] = []) {
    const seen: { query: string; params: Record<string, unknown> }[] = []
    return {
      seen,
      query: vi.fn(async ({ query, query_params }: { query: string; query_params: Record<string, unknown> }) => {
        seen.push({ query, params: query_params })
        if (query.includes('min(block_height) AS from_block')) return { json: async () => [{ from_block: 1, to_block: 1_000 }] }
        if (query.includes('INNER JOIN price_data.prices')) return { json: async () => cross }
        if (query.includes('-- pair-route:')) return { json: async () => [] }
        if (query.includes('_query(asset_id=')) return { json: async () => usd }
        throw new Error(`unexpected query: ${query}`)
      }),
    }
  }

  it('the first candle of the window opens at the pair close before it; the lookback candles are dropped', async () => {
    const client = pairClient([
      crossRow(T0 - 7_200, '0.5', '0.52', '0.49', '0.51'),
      crossRow(T0 - 300, '0.51', '0.53', '0.5', '0.52'),
      crossRow(T0, '0.55', '0.56', '0.55', '0.56'),
      // 19:05 printed nothing; 19:10 opens at the 19:00 close.
      crossRow(T0 + 600, '0.6', '0.61', '0.6', '0.61'),
    ])
    const out = await queryPairCandles(client as never, { baseId: 5, quoteId: 0, startTime: new Date(T0 * 1000), endTime: new Date((T0 + 900) * 1000), interval: '5min' }, 'usd-ratio')
    expect(out.map(r => [r.intervalStart, r.open, r.high, r.low, r.close])).toEqual([
      [T0, '0.52', '0.56', '0.52', '0.56'],
      [T0 + 600, '0.56', '0.61', '0.56', '0.61'],
    ])
    // The cross read started a day before the window, on the grid.
    const cross = client.seen.find(s => s.query.includes('INNER JOIN price_data.prices'))!
    expect(cross.params.start_time).toBe('2026-10-04 19:00:00')
    const range = client.seen.find(s => s.query.includes('min(block_height) AS from_block'))!
    expect(range.params.start_time).toBe('2026-10-04 19:00:00')
  })

  it('a pair with no candle in the lookback keeps its first candle\'s own open', async () => {
    const client = pairClient([crossRow(T0, '0.55', '0.56', '0.55', '0.56')])
    const [first] = await queryPairCandles(client as never, { baseId: 5, quoteId: 0, startTime: new Date(T0 * 1000), endTime: new Date((T0 + 300) * 1000), interval: '5min' }, 'usd-ratio')
    expect(first.open).toBe('0.55')
  })

  it('a USD-pegged quote in route mode is one series: USD candles carried from the lookback, priceSource kept', async () => {
    const usd = [
      { asset_id: 5, ...crossRow(T0 - 300, '4.5', '4.6', '4.4', '4.55'), prior_close: '4.49' },
      { asset_id: 5, ...crossRow(T0, '4.6', '4.62', '4.6', '4.61'), prior_close: '4.49' },
    ]
    const client = pairClient([], usd)
    const out = await queryUsdQuotedRouteCandles(client as never, { baseId: 5, quoteId: 10, startTime: new Date(T0 * 1000), endTime: new Date((T0 + 300) * 1000), interval: '5min' })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ intervalStart: T0, open: '4.55', high: '4.62', low: '4.55', close: '4.61', volumeTotal: '1' })
    expect(out[0].priceSource).toMatch(/^usd-ratio/)
    // The USD view's inclusive end is one second short of the half-open window end.
    const view = client.seen.find(s => s.query.includes('_query(asset_id='))!
    expect(view.params).toMatchObject({ start_time: '2026-10-04 19:00:00', end_time: '2026-10-05 19:04:59' })
  })
})
