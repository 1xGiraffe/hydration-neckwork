import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

// Contract + semantics tests for GET /api/v1/fees/charts.
//
// This endpoint is a drop-in for hydration-metrics-aggregator, so the properties
// pinned here are the ones a base-URL swap must not change: the parameter names,
// the response shape the Hydration UI zod-parses, the bucket grid, the
// aggregate-per-stream rule, and the accepted filter matrix. Each stream's
// ClickHouse fold is pinned as a SQL-text invariant (the source rows are tens of
// thousands of legs a day, so the fold lives in the query), and everything the
// service does in TS is pinned end to end.

type Row = Record<string, unknown>

function result(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1, symbol: 'LRNA', name: 'LRNA', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
  { asset_id: 22, symbol: 'USDC', name: 'USD Coin', decimals: 6, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 39, symbol: 'PAXG', name: 'PAX Gold', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 690, symbol: '2-Pool-GDOT', name: '2-Pool-GDOT', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

vi.mock('../../src/services/poolService.ts', () => ({
  initPoolService: vi.fn(),
  getPoolsIndex: vi.fn(async () => ({ totalTvlUsd: 0, pools: [] })),
}))

interface Seen { query: string; params: Record<string, unknown> }

/** Dispatches on the marker comment each built query carries. */
function fakeClient(byMarker: Record<string, Row[]> = {}) {
  const seen: Seen[] = []
  return {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query, params: query_params ?? {} })
      if (query.includes('FROM price_data.assets FINAL')) return result(ASSET_ROWS)
      if (query.includes('Bonds.TokenCreated')) return result([])
      for (const [marker, rows] of Object.entries(byMarker)) {
        if (query.includes(marker)) return result(rows)
      }
      throw new Error(`unexpected query: ${query.slice(0, 160)}`)
    }),
  }
}

let stopAssets: () => void

beforeAll(async () => {
  const { loadExplorerAssets, stopExplorerAssetsRefresh } = await import('../../src/services/explorerAssets.ts')
  await loadExplorerAssets(fakeClient() as never)
  stopAssets = stopExplorerAssetsRefresh
})

afterAll(() => { stopAssets?.() })

async function buildApp(client: unknown): Promise<FastifyInstance> {
  const { buildPublicApp } = await import('../../src/public/app.ts')
  const app = await buildPublicApp({ client: client as never, logger: false })
  await app.ready()
  return app
}

const PATH = '/api/v1/fees/charts'

/** Each call gets its own window, so no test reads another's cache entry. */
let windowSeed = 0
function window(days = 7): { startTime: string; endTime: string } {
  windowSeed += 1
  const end = Date.UTC(2026, 7, 12) - windowSeed * 86_400_000
  return {
    startTime: new Date(end - days * 86_400_000).toISOString(),
    endTime: new Date(end - 1).toISOString(),
  }
}

function url(params: Record<string, string>): string {
  return `${PATH}?${new URLSearchParams(params).toString()}`
}

// ---------------------------------------------------------------------------

describe('bucket grid', () => {
  it('anchors 7day and 30day buckets on 2000-01-03, reproducing the incumbent grid', async () => {
    const { firstBucketStart, BUCKET_SECONDS, BUCKET_ORIGIN_EPOCH } = await import('../../src/public/services/feesCharts.ts')
    expect(BUCKET_ORIGIN_EPOCH).toBe(Math.floor(Date.parse('2000-01-03T00:00:00Z') / 1000))

    // The incumbent's ALL range (startTime 2025-02-17) answers with 30-day
    // buckets starting 2025-02-20, 2025-03-22, … — every one an exact multiple
    // of 30 days after the origin.
    const allStart = Math.floor(Date.parse('2025-02-17T00:00:00Z') / 1000)
    const first = firstBucketStart(allStart, BUCKET_SECONDS['30day'])
    expect(new Date(first * 1000).toISOString()).toBe('2025-02-20T00:00:00.000Z')
    expect(new Date((first + BUCKET_SECONDS['30day']) * 1000).toISOString()).toBe('2025-03-22T00:00:00.000Z')

    // 7-day buckets land on Mondays for the same reason.
    const weekStart = Math.floor(Date.parse('2025-08-11T00:00:00Z') / 1000)
    const week = firstBucketStart(weekStart, BUCKET_SECONDS['7day'])
    expect(new Date(week * 1000).toISOString()).toBe('2025-08-11T00:00:00.000Z')
    expect(new Date(week * 1000).getUTCDay()).toBe(1)
  })

  it('leaves hour and day buckets on plain UTC boundaries', async () => {
    const { firstBucketStart, BUCKET_SECONDS } = await import('../../src/public/services/feesCharts.ts')
    for (const size of ['1hour', '6hour', '24hour'] as const) {
      const t = Math.floor(Date.parse('2026-08-10T13:37:11Z') / 1000)
      const start = firstBucketStart(t, BUCKET_SECONDS[size])
      expect(start % BUCKET_SECONDS[size]).toBe(0)
    }
  })

  it('counts only buckets whose start falls inside the range', async () => {
    const { bucketCount } = await import('../../src/public/services/feesCharts.ts')
    const from = Math.floor(Date.parse('2026-08-04T00:00:00Z') / 1000)
    const to = Math.floor(Date.parse('2026-08-11T23:59:59Z') / 1000)
    expect(bucketCount(from, to, 86_400)).toBe(8)
    // A range shorter than one bucket contains no bucket start at all.
    expect(bucketCount(from + 60, from + 120, 86_400)).toBe(0)
  })
})

