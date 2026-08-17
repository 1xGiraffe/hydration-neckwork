import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// Contract + semantics tests for the DefiLlama facade.
//
// The endpoints exist to replace HydraDX-api's /defillama/v1/* by a base-URL
// swap, so the shapes here are the incumbent's (JSON numbers, `volume_usd`,
// `dailyFees`) rather than the /v1 wire conventions. What this file pins is
// everything that decides the NUMBERS: the calendar-day bucketing, the
// closed-day rule, the netting definition, the fee-destination split, and the
// request bounds. The per-day fold itself runs in ClickHouse, so the rules that
// live in SQL are pinned as SQL-text invariants and measured against the live
// data lake in the task report.
type Row = Record<string, unknown>

function result(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1, symbol: 'H2O', name: 'H2O', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
]

/** The anchor probe's answer: the newest indexed block is mid-way through 2026-08-12. */
const ANCHOR_ROW: Row = { legs: '4200', anchor: '2026-08-12 18:22:36', block_height: 9123456 }

/** The leg head: the newest projected FILL, mid-way through 2026-08-12. */
const LEG_HEAD_ROW: Row = { head: '2026-08-12 18:22:36' }

interface Seen { query: string; params: Record<string, unknown> }

function fakeClient(byMarker: Record<string, Row[] | ((params: Record<string, unknown>) => Row[])> = {}) {
  const seen: Seen[] = []
  const client = {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      const params = query_params ?? {}
      seen.push({ query, params })
      if (query.includes('FROM price_data.assets FINAL')) return result(ASSET_ROWS)
      if (query.includes('Bonds.TokenCreated')) return result([])
      for (const [marker, rows] of Object.entries(byMarker)) {
        if (query.includes(marker)) return result(typeof rows === 'function' ? rows(params) : rows)
      }
      // The chunk-size probe defaults to knowing nothing, which is the "aggregate
      // empty or lagging" case: splitByLegs then leaves every month whole, so a
      // test that says nothing about it sees exactly the calendar-month chunking
      // that preceded the size split. A test exercising the split overrides it.
      if (query.includes('-- pub:dl:day-legs')) return result([])
      throw new Error(`unexpected query: ${query.slice(0, 160)}`)
    }),
  }
  return client
}

/** A day row as ClickHouse returns it: quoted Decimal(38,12) strings. */
function dayRow(day: string, volume: string, total = '0', account = '0', burned = '0', unknown = '0', hub = '0'): Row {
  return {
    day,
    volume_usd: volume,
    fee_total_usd: total,
    fee_account_usd: account,
    fee_burned_usd: burned,
    fee_unknown_usd: unknown,
    fee_hub_usd: hub,
  }
}

let stopAssets: () => void

beforeAll(async () => {
  const { loadExplorerAssets, stopExplorerAssetsRefresh } = await import('../../src/services/explorerAssets.ts')
  await loadExplorerAssets(fakeClient() as never)
  stopAssets = stopExplorerAssetsRefresh
})

afterAll(() => { stopAssets?.() })

async function buildApp(client: ReturnType<typeof fakeClient>): Promise<FastifyInstance> {
  const { buildPublicApp } = await import('../../src/public/app.ts')
  return buildPublicApp({ client: client as never, logger: false })
}

describe('backfill range validation', () => {
  it('accepts a single day and rejects an inverted range', async () => {
    const { MAX_BACKFILL_DAYS, backfillRangeError } = await import('../../src/public/services/defillama.ts')
    expect(backfillRangeError('2026-01-05', '2026-01-05')).toBeNull()
    expect(backfillRangeError('2026-01-05', '2026-01-04')).toMatch(/before/i)
    expect(MAX_BACKFILL_DAYS).toBeGreaterThan(30)
  })

  it('rejects a range past the day cap, counting both endpoints', async () => {
    const { MAX_BACKFILL_DAYS, backfillRangeError } = await import('../../src/public/services/defillama.ts')
    const start = Date.UTC(2024, 0, 1)
    const day = (n: number) => new Date(start + n * 86_400_000).toISOString().slice(0, 10)
    // endDate is inclusive, so the cap counts N days from N-1 days of span.
    expect(backfillRangeError(day(0), day(MAX_BACKFILL_DAYS - 1))).toBeNull()
    expect(backfillRangeError(day(0), day(MAX_BACKFILL_DAYS))).toMatch(new RegExp(`${MAX_BACKFILL_DAYS}`))
  })

  it('rejects a date that is not a real calendar day', async () => {
    const { backfillRangeError } = await import('../../src/public/services/defillama.ts')
    expect(backfillRangeError('2026-02-30', '2026-03-01')).toMatch(/calendar/i)
    expect(backfillRangeError('2026-13-01', '2026-13-02')).toMatch(/calendar/i)
  })
})

