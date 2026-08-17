import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { OHLCVCandle } from '../../src/types.ts'

// Contract tests for GET /v1/prices/pair. The candle views are parameterised
// ClickHouse views, so the fake client dispatches on the view name and the
// asset_id parameter — which is also how the bucket→view mapping is pinned.
type Row = Record<string, unknown>

function queryResult(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
  { asset_id: 222, symbol: 'HOLLAR', name: 'Hollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  // The interest-bearing money-market wrappers. HUSDC/HUSDT used to be on the
  // USD-pegged list; HUSDS/HUSDe never were, though all four behave alike.
  { asset_id: 1110, symbol: 'HUSDC', name: 'Hydrated USDC', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1111, symbol: 'HUSDT', name: 'Hydrated Tether', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1112, symbol: 'HUSDS', name: 'Hydrated USDS', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1113, symbol: 'HUSDe', name: 'Hydrated USDe', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

// DOT's own USD candles, as the Decimal strings the views return.
const DOT_CANDLES: Row[] = [
  { asset_id: 5, interval_start: '2026-06-24 00:00:00', open: '4.000000000000', high: '5.000000000000', low: '3.000000000000', close: '4.500000000000', volume_buy: '100.000000000000', volume_sell: '50.000000000000', volume_total: '150.000000000000' },
  { asset_id: 5, interval_start: '2026-06-24 01:00:00', open: '4.500000000000', high: '4.800000000000', low: '4.400000000000', close: '4.600000000000', volume_buy: '10.000000000000', volume_sell: '20.000000000000', volume_total: '30.000000000000' },
]
/** One weekly candle, on the Monday the model buckets weeks to. */
const WEEK_OF_AUG_3: Row[] = [
  { asset_id: 5, interval_start: '2026-08-03 00:00:00', open: '4.000000000000', high: '5.000000000000', low: '3.000000000000', close: '4.500000000000', volume_buy: '1.000000000000', volume_sell: '0', volume_total: '1.000000000000' },
]
/**
 * A `Hydrated *` wrapper's own USD candles at 1.02 — the accrued-interest premium
 * measured live (HUSDT reached 1.0195 by 2026-08-12), not a depeg.
 */
function hydratedCandles(assetId: number): Row[] {
  return [
    { asset_id: assetId, interval_start: '2026-06-24 00:00:00', open: '1.020000000000', high: '1.020000000000', low: '1.020000000000', close: '1.020000000000', volume_buy: '0', volume_sell: '0', volume_total: '0' },
    { asset_id: assetId, interval_start: '2026-06-24 01:00:00', open: '1.020000000000', high: '1.020000000000', low: '1.020000000000', close: '1.020000000000', volume_buy: '0', volume_sell: '0', volume_total: '0' },
  ]
}
// HDX's USD candles. Chosen so every cross field divides exactly: open and close
// both 0.02 against DOT's 4 and 4.5, and a 0.0125/0.025 range so the envelope's
// two divisions land on round numbers too.
const HDX_CANDLES: Row[] = [
  { asset_id: 0, interval_start: '2026-06-24 00:00:00', open: '0.020000000000', high: '0.025000000000', low: '0.012500000000', close: '0.020000000000', volume_buy: '1.000000000000', volume_sell: '2.000000000000', volume_total: '3.000000000000' },
  // No 01:00 HDX candle: that bucket cannot be priced in HDX at all.
]

interface Seen { query: string; params: Record<string, unknown> }

function fakeClient(overrides: { candles?: Record<number, Row[]> } = {}) {
  const seen: Seen[] = []
  const byAsset: Record<number, Row[]> = overrides.candles ?? { 5: DOT_CANDLES, 0: HDX_CANDLES }
  const client = {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      const params = query_params ?? {}
      seen.push({ query, params })
      if (query.includes('FROM price_data.assets FINAL')) return queryResult(ASSET_ROWS)
      if (query.includes('Bonds.TokenCreated')) return queryResult([])
      if (/FROM price_data\.ohlc_/.test(query)) return queryResult(byAsset[Number(params.asset_id)] ?? [])
      throw new Error(`unexpected query: ${query}`)
    }),
  }
  return client
}

let app: FastifyInstance
let stopAssets: () => void

async function freshApp(probe: ReturnType<typeof fakeClient>): Promise<FastifyInstance> {
  const { buildPublicApp } = await import('../../src/public/app.ts')
  return buildPublicApp({ client: probe as never, logger: false })
}

beforeAll(async () => {
  const { loadExplorerAssets, stopExplorerAssetsRefresh } = await import('../../src/services/explorerAssets.ts')
  const client = fakeClient()
  await loadExplorerAssets(client as never)
  stopAssets = stopExplorerAssetsRefresh
  app = await freshApp(client)
})

afterAll(async () => {
  await app?.close()
  stopAssets?.()
})

const WINDOW = 'from=2026-06-24T00:00:00Z&to=2026-06-24T02:00:00Z'

describe('GET /v1/prices/pair', () => {
  it('serves the base asset\'s own candles when the quote is USD-pegged', async () => {
    const res = await app.inject(`/v1/prices/pair?assetIn=5&assetOut=222&bucket=1h&${WINDOW}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      referenceAsset: 'usd',
      items: [
        { timestamp: '2026-06-24T00:00:00.000Z', open: '4', high: '5', low: '3', close: '4.5', volumeUsd: '150' },
        { timestamp: '2026-06-24T01:00:00.000Z', open: '4.5', high: '4.8', low: '4.4', close: '4.6', volumeUsd: '30' },
      ],
    })
    expect(res.headers['cache-control']).toBe('public, max-age=5')
  })

  it('combines the two USD series field by field for a non-USD quote', async () => {
    const probe = fakeClient()
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject(`/v1/prices/pair?assetIn=5&assetOut=0&bucket=1h&${WINDOW}`)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        referenceAsset: '0',
        items: [
          {
            timestamp: '2026-06-24T00:00:00.000Z',
            // Points against the matching point — the same instant, so the real rate.
            // open 4 / 0.02 = 200; close 4.5 / 0.02 = 225 (one DOT buys 225 HDX).
            open: '200',
            // Range as the widest the two series admit: high 5 / LOW 0.0125 = 400,
            // low 3 / HIGH 0.025 = 120. Quoting the range at the quote's close
            // instead gave 250 / 150 — a band 2.1x narrower that need not contain
            // the rates that traded.
            high: '400',
            low: '120',
            close: '225',
            volumeUsd: '150',
          },
        ],
      })
      // The envelope contains both points by construction.
      const [candle] = res.json().items
      for (const point of [candle.open, candle.close]) {
        expect(Number(candle.low)).toBeLessThanOrEqual(Number(point))
        expect(Number(point)).toBeLessThanOrEqual(Number(candle.high))
      }
      // Both series are read from the same view, one request each.
      const assets = probe.seen.filter(s => /ohlc_1h_query/.test(s.query)).map(s => Number(s.params.asset_id))
      expect(assets.sort()).toEqual([0, 5])
    } finally {
      await app2.close()
    }
  })

  it('maps each bucket to its own candle view', async () => {
    for (const [bucket, view] of [['5m', 'ohlc_5min_query'], ['15m', 'ohlc_15min_query'], ['30m', 'ohlc_30min_query'], ['4h', 'ohlc_4h_query'], ['1d', 'ohlc_1d_query'], ['1w', 'ohlc_1w_query']] as const) {
      const probe = fakeClient()
      const app2 = await freshApp(probe)
      try {
        // `from` omitted: the default window is 500 buckets, which is inside the
        // candle cap for every bucket size.
        const res = await app2.inject(`/v1/prices/pair?assetIn=5&assetOut=222&bucket=${bucket}&to=2026-06-24T00:00:00Z`)
        expect(res.statusCode).toBe(200)
        expect(probe.seen.some(s => s.query.includes(`price_data.${view}(`))).toBe(true)
      } finally {
        await app2.close()
      }
    }
  })

  it('never returns a bucket that has not closed yet', async () => {
    const future = new Date(Date.now() + 3 * 3_600_000)
    const openBucket = `${future.toISOString().slice(0, 10)} ${String(future.getUTCHours()).padStart(2, '0')}:00:00`
    const probe = fakeClient({
      candles: {
        5: [
          ...DOT_CANDLES,
          // A bucket whose end is in the future: partial by construction.
          { asset_id: 5, interval_start: openBucket, open: '9.000000000000', high: '9.000000000000', low: '9.000000000000', close: '9.000000000000', volume_buy: '0', volume_sell: '0', volume_total: '0' },
        ],
      },
    })
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=222&bucket=1h')
      expect(res.statusCode).toBe(200)
      expect(res.json().items.map((c: { close: string }) => c.close)).toEqual(['4.5', '4.6'])
    } finally {
      await app2.close()
    }
  })

  it('rejects a window wider than the candle cap instead of truncating it', async () => {
    const res = await app.inject('/v1/prices/pair?assetIn=5&assetOut=222&bucket=1h&from=2020-01-01T00:00:00Z&to=2026-06-24T00:00:00Z')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/5000/)
  })

  it('serves exactly the shared bucket enum minus 1m, from one source', async () => {
    const { zBucket } = await import('../../src/public/schemas/common.ts')
    const doc = (await app.inject('/openapi.json')).json()
    const parameter = doc.paths['/v1/prices/pair'].get.parameters.find((p: { name: string }) => p.name === 'bucket')
    // Derived from zBucket rather than re-declared, so the published set cannot
    // drift from the shared wire enum.
    expect(parameter.schema.enum.sort()).toEqual(zBucket.options.filter(b => b !== '1m').sort())
  })

  it('rejects an out-of-range asset id rather than overflowing the query parameter', async () => {
    // 99999999999 does not fit UInt32; unbounded it reached ClickHouse as a 500.
    const res = await app.inject('/v1/prices/pair?assetIn=99999999999&assetOut=222')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('bad_request')
  })

  it('rejects an unsupported bucket, an inverted window and a missing asset', async () => {
    // There is no minute-level candle model, so 1m is refused rather than rounded up.
    expect((await app.inject('/v1/prices/pair?assetIn=5&assetOut=222&bucket=1m')).statusCode).toBe(400)
    expect((await app.inject(`/v1/prices/pair?assetIn=5&assetOut=222&from=2026-06-24T02:00:00Z&to=2026-06-24T00:00:00Z`)).statusCode).toBe(400)
    expect((await app.inject('/v1/prices/pair?assetIn=5&assetOut=222&from=1969-12-31T00:00:00Z&to=1970-01-02T00:00:00Z')).statusCode).toBe(400)
    expect((await app.inject('/v1/prices/pair?assetIn=5')).statusCode).toBe(400)
    expect((await app.inject('/v1/prices/pair?assetIn=DOT&assetOut=222')).statusCode).toBe(400)
  })

  it('floors the weekly window onto MONDAY, the day the candle model buckets weeks to', async () => {
    const probe = fakeClient({ candles: { 5: WEEK_OF_AUG_3 } })
    const app2 = await freshApp(probe)
    try {
      // One weekly candle, addressed by its own timestamp. Flooring to a plain
      // multiple of 604800 anchors the grid at 1970-01-01, a THURSDAY, so both
      // bounds landed on the Thursday before and the window could not contain a
      // Monday at all: `from == to` at bucket=1w was empty on every weekday.
      const res = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=222&bucket=1w&from=2026-08-03T00:00:00Z&to=2026-08-03T00:00:00Z')
      expect(res.statusCode).toBe(200)
      expect(res.json().items.map((c: { timestamp: string }) => c.timestamp)).toEqual(['2026-08-03T00:00:00.000Z'])
      const weekly = probe.seen.find(s => s.query.includes('price_data.ohlc_1w_query('))
      expect([weekly?.params.start_time, weekly?.params.end_time]).toEqual(['2026-08-03 00:00:00', '2026-08-03 00:00:00'])
    } finally {
      await app2.close()
    }
  })

  it('floors a mid-week bound down to the week that contains it', async () => {
    const probe = fakeClient({ candles: { 5: WEEK_OF_AUG_3 } })
    const app2 = await freshApp(probe)
    try {
      // Wednesday to Wednesday. On the Thursday-anchored grid a Mon/Tue/Wed bound
      // floored PAST the week containing it, silently dropping that candle.
      const res = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=222&bucket=1w&from=2026-07-29T12:00:00Z&to=2026-08-05T12:00:00Z')
      expect(res.statusCode).toBe(200)
      const weekly = probe.seen.find(s => s.query.includes('price_data.ohlc_1w_query('))
      expect([weekly?.params.start_time, weekly?.params.end_time]).toEqual(['2026-07-27 00:00:00', '2026-08-03 00:00:00'])
    } finally {
      await app2.close()
    }
  })

  it('ends the weekly series at the newest CLOSED Monday candle on any weekday', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // Monday 2026-08-17 12:00 UTC: the week that opened Monday 2026-08-10 closed
      // twelve hours ago. The Thursday-anchored grid put the read window's end at
      // Thursday 2026-08-06, so that closed candle stayed unreachable until the
      // following Thursday — the weekly series was a week stale three days in seven.
      vi.setSystemTime(Date.parse('2026-08-17T12:00:00Z'))
      const probe = fakeClient({ candles: { 5: [] } })
      const app2 = await freshApp(probe)
      try {
        const res = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=222&bucket=1w&from=2026-08-10T00:00:00Z')
        expect(res.statusCode).toBe(200)
        const weekly = probe.seen.find(s => s.query.includes('price_data.ohlc_1w_query('))
        expect(weekly?.params.end_time).toBe('2026-08-10 00:00:00')
      } finally {
        await app2.close()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('quotes the interest-bearing Hydrated wrappers through the cross path, not as dollars', async () => {
    const probe = fakeClient({
      candles: { 5: DOT_CANDLES, 1110: hydratedCandles(1110), 1111: hydratedCandles(1111), 1112: hydratedCandles(1112), 1113: hydratedCandles(1113) },
    })
    const app2 = await freshApp(probe)
    try {
      for (const quote of [1110, 1111, 1112, 1113]) {
        const res = await app2.inject(`/v1/prices/pair?assetIn=5&assetOut=${quote}&bucket=1h&${WINDOW}`)
        expect(res.statusCode).toBe(200)
        const body = res.json()
        // A `Hydrated *` token is a money-market wrapper accruing about 2 %/yr away
        // from par, so it is not the dollar. HUSDT/HUSDC were on the USD-pegged
        // list, which published the base asset's RAW USD close (4.5) as the pair
        // rate and understated it by exactly the accrued interest — and grew worse
        // every day. HUSDS/HUSDe never were, so the list also contradicted itself.
        expect(body.referenceAsset).toBe(String(quote))
        expect(body.items[0].close).toBe('4.411764705882352941')
        expect(body.items[0].close).not.toBe('4.5')
      }
    } finally {
      await app2.close()
    }
  })

  it('refuses a pair of an asset with itself instead of publishing its price drift', async () => {
    // Dividing an asset's USD OHLC by its own bucket close leaves the bucket's
    // price DRIFT wearing the shape of a market rate: live HDX/HDX at 1d read
    // open 0.9589, high 1.0162, close 1. The price of an asset in itself is 1.
    const res = await app.inject('/v1/prices/pair?assetIn=5&assetOut=5&bucket=1h')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/must be different/)
    expect((await app.inject('/v1/prices/pair?assetIn=222&assetOut=222&bucket=1h')).statusCode).toBe(400)
  })

  it('publishes the registry id as referenceAsset, not the caller\'s spelling of it', async () => {
    // `005` passes the id regex; echoing it back handed out a referenceAsset that
    // /v1/assets never lists.
    const res = await app.inject(`/v1/prices/pair?assetIn=5&assetOut=000&bucket=1h&${WINDOW}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().referenceAsset).toBe('0')
  })

  it('answers a window after the last closed bucket with empty items, not a false 400', async () => {
    // The request is well formed and simply has nothing closed in it yet — the same
    // situation as a pre-listing window, which already answers 200 + empty. The old
    // code compared the clamped bounds and rejected these with "from must be earlier
    // than to", naming an ordering the caller had not violated.
    for (const query of [
      'from=2087-01-01T00:00:00Z',
      'from=2087-01-01T00:00:00Z&to=2087-02-01T00:00:00Z',
      `from=${new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString()}&to=${new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString()}`,
    ]) {
      const res = await app.inject(`/v1/prices/pair?assetIn=5&assetOut=222&bucket=1h&${query}`)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ referenceAsset: 'usd', items: [] })
    }
    // A window the caller actually inverted is still a 400.
    const inverted = await app.inject('/v1/prices/pair?assetIn=5&assetOut=222&bucket=1h&from=2026-06-24T02:00:00Z&to=2026-06-24T00:00:00Z')
    expect(inverted.statusCode).toBe(400)
    expect(inverted.json().error.message).toBe('from must be earlier than to')
  })

  it('refuses an inversion that lands inside one bucket, as the published rule says', async () => {
    // Testing the FLOORED bounds hid every inversion smaller than the bucket: both
    // of these floor to a single bucket start, compared equal, and answered 200
    // with that candle — while the description promised a 400 for a `from` later
    // than the `to` the caller sent. Swapping two same-day bounds is the likeliest
    // way to make this mistake, so it is the one that must not pass silently.
    const day = await app.inject('/v1/prices/pair?assetIn=5&assetOut=222&bucket=1d&from=2026-08-05T20:00:00Z&to=2026-08-05T04:00:00Z')
    expect(day.statusCode).toBe(400)
    expect(day.json().error.message).toBe('from must be earlier than to')
    const week = await app.inject('/v1/prices/pair?assetIn=5&assetOut=222&bucket=1w&from=2026-08-07T00:00:00Z&to=2026-08-03T00:00:00Z')
    expect(week.statusCode).toBe(400)
    // Equal instants are not an inversion: one bucket, still served.
    const equal = await app.inject('/v1/prices/pair?assetIn=5&assetOut=222&bucket=1d&from=2026-06-24T04:00:00Z&to=2026-06-24T04:00:00Z')
    expect(equal.statusCode).toBe(200)
    // And two instants inside one bucket, in the right order, still floor onto that
    // one bucket — the flooring rule is unchanged, only the ordering test moved.
    const probe = fakeClient()
    const app2 = await freshApp(probe)
    try {
      const ordered = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=222&bucket=1d&from=2026-06-25T04:00:00Z&to=2026-06-25T20:00:00Z')
      expect(ordered.statusCode).toBe(200)
      const daily = probe.seen.find(s => s.query.includes('price_data.ohlc_1d_query('))
      expect([daily?.params.start_time, daily?.params.end_time]).toEqual(['2026-06-25 00:00:00', '2026-06-25 00:00:00'])
    } finally {
      await app2.close()
    }
  })

  it('measures the candle cap on the window actually read, not the one requested', async () => {
    // `to` is clamped to the last closed bucket, so a far-future `to` reads up to
    // now instead of tripping the cap on a nominal 500-year window...
    const clamped = await app.inject('/v1/prices/pair?assetIn=5&assetOut=222&bucket=1h&from=2026-06-24T00:00:00Z&to=2525-01-01T00:00:00Z')
    expect(clamped.statusCode).toBe(200)
    // ...and a window lying entirely beyond it reads nothing, so it answers empty
    // rather than reporting a cap on candles no one could have been served.
    const beyond = await app.inject('/v1/prices/pair?assetIn=5&assetOut=222&bucket=1h&from=2087-01-01T00:00:00Z&to=2099-01-01T00:00:00Z')
    expect(beyond.statusCode).toBe(200)
    expect(beyond.json().items).toEqual([])
  })

  it('answers a pair with no candles with empty items, not 404', async () => {
    const probe = fakeClient({ candles: {} })
    const app2 = await freshApp(probe)
    try {
      // A window no other test uses: the in-process response cache is global.
      const res = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=222&from=2026-06-20T00:00:00Z&to=2026-06-20T02:00:00Z')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ referenceAsset: 'usd', items: [] })
    } finally {
      await app2.close()
    }
  })
})