describe('periodAggregate', () => {
  it('sums every stream but hsm_revenue, which is the mean', async () => {
    const { AGGREGATE_MODE, aggregate } = await import('../../src/public/services/feesCharts.ts')
    expect(AGGREGATE_MODE.asset).toBe('sum')
    expect(AGGREGATE_MODE.protocol).toBe('sum')
    expect(AGGREGATE_MODE.liquidation_penalty).toBe('sum')
    expect(AGGREGATE_MODE.pepl_liquidation_profit).toBe('sum')
    expect(AGGREGATE_MODE.asset_reserve).toBe('sum')
    expect(AGGREGATE_MODE.borrow_apr).toBe('sum')
    // hsm_revenue is refused rather than served (HSM_REVENUE_UNSUPPORTED); its
    // entry records the incumbent's rule for the day it becomes reproducible.
    // Measured: 2026-07-28/29 returned 58.599 and 29.087 with a periodAggregate
    // of 43.843 — their mean, not their sum.
    expect(AGGREGATE_MODE.hsm_revenue).toBe('mean')
    expect(aggregate([58.59941898053752, 29.086591819878024], 'mean')).toBeCloseTo(43.84300540020777, 10)
  })

  it('is 0 for an empty series rather than NaN', async () => {
    const { aggregate } = await import('../../src/public/services/feesCharts.ts')
    expect(aggregate([], 'mean')).toBe(0)
    expect(aggregate([], 'sum')).toBe(0)
  })
})

