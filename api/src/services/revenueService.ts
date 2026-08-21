// The explorer's revenue read models: the /revenue dashboard (totals, bucketed
// history, breakdown, top payers) and the live flow feed the animated river
// drinks from.
//
// Both compose the same two arms:
//   cold  — price_data.revenue_events, the derivations-built canonical table
//           (closed hours only, event-time valued);
//   tail  — the SAME per-stream definitions run over raw for everything past
//           each stream's own cold high-water mark, so for the EVENTFUL
//           streams the split is a performance boundary, not a coverage gate.
//           hollar_borrow is the exception: it accrues per hour and has no
//           eventful raw form, so its dashboard figures end at the last booked
//           hour — the open hour plus the job's rebuild hold, up to ~2h behind
//           now (the flow's drip stands in for exactly that gap).
// The per-stream marks are read ONCE per request and threaded into BOTH arms
// as literals — the cold caps and the tail filters (and the tail's cache
// identity) — so a REPLACE PARTITION landing mid-request cannot make the arms
// overlap on an hour or straddle a gap (the SPLIT_BOUNDS argument from the
// public fees service, applied across two queries).
//
// Explorer surfaces show PROTOCOL revenue only: the omnipool asset fee's
// lp/unknown legs exist in revenue_events solely for the public destination
// matrix and are filtered out here (PROTOCOL_REVENUE_PREDICATE_SQL / its TS
// twin below).

import type { ClickHouseClient } from '../db/client.ts'
import { measuredParaBlockMs } from './blockTime.ts'
import { accountBorrowInterestSql, distributeUsd1e12 } from './borrowAttribution.ts'
import { cached, cachedSwr } from './cache.ts'
import { accountRef, type AccountRef } from './explorerService.ts'
import {
  HOLLAR_RESERVE_ADDRESS,
  PROTOCOL_REVENUE_PREDICATE_SQL,
  REVENUE_STREAMS,
  buildRevenueEventRowsSql,
  hollarBorrowHourlyRows,
  type EventfulRevenueStream,
  type RevenueStream,
} from './revenueStreams.ts'
import { DECIMAL_STRINGS, scaledUsd } from './valuation.ts'

let client: ClickHouseClient

export function initRevenueService(c: ClickHouseClient): void {
  client = c
}

export const REVENUE_RANGES = ['30d', '1y', 'all'] as const
export type RevenueRange = (typeof REVENUE_RANGES)[number]

const RANGE_SECONDS: Record<RevenueRange, number | null> = {
  '30d': 30 * 86_400,
  '1y': 365 * 86_400,
  all: null,
}

/**
 * One grain per range: 30D reads as daily bars, 1Y as ISO weeks, All as
 * calendar months. Weeks/months are calendar buckets, not fixed-second
 * intervals, so each range carries its own SQL expression and the response's
 * bucketSeconds is nominal (charts label buckets by their start).
 */
const RANGE_BUCKET_SQL: Record<RevenueRange, string> = {
  '30d': 'toStartOfDay(block_timestamp)',
  '1y': 'toStartOfWeek(block_timestamp, 1)',
  all: 'toStartOfMonth(block_timestamp)',
}
const RANGE_BUCKET_SECONDS: Record<RevenueRange, number> = {
  '30d': 86_400,
  '1y': 7 * 86_400,
  all: 30 * 86_400,
}