/** One OHLCV row, as the Decimal strings the candle views return. */
function candleRow(assetId: number, open: string, high: string, low: string, close: string, volume = '0'): OHLCVCandle {
  return { asset_id: assetId, interval_start: '2026-06-24 00:00:00', open, high, low, close, volume_buy: '0', volume_sell: '0', volume_total: volume }
}

/**
 * Whether two decimal strings are exact reciprocals, checked on integers rather
 * than a float: each is read as a count of 1e-18, so the product of an exact
 * reciprocal pair is exactly 1e-36.
 */
function areReciprocal(a: string, b: string): boolean {
  const asScaled = (value: string) => {
    const [whole, fraction = ''] = value.split('.')
    return BigInt(whole + fraction.padEnd(18, '0').slice(0, 18))
  }
  return asScaled(a) * asScaled(b) === 10n ** 36n
}

describe('cross-pair envelope', () => {
  it('is exactly reciprocal-symmetric: high(A/B) is 1/low(B/A)', async () => {
    const { crossCandles } = await import('../../src/public/routes/prices.ts')
    // Values chosen so every one of the eight divisions is exact, so the reciprocal
    // relation can be asserted on the published strings and not on a tolerance.
    const a = candleRow(5, '4', '8', '2', '5')
    const b = candleRow(0, '2', '4', '1', '5')
    const [ab] = crossCandles([a], [b])
    const [ba] = crossCandles([b], [a])
    expect(ab).toMatchObject({ open: '2', high: '8', low: '0.5', close: '1' })
    expect(ba).toMatchObject({ open: '0.5', high: '2', low: '0.125', close: '1' })
    // The envelope's asymmetric pairing is what makes this hold: high(A/B) is
    // aHigh/bLow and low(B/A) is bLow/aHigh, so they are reciprocals by
    // construction. Quoting the whole range at the quote's close did NOT have this
    // property — the old high(A/B) was aHigh/bClose against a low(B/A) of
    // bLow/aClose, two quantities with no algebraic relation.
    expect(areReciprocal(ab.high, ba.low)).toBe(true)
    expect(areReciprocal(ab.low, ba.high)).toBe(true)
    expect(areReciprocal(ab.open, ba.open)).toBe(true)
    expect(areReciprocal(ab.close, ba.close)).toBe(true)
  })

  it('recovers the range from the quote leg when the base leg is flat', async () => {
    const { crossCandles } = await import('../../src/public/routes/prices.ts')
    // The HOLLAR/DOT case, measured live: HOLLAR's own hourly high and low are equal
    // at 12 decimals, so quoting the whole range at one quote close collapsed the
    // band to a POINT — it contained the rates that actually traded in 0 % of 200
    // buckets. The variation lives entirely in the quote leg, and the envelope reads
    // it: the pair's width becomes the quote's own width (5/4 = 1.25 = 0.25/0.2).
    const flatBase = candleRow(222, '1', '1', '1', '1')
    const movingQuote = candleRow(5, '4', '5', '4', '4')
    const [candle] = crossCandles([flatBase], [movingQuote])
    expect(candle).toMatchObject({ open: '0.25', high: '0.25', low: '0.2', close: '0.25' })
    expect(Number(candle.high)).toBeGreaterThan(Number(candle.low))
    // The old formula: every field over the quote close, so high === low === 0.25.
    const collapsed = '0.25'
    expect(candle.low).not.toBe(collapsed)
  })

  it('contains a traded rate the displaced band excluded', async () => {
    const { crossCandles } = await import('../../src/public/routes/prices.ts')
    // A bucket where the base rises while the quote falls. The pair's true high is
    // reached at the instant the base peaks and the quote troughs — 12 — which the
    // old band (base range over the quote CLOSE: 5/1 = 5 down to 2/1 = 2) placed
    // entirely BELOW. The envelope contains it.
    const [candle] = crossCandles([candleRow(5, '2', '6', '2', '5')], [candleRow(0, '2', '2', '0.5', '1')])
    expect(candle).toMatchObject({ open: '1', high: '12', low: '1', close: '5' })
    expect(Number(candle.high)).toBeGreaterThanOrEqual(12)
  })

  it('drops a bucket whose quote LOW is not positive, so no divisor can be zero', async () => {
    const { crossCandles } = await import('../../src/public/routes/prices.ts')
    // The low is the smallest of the quote's four values, so it is the only guard
    // needed — a zero low would otherwise divide the base high by nothing.
    expect(crossCandles([candleRow(5, '1', '1', '1', '1')], [candleRow(0, '2', '2', '0', '2')])).toEqual([])
  })
})