describe('stream SQL', () => {
  async function build(streamType: 'asset' | 'protocol' | 'liquidation_penalty' | 'pepl_liquidation_profit' | 'asset_reserve' | 'hsm_revenue', destination: string = 'protocol') {
    const { buildFeesStreamSql } = await import('../../src/public/services/feesCharts.ts')
    return buildFeesStreamSql(streamType, destination as never)
  }

  it('serves every event stream from revenue_events plus the shared builder tail', async () => {
    // One source of truth: the cold arm reads the derivations-built canonical
    // table and the tail runs the SAME definition (services/revenueStreams.ts,
    // its marker comment travels with it) over raw. A stream defined twice
    // would let the public series and the explorer drift apart.
    const markers = {
      asset: '-- rev:omnipool_asset_fee',
      protocol: '-- rev:omnipool_protocol_fee',
      liquidation_penalty: '-- rev:liquidation_penalty',
      pepl_liquidation_profit: '-- rev:pepl_liquidation_profit',
      asset_reserve: '-- rev:asset_reserve',
      hsm_revenue: '-- rev:hsm_revenue',
    } as const
    for (const [streamType, marker] of Object.entries(markers)) {
      const sql = await build(streamType as never, streamType === 'asset' ? 'total' : 'protocol')
      expect(sql, streamType).toContain('FROM price_data.revenue_events')
      expect(sql, streamType).toContain(marker)
    }
  })

  // The split's correctness is entirely in where the two arms are cut.
  describe('cold/tail split', () => {
    it('cuts both arms at one shared mark, resolved exactly once', async () => {
      // A scalar WITH alias is evaluated once and substituted as a constant;
      // written as repeated subqueries, a REPLACE PARTITION landing between two
      // evaluations could move the mark mid-query and leave the arms
      // overlapping on an hour or straddling a gap.
      const sql = await build('asset', 'total')
      expect(sql.match(/SELECT max\(block_timestamp\) FROM price_data\.revenue_events/g)).toHaveLength(1)
      expect(sql).toContain('AS cold_mark')
      expect(sql).toContain('block_timestamp <= cold_mark')
      expect(sql).toContain('block_timestamp > cold_mark')
    })

    it('has no readiness gate on the derived table', async () => {
      // max() of an empty DateTime column is the epoch, which puts the mark
      // below every event and hands the whole range to the raw arm — a
      // performance split, never a coverage gate.
      const sql = await build('liquidation_penalty')
      expect(sql).not.toMatch(/readiness|coverage|EXISTS \(SELECT 1 FROM price_data\.revenue_events\)/i)
    })

    it('bounds both arms by the same anchored window and bucket-start rule', async () => {
      const sql = await build('hsm_revenue')
      expect(sql).toContain('block_timestamp > {anchor:DateTime} - INTERVAL {hours:UInt32} HOUR')
      expect(sql).toContain('WHERE bucket_start >= {start:DateTime} AND bucket_start <= {end:DateTime}')
      expect(sql.trimEnd().endsWith('ORDER BY bucket_start')).toBe(true)
    })
  })

  it('maps the destination matrix onto the rows destination class', async () => {
    // asset: lp = the pool account's share; protocol = routed out or burned;
    // total = everything including the legacy pre-2025-01-25 legs whose
    // destination the chain never recorded (counted in total, claimed by
    // neither share). hub: every destination is protocol revenue, burned is
    // the burn component alone.
    expect(await build('asset', 'lp')).toContain("dest = 'lp'")
    expect(await build('asset', 'protocol')).toContain("dest IN ('protocol', 'burned')")
    expect(await build('asset', 'total')).not.toContain("dest = 'lp'")
    expect(await build('protocol', 'burned')).toContain("(dest = 'burned')")
    expect(await build('protocol', 'total')).not.toContain("(dest = 'burned')")
  })

  it('splits the Omnipool hub fee from the per-asset fee in the tail definition', async () => {
    expect(await build('asset', 'total')).toContain('asset_id != 1')
    expect(await build('protocol', 'total')).toContain('asset_id = 1')
    expect(await build('asset', 'total')).toContain("leg_kind = 'fee'")
  })

  it('deduplicates a replayed range before summing, on every event-shaped tail', async () => {
    for (const streamType of ['asset', 'liquidation_penalty', 'pepl_liquidation_profit', 'asset_reserve', 'hsm_revenue'] as const) {
      const sql = await build(streamType, streamType === 'asset' ? 'total' : 'protocol')
      expect(sql, streamType).toMatch(/FINAL|argMax/)
    }
  })

  it('leads the HOLLAR debt window in by one hour so the first hour can be differenced', async () => {
    const { buildHollarDebtSql } = await import('../../src/public/services/feesCharts.ts')
    const from = Math.floor(Date.parse('2026-08-04T00:00:00Z') / 1000)
    const sql = buildHollarDebtSql(3_600, from - 3_600, from + 7 * 86_400)
    expect(sql).toContain('bucket_seconds = 3600')
    expect(sql).toContain("start_time = '2026-08-03 23:00:00'")
    expect(sql).toContain("end_time = '2026-08-11 00:00:00'")
  })
})

