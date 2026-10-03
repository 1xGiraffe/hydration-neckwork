import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

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
  { asset_id: 10, symbol: 'USDT', name: 'Tether', decimals: 6, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  // A stablecoin the endpoint does NOT substitute the dollar for: HOLLAR is
  // protocol-minted and floats on its own stablepools, so it quotes as a cross.
  { asset_id: 222, symbol: 'HOLLAR', name: 'Hollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  // The interest-bearing money-market wrappers. HUSDC/HUSDT used to be on the
  // USD-pegged list; HUSDS/HUSDe never were, though all four behave alike.
  { asset_id: 1110, symbol: 'HUSDC', name: 'Hydrated USDC', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1111, symbol: 'HUSDT', name: 'Hydrated Tether', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1112, symbol: 'HUSDS', name: 'Hydrated USDS', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1113, symbol: 'HUSDe', name: 'Hydrated USDe', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  // Pool shares: 2-Pool-HUSDC is published under its wrapper HUSDC, while
  // 2-Pool-PRIME (PRIME + HOLLAR) keeps its own series — its wrapper a2-Pool-PRIME
  // is no product name and PRIME is a LEG of the pool, not the share.
  { asset_id: 110, symbol: '2-Pool-HUSDC', name: '2-Pool-HUSDC', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 43, symbol: 'PRIME', name: 'PRIME', decimals: 6, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 143, symbol: '2-Pool-PRIME', name: '2-Pool-PRIME', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1143, symbol: 'a2-Pool-PRIME', name: 'a2-Pool-PRIME', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
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

/**
 * The per-block cross, as the shared module returns it: exact decimal text for the
 * REAL ratio, not a band composed from the two legs' stored candles. DOT/HDX here
 * opens at 200 and closes at 225, having traded as high as 260 and as low as 190 —
 * a range the stored aggregates could only have bounded at 400/120.
 */
const CROSS_ROWS = [
  {
    interval_start: '2026-06-24 00:00:00',
    open: '200.000000000000000000', high: '260.000000000000000000',
    low: '190.000000000000000000', close: '225.000000000000000000',
    volume_buy: '100.000000000000', volume_sell: '50.000000000000', volume_total: '150.000000000000',
  },
]

/** The additive pair-volume fields of a bucket the pair did not trade in (the fake fold holds no rows). */
const NO_PAIR_VOLUME = { pairVolumeUsd: '0', volumeBase: '0', volumeQuote: '0' }

interface Seen { query: string; params: Record<string, unknown> }

function fakeClient(overrides: { candles?: Record<number, Row[]>; cross?: unknown[]; route?: Row[]; coverage?: Row[]; headTime?: number; pairVolume?: Row[]; pairVolumeTail?: Row[]; storedThrough?: number } = {}) {
  const seen: Seen[] = []
  const byAsset: Record<number, Row[]> = overrides.candles ?? { 5: DOT_CANDLES, 0: HDX_CANDLES }
  const client = {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      const params = query_params ?? {}
      seen.push({ query, params })
      if (query.includes('FROM price_data.assets FINAL')) return queryResult(ASSET_ROWS)
      // The price pipeline's head: by default as fresh as the wall clock, so the
      // closed-bucket clamp is the old one unless a test lags the head.
      if (query.includes('AS b, toUnixTimestamp(block_timestamp) AS t')) return queryResult([{ b: 1_000, t: overrides.headTime ?? Math.floor(Date.now() / 1000) }] as never)
      if (query.includes('Bonds.TokenCreated')) return queryResult([])
      // The cross path resolves its block range first, then joins the two legs.
      if (query.includes('min(block_height) AS from_block')) return queryResult([{ from_block: 1, to_block: 1_000 }] as never)
      if (query.includes('INNER JOIN price_data.prices')) return queryResult((overrides.cross ?? CROSS_ROWS) as never)
      if (query.includes('-- pair-route:candles')) return queryResult(overrides.route ?? [])
      if (query.includes('-- pair-route:coverage')) return queryResult(overrides.coverage ?? [])
      // The pair volume: the fold's rows for the pair, how far the fold reaches, and the unfolded tail.
      if (query.includes('-- pair-volume:stored-through')) return queryResult([{ t: overrides.storedThrough ?? 0 }] as never)
      if (query.includes('-- pair-volume:stored')) return queryResult(overrides.pairVolume ?? [])
      if (query.includes('-- pair-volume:tail')) return queryResult(overrides.pairVolumeTail ?? [])
      if (/FROM price_data\.ohlc_/.test(query)) return queryResult(byAsset[Number(params.asset_id)] ?? [])
      throw new Error(`unexpected query: ${query}`)
    }),
  }
  return client
}

let app: FastifyInstance
let stopAssets: () => void

// The head probe is cached for a second; each test states its own head.
beforeEach(async () => {
  const { resetCacheForTests } = await import('../../src/services/cache.ts')
  resetCacheForTests()
})

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
    const res = await app.inject(`/v1/prices/pair?assetIn=5&assetOut=10&bucket=1h&${WINDOW}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      referenceAsset: 'usd',
      items: [
        { timestamp: '2026-06-24T00:00:00.000Z', open: '4', high: '5', low: '3', close: '4.5', volumeUsd: '150', closed: true, ...NO_PAIR_VOLUME },
        { timestamp: '2026-06-24T01:00:00.000Z', open: '4.5', high: '4.8', low: '4.4', close: '4.6', volumeUsd: '30', closed: true, ...NO_PAIR_VOLUME },
      ],
    })
    // Closed buckets only: they never change, so they are shared for long.
    expect(res.headers['cache-control']).toBe('public, max-age=300')
  })

  it('serves the per-block ratio for a non-USD quote, not a band over stored candles', async () => {
    const probe = fakeClient()
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject(`/v1/prices/pair?assetIn=5&assetOut=0&bucket=1h&${WINDOW}`)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        referenceAsset: '0',
        items: [
          // Every field is the real ratio's own statistic over the bucket's blocks.
          // Composing the legs' stored candles instead could only have bounded the
          // range at high 5/LOW 0.0125 = 400 and low 3/HIGH 0.025 = 120 — a band
          // formed from two different instants, containing rates that never existed.
          { timestamp: '2026-06-24T00:00:00.000Z', open: '200', high: '260', low: '190', close: '225', volumeUsd: '150', closed: true, ...NO_PAIR_VOLUME },
        ],
      })
      const [candle] = res.json().items
      for (const point of [candle.open, candle.close]) {
        expect(Number(candle.low)).toBeLessThanOrEqual(Number(point))
        expect(Number(point)).toBeLessThanOrEqual(Number(candle.high))
      }
      // The quote leg is never read from the candle views on this path: a cross is
      // derived from prices, so reading a stored quote candle would mean the old
      // composition had survived somewhere.
      expect(probe.seen.filter(s => /ohlc_/.test(s.query))).toHaveLength(0)
      expect(probe.seen.some(s => s.query.includes('INNER JOIN price_data.prices'))).toBe(true)
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
        const res = await app2.inject(`/v1/prices/pair?assetIn=5&assetOut=10&bucket=${bucket}&to=2026-06-24T00:00:00Z`)
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
      const res = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=1h')
      expect(res.statusCode).toBe(200)
      expect(res.json().items.map((c: { close: string }) => c.close)).toEqual(['4.5', '4.6'])
    } finally {
      await app2.close()
    }
  })

  it('rejects a window wider than the candle cap instead of truncating it', async () => {
    const res = await app.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=1h&from=2020-01-01T00:00:00Z&to=2026-06-24T00:00:00Z')
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
    const res = await app.inject('/v1/prices/pair?assetIn=99999999999&assetOut=10')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('bad_request')
  })

  it('rejects an unsupported bucket, an inverted window and a missing asset', async () => {
    // There is no minute-level candle model, so 1m is refused rather than rounded up.
    expect((await app.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=1m')).statusCode).toBe(400)
    expect((await app.inject(`/v1/prices/pair?assetIn=5&assetOut=10&from=2026-06-24T02:00:00Z&to=2026-06-24T00:00:00Z`)).statusCode).toBe(400)
    expect((await app.inject('/v1/prices/pair?assetIn=5&assetOut=10&from=1969-12-31T00:00:00Z&to=1970-01-02T00:00:00Z')).statusCode).toBe(400)
    expect((await app.inject('/v1/prices/pair?assetIn=5')).statusCode).toBe(400)
    expect((await app.inject('/v1/prices/pair?assetIn=DOT&assetOut=10')).statusCode).toBe(400)
  })

  it('floors the weekly window onto MONDAY, the day the candle model buckets weeks to', async () => {
    const probe = fakeClient({ candles: { 5: WEEK_OF_AUG_3 } })
    const app2 = await freshApp(probe)
    try {
      // One weekly candle, addressed by its own timestamp. Flooring to a plain
      // multiple of 604800 anchors the grid at 1970-01-01, a THURSDAY, so both
      // bounds landed on the Thursday before and the window could not contain a
      // Monday at all: `from == to` at bucket=1w was empty on every weekday.
      const res = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=1w&from=2026-08-03T00:00:00Z&to=2026-08-03T00:00:00Z')
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
      const res = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=1w&from=2026-07-29T12:00:00Z&to=2026-08-05T12:00:00Z')
      expect(res.statusCode).toBe(200)
      const weekly = probe.seen.find(s => s.query.includes('price_data.ohlc_1w_query('))
      expect([weekly?.params.start_time, weekly?.params.end_time]).toEqual(['2026-07-27 00:00:00', '2026-08-03 00:00:00'])
    } finally {
      await app2.close()
    }
  })

  it('ends the weekly series at the week the head is in, the newest CLOSED Monday candle before it', async () => {
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
        const res = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=1w&from=2026-08-10T00:00:00Z')
        expect(res.statusCode).toBe(200)
        // The read reaches the open week (Monday 2026-08-17), which the series carries
        // as `closed: false`; the week of 2026-08-10 is the newest closed one.
        const weekly = probe.seen.find(s => s.query.includes('price_data.ohlc_1w_query('))
        expect(weekly?.params.end_time).toBe('2026-08-17 00:00:00')
      } finally {
        await app2.close()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  // A bucket's last blocks finalize ~46 s after it ends. Clamping on wall clock
  // published the bucket before they were indexed and revised it once they landed
  // (1-6 revisions up to 58 s after publication, measured 2026-10-03), so CLOSED is
  // judged by the price pipeline's head block timestamp instead.
  it('flags a bucket closed only once the FINALIZED head has passed its end, not the wall clock, and serves the open one flagged', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // 12:00:20 by the clock, but the newest finalized, indexed block is 11:59:30:
      // the 11:55 bucket has ended by the clock and is still missing 30 s of blocks.
      vi.setSystemTime(Date.parse('2026-08-17T12:00:20Z'))
      const candle = (t: string, close: string) => ({ asset_id: 5, interval_start: t, open: '4', high: '5', low: '3', close, volume_total: '1' })
      const probe = fakeClient({ candles: { 5: [candle('2026-08-17 11:50:00', '4.1'), candle('2026-08-17 11:55:00', '4.2')] }, headTime: Date.parse('2026-08-17T11:59:30Z') / 1000 })
      const app2 = await freshApp(probe)
      try {
        const usd = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=5m')
        expect(usd.statusCode).toBe(200)
        // The read reaches the bucket the head is in (11:55), which is served OPEN.
        const view = probe.seen.find(s => s.query.includes('price_data.ohlc_5min_query('))
        expect(view?.params.end_time).toBe('2026-08-17 11:55:00')
        const items = usd.json().items as Array<{ timestamp: string; closed: boolean }>
        expect(items.slice(-2).map(c => [c.timestamp, c.closed])).toEqual([['2026-08-17T11:50:00.000Z', true], ['2026-08-17T11:55:00.000Z', false]])
        // A response holding the open bucket is shared for a moment only.
        expect(usd.headers['cache-control']).toBe('public, max-age=2')
        // The cross path reads up to the open bucket's end.
        const cross = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=0&bucket=5m')
        expect(cross.statusCode).toBe(200)
        const range = probe.seen.find(s => s.query.includes('min(block_height) AS from_block'))
        expect(range?.params.end_time).toBe('2026-08-17 12:00:00')
        // A past `to` (hydration-ui's reference-price query) keeps closed buckets only.
        const past = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=5m&to=2026-08-17T11:50:00Z')
        expect((past.json().items as Array<{ closed: boolean }>).every(c => c.closed)).toBe(true)
        expect(past.headers['cache-control']).toBe('public, max-age=300')
      } finally {
        await app2.close()
      }
      // Once the head passes 12:00:00 the 11:55 bucket is closed; its candle is final.
      const { resetCacheForTests } = await import('../../src/services/cache.ts')
      resetCacheForTests()
      const later = fakeClient({ candles: { 5: [candle('2026-08-17 11:55:00', '4.3')] }, headTime: Date.parse('2026-08-17T12:00:00Z') / 1000 })
      const app3 = await freshApp(later)
      try {
        const res = await app3.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=5m&from=2026-08-17T11:55:00Z&to=2026-08-17T11:55:00Z')
        expect(res.json().items).toEqual([{ timestamp: '2026-08-17T11:55:00.000Z', open: '4', high: '5', low: '3', close: '4.3', volumeUsd: '1', closed: true, ...NO_PAIR_VOLUME }])
      } finally {
        await app3.close()
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
        // The cross path answered, so the rate is the pair's own ratio and not the
        // base asset's raw USD close (4.5) that the USD path would have published.
        expect(body.items[0].close).toBe('225')
        expect(body.items[0].close).not.toBe('4.5')
      }
    } finally {
      await app2.close()
    }
  })

  // The price writer publishes a Hydrated pool share only under its money-market
  // wrapper (1:1 with it), so reading the share's own id served empty candles for
  // every 2-Pool-H* pool (live: 110–113, 10044 over their whole history).
  it('reads a Hydrated pool share from its wrapper\'s series, and any other share from its own', async () => {
    const { registerShareWrapper } = await import('../../src/services/explorerAssets.ts')
    registerShareWrapper(110, { aTokenId: 1110, marketKey: 'core' })
    registerShareWrapper(143, { aTokenId: 1143, marketKey: 'core' })
    const probe = fakeClient({ candles: { 1110: hydratedCandles(1110) } })
    const app2 = await freshApp(probe)
    try {
      const crossQuote = () => probe.seen.filter(q => q.query.includes('INNER JOIN price_data.prices')).at(-1)?.params
      const asQuote = await app2.inject(`/v1/prices/pair?assetIn=5&assetOut=110&bucket=1h&${WINDOW}`)
      expect(asQuote.statusCode).toBe(200)
      expect(asQuote.json().referenceAsset).toBe('110')
      expect(crossQuote()).toMatchObject({ base_id: 5, quote_id: 1110 })

      const asBase = await app2.inject(`/v1/prices/pair?assetIn=110&assetOut=10&bucket=1h&${WINDOW}`)
      expect(asBase.statusCode).toBe(200)
      expect(asBase.json().items[0].close).toBe('1.02')

      await app2.inject(`/v1/prices/pair?assetIn=5&assetOut=143&bucket=1h&${WINDOW}`)
      expect(crossQuote()).toMatchObject({ base_id: 5, quote_id: 143 })

      // One series, so the "pair" is an asset in itself.
      expect((await app2.inject(`/v1/prices/pair?assetIn=110&assetOut=1110&bucket=1h&${WINDOW}`)).statusCode).toBe(400)
    } finally {
      await app2.close()
      registerShareWrapper(110, null)
      registerShareWrapper(143, null)
    }
  })

  it('refuses a pair of an asset with itself instead of publishing its price drift', async () => {
    // Dividing an asset's USD OHLC by its own bucket close leaves the bucket's
    // price DRIFT wearing the shape of a market rate: live HDX/HDX at 1d read
    // open 0.9589, high 1.0162, close 1. The price of an asset in itself is 1.
    const res = await app.inject('/v1/prices/pair?assetIn=5&assetOut=5&bucket=1h')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/must be different/)
    expect((await app.inject('/v1/prices/pair?assetIn=10&assetOut=10&bucket=1h')).statusCode).toBe(400)
  })

  it('publishes the registry id as referenceAsset, not the caller\'s spelling of it', async () => {
    // `005` passes the id regex; echoing it back handed out a referenceAsset that
    // /v1/assets never lists.
    const res = await app.inject(`/v1/prices/pair?assetIn=5&assetOut=000&bucket=1h&${WINDOW}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().referenceAsset).toBe('0')
  })

  it('answers a window after the open bucket with empty items, not a false 400', async () => {
    // The request is well formed and simply has nothing closed in it yet — the same
    // situation as a pre-listing window, which already answers 200 + empty. The old
    // code compared the clamped bounds and rejected these with "from must be earlier
    // than to", naming an ordering the caller had not violated.
    for (const query of [
      'from=2087-01-01T00:00:00Z',
      'from=2087-01-01T00:00:00Z&to=2087-02-01T00:00:00Z',
    ]) {
      const res = await app.inject(`/v1/prices/pair?assetIn=5&assetOut=10&bucket=1h&${query}`)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ referenceAsset: 'usd', items: [] })
    }
    // A window the caller actually inverted is still a 400.
    const inverted = await app.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=1h&from=2026-06-24T02:00:00Z&to=2026-06-24T00:00:00Z')
    expect(inverted.statusCode).toBe(400)
    expect(inverted.json().error.message).toBe('from must be earlier than to')
  })

  it('refuses an inversion that lands inside one bucket, as the published rule says', async () => {
    // Testing the FLOORED bounds hid every inversion smaller than the bucket: both
    // of these floor to a single bucket start, compared equal, and answered 200
    // with that candle — while the description promised a 400 for a `from` later
    // than the `to` the caller sent. Swapping two same-day bounds is the likeliest
    // way to make this mistake, so it is the one that must not pass silently.
    const day = await app.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=1d&from=2026-08-05T20:00:00Z&to=2026-08-05T04:00:00Z')
    expect(day.statusCode).toBe(400)
    expect(day.json().error.message).toBe('from must be earlier than to')
    const week = await app.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=1w&from=2026-08-07T00:00:00Z&to=2026-08-03T00:00:00Z')
    expect(week.statusCode).toBe(400)
    // Equal instants are not an inversion: one bucket, still served.
    const equal = await app.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=1d&from=2026-06-24T04:00:00Z&to=2026-06-24T04:00:00Z')
    expect(equal.statusCode).toBe(200)
    // And two instants inside one bucket, in the right order, still floor onto that
    // one bucket — the flooring rule is unchanged, only the ordering test moved.
    const probe = fakeClient()
    const app2 = await freshApp(probe)
    try {
      const ordered = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=1d&from=2026-06-25T04:00:00Z&to=2026-06-25T20:00:00Z')
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
    const clamped = await app.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=1h&from=2026-06-24T00:00:00Z&to=2525-01-01T00:00:00Z')
    expect(clamped.statusCode).toBe(200)
    // ...and a window lying entirely beyond it reads nothing, so it answers empty
    // rather than reporting a cap on candles no one could have been served.
    const beyond = await app.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=1h&from=2087-01-01T00:00:00Z&to=2099-01-01T00:00:00Z')
    expect(beyond.statusCode).toBe(200)
    expect(beyond.json().items).toEqual([])
  })

  it('answers a pair with no candles with empty items, not 404', async () => {
    const probe = fakeClient({ candles: {} })
    const app2 = await freshApp(probe)
    try {
      // A window no other test uses: the in-process response cache is global.
      const res = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=10&from=2026-06-20T00:00:00Z&to=2026-06-20T02:00:00Z')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ referenceAsset: 'usd', items: [] })
    } finally {
      await app2.close()
    }
  })
})