/** The TS twin of RANGE_BUCKET_SQL, for folding the raw tail into the same buckets. */
function bucketStartSeconds(range: RevenueRange, t: number): number {
  if (range === '30d') return t - (t % 86_400)
  const d = new Date(t * 1000)
  if (range === '1y') {
    const midnight = t - (t % 86_400)
    const mondayOffset = (d.getUTCDay() + 6) % 7
    return midnight - mondayOffset * 86_400
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000
}

export interface RevenuePoint { t: number; usd: number }
export interface RevenueDashboard {
  totals: { day: number; week: number; month: number; allTime: number }
  history: {
    range: RevenueRange
    bucketSeconds: number
    series: { stream: RevenueStream; points: RevenuePoint[] }[]
  }
  breakdown: { stream: RevenueStream; usd: number; share: number }[]
  topAccounts: { account: AccountRef; usd: number }[]
  asOf: string
}

export interface RevenueFlowItem {
  stream: RevenueStream
  block: number
  t: number
  eventIndex: number
  legIndex: number
  account: AccountRef | null
  assetId: number
  usd: number
}

export interface RevenueFlowResponse {
  items: RevenueFlowItem[]
  drips: { key: string; label: string; stream: RevenueStream; usdPerBlock: number }[]
  cursor: string
  head: number
  blockSeconds: number
}

const EVENTFUL: readonly EventfulRevenueStream[]
  = REVENUE_STREAMS.filter((s): s is EventfulRevenueStream => s !== 'hollar_borrow')

const USD_UNIT = 1e12

/**
 * The TS twin of PROTOCOL_REVENUE_PREDICATE_SQL — kept in step by
 * tests/protocolRevenueTwin.test.ts, which evaluates both over every combination.
 */
export function isProtocolRevenue(stream: string, dest: string): boolean {
  if (dest === 'lp') return false
  return stream !== 'omnipool_asset_fee' || dest === 'protocol' || dest === 'burned' || dest === 'pol'
}

function chTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

const CH_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/**
 * Each stream's cold high-water mark (max block_timestamp in revenue_events),
 * epoch 0 for a stream the job has not materialized yet — which simply hands
 * that stream's whole window to the raw arm.
 */
async function coldMarks(): Promise<Map<RevenueStream, string>> {
  return cached('revenue:cold-marks', 15_000, async () => {
    const res = await client.query({
      query: `SELECT stream, toString(max(block_timestamp)) AS mark FROM price_data.revenue_events GROUP BY stream`,
      format: 'JSONEachRow',
    })
    const out = new Map<RevenueStream, string>()
    for (const row of await res.json<{ stream: RevenueStream; mark: string }>()) {
      if (CH_TS.test(row.mark)) out.set(row.stream, row.mark)
    }
    return out
  })
}

interface TailRow {
  stream: RevenueStream
  block_height: number
  block_timestamp: string
  event_index: number
  leg_index: number
  dest: string
  account: string
  asset_id: number
  amount: string
  amount_usd: string
}

/**
 * The raw tail: every stream's rows past its own cold mark, one UNION query
 * through the shared builders. Bounded to `hours` before now; cached briefly
 * (single-flight) so concurrent flow pollers share one execution. The caller
 * passes the SAME marks it caps the cold arm with, and those marks are part of
 * the cache identity — a cached tail built from older marks must never be
 * paired with fresher cold caps (rows between the two mark generations would
 * be counted twice) or vice versa (counted in neither arm).
 */
async function tailRows(hours: number, marks: Map<RevenueStream, string>): Promise<TailRow[]> {
  const marksKey = [...marks].map(([s, m]) => `${s}=${m}`).sort().join(',')
  return cached(`revenue:tail:${hours}:${marksKey}`, 2_000, async () => {
    const arms = EVENTFUL.map(stream => {
      const mark = marks.get(stream) ?? '1970-01-01 00:00:00'
      return `SELECT * FROM (
${buildRevenueEventRowsSql(stream)}
) WHERE block_timestamp > toDateTime('${mark}')`
    })
    const res = await client.query({
      query: arms.join('\nUNION ALL\n'),
      query_params: { anchor: chTimestamp(Math.floor(Date.now() / 1000)), hours },
      format: 'JSONEachRow',
      clickhouse_settings: DECIMAL_STRINGS,
    })
    const rows = await res.json<TailRow>()
    rows.sort((a, b) => a.block_height - b.block_height || a.event_index - b.event_index || a.leg_index - b.leg_index)
    return rows
  })
}

/** Streams' cold caps as one predicate, so the cold arm never crosses the marks the tail was built from. */
function coldCapPredicateSql(marks: Map<RevenueStream, string>): string {
  const arms = REVENUE_STREAMS.map(stream =>
    `(stream = '${stream}' AND block_timestamp <= toDateTime('${marks.get(stream) ?? '1970-01-01 00:00:00'}'))`)
  return `(${arms.join(' OR ')})`
}

function tailSeconds(row: TailRow): number {
  return Math.floor(Date.parse(`${row.block_timestamp.replace(' ', 'T')}Z`) / 1000)
}

/**
 * How far the raw tail must reach: the oldest cold mark, floored so a stream
 * the job has never built (mark = epoch) cannot demand an unbounded raw scan —
 * its history is simply incomplete until the job lands, which the derivations
 * freshness contract states rather than hides.
 */
const MAX_TAIL_HOURS = 26

function tailHours(marks: Map<RevenueStream, string>, nowSeconds: number): number {
  let oldest = nowSeconds
  for (const stream of EVENTFUL) {
    const mark = marks.get(stream)
    const seconds = mark ? Math.floor(Date.parse(`${mark.replace(' ', 'T')}Z`) / 1000) : 0
    if (seconds < oldest) oldest = seconds
  }
  return Math.min(MAX_TAIL_HOURS, Math.max(1, Math.ceil((nowSeconds - oldest) / 3_600) + 1))
}

export async function getRevenueDashboard(range: RevenueRange): Promise<RevenueDashboard> {
  return cachedSwr(`revenue:dashboard:${range}`, 60_000, 300_000, async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const marks = await coldMarks()
    const caps = coldCapPredicateSql(marks)
    const bucketSeconds = RANGE_BUCKET_SECONDS[range]
    const rangeStart = RANGE_SECONDS[range] == null ? 0 : nowSeconds - (RANGE_SECONDS[range] ?? 0)
    const bucketSql = RANGE_BUCKET_SQL[range]

    const totalsQuery = client.query({
      query: `-- rev:dashboard:totals
SELECT stream,
       toString(sumIf(amount_usd, block_timestamp > toDateTime('${chTimestamp(nowSeconds - 86_400)}'))) AS day,
       toString(sumIf(amount_usd, block_timestamp > toDateTime('${chTimestamp(nowSeconds - 7 * 86_400)}'))) AS week,
       toString(sumIf(amount_usd, block_timestamp > toDateTime('${chTimestamp(nowSeconds - 30 * 86_400)}'))) AS month,
       toString(sum(amount_usd)) AS all_time
FROM price_data.revenue_events
WHERE ${PROTOCOL_REVENUE_PREDICATE_SQL} AND ${caps}
GROUP BY stream`,
      format: 'JSONEachRow',
      clickhouse_settings: DECIMAL_STRINGS,
    })
    const bucketsQuery = client.query({
      query: `-- rev:dashboard:buckets
SELECT stream, toUnixTimestamp(${bucketSql}) AS t,
       toString(sum(amount_usd)) AS usd
FROM price_data.revenue_events
WHERE ${PROTOCOL_REVENUE_PREDICATE_SQL} AND ${caps}
  AND block_timestamp >= toDateTime('${chTimestamp(rangeStart)}')
GROUP BY stream, t
ORDER BY t`,
      format: 'JSONEachRow',
      clickhouse_settings: DECIMAL_STRINGS,
    })
    const topQuery = client.query({
      query: `-- rev:dashboard:top-accounts
SELECT account, toString(sum(amount_usd)) AS usd
FROM price_data.revenue_events
WHERE ${PROTOCOL_REVENUE_PREDICATE_SQL} AND ${caps}
  AND account != '' AND block_timestamp >= toDateTime('${chTimestamp(rangeStart)}')
GROUP BY account
ORDER BY sum(amount_usd) DESC
LIMIT 10`,
      format: 'JSONEachRow',
      clickhouse_settings: DECIMAL_STRINGS,
    })
    const tail = (await tailRows(tailHours(marks, nowSeconds), marks))
      .filter(row => isProtocolRevenue(row.stream, row.dest))

    // Integer 1e-12 USD end to end; one float conversion at the wire below.
    const totals = new Map<RevenueStream, { day: bigint; week: bigint; month: bigint; allTime: bigint }>()
    for (const row of await (await totalsQuery).json<{ stream: RevenueStream; day: string; week: string; month: string; all_time: string }>()) {
      totals.set(row.stream, {
        day: scaledUsd(row.day), week: scaledUsd(row.week), month: scaledUsd(row.month), allTime: scaledUsd(row.all_time),
      })
    }
    const buckets = new Map<RevenueStream, Map<number, bigint>>()
    for (const row of await (await bucketsQuery).json<{ stream: RevenueStream; t: number; usd: string }>()) {
      const series = buckets.get(row.stream) ?? new Map<number, bigint>()
      series.set(Number(row.t), scaledUsd(row.usd))
      buckets.set(row.stream, series)
    }
    // Payer ranking: `top` holds EXACT cold eventful sums per account; every
    // other component (raw tail, HOLLAR interest, reserve mints) accumulates
    // into `adds` and merges at the end. Keeping the two apart is what makes
    // the ranking exact despite the cold query's LIMIT: an account that gains
    // an add but sits outside the cold top 10 has its full cold sum fetched
    // below, and an account with no adds at all cannot outrank the 10th cold
    // account it already lost to.
    const top = new Map<string, bigint>()
    for (const row of await (await topQuery).json<{ account: string; usd: string }>()) {
      top.set(row.account, scaledUsd(row.usd))
    }
    const adds = new Map<string, bigint>()
    const addTop = (account: string, usd: bigint): void => {
      if (account && usd > 0n) adds.set(account, (adds.get(account) ?? 0n) + usd)
    }

    for (const row of tail) {
      const t = tailSeconds(row)
      const usd = scaledUsd(row.amount_usd)
      if (usd <= 0n) continue
      const streamTotals = totals.get(row.stream) ?? { day: 0n, week: 0n, month: 0n, allTime: 0n }
      if (t > nowSeconds - 86_400) streamTotals.day += usd
      if (t > nowSeconds - 7 * 86_400) streamTotals.week += usd
      if (t > nowSeconds - 30 * 86_400) streamTotals.month += usd
      streamTotals.allTime += usd
      totals.set(row.stream, streamTotals)
      if (t >= rangeStart) {
        const bucket = bucketStartSeconds(range, t)
        const series = buckets.get(row.stream) ?? new Map<number, bigint>()
        series.set(bucket, (series.get(bucket) ?? 0n) + usd)
        buckets.set(row.stream, series)
        addTop(row.account, usd)
      }
    }

    const sumAll = (pick: (t: { day: bigint; week: bigint; month: bigint; allTime: bigint }) => bigint): number =>
      Number([...totals.values()].reduce((a, t) => a + pick(t), 0n)) / USD_UNIT

    const rangeTotals = new Map<RevenueStream, bigint>()
    for (const [stream, series] of buckets) {
      rangeTotals.set(stream, [...series.values()].reduce((a, b) => a + b, 0n))
    }
    const rangeSum = [...rangeTotals.values()].reduce((a, b) => a + b, 0n)

    // Borrow interest joins the payer ranking too, or a pure HOLLAR borrower
    // would show revenue on their account page yet never rank here (the
    // symmetry rule). hollar_borrow is attributed EXACTLY for the booked
    // window: the range's booked USD split over the same scaled-debt×Δindex
    // weights the account_revenue job uses, with the weights window ending at
    // the stream's cold mark — the last booked hour — so a borrower who only
    // opened debt after the mark takes no share of interest booked before
    // they borrowed. asset_reserve (dormant since
    // 2026-06-25) joins from account_revenue for months FULLY inside the
    // range — exact for "all", and a mint in a partial boundary month simply
    // stays out of the ranking rather than being time-scaled onto payers.
    const hollarRangeUsd = rangeTotals.get('hollar_borrow') ?? 0n
    if (hollarRangeUsd > 0n) {
      const weightsRes = await client.query({
        query: accountBorrowInterestSql(),
        query_params: {
          reserve: HOLLAR_RESERVE_ADDRESS,
          start: chTimestamp(rangeStart),
          end: marks.get('hollar_borrow') ?? chTimestamp(nowSeconds),
        },
        format: 'JSONEachRow',
      })
      const weights = (await weightsRes.json<{ account: string; interest: string }>())
        .map(r => ({ account: r.account, weight: BigInt(r.interest) }))
      for (const [account, usd] of distributeUsd1e12(hollarRangeUsd, weights)) addTop(account, usd)
    }
    if ((rangeTotals.get('asset_reserve') ?? 0n) > 0n) {
      const firstFullMonth = (s: number): number => {
        const d = new Date(s * 1000)
        const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000
        const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
        return s <= monthStart ? Number(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
          : Number(`${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, '0')}`)
      }
      const lastFullMonth = (s: number): number => {
        const d = new Date(s * 1000)
        const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 1)
        return Number(`${prev.getUTCFullYear()}${String(prev.getUTCMonth() + 1).padStart(2, '0')}`)
      }
      const reserveRes = await client.query({
        query: `-- rev:dashboard:reserve-payers
SELECT account, toString(sum(revenue_usd)) AS usd
FROM price_data.account_revenue
WHERE stream = 'asset_reserve' AND account != ''
  AND month >= ${firstFullMonth(Math.max(rangeStart, 0))} AND month <= ${lastFullMonth(nowSeconds)}
GROUP BY account`,
        format: 'JSONEachRow',
        clickhouse_settings: DECIMAL_STRINGS,
      })
      for (const row of await reserveRes.json<{ account: string; usd: string }>()) {
        addTop(row.account, scaledUsd(row.usd))
      }
    }

    // An account with adds but outside the cold top 10 still owns cold
    // eventful revenue the LIMIT dropped; without it the combined ranking
    // would compare partial totals. Fetch those accounts' exact cold sums
    // (bounded: tail actors + borrowers + reserve payers), then merge.
    const missing = [...adds.keys()].filter(account => !top.has(account))
    if (missing.length > 0) {
      const sumsRes = await client.query({
        query: `-- rev:dashboard:top-account-sums
SELECT account, toString(sum(amount_usd)) AS usd
FROM price_data.revenue_events
WHERE ${PROTOCOL_REVENUE_PREDICATE_SQL} AND ${caps}
  AND block_timestamp >= toDateTime('${chTimestamp(rangeStart)}')
  AND account IN {accounts:Array(String)}
GROUP BY account`,
        query_params: { accounts: missing },
        format: 'JSONEachRow',
        clickhouse_settings: DECIMAL_STRINGS,
      })
      for (const row of await sumsRes.json<{ account: string; usd: string }>()) {
        top.set(row.account, scaledUsd(row.usd))
      }
    }
    for (const [account, usd] of adds) {
      top.set(account, (top.get(account) ?? 0n) + usd)
    }

    return {
      totals: {
        day: sumAll(t => t.day),
        week: sumAll(t => t.week),
        month: sumAll(t => t.month),
        allTime: sumAll(t => t.allTime),
      },
      history: {
        range,
        bucketSeconds,
        series: REVENUE_STREAMS
          .filter(stream => (buckets.get(stream)?.size ?? 0) > 0)
          .map(stream => ({
            stream,
            points: [...(buckets.get(stream) ?? new Map<number, bigint>())]
              .sort(([a], [b]) => a - b)
              .map(([t, usd]) => ({ t, usd: Number(usd) / USD_UNIT })),
          })),
      },
      breakdown: REVENUE_STREAMS
        .filter(stream => (rangeTotals.get(stream) ?? 0n) > 0n)
        .map(stream => ({
          stream,
          usd: Number(rangeTotals.get(stream) ?? 0n) / USD_UNIT,
          share: rangeSum > 0n ? Number(((rangeTotals.get(stream) ?? 0n) * 1_000_000n) / rangeSum) / 1_000_000 : 0,
        }))
        .sort((a, b) => b.usd - a.usd),
      topAccounts: [...top]
        .sort(([, a], [, b]) => (b > a ? 1 : b < a ? -1 : 0))
        .slice(0, 10)
        .map(([account, usd]) => ({ account: accountRef(account), usd: Number(usd) / USD_UNIT })),
      asOf: new Date(nowSeconds * 1000).toISOString(),
    }
  })
}