describe('request validation', () => {
  it('accepts every combination the incumbent accepts', async () => {
    const { FEES_COMBINATIONS, isValidCombination } = await import('../../src/public/services/feesCharts.ts')
    // The seven the UI fires, in both of its view modes.
    for (const combo of [
      ['omnipool', 'asset', 'protocol'], ['omnipool', 'protocol', 'protocol'],
      ['omnipool', 'asset', 'total'], ['omnipool', 'protocol', 'total'],
      ['money-market', 'liquidation_penalty', 'protocol'],
      ['money-market', 'pepl_liquidation_profit', 'protocol'],
      ['money-market', 'asset_reserve', 'protocol'],
      ['hollar', 'borrow_apr', 'protocol'], ['hollar', 'hsm_revenue', 'protocol'],
    ]) expect(isValidCombination(combo[0], combo[1], combo[2]), combo.join('+')).toBe(true)
    expect(FEES_COMBINATIONS.length).toBe(11)
    expect(isValidCombination('hollar', 'asset', 'protocol')).toBe(false)
    expect(isValidCombination('omnipool', 'hsm_revenue', 'protocol')).toBe(false)
  })

  it('rejects a mismatched product/stream pair with the valid matrix', async () => {
    const app = await buildApp(fakeClient())
    const res = await app.inject({ method: 'GET', url: url({
      productType: 'omnipool', streamType: 'hsm_revenue', feeDestination: 'protocol',
      bucketSize: '24hour', ...window(),
    }) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toContain('omnipool+asset+protocol')
    await app.close()
  })

  it('refuses streamType=total by name, explaining that its shape differs', async () => {
    const app = await buildApp(fakeClient())
    const res = await app.inject({ method: 'GET', url: url({
      productType: 'omnipool', streamType: 'total', bucketSize: '24hour', ...window(),
    }) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toContain('composite object')
    await app.close()
  })

  it('serves hsm_revenue through the fill-derived SQL', async () => {
    const app = await buildApp(fakeClient({ '-- pub:fees:hsm-revenue': [] }))
    const res = await app.inject({ method: 'GET', url: url({
      productType: 'hollar', streamType: 'hsm_revenue', feeDestination: 'protocol',
      bucketSize: '24hour', ...window(),
    }) })
    // Once refused (the arb legs were thought unindexed), now served: the
    // arbitrage's own pool trade is in pool_swap_legs with the executor as
    // swapper, so the profit is read per fill.
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [], periodAggregate: 0 })
    await app.close()
  })

  it('refuses a timestamp with no zone rather than reading it as local time', async () => {
    const app = await buildApp(fakeClient({ '-- pub:fees:omnipool': [] }))
    const bare = await app.inject({ method: 'GET', url: url({
      productType: 'omnipool', streamType: 'asset', feeDestination: 'protocol', bucketSize: '24hour',
      startTime: '2026-08-04T00:00:00', endTime: '2026-08-11T23:59:59',
    }) })
    expect(bare.statusCode).toBe(400)
    // An offset is fine, and so is a date, which ISO-8601 defines as UTC.
    for (const [startTime, endTime] of [
      ['2026-08-04T00:00:00+02:00', '2026-08-11T23:59:59+02:00'],
      ['2026-08-04', '2026-08-11'],
    ]) {
      const res = await app.inject({ method: 'GET', url: url({
        productType: 'omnipool', streamType: 'asset', feeDestination: 'protocol', bucketSize: '24hour',
        startTime, endTime,
      }) })
      expect(res.statusCode, `${startTime}`).toBe(200)
    }
    await app.close()
  })

  it('refuses a range whose bucket count is unbounded in two parameters', async () => {
    const app = await buildApp(fakeClient())
    const res = await app.inject({ method: 'GET', url: url({
      productType: 'omnipool', streamType: 'asset', feeDestination: 'protocol', bucketSize: '1hour',
      startTime: '2025-02-17T00:00:00.000Z', endTime: '2026-08-11T23:59:59.999Z',
    }) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toContain('the limit is 5000')
    await app.close()
  })

  it('refuses a reversed range and an unknown bucket size', async () => {
    const app = await buildApp(fakeClient())
    const reversed = await app.inject({ method: 'GET', url: url({
      productType: 'omnipool', streamType: 'asset', feeDestination: 'protocol', bucketSize: '24hour',
      startTime: '2026-08-11T00:00:00.000Z', endTime: '2026-08-04T00:00:00.000Z',
    }) })
    expect(reversed.statusCode).toBe(400)
    const bucket = await app.inject({ method: 'GET', url: url({
      productType: 'omnipool', streamType: 'asset', feeDestination: 'protocol', bucketSize: '12hour', ...window(),
    }) })
    expect(bucket.statusCode).toBe(400)
    await app.close()
  })

  it('defaults feeDestination to protocol, as the money-market and hollar streams always send it', async () => {
    const rows = [{ bucket: '2026-08-04 00:00:00', value: '1.5' }]
    const app = await buildApp(fakeClient({ '-- pub:fees:asset-reserve': rows }))
    const res = await app.inject({ method: 'GET', url: url({
      productType: 'money-market', streamType: 'asset_reserve', bucketSize: '24hour', ...window(),
    }) })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

describe('response', () => {
  /** The Hydration UI's own parser, replicated from apps/main/src/api/stats.ts. */
  const chartDataSchema = z.object({
    data: z.array(z.object({ timestamp: z.string(), value: z.number() })),
    periodAggregate: z.number(),
  })

  it('parses under the UI schema and renders bucket starts as ISO-with-millis', async () => {
    const rows = [
      { bucket: '2026-08-04 00:00:00', value: '353.405901418222' },
      { bucket: '2026-08-05 00:00:00', value: '381.049513975733' },
    ]
    const app = await buildApp(fakeClient({ '-- pub:fees:omnipool': rows }))
    const res = await app.inject({ method: 'GET', url: url({
      productType: 'omnipool', streamType: 'asset', feeDestination: 'protocol',
      bucketSize: '24hour', ...window(),
    }) })
    expect(res.statusCode).toBe(200)
    const parsed = chartDataSchema.parse(res.json())
    expect(parsed.data.map(p => p.timestamp)).toEqual([
      '2026-08-04T00:00:00.000Z', '2026-08-05T00:00:00.000Z',
    ])
    expect(parsed.data[0].value).toBeCloseTo(353.405901418222, 9)
    expect(parsed.periodAggregate).toBeCloseTo(734.455415393955, 9)
    await app.close()
  })

  // The parse above proves the types the UI validates; this pins the serialized
  // document, which the schema cannot express. The incumbent aggregator is not
  // reachable from this host, so the reference is the shape recorded off it in
  // task-b2-report.md and reconfirmed live on api-public 2026-08-13:
  //   {"data":[{"timestamp":"2026-08-06T00:00:00.000Z","value":440.352085412421}],
  //    "periodAggregate":1756.9516986682381}
  it('serves the incumbent\'s two top-level keys in order, with numeric values', async () => {
    const rows = [{ bucket: '2026-08-04 00:00:00', value: '353.405901418222' }]
    const app = await buildApp(fakeClient({ '-- pub:fees:omnipool': rows }))
    const res = await app.inject({ method: 'GET', url: url({
      productType: 'omnipool', streamType: 'asset', feeDestination: 'protocol',
      bucketSize: '24hour', ...window(),
    }) })
    const body = res.json() as { data: Record<string, unknown>[]; periodAggregate: unknown }
    // A JS object's key order IS its wire order.
    expect(Object.keys(body)).toEqual(['data', 'periodAggregate'])
    expect(Object.keys(body.data[0])).toEqual(['timestamp', 'value'])
    expect(typeof body.data[0].timestamp).toBe('string')
    expect(typeof body.data[0].value).toBe('number')
    expect(typeof body.periodAggregate).toBe('number')
    // JSON numbers, not the decimal strings the /v1 surfaces carry — the
    // inherited-contract exception this route documents.
    expect(res.body).not.toMatch(/"(value|periodAggregate)":\s*"/)
    await app.close()
  })

  it('is an empty series, not a zero one, when a stream has no rows in the window', async () => {
    const app = await buildApp(fakeClient({ '-- pub:fees:asset-reserve': [] }))
    const res = await app.inject({ method: 'GET', url: url({
      productType: 'money-market', streamType: 'asset_reserve', feeDestination: 'protocol',
      bucketSize: '24hour', ...window(),
    }) })
    expect(res.json()).toEqual({ data: [], periodAggregate: 0 })
    await app.close()
  })

  it('declares its own 5-minute freshness rather than inheriting a neighbour TTL', async () => {
    const app = await buildApp(fakeClient({ '-- pub:fees:omnipool': [] }))
    const res = await app.inject({ method: 'GET', url: url({
      productType: 'omnipool', streamType: 'protocol', feeDestination: 'protocol',
      bucketSize: '24hour', ...window(),
    }) })
    expect(res.headers['cache-control']).toBe('public, max-age=300')
    await app.close()
  })

  it('passes the bucket width and the grid-aligned window down to ClickHouse', async () => {
    const client = fakeClient({ '-- pub:fees:omnipool': [] })
    const app = await buildApp(client)
    await app.inject({ method: 'GET', url: url({
      productType: 'omnipool', streamType: 'asset', feeDestination: 'total', bucketSize: '7day',
      startTime: '2026-08-04T12:00:00.000Z', endTime: '2026-08-11T23:59:59.000Z',
    }) })
    const call = client.seen.find(s => s.query.includes('-- pub:fees:omnipool'))
    expect(call?.params.bucket).toBe(604_800)
    // 2026-08-04T12:00Z is mid-week; the first 7-day grid point at or after it is
    // the following Monday.
    expect(call?.params.start).toBe('2026-08-10 00:00:00')
    await app.close()
  })
})

describe('hollar borrow interest', () => {
  it('differences the borrow index hourly and folds the hours into the response bucket', async () => {
    // RAY = 1e27. A 1e27-scaled debt whose index moves by 1e21 accrues
    // 1e27 * 1e21 / 1e27 = 1e21 planck, and HOLLAR is 18-decimal, so 1000 HOLLAR
    // — priced here at $1. Two such hours land in one 24hour bucket.
    const debt = [
      { bucket: '2026-08-03 23:00:00', pool_address: 'core', debt_scaled: '1000000000000000000000000000', borrow_index: '1000000000000000000000000000' },
      { bucket: '2026-08-04 00:00:00', pool_address: 'core', debt_scaled: '1000000000000000000000000000', borrow_index: '1000001000000000000000000000' },
      { bucket: '2026-08-04 01:00:00', pool_address: 'core', debt_scaled: '1000000000000000000000000000', borrow_index: '1000002000000000000000000000' },
    ]
    const price = [
      { bucket: '2026-08-04 00:00:00', close: '1' },
      { bucket: '2026-08-04 01:00:00', close: '1' },
    ]
    const app = await buildApp(fakeClient({ '-- pub:fees:hollar-debt': debt, '-- pub:fees:hollar-price': price }))
    const res = await app.inject({ method: 'GET', url: url({
      productType: 'hollar', streamType: 'borrow_apr', feeDestination: 'protocol', bucketSize: '24hour',
      startTime: '2026-08-04T00:00:00.000Z', endTime: '2026-08-04T23:59:59.000Z',
    }) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].timestamp).toBe('2026-08-04T00:00:00.000Z')
    expect(body.data[0].value).toBeCloseTo(2_000, 6)
    await app.close()
  })

  it('advances closed prices through debt gaps without leaking a future price across markets', async () => {
    const debt = [
      // Insert core first so the old shared-lastPrice implementation walked its
      // later observation before it started gigahdx's earlier series.
      { bucket: '2026-08-04 23:00:00', pool_address: 'core', debt_scaled: '1000000000000000000000000000', borrow_index: '1000000000000000000000000000' },
      { bucket: '2026-08-05 02:00:00', pool_address: 'core', debt_scaled: '1000000000000000000000000000', borrow_index: '1000001000000000000000000000' },
      { bucket: '2026-08-04 23:00:00', pool_address: 'gigahdx', debt_scaled: '1000000000000000000000000000', borrow_index: '1000000000000000000000000000' },
      { bucket: '2026-08-05 00:00:00', pool_address: 'gigahdx', debt_scaled: '1000000000000000000000000000', borrow_index: '1000001000000000000000000000' },
    ]
    const price = [
      // Usable at 23:00 from the prior closed candle. There is deliberately no
      // exact 00:00 price, so gigahdx must carry $0.50 forward.
      { bucket: '2026-08-04 23:00:00', close: '0.5' },
      // This becomes usable while core has no debt observation. Its 02:00
      // accrual must still use $2, but it must never flow backwards into the
      // other market's 00:00 accrual.
      { bucket: '2026-08-05 01:00:00', close: '2' },
    ]
    const app = await buildApp(fakeClient({ '-- pub:fees:hollar-debt': debt, '-- pub:fees:hollar-price': price }))
    const res = await app.inject({ method: 'GET', url: url({
      productType: 'hollar', streamType: 'borrow_apr', feeDestination: 'protocol', bucketSize: '24hour',
      startTime: '2026-08-05T00:00:00.000Z', endTime: '2026-08-05T23:59:59.000Z',
    }) })
    expect(res.statusCode).toBe(200)
    // 1,000 HOLLAR × $2 in core + 1,000 × $0.50 in gigahdx.
    expect(res.json().data[0].value).toBeCloseTo(2_500, 6)
    await app.close()
  })

  it('renders nothing at all when the money-market anchor is not snapshotted', async () => {
    // clickhouse/schema/007_money_market_history.sql: an empty view result means
    // "no model here", and a zeroed series would report the protocol as earning
    // nothing rather than as unmeasured.
    const client = fakeClient({ '-- pub:fees:hollar-debt': [], '-- pub:fees:hollar-price': [] })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: url({
      productType: 'hollar', streamType: 'borrow_apr', feeDestination: 'protocol',
      bucketSize: '24hour', ...window(),
    }) })
    expect(res.json()).toEqual({ data: [], periodAggregate: 0 })
    // The price read is skipped entirely — there is nothing to value.
    expect(client.seen.some(s => s.query.includes('-- pub:fees:hollar-price'))).toBe(false)
    await app.close()
  })
})
