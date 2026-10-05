import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from '../src/services/explorerAssets.ts'
import { FactSink, HourPricer, type FoldWindow } from '../src/services/userRevenueFold.ts'

// The month build's computation is the window's (tested in userRevenueFold.test.ts);
// here it is a canned result, so the job's own rules are what is under test.
vi.mock('../src/services/userRevenueWindow.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/userRevenueWindow.ts')>()
  return {
    ...actual,
    lastBlockBefore: async () => 100,
    computeUserRevenueWindow: async (_client: unknown, w: FoldWindow) => {
      const sink = new FactSink(w, new HourPricer(w), new Set())
      sink.emit('0xaa', 'user', 0, 'gigahdx_yield', 'gigahdx', '', 0, 5n, 'accrual')
      return { sink, anchorOut: [{ pot: 'mm', holder: '0xh', exposure_id: '0xc', units: 7n, aux: '' }], protocolFp: '1', holderMembers: { accounts: [], classes: [] }, pegSegments: new Map(), stats: { omnipoolUnstated: 0, farmUnstated: 0, farmDryGaps: 0 } }
    },
  }
})

const {
  accountUserRevenueStaleMonthsSql, buildUserRevenueMonth, runAccountUserRevenue, runUserRevenueHourly,
  userRevenueBudgetSeconds, userRevenueSourceHoursSql, userRevenueStaleHoursSql, USER_REVENUE_TABLES,
} = await import('../src/derivations/jobs.ts')

const tables = { hourly: 'price_data.t_hourly', daily: 'price_data.t_daily', anchor: 'price_data.t_anchor' }
const SEP_2026 = Date.UTC(2026, 8, 1) / 1000
const OCT_2026 = Date.UTC(2026, 9, 1) / 1000

/** Records every statement in order; answers the reads the jobs make. */
function fakeClient(opts: { stale?: unknown[]; staleHours?: unknown[]; anchorRows?: unknown[]; cut?: number } = {}) {
  const log: string[] = []
  const client = {
    query: async ({ query }: { query: string }) => {
      const q = query.replace(/\s+/g, ' ').trim()
      log.push(`Q ${q.slice(0, 80)}`)
      const json = async (): Promise<unknown[]> => {
        if (q.includes('system.processes')) return [{ n: '0' }]
        if (q.startsWith('SELECT toString(now())')) return [{ t: '2026-10-02 00:00:00' }]
        if (q.startsWith('SELECT toUnixTimestamp(min(computed_at))')) return [{ t: String(SEP_2026) }]
        if (q.startsWith('SELECT toUnixTimestamp(')) return [{ floor: String(SEP_2026 - 86_400 * 400), cut: String(opts.cut ?? OCT_2026 + 3600 * 5) }]
        if (q.includes("multiIf(der.n = 0, 'unbuilt'")) return opts.stale ?? []
        if (q.startsWith('-- ur:stale-hours')) return opts.staleHours ?? []
        if (q.startsWith('SELECT pot, holder, exposure_id')) return opts.anchorRows ?? []
        if (q.includes('groupBitXor(cityHash64(pot, holder')) return [{ fp: '42' }]
        if (q.includes('SELECT count() AS n FROM')) return [{ n: '1' }]
        if (q.includes('arrayJoin({assets:Array(UInt32)})')) return [{ a: 0, fp: '9' }]
        if (q.includes('account_tags')) return []
        if (q.includes('ur:window')) return []
        return []
      }
      return { json, text: async () => (await json()).map(r => JSON.stringify(r)).join('\n') }
    },
    command: async ({ query }: { query: string }) => { log.push(`C ${query.replace(/\s+/g, ' ').trim()}`); return {} },
    insert: async ({ table, values }: { table: string; values: unknown[] }) => { log.push(`I ${table} ${values.length}`) },
  }
  return { client: client as never, log }
}

beforeAll(async () => {
  await loadExplorerAssets({ query: async () => ({ json: async () => [{ asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12 }] }) } as never)
})
afterAll(() => stopExplorerAssetsRefresh())