describe('GET /v1/prices/pair pair volume', () => {
  const t0 = Date.parse('2026-06-24T00:00:00Z') / 1000
  // HDX (0) / DOT (5): the fold keys the pair (lo, hi) = (0, 5); 20.5 of the 120.5
  // USD had HDX paid in (DOT bought).
  const STORED = [{ t: t0, v: '120.5', v_lo_in: '20.5', a_lo: '1000.5', a_hi: '25.25' }]

  it('adds the pair\'s own volume, identical both ways, with base and quote amounts swapping places, and leaves volumeUsd alone', async () => {
    const probe = fakeClient({ pairVolume: STORED as never })
    const app2 = await freshApp(probe)
    try {
      const dotHdx = (await app2.inject(`/v1/prices/pair?assetIn=5&assetOut=0&bucket=1h&${WINDOW}`)).json().items[0]
      const hdxDot = (await app2.inject(`/v1/prices/pair?assetIn=0&assetOut=5&bucket=1h&${WINDOW}`)).json().items[0]
      expect(dotHdx).toMatchObject({ timestamp: '2026-06-24T00:00:00.000Z', volumeUsd: '150', pairVolumeUsd: '120.5', volumeBase: '25.25', volumeQuote: '1000.5' })
      expect(hdxDot).toMatchObject({ timestamp: '2026-06-24T00:00:00.000Z', pairVolumeUsd: '120.5', volumeBase: '1000.5', volumeQuote: '25.25' })
      // Both orientations read the one (lo, hi) key.
      const reads = probe.seen.filter(s => s.query.includes('-- pair-volume:stored') && !s.query.includes('stored-through'))
      expect(reads.map(r => [r.params.lo, r.params.hi])).toEqual([[0, 5], [0, 5]])
      // A closed-only window never builds the live tail.
      expect(probe.seen.some(s => s.query.includes('-- pair-volume:tail'))).toBe(false)
    } finally {
      await app2.close()
    }
  })

  it('builds the open bucket\'s pair volume from the unfolded tail up to the head, and the stored rows stop where the tail starts', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-08-17T11:58:00Z'), toFake: ['Date'] })
    try {
      const head = Date.parse('2026-08-17T11:57:00Z') / 1000
      const storedThrough = Date.parse('2026-08-17T11:00:00Z') / 1000
      const open = Date.parse('2026-08-17T11:55:00Z') / 1000
      const candle = (t: string, close: string) => ({ asset_id: 5, interval_start: t, open: '4', high: '5', low: '3', close, volume_total: '1' })
      // DOT (5) quoted in USDT (10): a USD-quoted series, but the pair volume is
      // still the DOT/USDT trades' — the quote is a real token.
      const probe = fakeClient({
        candles: { 5: [candle('2026-08-17 11:50:00', '4.2'), candle('2026-08-17 11:55:00', '4.3')] },
        headTime: head,
        storedThrough,
        pairVolumeTail: [
          { asset_lo: 5, asset_hi: 10, t: open, v: '7', v_lo_in: '7', a_lo: '1.5', a_hi: '7.01' },
          // Another pair's tail row is not this pair's volume.
          { asset_lo: 0, asset_hi: 5, t: open, v: '99', v_lo_in: '0', a_lo: '1', a_hi: '1' },
        ] as never,
      })
      const app2 = await freshApp(probe)
      try {
        const res = await app2.inject('/v1/prices/pair?assetIn=5&assetOut=10&bucket=5m&from=2026-08-17T11:50:00Z')
        const items = res.json().items as Array<{ timestamp: string; closed: boolean; pairVolumeUsd: string; volumeBase: string; volumeQuote: string }>
        const last = items.at(-1)!
        expect(last).toMatchObject({ timestamp: '2026-08-17T11:55:00.000Z', closed: false, volumeUsd: '1', pairVolumeUsd: '7', volumeBase: '1.5', volumeQuote: '7.01' })
        const stored = probe.seen.find(s => s.query.includes('-- pair-volume:stored\n'))
        expect(stored?.params.end).toBe(storedThrough)
        const tail = probe.seen.find(s => s.query.includes('-- pair-volume:tail'))
        expect(tail?.params).toEqual({ from: storedThrough, to: head })
      } finally {
        await app2.close()
      }
    } finally {
      vi.useRealTimers()
    }
  })
})