// ---------------------------------------------------------------------------
// Live flow
// ---------------------------------------------------------------------------

/** Flow cursor: "<block>-<eventIndex>-<legIndex>", strictly increasing. */
export const FLOW_CURSOR_RE = /^\d{1,10}-\d{1,10}-\d{1,5}$/

function cursorTuple(cursor: string | null): [number, number, number] {
  if (!cursor) return [0, 0, -1]
  const [block, event, leg] = cursor.split('-').map(Number)
  return [block, event, leg]
}

function afterCursor(row: TailRow, [block, event, leg]: [number, number, number]): boolean {
  if (row.block_height !== block) return row.block_height > block
  if (row.event_index !== event) return row.event_index > event
  return row.leg_index > leg
}

/** On a cursorless first call, only the most recent minute seeds the river. */
const FLOW_SEED_SECONDS = 60
const FLOW_MAX_ITEMS = 400

async function indexedHead(): Promise<number> {
  return cached('revenue:head', 1_500, async () => {
    const res = await client.query({
      query: 'SELECT max(last_block) AS head FROM price_data.raw_ingestion_state',
      format: 'JSONEachRow',
    })
    return Number((await res.json<{ head: number | null }>())[0]?.head ?? 0)
  })
}

/** pool proxy → market key, for the borrow-drip labels. */
async function marketKeyByPool(): Promise<Map<string, string>> {
  return cached('revenue:market-keys', 300_000, async () => {
    const res = await client.query({
      query: `SELECT lower(pool_proxy) AS pool, any(market_key) AS market
              FROM price_data.atoken_reserve_map FINAL GROUP BY pool`,
      format: 'JSONEachRow',
    })
    return new Map((await res.json<{ pool: string; market: string }>()).map(r => [r.pool, r.market]))
  })
}