describe('user revenue staleness', () => {
  it('cascades every cumulative source forward and re-marks the pool grid\'s and a price row\'s next hour, gated on cut, floor and settle', () => {
    const sql = userRevenueSourceHoursSql().replace(/\s+/g, ' ')
    expect(sql).toContain('max(cum) OVER (ORDER BY hour ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)')
    expect(sql).toContain("SELECT hour + INTERVAL 1 HOUR AS hour, max(src_ingest) AS own")
    expect(sql).toContain('price_data.revenue_hour_watermarks')
    expect(sql).toContain('price_data.pool_swap_hour_watermarks')
    // A price row re-marks its hour and every hour its candle can be carried to (30 days), only when ingested after `since`.
    expect(sql).toContain('SELECT arrayJoin(arrayMap(i -> hour + toIntervalHour(i), range(0, 720 + 2))) AS hour, max(price_ingest) AS own')
    expect(sql).toContain('FROM price_data.pair_route_hour_watermarks WHERE price_ingest > {since:DateTime} GROUP BY hour')
    // A 600-block bucket is a cumulative mark at its EARLIEST hour (a bucket spanning an hour boundary keeps both).
    expect(sql).toContain('SELECT intDiv(block_height, 600) AS bucket, toStartOfHour(min(block_timestamp)) AS hour')
    expect(sql).toContain('FROM recent_buckets AS r INNER JOIN bucket_hours AS bh ON bh.bucket = r.bucket')
    expect(sql).toContain('hour < cut AND hour >= floor AND src_ingest <= now() - INTERVAL 300 SECOND AS foldable')
  })
  it('re-marks a farm sync\'s hours back to the previous sync and a voting record\'s allocation hour as OWN marks (no forward cascade), mapping only rows newer than `since`', () => {
    const sql = userRevenueSourceHoursSql().replace(/\s+/g, ' ')
    expect(sql).toContain('SELECT toDateTime(arrayJoin(range(toUInt32(hp.hour), toUInt32(hn.hour) + 1, 3600))) AS hour, max(s.ing) AS own, toDateTime(0) AS cum')
    // Replayed sync rows are deduplicated to one per identity BEFORE the neighbours are taken, and an inserted sync
    // re-marks up to the next sync.
    expect(sql).toContain('max(ingested_at) AS ing FROM price_data.lm_yield_farm_events')
    expect(sql).toContain('GROUP BY pallet, yield_farm_id, block_height, event_index))')
    expect(sql).toContain('leadInFrame(block_height, 1, block_height)')
    expect(sql).toContain('INNER JOIN sync_block_hours AS hn ON hn.b = s.next')
    expect(sql).toContain('SELECT toStartOfHour(a.ts) AS hour, max(r.ing) AS own, toDateTime(0) AS cum')
    expect(sql).toContain('FROM price_data.gigahdx_reward_records WHERE ingested_at > {since:DateTime}')
    expect(sql).not.toContain('raw_events')
    expect(sql).toContain("WHERE src_ingest > {since:DateTime} GROUP BY bucket")
    expect(sql).toContain("event_kind = 'sync' AND ingested_at > {since:DateTime}")
  })
  it('re-queues a month on its opening anchor, on a crashed or changed successor anchor, on the registry, and the live month at most hourly', () => {
    const sql = accountUserRevenueStaleMonthsSql(tables, '5').replace(/\s+/g, ' ')
    expect(sql).toContain('der.opening_fp != a_open.fp')
    expect(sql).toContain('der.closing_fp != a_next.fp')
    expect(sql).toContain("WHERE account = '' AND stream = ''")
    expect(sql).toContain('der.der_computed < now() - INTERVAL 3600 SECOND')
    // The registry input per month in the projection's GROUP BY shape, never DISTINCT over the table.
    expect(sql).toContain("SELECT toYYYYMM(hour) AS bucket, asset_id AS a FROM price_data.t_hourly WHERE stream != '' GROUP BY bucket, a")
    expect(sql).not.toContain('DISTINCT')
    // The rebound months come in as a parameter (recomputed only when the binding set changes), not a daily scan.
    expect(sql).toContain('rebound AS (SELECT arrayJoin({rebound:Array(UInt32)}) AS p)')
    expect(sql).not.toContain('0x45544800')
    // The live month waits an hour whatever moved; a bound H160's month moves to the owner's key.
    expect(sql).toContain('OR ((NOT src.p = (SELECT p FROM last_month) OR der.der_computed < now() - INTERVAL 3600 SECOND)')
    // …except after a cascade moved its opening anchor: then at once (M9).
    expect(sql).toContain('OR (src.p = (SELECT p FROM last_month) AND der.opening_fp != a_open.fp)')
    // The holder set joins per month, narrowed to the month's own accounts (M8): read by account prefix, never the table.
    expect(sql).toContain("FROM price_data.t_daily WHERE account IN {hk:Array(String)} AND stream != '' GROUP BY p, account")
    expect(sql).toContain('LEFT JOIN holders ON holders.p = src.p')
    expect(sql).toContain('holders.hfp)')
    expect(sql).toContain("src.p IN (SELECT p FROM rebound), 'binding'")
    // A build that crashed between the daily and the hourly swap leaves an hourly row older than the daily marker.
    expect(sql).toContain('SELECT toYYYYMM(hour) AS p, min(dc) AS h_min FROM (SELECT hour, max(computed_at) AS dc FROM price_data.t_hourly GROUP BY hour) GROUP BY p')
    expect(sql).toContain("(hb.h_min < der.der_computed), 'build-mismatch'")
    expect(sql).toContain('OR (hb.h_min < der.der_computed) OR (src.p = (SELECT p FROM last_month) AND der.opening_fp != a_open.fp) OR (src.p = (SELECT p FROM last_month) AND hr.r_max > der.der_computed) OR ((NOT')
    // …and after the hourly fold republished hours the live month's build already covered (a token restatement):
    // at once too, so the account totals never trail the hourly ones by the throttle (L4).
    // "Covered" is the marker's folded_through (the end of the last hour the build folded), never a guess from
    // the build's clock: an hour that closed before the build but was not yet foldable is a first fold, not a
    // restatement.
    expect(sql).toContain('max(folded_through) AS folded_through')
    expect(sql).toContain('WHERE h.hour < der.folded_through AND h.dc > der.der_computed')
    expect(sql).not.toContain('toStartOfHour(der.der_computed) - INTERVAL 1 HOUR')
    expect(sql).toContain("(src.p = (SELECT p FROM last_month) AND hr.r_max > der.der_computed), 'hours-restated'")
    expect(sql).toContain('mapFromArrays({tfk:Array(UInt32)}, {tfv:Array(UInt64)})[toUInt32(src.p)]')
  })
  it('recomputes the rebound months only when the binding set changed, and drops a rebuilt month from the answer', async () => {
    const { userRevenueReboundMonths, userRevenueReboundForget } = await import('../src/derivations/jobs.ts')
    let fp = '1'
    const reads: string[] = []
    const client = {
      query: async ({ query }: { query: string }) => {
        const tag = query.split('\n')[0]
        reads.push(tag)
        return { json: async () => (tag === '-- ur:bindings-fp' ? [{ fp }] : [{ p: 202601 }, { p: 202605 }]) }
      },
    } as never
    const t = { ...tables, daily: 'price_data.t_rebound_daily' }
    expect(await userRevenueReboundMonths(client, t)).toEqual({ months: [202601, 202605], recomputed: true })
    expect(await userRevenueReboundMonths(client, t)).toEqual({ months: [202601, 202605], recomputed: false })
    userRevenueReboundForget(t, 202601)
    expect(await userRevenueReboundMonths(client, t)).toEqual({ months: [202605], recomputed: false })
    fp = '2'
    expect(await userRevenueReboundMonths(client, t)).toEqual({ months: [202601, 202605], recomputed: true })
    expect(reads.filter(r => r === '-- ur:rebound')).toHaveLength(2)
  })
  it('compares an hour\'s stored fingerprint with the registry over its own asset set XOR the rule', () => {
    const sql = userRevenueStaleHoursSql(tables, '5').replace(/\s+/g, ' ')
    expect(sql).toContain('bitXor(toUInt64(5), groupBitXor(')
    expect(sql).toContain('der.fp_max != bitXor(if(cur.bucket = toDateTime(0), toUInt64(5), cur.cur_fp), mapFromArrays({tfk:Array(UInt32)}, {tfv:Array(UInt64)})[toUInt32(s.hour)])')
    expect(sql).toContain('WHERE s.foldable AND s.hour >= toDateTime({fromHour:UInt32})')
  })
  it('reads its budget from the environment, falling back to 180 s', () => {
    expect(userRevenueBudgetSeconds(undefined)).toBe(180)
    expect(userRevenueBudgetSeconds('abc')).toBe(180)
    expect(userRevenueBudgetSeconds('30')).toBe(30)
    expect(USER_REVENUE_TABLES.daily).toBe('price_data.account_user_revenue_daily')
  })
})