describe('monthChunks', () => {
  it('splits a range on UTC month boundaries and clips both ends', async () => {
    const { monthChunks } = await import('../../src/public/services/defillama.ts')
    expect(monthChunks('2026-01-15', '2026-03-02')).toEqual([
      { from: '2026-01-15', to: '2026-02-01' },
      { from: '2026-02-01', to: '2026-03-01' },
      { from: '2026-03-01', to: '2026-03-02' },
    ])
  })

  it('leaves a range inside one month whole, and crosses a year boundary', async () => {
    const { monthChunks } = await import('../../src/public/services/defillama.ts')
    expect(monthChunks('2026-01-05', '2026-01-09')).toEqual([{ from: '2026-01-05', to: '2026-01-09' }])
    expect(monthChunks('2025-12-30', '2026-01-02')).toEqual([
      { from: '2025-12-30', to: '2026-01-01' },
      { from: '2026-01-01', to: '2026-01-02' },
    ])
  })

  it('is empty when the range is empty', async () => {
    const { monthChunks } = await import('../../src/public/services/defillama.ts')
    expect(monthChunks('2026-01-05', '2026-01-05')).toEqual([])
  })
})

// A calendar month is the wrong unit for a cost bound: the fold's cost tracks the
// LEG COUNT in its range, and the busiest month measured 10.0 s at 2.56 GiB — 69 %
// of the memory cap today and over it at 3 x the block rate. splitByLegs
// subdivides a month so the bound is on legs instead, which also makes it
// cadence-proof (the same leg count costs the same whenever it was produced).
describe('splitByLegs', () => {
  const load = () => import('../../src/public/services/defillama.ts')
  const legs = (entries: Array<[string, number]>) => new Map(entries)

  it('cuts before crossing the cap, never after', async () => {
    const { splitByLegs } = await load()
    // 4 days of 400 each, cap 1000: 2 + 2, because adding a third would reach 1200.
    const out = splitByLegs({ from: '2026-01-01', to: '2026-01-05' }, legs([
      ['2026-01-01', 400], ['2026-01-02', 400], ['2026-01-03', 400], ['2026-01-04', 400],
    ]), 1000)
    expect(out).toEqual([
      { from: '2026-01-01', to: '2026-01-03' },
      { from: '2026-01-03', to: '2026-01-05' },
    ])
  })

  it('keeps a whole day in one chunk even when the day alone exceeds the cap', async () => {
    const { splitByLegs } = await load()
    // A day is the fold's output granularity: splitting one would leave a chunk
    // holding a partial day, which is the one thing that makes chunking
    // arithmetic-dependent. The oversized day rides alone and exceeds the cap.
    const out = splitByLegs({ from: '2026-01-01', to: '2026-01-04' }, legs([
      ['2026-01-01', 100], ['2026-01-02', 5000], ['2026-01-03', 100],
    ]), 1000)
    expect(out).toEqual([
      { from: '2026-01-01', to: '2026-01-02' },
      { from: '2026-01-02', to: '2026-01-03' },
      { from: '2026-01-03', to: '2026-01-04' },
    ])
    // Every day still appears in exactly one chunk, which is what makes the split
    // invisible in the response.
    expect(out[0].to).toBe(out[1].from)
    expect(out[1].to).toBe(out[2].from)
  })

  it('leaves a light month as a single chunk', async () => {
    const { splitByLegs } = await load()
    const month = { from: '2026-01-01', to: '2026-02-01' }
    expect(splitByLegs(month, legs([['2026-01-01', 10]]), 1_500_000)).toEqual([month])
  })

  // The hint is a SIZE input, never a correctness input. An empty or stale
  // aggregate can only make chunks the wrong size — it can never change a value,
  // because boundaries are midnights and the per-day rows concatenate.
  it('degrades to one chunk when the aggregate knows nothing', async () => {
    const { splitByLegs } = await load()
    const month = { from: '2026-01-01', to: '2026-02-01' }
    expect(splitByLegs(month, legs([]), 1_500_000)).toEqual([month])
  })

  it('covers the month exactly, with no gap or overlap, for any cap', async () => {
    const { splitByLegs } = await load()
    const month = { from: '2025-05-01', to: '2025-06-01' }
    const byDay = legs(Array.from({ length: 31 }, (_, i) =>
      [`2025-05-${String(i + 1).padStart(2, '0')}`, 150_000] as [string, number]))
    for (const cap of [1, 100_000, 300_000, 1_500_000, 10_000_000]) {
      const out = splitByLegs(month, byDay, cap)
      expect(out[0].from, `cap ${cap}`).toBe(month.from)
      expect(out[out.length - 1].to, `cap ${cap}`).toBe(month.to)
      for (let i = 1; i < out.length; i++) expect(out[i].from, `cap ${cap}`).toBe(out[i - 1].to)
    }
  })

  it('is calibrated so the worst chunk stays well inside the memory cap', async () => {
    const { MAX_CHUNK_LEGS } = await load()
    // Measured: 1,415,954 legs → 1.00 GiB, 4,647,377 → 2.56 GiB against a 3.73 GiB
    // cap. 1.5 M keeps the worst chunk near 1 GiB with ~3.5x headroom, and because
    // the bound counts legs it does not move when the block time does.
    expect(MAX_CHUNK_LEGS).toBe(1_500_000)
  })
})