/**
 * The borrow drip: HOLLAR interest accrues every block, so the river shows it
 * as a per-block trickle at the LAST OBSERVED hourly accrual rate — measured
 * from our own booked math (hollarBorrowHourlyRows over the last closed
 * hours), not modeled from rate parameters, so the drip and the books always
 * agree at hour grain. Reserve-factor interest has no drip while
 * MintedToTreasury lies dormant; when mints resume they surface as booked
 * history, never as invented flow items.
 */
async function borrowDrips(blockSeconds: number): Promise<RevenueFlowResponse['drips']> {
  return cached('revenue:drips', 60_000, async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const rows = await hollarBorrowHourlyRows(client, nowSeconds - 48 * 3_600, nowSeconds)
    if (!rows.length) return []
    // EACH pool's latest observed accrual, carried forward: the rate is a step
    // function and the view emits rows only for hours a reserve was touched,
    // so pinning all pools to one shared newest hour made the drip vanish
    // whenever that hour lacked an observation (a quiet market, or the cut
    // hour itself) even though interest kept accruing.
    const latest = new Map<string, (typeof rows)[number]>()
    for (const row of rows) {
      const seen = latest.get(row.poolAddress)
      if (!seen || row.hour > seen.hour) latest.set(row.poolAddress, row)
    }
    const markets = await marketKeyByPool()
    return [...latest.values()]
      .filter(r => r.usd1e12 > 0n)
      .map(r => ({
        key: r.poolAddress,
        label: `HOLLAR interest · ${markets.get(r.poolAddress) ?? 'money market'}`,
        stream: 'hollar_borrow' as RevenueStream,
        usdPerBlock: (Number(r.usd1e12) / USD_UNIT) * (blockSeconds / 3_600),
      }))
      .sort((a, b) => b.usdPerBlock - a.usdPerBlock)
  })
}