describe('GET /v1/prices/pair under PAIR_PRICE_SOURCE', () => {
  const S30 = (x: string) => `${x}.${'0'.repeat(30)}`
  const T = Date.parse('2026-06-24T00:00:00Z') / 1000
  // The fold covered both hours fully (the newest block of each ~2 s before its end).
  const COVERAGE = [{ h: T, lt: T + 3_598, full: 1 }, { h: T + 3_600, lt: T + 7_198, full: 1 }]
  const ROUTE = [{ lo: 5, hi: 10, t: T, open: S30('8'), high: S30('10'), low: S30('5'), close: S30('9'), complete: 1 }]

  it('is today\'s answer, byte for byte, while the source is usd-ratio, and reads no route candle', async () => {
    const probe = fakeClient({ route: ROUTE })
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject(`/v1/prices/pair?assetIn=5&assetOut=10&bucket=1h&${WINDOW}`)
      expect(res.body).toBe(JSON.stringify({
        referenceAsset: 'usd',
        items: [
          { timestamp: '2026-06-24T00:00:00.000Z', open: '4', high: '5', low: '3', close: '4.5', volumeUsd: '150', closed: true, ...NO_PAIR_VOLUME },
          { timestamp: '2026-06-24T01:00:00.000Z', open: '4.5', high: '4.8', low: '4.4', close: '4.6', volumeUsd: '30', closed: true, ...NO_PAIR_VOLUME },
        ],
      }))
      expect(probe.seen.some(s => s.query.includes('pair_route_ohlc'))).toBe(false)
    } finally {
      await app2.close()
    }
  })

  it('in route mode keeps referenceAsset usd while every candle is a USD candle, and marks a bucket the fold did not cover as a fallback', async () => {
    vi.stubEnv('PAIR_PRICE_SOURCE', 'route')
    // The fold covered the first hour (no route row: the Omnipool crossing) but not the second.
    const probe = fakeClient({ route: [], coverage: [COVERAGE[0]!] })
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject(`/v1/prices/pair?assetIn=5&assetOut=10&bucket=1h&${WINDOW}`)
      expect(res.json().referenceAsset).toBe('usd')
      expect(res.json().items.map((c: { priceSource: string }) => c.priceSource)).toEqual(['usd-ratio', 'usd-ratio-fallback'])
    } finally {
      vi.unstubAllEnvs()
      await app2.close()
    }
  })

  it('in route mode prices a covered bucket along the route against the token itself, keeping the volume', async () => {
    vi.stubEnv('PAIR_PRICE_SOURCE', 'route')
    const probe = fakeClient({ route: ROUTE, coverage: COVERAGE })
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject(`/v1/prices/pair?assetIn=5&assetOut=10&bucket=1h&${WINDOW}`)
      expect(res.json().items).toEqual([
        { timestamp: '2026-06-24T00:00:00.000Z', open: '8', high: '10', low: '5', close: '9', volumeUsd: '150', priceSource: 'route', closed: true, ...NO_PAIR_VOLUME },
        { timestamp: '2026-06-24T01:00:00.000Z', open: '4.5', high: '4.8', low: '4.4', close: '4.6', volumeUsd: '30', priceSource: 'usd-ratio', closed: true, ...NO_PAIR_VOLUME },
      ])
      // A route-priced candle is quoted in the token, so the series names it.
      expect(res.json().referenceAsset).toBe('10')
      // The cross path inverts a pair stored the other way round: DOT in HDX from (HDX, DOT).
      const probe2 = fakeClient({ coverage: COVERAGE, route: [{ lo: 0, hi: 5, t: T, open: '0.005' + '0'.repeat(27), high: '0.01' + '0'.repeat(28), low: '0.004' + '0'.repeat(27), close: '0.005' + '0'.repeat(27), complete: 1 }] })
      const app3 = await freshApp(probe2)
      try {
        const cross = await app3.inject(`/v1/prices/pair?assetIn=5&assetOut=0&bucket=1h&${WINDOW}`)
        expect(cross.json().items).toEqual([
          { timestamp: '2026-06-24T00:00:00.000Z', open: '200', high: '250', low: '100', close: '200', volumeUsd: '150', priceSource: 'route', closed: true, ...NO_PAIR_VOLUME },
        ])
      } finally {
        await app3.close()
      }
    } finally {
      vi.unstubAllEnvs()
      await app2.close()
    }
  })
})