describe('pair candle arithmetic', () => {
  it('divides decimal strings exactly, without floating point', async () => {
    const { crossCandles } = await import('../../src/public/routes/prices.ts')
    // 1/3 is not representable in binary floating point; the quotient is exact to
    // the published scale and is never a rounded double.
    const [candle] = crossCandles(
      [{ asset_id: 5, interval_start: '2026-06-24 00:00:00', open: '1.000000000000', high: '1.000000000000', low: '1.000000000000', close: '1.000000000000', volume_buy: '0', volume_sell: '0', volume_total: '7.500000000000' }],
      [{ asset_id: 0, interval_start: '2026-06-24 00:00:00', open: '3.000000000000', high: '3.000000000000', low: '3.000000000000', close: '3.000000000000', volume_buy: '0', volume_sell: '0', volume_total: '0' }],
    )
    expect(candle.close).toBe('0.333333333333333333')
    expect(candle.volumeUsd).toBe('7.5')
  })

  it('drops a bucket the quote asset has no candle for', async () => {
    const { crossCandles } = await import('../../src/public/routes/prices.ts')
    const candles = crossCandles(
      [
        { asset_id: 5, interval_start: '2026-06-24 00:00:00', open: '1', high: '1', low: '1', close: '1', volume_buy: '0', volume_sell: '0', volume_total: '0' },
        { asset_id: 5, interval_start: '2026-06-24 01:00:00', open: '1', high: '1', low: '1', close: '1', volume_buy: '0', volume_sell: '0', volume_total: '0' },
      ],
      [{ asset_id: 0, interval_start: '2026-06-24 01:00:00', open: '2', high: '2', low: '2', close: '2', volume_buy: '0', volume_sell: '0', volume_total: '0' }],
    )
    expect(candles.map(c => c.timestamp)).toEqual(['2026-06-24T01:00:00.000Z'])
    expect(candles[0].close).toBe('0.5')
  })

  it('reads a value in exponent notation instead of silently pricing it at zero', async () => {
    const { crossCandles, trimDecimal, expandExponent } = await import('../../src/public/routes/prices.ts')
    // A JS number renders as 1e-7 / 1e+21 at the extremes, and every decimal parser
    // below would read those as 0 — a bucket priced at nothing.
    expect(expandExponent('1e-7')).toBe('0.0000001')
    expect(expandExponent('-1.5e-7')).toBe('-0.00000015')
    expect(expandExponent('1e+21')).toBe('1000000000000000000000')
    expect(trimDecimal(1e-7)).toBe('0.0000001')
    expect(trimDecimal(1e21)).toBe('1000000000000000000000')
    // The whole cross path: a quote close of 1e-7 must divide, not vanish.
    const [candle] = crossCandles(
      [{ asset_id: 5, interval_start: '2026-06-24 00:00:00', open: '1', high: '1', low: '1', close: '1', volume_buy: '0', volume_sell: '0', volume_total: '0' }],
      [{ asset_id: 0, interval_start: '2026-06-24 00:00:00', open: '1e-7', high: '1e-7', low: '1e-7', close: '1e-7', volume_buy: '0', volume_sell: '0', volume_total: '0' } as never],
    )
    expect(candle.close).toBe('10000000')
  })

  it('drops a bucket whose quote close is zero rather than dividing by it', async () => {
    const { crossCandles } = await import('../../src/public/routes/prices.ts')
    expect(crossCandles(
      [{ asset_id: 5, interval_start: '2026-06-24 00:00:00', open: '1', high: '1', low: '1', close: '1', volume_buy: '0', volume_sell: '0', volume_total: '0' }],
      [{ asset_id: 0, interval_start: '2026-06-24 00:00:00', open: '0', high: '0', low: '0', close: '0', volume_buy: '0', volume_sell: '0', volume_total: '0' }],
    )).toEqual([])
  })
})