export async function getRevenueFlow(after: string | null): Promise<RevenueFlowResponse> {
  const [head, rows, blockMs] = await Promise.all([
    indexedHead(),
    coldMarks().then(marks => tailRows(1, marks)),
    measuredParaBlockMs(client),
  ])
  const blockSeconds = blockMs / 1_000
  const cursor = cursorTuple(after)
  const nowSeconds = Math.floor(Date.now() / 1000)
  const items = rows
    .filter(row => isProtocolRevenue(row.stream, row.dest))
    // asset_reserve (MintedToTreasury) rides along as ITEMS: there is no
    // reserve-factor drip (the accrual is not continuously booked, and the
    // factor has been 0 since 2026-06-25), so each mint is revenue the river
    // has not streamed yet. Only hollar_borrow has a drip, and its hourly
    // reserve rows never reach the flow (they are not eventful-stream rows).
    .filter(row => scaledUsd(row.amount_usd) > 0n)
    .filter(row => (after ? afterCursor(row, cursor) : tailSeconds(row) > nowSeconds - FLOW_SEED_SECONDS))
    .slice(-FLOW_MAX_ITEMS)
    .map(row => ({
      stream: row.stream,
      block: row.block_height,
      t: tailSeconds(row),
      eventIndex: row.event_index,
      legIndex: row.leg_index,
      account: row.account ? accountRef(row.account) : null,
      assetId: row.asset_id,
      usd: Number(scaledUsd(row.amount_usd)) / USD_UNIT,
    }))
  const last = items[items.length - 1]
  return {
    items,
    drips: await borrowDrips(blockSeconds),
    cursor: last ? `${last.block}-${last.eventIndex}-${last.legIndex}` : (after ?? `${head}-0-0`),
    head,
    blockSeconds,
  }
}