describe('the month build\'s publication', () => {
  it('writes the successor anchor to staging, swaps the facts in, and the anchor LAST', async () => {
    const { client, log } = fakeClient()
    const built = await buildUserRevenueMonth(client, 202609, tables, { floor: 0, cut: OCT_2026 + 7200 })
    expect(built?.complete).toBe(true)
    const steps = log.filter(l => l.startsWith('C') || l.startsWith('I'))
    const at = (s: string) => steps.findIndex(l => l.includes(s))
    expect(at('I price_data.t_anchor_staging')).toBeLessThan(at('REPLACE PARTITION 202609 FROM price_data.t_daily_staging'))
    expect(at('REPLACE PARTITION 202609 FROM price_data.t_daily_staging')).toBeLessThan(at('REPLACE PARTITION 202609 FROM price_data.t_hourly_staging'))
    expect(at('REPLACE PARTITION 202609 FROM price_data.t_hourly_staging')).toBeLessThan(at('REPLACE PARTITION 202610 FROM price_data.t_anchor_staging'))
    expect(steps.at(-1)).toBe('C ALTER TABLE price_data.t_anchor_staging DROP PARTITION 202610')
  })
  it('writes no successor anchor for the month still filling', async () => {
    const { client, log } = fakeClient()
    const built = await buildUserRevenueMonth(client, 202610, tables, { floor: 0, cut: OCT_2026 + 3 * 3600 })
    expect(built?.complete).toBe(false)
    expect(built?.hours).toBe(3)
    expect(log.some(l => l.includes('REPLACE PARTITION 202611 FROM price_data.t_anchor_staging'))).toBe(false)
  })
})