describe('buildDayLegsSql', () => {
  it('reads the pre-aggregate, not the leg projection', async () => {
    const { buildDayLegsSql } = await import('../../src/public/services/defillama.ts')
    const sql = buildDayLegsSql()
    // leg_count is already deduplicated, so the probe is a sum over a few thousand
    // rows instead of a count over 65 M legs — which is what makes size-aware
    // chunking affordable on every cold request.
    expect(sql).toContain('FROM price_data.pool_swap_hourly')
    expect(sql).toContain('sum(leg_count)')
    expect(sql).not.toContain('pool_swap_legs')
    // Half-open on the same midnights the chunks use, so the hint counts each day
    // exactly once.
    expect(sql).toContain("hour >= toDateTime({from:String}, 'UTC')")
    expect(sql).toContain("hour < toDateTime({to:String}, 'UTC')")
  })
})

describe('daily SQL invariants', () => {
  it('deduplicates the replaceable leg identity before any sum', async () => {
    const { buildDailySql } = await import('../../src/public/services/defillama.ts')
    const sql = buildDailySql()
    // pool_swap_legs is ReplacingMergeTree(ingested_at): a replayed range inserts
    // a second copy of every leg, so the newest copy per leg identity wins BEFORE
    // the amounts are summed.
    expect(sql).toMatch(/GROUP BY venue, pool_key, block_height, event_index, leg_kind, leg_index/)
    expect(sql).toMatch(/argMax\(amount, ingested_at\)/)
  })

  it('reads a half-open calendar range and buckets by the UTC day', async () => {
    const { buildDailySql } = await import('../../src/public/services/defillama.ts')
    const sql = buildDailySql()
    // Half-open: a block whose timestamp is exactly midnight belongs to the day
    // that starts there, and to exactly one chunk of a chunked request.
    expect(sql).toContain("block_timestamp >= toDateTime({from:String}, 'UTC')")
    expect(sql).toContain("block_timestamp < toDateTime({to:String}, 'UTC')")
    // The bucket is a UTC calendar day even if the server's session timezone
    // ever stops being UTC.
    expect(sql).toContain("toDate(min(block_time), 'UTC')")
  })

  it('prices every leg at a candle that had closed before the fill', async () => {
    const { buildDailySql } = await import('../../src/public/services/defillama.ts')
    const sql = buildDailySql()
    expect(sql).toContain('interval_start + INTERVAL 1 HOUR AS price_time')
    expect(sql).toContain('p.price_time <= l.block_time')
    expect(sql).toContain('ASOF LEFT JOIN')
    // The candle window covers the range plus the staleness lookback, so a leg at
    // the very start of the range still finds the price that preceded it.
    expect(sql).toContain("interval_start > toDateTime({from:String}, 'UTC') - INTERVAL 30 DAY")
  })

  it('counts a trade once, at the larger of its two boundary sides', async () => {
    const { buildDailySql } = await import('../../src/public/services/defillama.ts')
    const sql = buildDailySql()
    // The SQL form of nettedTradeScaled — the two must not drift, because the
    // rolling /volume endpoint nets in TS and the backfill nets here.
    expect(sql).toContain('greatest(sum(greatest(-net_usd, toDecimal256(0, 12))), sum(greatest(net_usd, toDecimal256(0, 12))))')
    expect(sql).toContain('GROUP BY day, trade_key')
  })

  it('never lets a fee leg reach the volume total', async () => {
    const { buildDailySql } = await import('../../src/public/services/defillama.ts')
    const sql = buildDailySql()
    // net_usd is the only input to a side, and it sums in/out legs only: a
    // stableswap fee is already inside the trade's own amounts, so adding fee
    // legs to trade legs would count the same value twice.
    expect(sql).toContain("sum(multiIf(leg_kind = 'out', usd, leg_kind = 'in', -usd, toDecimal256(0, 12))) AS net_usd")
    const volumeExpression = sql.slice(sql.lastIndexOf('SELECT day,'), sql.indexOf(' AS volume,'))
    expect(volumeExpression).not.toContain('fee')
  })

  it('splits fee legs by destination and never merges the unknown class into accrued', async () => {
    const { buildDailySql } = await import('../../src/public/services/defillama.ts')
    const sql = buildDailySql()
    // Legacy Omnipool asset-fee legs carry fee_dest '' — the event names no
    // destination and the era boundary measured the fee reaching three different
    // recipients, so '' is unknown, never "accrued to an account".
    // The published total is its own sum over every fee leg, so a destination
    // class nobody has seen yet still lands in dailyFees instead of vanishing.
    expect(sql).toContain("sumIf(usd, leg_kind = 'fee') AS fee_total")
    expect(sql).toContain("sumIf(usd, leg_kind = 'fee' AND fee_dest = 'account') AS fee_account")
    expect(sql).toContain("sumIf(usd, leg_kind = 'fee' AND fee_dest = 'burned') AS fee_burned")
    expect(sql).toContain("sumIf(usd, leg_kind = 'fee' AND fee_dest = '') AS fee_unknown")
    expect(sql).toContain("sumIf(usd, leg_kind = 'fee' AND asset_id = 1) AS fee_hub")
  })

  it('drops a trade whose every fill is an aToken wrap, on both netted surfaces', async () => {
    const { buildDailySql } = await import('../../src/public/services/defillama.ts')
    const { buildRoutedTradesSql } = await import('../../src/public/services/poolVolumes.ts')
    for (const sql of [buildDailySql(), buildRoutedTradesSql()]) {
      // An aToken mint/redeem is a 1:1 money-market wrap, not a swap, and both
      // of these totals are published as DEX volume.
      expect(sql).toContain("venue = 'aave' AS is_aave")
      expect(sql).toContain('min(is_aave) AS all_aave')
      // The filter is at the TRADE stage, never on the legs: an aave leg inside
      // a routed swap is a real hop, and it already cancels in the per-asset
      // net, so removing it would break the trade's two boundary sides.
      expect(sql).toContain('HAVING min(all_aave) = 0')
      expect(sql).not.toMatch(/WHERE[^)]*venue != 'aave'/)
    }
    // Both surfaces filter at their own trade-level GROUP BY, so neither can
    // inherit the other's — /defillama/v1/volume and /v1/stats/platform read
    // buildRoutedTradesSql, /defillama/v1/backfill reads buildDailySql.
    expect(buildRoutedTradesSql()).toContain('GROUP BY trade_key\n  HAVING min(all_aave) = 0')
    expect(buildDailySql()).toContain('GROUP BY day, trade_key\n  HAVING min(all_aave) = 0')
  })

  it('reads the range exactly once — every stage is referenced by one other stage', async () => {
    const { buildDailySql } = await import('../../src/public/services/defillama.ts')
    const sql = buildDailySql()
    // ClickHouse inlines a CTE at EVERY reference and re-reads it there; a
    // multi-month range cannot afford a second scan.
    const references = (cte: string): number =>
      (sql.match(new RegExp(`\\b${cte}\\b`, 'g')) ?? []).length - (sql.includes(`${cte} AS (`) ? 1 : 0)
    for (const cte of ['legs', 'priced', 'fill_asset', 'fill', 'flagged', 'keyed', 'netted']) {
      expect([cte, references(cte)]).toEqual([cte, 1])
    }
  })
})