describe('the bounded lane', () => {
  it('builds the live month first, then the oldest, and yields once the budget is spent (never inside a month)', async () => {
    const { client, log } = fakeClient({ stale: [
      { p: '202607', src_ingest: 'x', reason: 'unbuilt', live: 0 },
      { p: '202608', src_ingest: 'x', reason: 'unbuilt', live: 0 },
      { p: '202610', src_ingest: 'x', reason: 'live-month', live: 1 },
    ] })
    await runAccountUserRevenue(client, tables, 0)
    const built = log.filter(l => l.includes('REPLACE PARTITION') && l.includes('t_daily_staging')).map(l => l.match(/PARTITION (\d+)/)![1])
    expect(built).toEqual(['202610'])
    const { client: c2, log: l2 } = fakeClient({ stale: [
      { p: '202607', src_ingest: 'x', reason: 'unbuilt', live: 0 },
      { p: '202610', src_ingest: 'x', reason: 'live-month', live: 1 },
    ] })
    await runAccountUserRevenue(c2, tables, 60)
    expect(l2.filter(l => l.includes('REPLACE PARTITION') && l.includes('t_daily_staging')).map(l => l.match(/PARTITION (\d+)/)![1])).toEqual(['202610', '202607'])
  })
  it('folds stale hours newest first as runs inside one month, keeping the month\'s other hours', async () => {
    const { client, log } = fakeClient({ staleHours: [
      { hour: '2026-09-30 22:00:00', src_ingest: 'x', minb: '1', maxb: '2' },
      { hour: '2026-09-30 23:00:00', src_ingest: 'x', minb: '1', maxb: '2' },
      { hour: '2026-10-01 01:00:00', src_ingest: 'x', minb: '1', maxb: '2' },
    ] })
    await runUserRevenueHourly(client, tables, 60)
    const kept = log.filter(l => l.startsWith('C INSERT INTO price_data.t_hourly_staging SELECT * FROM price_data.t_hourly'))
    expect(kept).toHaveLength(2)
    const swaps = log.filter(l => l.includes('REPLACE PARTITION')).map(l => l.match(/PARTITION (\d+)/)![1])
    expect(swaps).toEqual(['202610', '202609'])
  })
  // The account fold runs BEFORE the hourly fold in a cycle: hours the hourly fold restates in the live month are
  // re-checked in the same cycle, so the account totals do not trail the hourly ones by a cycle.
  it('rebuilds the live month in the same cycle when the hourly fold restated its hours', async () => {
    const staleHours = [{ hour: '2026-10-01 01:00:00', src_ingest: 'x', minb: '1', maxb: '2' }]
    const { client, log } = fakeClient({ staleHours, stale: [
      { p: '202609', src_ingest: 'x', reason: 'sources', live: 0 },
      { p: '202610', src_ingest: 'x', reason: 'hours-restated', live: 1 },
    ] })
    await runUserRevenueHourly(client, tables, 60)
    const hourlySwap = log.findIndex(l => l.includes('REPLACE PARTITION 202610 FROM price_data.t_hourly_staging'))
    const dailySwaps = log.map((l, i) => [l, i] as const).filter(([l]) => l.includes('REPLACE PARTITION') && l.includes('t_daily_staging'))
    // Only the live month, and after the hourly fold's own swap; history stays the account fold's lane.
    expect(dailySwaps.map(([l]) => l.match(/PARTITION (\d+)/)![1])).toEqual(['202610'])
    expect(dailySwaps[0][1]).toBeGreaterThan(hourlySwap)
    // No head-month fold, no re-check.
    const { client: c2, log: l2 } = fakeClient({ staleHours: [{ hour: '2026-09-30 22:00:00', src_ingest: 'x', minb: '1', maxb: '2' }], stale: [
      { p: '202610', src_ingest: 'x', reason: 'hours-restated', live: 1 },
    ] })
    await runUserRevenueHourly(c2, tables, 60)
    expect(l2.some(l => l.includes('t_daily_staging'))).toBe(false)
  })
})