describe('GET /defillama/v1/volume', () => {
  it('serves the rolling 24h netted total as the incumbent one-element array of numbers', async () => {
    const client = fakeClient({
      '-- pub:vol:anchor': [ANCHOR_ROW],
      '-- pub:vol:routed': [
        { in_usd: '1000.000000000000', out_usd: '1200.000000000000' },
        { in_usd: '30.005000000000', out_usd: '29.000000000000' },
      ],
    })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/volume' })
    expect(res.statusCode).toBe(200)
    // Each trade counts once at its larger side: 1200 + 30.01 (half-up at 2dp).
    expect(res.json()).toEqual([{ volume_usd: 1230.01 }])
    // JSON numbers, not strings: the incumbent's body shape, so a consumer can
    // swap the base URL without touching its parser.
    expect(res.body).toBe('[{"volume_usd":1230.01}]')
    await app.close()
  })

  it('is 0 rather than an error when the projection is empty', async () => {
    const client = fakeClient({ '-- pub:vol:anchor': [{ legs: '0', anchor: '1970-01-01 00:00:00', block_height: 0 }] })
    const app = await buildApp(client)
    // The 24h total is a shared cache entry (the same one /v1/stats/platform
    // reads), so this case has to look past the previous test's answer.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000)
    try {
      const res = await app.inject({ method: 'GET', url: '/defillama/v1/volume' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([{ volume_usd: 0 }])
      // No leg query is issued at all when there is nothing to read.
      expect(client.seen.some(s => s.query.includes('-- pub:vol:routed'))).toBe(false)
    } finally {
      clock.mockRestore()
    }
    await app.close()
  })
})

describe('GET /defillama/v1/backfill', () => {
  it('serves one row per day with numeric USD and the fee-destination breakdown', async () => {
    const client = fakeClient({
      '-- pub:dl:leg-head': [LEG_HEAD_ROW],
      '-- pub:dl:daily': [
        dayRow('2024-03-01', '1057541.897127706898', '3403.692076125741', '53.430335119385', '532.382219428621', '2817.879521577735', '532.382219428621'),
        dayRow('2024-03-02', '1477605.869309574227', '4431.394101185134', '118.811918243577', '715.859253562884', '3596.722929378673', '715.859253562884'),
      ],
    })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2024-03-01&endDate=2024-03-02' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      {
        date: '2024-03-01',
        volume_usd: 1057541.9,
        // dailyFees is every fee leg the trades paid, whatever its destination.
        dailyFees: 3403.69,
        dailyFeesToAccounts: 53.43,
        dailyFeesBurned: 532.38,
        dailyFeesUnknownDestination: 2817.88,
        dailyProtocolFees: 532.38,
      },
      {
        date: '2024-03-02',
        volume_usd: 1477605.87,
        dailyFees: 4431.39,
        dailyFeesToAccounts: 118.81,
        dailyFeesBurned: 715.86,
        dailyFeesUnknownDestination: 3596.72,
        dailyProtocolFees: 715.86,
      },
    ])
    await app.close()
  })

  // The compatibility contract, held separately from the values. Probed on the
  // incumbent 2026-08-13 — `?startDate=2026-08-01&endDate=2026-08-10` answered
  // [{"volume_usd":20559996.962531622,"dailyFees":8869.308429580933}] on BOTH
  // api.hydradx.io and api.nice.hydration.cloud: an array of objects whose two
  // fields are JSON numbers. The one deliberate difference is MULTIPLICITY — the
  // incumbent collapses any range into a single unlabelled row, and this endpoint
  // labels and emits one row per day, which is the reindex it exists for. The
  // field names and types a parser reads are unchanged.
  it('keeps the incumbent\'s two field names as JSON numbers on every row', async () => {
    const client = fakeClient({
      '-- pub:dl:leg-head': [LEG_HEAD_ROW],
      '-- pub:dl:daily': [dayRow('2024-03-01', '1057541.897127706898', '3403.692076125741')],
    })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2024-03-01&endDate=2024-03-01' })
    const rows = res.json() as Record<string, unknown>[]
    expect(Array.isArray(rows)).toBe(true)
    // A JS object's key order IS its wire order; `date` leads and the additive
    // fee breakdown follows the two inherited names.
    expect(Object.keys(rows[0])).toEqual([
      'date', 'volume_usd', 'dailyFees', 'dailyFeesToAccounts',
      'dailyFeesBurned', 'dailyFeesUnknownDestination', 'dailyProtocolFees',
    ])
    expect(typeof rows[0].volume_usd).toBe('number')
    expect(typeof rows[0].dailyFees).toBe('number')
    expect(typeof rows[0].date).toBe('string')
    // Numbers, never the decimal STRINGS the /v1 surfaces carry — the whole
    // point of a facade is that the consumer's parser does not change.
    expect(res.body).not.toMatch(/"(volume_usd|daily[A-Za-z]*)":\s*"/)
    await app.close()
  })

  it('totals fees over every leg, not over the destination classes it knows about', async () => {
    const client = fakeClient({
      '-- pub:dl:leg-head': [LEG_HEAD_ROW],
      // Three sub-cent classes, each 0.00 on the wire, but 0.012 together.
      '-- pub:dl:daily': [dayRow('2024-04-01', '0', '0.012000000000', '0.004000000000', '0.004000000000', '0.004000000000')],
    })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2024-04-01&endDate=2024-04-01' })
    // dailyFees is its own sum over every fee leg — so it is right whether or
    // not the three known destination classes cover them — and each field is
    // rounded once, from the full Decimal(38,12) value.
    expect(res.json()).toEqual([{
      date: '2024-04-01',
      volume_usd: 0,
      dailyFees: 0.01,
      dailyFeesToAccounts: 0,
      dailyFeesBurned: 0,
      dailyFeesUnknownDestination: 0,
      dailyProtocolFees: 0,
    }])
    await app.close()
  })

  it('keeps a fee whose destination class is not one of the three inside dailyFees', async () => {
    const client = fakeClient({
      '-- pub:dl:leg-head': [LEG_HEAD_ROW],
      '-- pub:dl:daily': [dayRow('2024-05-01', '100', '10', '4')],
    })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2024-05-01&endDate=2024-05-01' })
    const [day] = res.json()
    // A future destination the chain starts recording would leave the breakdown
    // short of the total rather than dropping out of the fee number entirely.
    expect([day.dailyFees, day.dailyFeesToAccounts]).toEqual([10, 4])
    await app.close()
  })

  it('splits the range into one query per calendar month, each with half-open UTC bounds', async () => {
    const client = fakeClient({ '-- pub:dl:leg-head': [LEG_HEAD_ROW], '-- pub:dl:daily': [] })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2026-01-20&endDate=2026-03-05' })
    expect(res.statusCode).toBe(200)
    const ranges = client.seen.filter(s => s.query.includes('-- pub:dl:daily')).map(s => [s.params.from, s.params.to])
    // Calendar months are the table's own partitions (PARTITION BY
    // toYYYYMM(block_timestamp)), so a chunk reads exactly one partition.
    expect(ranges).toEqual([
      ['2026-01-20 00:00:00', '2026-02-01 00:00:00'],
      ['2026-02-01 00:00:00', '2026-03-01 00:00:00'],
      ['2026-03-01 00:00:00', '2026-03-06 00:00:00'],
    ])
    await app.close()
  })

  // A busy month is subdivided so no single query carries more legs than the
  // memory cap allows, while the month split stays the OUTER one so a chunk still
  // reads exactly one partition. The days a chunk boundary falls on are the thing
  // to watch: a day must land in exactly one chunk, or the fold would report it
  // twice or not at all.
  it('subdivides a month whose leg count exceeds the per-chunk cap', async () => {
    const heavy = Array.from({ length: 28 }, (_, i) => ({
      day: `2026-02-${String(i + 1).padStart(2, '0')}`, legs: '600000',
    }))
    const client = fakeClient({
      '-- pub:dl:leg-head': [LEG_HEAD_ROW],
      '-- pub:dl:day-legs': heavy,
      '-- pub:dl:daily': [],
    })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2026-02-01&endDate=2026-02-28' })
    expect(res.statusCode).toBe(200)
    const ranges = client.seen.filter(s => s.query.includes('-- pub:dl:daily')).map(s => [s.params.from, s.params.to])
    // 600k legs a day against a 1.5M cap: two days per chunk, cut before the
    // third would cross it.
    expect(ranges).toEqual([
      ['2026-02-01 00:00:00', '2026-02-03 00:00:00'],
      ['2026-02-03 00:00:00', '2026-02-05 00:00:00'],
      ['2026-02-05 00:00:00', '2026-02-07 00:00:00'],
      ['2026-02-07 00:00:00', '2026-02-09 00:00:00'],
      ['2026-02-09 00:00:00', '2026-02-11 00:00:00'],
      ['2026-02-11 00:00:00', '2026-02-13 00:00:00'],
      ['2026-02-13 00:00:00', '2026-02-15 00:00:00'],
      ['2026-02-15 00:00:00', '2026-02-17 00:00:00'],
      ['2026-02-17 00:00:00', '2026-02-19 00:00:00'],
      ['2026-02-19 00:00:00', '2026-02-21 00:00:00'],
      ['2026-02-21 00:00:00', '2026-02-23 00:00:00'],
      ['2026-02-23 00:00:00', '2026-02-25 00:00:00'],
      ['2026-02-25 00:00:00', '2026-02-27 00:00:00'],
      ['2026-02-27 00:00:00', '2026-03-01 00:00:00'],
    ])
    // Contiguous and non-overlapping end to end: every day is folded once.
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1])
    await app.close()
  })

  // The boundary day of a split chunk is the one the split could plausibly break:
  // it is the last day of one query and must not also appear in the next.
  it('reports a split chunk\'s boundary day exactly once, with its own value', async () => {
    const client = fakeClient({
      '-- pub:dl:leg-head': [LEG_HEAD_ROW],
      '-- pub:dl:day-legs': [
        { day: '2026-02-01', legs: '1000000' },
        { day: '2026-02-02', legs: '1000000' },
        { day: '2026-02-03', legs: '1000000' },
      ],
      // Each chunk answers only for the days inside its own half-open bounds,
      // exactly as the real fold does.
      '-- pub:dl:daily': (params) => {
        const from = String(params.from).slice(0, 10)
        return [dayRow(from, '100', '10', '4')]
      },
    })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2026-02-01&endDate=2026-02-03' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ date: string; volume_usd: number }>
    // Three chunks of one day each (1M legs a day, 1.5M cap), concatenated with
    // no day duplicated and none dropped.
    expect(body.map(d => d.date)).toEqual(['2026-02-01', '2026-02-02', '2026-02-03'])
    expect(new Set(body.map(d => d.date)).size).toBe(body.length)
    for (const day of body) expect(day.volume_usd).toBe(100)
    await app.close()
  })

  it('emits only closed UTC days — never the day the indexer is still inside', async () => {
    const client = fakeClient({
      '-- pub:dl:leg-head': [LEG_HEAD_ROW],
      '-- pub:dl:daily': [dayRow('2026-08-10', '10'), dayRow('2026-08-11', '20')],
    })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2026-08-10&endDate=2026-08-31' })
    expect(res.statusCode).toBe(200)
    expect(res.json().map((r: { date: string }) => r.date)).toEqual(['2026-08-10', '2026-08-11'])
    // The anchor sits inside 2026-08-12, so the range is cut at its start: a
    // partially indexed day would report a fraction of its volume as the day's.
    const ranges = client.seen.filter(s => s.query.includes('-- pub:dl:daily')).map(s => s.params.to)
    expect(ranges).toEqual(['2026-08-12 00:00:00'])
    await app.close()
  })

  it('cuts on the newest projected FILL, not on the newest indexed block', async () => {
    const client = fakeClient({
      // The blocks head is two days ahead of the leg model: raw is indexed but
      // the materialized view has not caught up.
      '-- pub:vol:anchor': [{ legs: '4200', anchor: '2026-08-12 18:22:36', block_height: 9123456 }],
      '-- pub:dl:leg-head': [{ head: '2026-08-10 04:00:00' }],
      '-- pub:dl:daily': [dayRow('2026-08-09', '10')],
    })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2026-08-08&endDate=2026-08-12' })
    expect(res.statusCode).toBe(200)
    // Cut at the leg head's own day. Cutting on the blocks head would declare
    // 2026-08-10 and 08-11 complete while their fills were still arriving, and
    // publish the undercount as a finished day.
    const to = client.seen.filter(s => s.query.includes('-- pub:dl:daily')).map(s => s.params.to)
    expect(to).toEqual(['2026-08-10 00:00:00'])
    // The leg head is a partition-key max, answered from part metadata — it does
    // not read block_height, which is what made the shared anchor expensive.
    const head = client.seen.find(s => s.query.includes('-- pub:dl:leg-head'))!
    expect(head.query).toContain('SELECT toString(max(block_timestamp)) AS head FROM price_data.pool_swap_legs')
    expect(head.query).not.toContain('block_height')
    await app.close()
  })

  it('answers empty, without querying, when the leg model is empty', async () => {
    const client = fakeClient({ '-- pub:dl:leg-head': [{ head: '1970-01-01 00:00:00' }] })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2024-01-01&endDate=2024-01-05' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    // An empty model's max() is the DateTime epoch, which is "no data" — not a
    // 1970 cutoff that would make every requested day look closed.
    expect(client.seen.some(s => s.query.includes('-- pub:dl:daily'))).toBe(false)
    await app.close()
  })

  it('answers empty, without querying, for a range that is entirely still open', async () => {
    const client = fakeClient({ '-- pub:dl:leg-head': [LEG_HEAD_ROW] })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2026-08-12&endDate=2026-08-14' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
    expect(client.seen.some(s => s.query.includes('-- pub:dl:daily'))).toBe(false)
    await app.close()
  })

  it('omits a day with no indexed fill rather than publishing a zero for it', async () => {
    const client = fakeClient({
      '-- pub:dl:leg-head': [LEG_HEAD_ROW],
      '-- pub:dl:daily': [dayRow('2023-01-06', '1234.5')],
    })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2023-01-01&endDate=2023-01-07' })
    // 2023-01-06 is the first day the projection has a fill. The days before it
    // are not published as 0 — "no trade indexed" is not "zero volume traded".
    expect(res.json()).toEqual([{
      date: '2023-01-06',
      volume_usd: 1234.5,
      dailyFees: 0,
      dailyFeesToAccounts: 0,
      dailyFeesBurned: 0,
      dailyFeesUnknownDestination: 0,
      dailyProtocolFees: 0,
    }])
    await app.close()
  })

  it('omits a day whose fills could not be valued at all, but keeps a sub-cent one', async () => {
    const client = fakeClient({
      '-- pub:dl:leg-head': [LEG_HEAD_ROW],
      '-- pub:dl:daily': [
        // Traded, but no asset of that day has a closed candle.
        dayRow('2023-02-01', '0', '0'),
        // Traded a dust amount: worth less than a cent, but valued.
        dayRow('2023-02-02', '0.000000000001', '0'),
      ],
    })
    const app = await buildApp(client)
    const res = await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2023-02-01&endDate=2023-02-02' })
    // The unvalued day is a gap, not a zero. The dust day rounds to 0.00 on the
    // wire but is real, so it stays — the test is on the full-scale value.
    expect(res.json().map((r: { date: string; volume_usd: number }) => [r.date, r.volume_usd])).toEqual([['2023-02-02', 0]])
    await app.close()
  })

  it('rejects an inverted range, an oversized range and a malformed date with 400', async () => {
    const { MAX_BACKFILL_DAYS } = await import('../../src/public/services/defillama.ts')
    const client = fakeClient({ '-- pub:dl:leg-head': [LEG_HEAD_ROW], '-- pub:dl:daily': [] })
    const app = await buildApp(client)
    const cases = [
      '/defillama/v1/backfill?startDate=2026-03-05&endDate=2026-03-01',
      `/defillama/v1/backfill?startDate=2020-01-01&endDate=2026-01-01`,
      '/defillama/v1/backfill?startDate=2026-3-5&endDate=2026-03-06',
      '/defillama/v1/backfill?startDate=2026-03-05',
    ]
    for (const url of cases) {
      const res = await app.inject({ method: 'GET', url })
      expect([url, res.statusCode]).toEqual([url, 400])
      expect(res.json().error.code).toBe('bad_request')
    }
    expect(MAX_BACKFILL_DAYS).toBeLessThan(2000)
    // A rejected request never reaches ClickHouse.
    expect(client.seen.some(s => s.query.includes('-- pub:dl:daily'))).toBe(false)
    await app.close()
  })

  it('caches each chunk under its own normalized key, so overlapping ranges share work', async () => {
    const client = fakeClient({
      '-- pub:dl:leg-head': [LEG_HEAD_ROW],
      '-- pub:dl:daily': params => [dayRow(String(params.from).slice(0, 10), '5')],
    })
    const app = await buildApp(client)
    await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2025-05-01&endDate=2025-06-30' })
    const first = client.seen.filter(s => s.query.includes('-- pub:dl:daily')).length
    await app.inject({ method: 'GET', url: '/defillama/v1/backfill?startDate=2025-06-01&endDate=2025-07-31' })
    const second = client.seen.filter(s => s.query.includes('-- pub:dl:daily')).length
    // June is a whole month in both requests and is computed once; only July is new.
    expect([first, second - first]).toEqual([2, 1])
    await app.close()
  })
})

describe('cache-control', () => {
  it('gives the rolling total a short TTL and the historical range a long one', async () => {
    const { PUBLIC_CACHE_CONTROL } = await import('../../src/public/cacheControl.ts')
    const ttl = (path: string) => PUBLIC_CACHE_CONTROL.find(([pattern]) => pattern.test(path))?.[1]
    expect(ttl('/defillama/v1/volume')).toBe(60)
    expect(ttl('/defillama/v1/backfill')).toBe(3600)
    // Anchored, so a future /defillama/v1/backfill-csv cannot inherit the TTL.
    expect(ttl('/defillama/v1/volume/HDX')).toBeUndefined()
    expect(ttl('/defillama/v1/backfill/all')).toBeUndefined()
  })
})
