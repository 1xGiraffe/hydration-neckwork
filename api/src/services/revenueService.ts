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
// overlap on an hour or straddle a gap (the `cold_mark` split the
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
import { chTimestamp } from './clickhouseTime.ts'
import { accountRef, type AccountRef } from './explorerService.ts'
import {
  HOLLAR_RESERVE_ADDRESS,
  PROTOCOL_REVENUE_PREDICATE_SQL,
  REVENUE_STREAMS,
  hollarBorrowHourlyRows,
  isProtocolRevenue,
  loadInternalPayerAccounts,
  protocolRevenueWindows,
  revenueColdCapPredicateSql,
  revenueColdMarks,
  revenueTailHours,
  revenueTailRows,
  revenueTailSeconds,
  type RevenueStream,
  type RevenueTailRow,
} from './revenueStreams.ts'
import { modlAccountId } from './tagService.ts'
import { displayDescriptor } from './explorerAssets.ts'
import {
  USER_REVENUE_DAILY_TABLE, USER_REVENUE_DUST_1E12 as USD_DUST, USER_REVENUE_HOURLY_TABLE, accountFoldCoverage, snapUserRevenueDust, publicationGeneration, userRevenueDayBuckets, userRevenueStreamTotals, userRevenueViaTotals,
  userRevenueOwnerKeySql, userRevenueWindows, windowFirstDay, type AccountFoldCoverage,
} from './userRevenueRead.ts'
import { USER_REVENUE_DISPLAY_STREAMS, userRevenueDisplayStream, type UserRevenueUnmeasured } from './userRevenueStreams.ts'
import { DECIMAL_STRINGS, OMNIPOOL_ACCOUNT, scaledUsd } from './valuation.ts'

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
export type StakerPot = 'staking' | 'gigahdx' | 'gigarwd'
export interface StakerPoint { t: number; hdx: number; usd: number }
export interface StakerDistributions {
  range: RevenueRange
  bucketSeconds: number
  series: { pot: StakerPot; points: StakerPoint[] }[]
  totals: { hdx: number; usd: number }
  allTime: { hdx: number; usd: number }
}
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

const USD_UNIT = 1e12

// The cold/tail composition (marks, caps, raw tail, the protocol-revenue twin)
// lives in revenueStreams.ts, shared with the public /v1/stats/platform headline.
export { isProtocolRevenue }
const coldMarks = (): Promise<Map<RevenueStream, string>> => revenueColdMarks(client)
const tailRows = (hours: number, marks: Map<RevenueStream, string>): Promise<RevenueTailRow[]> => revenueTailRows(client, hours, marks)
const coldCapPredicateSql = revenueColdCapPredicateSql
const tailSeconds = revenueTailSeconds
const tailHours = revenueTailHours
type TailRow = RevenueTailRow

// ---------------------------------------------------------------------------
// Staker distributions — the trade-fee HDX handed to the staking pots
// ---------------------------------------------------------------------------

/**
 * The three pots stakers are paid from, keyed by pallet account. The runtime's
 * fee processor converts the non-LP Omnipool fee share to HDX and splits it
 * 15% gigahdx! (GIGAHDX yield) / 25% gigarwd! (voting rewards) / 5% staking#
 * (legacy staking); before 2026-06-22 the referrals-pallet converter and the
 * Omnipool's direct in-HDX fee legs played the same role.
 */
const STAKER_POT_BY_ACCOUNT: Record<string, StakerPot> = {
  [modlAccountId('staking#')]: 'staking',
  [modlAccountId('gigahdx!')]: 'gigahdx',
  [modlAccountId('gigarwd!')]: 'gigarwd',
}
const STAKER_POTS_ORDERED: readonly StakerPot[] = ['staking', 'gigahdx', 'gigarwd']

/**
 * The from-account whitelist IS the revenue boundary: only the protocol's fee
 * converters count. Treasury incentive drips into the same pots are programme
 * outflows, not fee revenue, and stay outside deliberately — as do the
 * gigarwd!↔gigarwd!alc allocation round-trips and third-party dust.
 */
const STAKER_FEE_SOURCES: readonly string[] = [
  modlAccountId('feeproc/'), // fee processor, 2026-06-22 →
  modlAccountId('referral'), // referrals-pallet converter (legacy era)
  OMNIPOOL_ACCOUNT, // direct in-HDX fee legs (legacy era)
]

const HDX_UNIT = 1e12

const quotedList = (values: readonly string[]): string => values.map(v => `'${v}'`).join(', ')

/**
 * Fee-derived HDX inflows into the staking pots, hour-collapsed BEFORE the
 * price join: every transfer inside an hour shares the same last-closed 1h
 * candle under the event-time rule, so the collapse is exact and the ASOF join
 * touches thousands of hour rows instead of millions of legacy per-trade legs
 * (measured 18.4s → 0.5s all-time). FINAL is bounded by the three-pot
 * primary-key prefix, and a replayed range's replacement rows share the row's
 * block_timestamp, so the client's partition-scoped FINAL setting cannot split
 * a replace pair across partitions. An unpriced hour keeps usd = 0 — explicit
 * incompleteness, same rule as the revenue streams.
 *
 * The valuation is the plain decimal operators for the reason at `pricedCteSql`
 * in valuation.ts — `sum(toDecimal256(amount, 0))` is a Decimal256(0), so the
 * product with a Decimal256(12) close is an exact Decimal256(12) and dividing by
 * the Decimal256(0) unit keeps that scale. Measured 3.70 → 2.76 CPU-s all-time,
 * with the folded per-pot output identical to the digit.
 */
function stakerInflowsSql(marker: string, bucketExpr: string | null, startSql: string | null): string {
  return `-- rev:dashboard:${marker}
WITH pot_inflows AS (
  SELECT toStartOfHour(block_timestamp) AS hour_start, account AS pot,
         toUInt32(0) AS hdx_asset, sum(toDecimal256(amount, 0)) AS amount
  FROM price_data.account_transfer_activity FINAL
  WHERE account IN (${quotedList(Object.keys(STAKER_POT_BY_ACCOUNT))})
    AND to_account = account AND asset_id = 0
    AND from_account IN (${quotedList(STAKER_FEE_SOURCES)})
    ${startSql ? `AND block_timestamp >= toDateTime('${startSql}')` : ''}
  GROUP BY hour_start, pot
)
SELECT pot${bucketExpr ? `, toUnixTimestamp(${bucketExpr}) AS t` : ''},
       toString(sum(r.amount)) AS amount,
       toString(sum(if(p.close > 0,
         r.amount * toDecimal256(p.close, 12) / toDecimal256(${10n ** 12n}, 0),
         toDecimal256(0, 12)))) AS usd
FROM pot_inflows r
ASOF LEFT JOIN (
  SELECT asset_id, interval_start + INTERVAL 1 HOUR AS price_time, argMaxMerge(close_state) AS close
  FROM price_data.ohlc_1h
  WHERE asset_id = 0
  GROUP BY asset_id, interval_start
) p ON p.asset_id = r.hdx_asset AND p.price_time <= r.hour_start
GROUP BY pot${bucketExpr ? ', t ORDER BY t' : ''}`
}

interface StakerRow { pot: string; t?: number; amount: string; usd: string }

/**
 * All-time pot totals, cached once ACROSS ranges: the scan reads the pots'
 * full transfer slices (~10M rows), and the figure moves by well under a
 * display digit per freshness window, so every range's tiles share one scan.
 */
async function stakerAllTimeTotals(): Promise<{ hdx: bigint; usd: bigint }> {
  return cachedSwr('revenue:stakers:alltime', 60_000, 300_000, async () => {
    const res = await client.query({
      query: stakerInflowsSql('stakers-alltime', null, null),
      format: 'JSONEachRow',
      clickhouse_settings: DECIMAL_STRINGS,
    })
    let hdx = 0n
    let usd = 0n
    for (const row of await res.json<StakerRow>()) {
      if (!STAKER_POT_BY_ACCOUNT[row.pot]) continue
      hdx += BigInt(row.amount)
      usd += scaledUsd(row.usd)
    }
    return { hdx, usd }
  })
}

/**
 * The staker-distributions section reads this endpoint directly — it carries
 * its OWN range, independent of the dashboard's timeframe tabs, so the full
 * history is one request whatever window the rest of the page shows.
 */
export async function getStakerDistributions(range: RevenueRange): Promise<StakerDistributions> {
  return cachedSwr(`revenue:stakers:${range}`, 60_000, 300_000, async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const rangeStart = RANGE_SECONDS[range] == null ? 0 : nowSeconds - (RANGE_SECONDS[range] ?? 0)
    const seriesQuery = client.query({
      query: stakerInflowsSql(
        'stakers-series',
        RANGE_BUCKET_SQL[range].replace('block_timestamp', 'r.hour_start'),
        rangeStart > 0 ? chTimestamp(rangeStart) : null,
      ),
      format: 'JSONEachRow',
      clickhouse_settings: DECIMAL_STRINGS,
    })
    // The all-range series already spans everything — only bounded ranges need
    // the shared all-time totals for their tiles.
    const allTimePromise = range === 'all' ? null : stakerAllTimeTotals()

    // Integer planck/1e-12-USD sums end to end, one float conversion at the wire.
    const bySeries = new Map<StakerPot, Map<number, { hdx: bigint; usd: bigint }>>()
    let rangeHdx = 0n
    let rangeUsd = 0n
    for (const row of await (await seriesQuery).json<StakerRow>()) {
      const pot = STAKER_POT_BY_ACCOUNT[row.pot]
      if (!pot || row.t == null) continue
      const hdx = BigInt(row.amount)
      const usd = scaledUsd(row.usd)
      const series = bySeries.get(pot) ?? new Map<number, { hdx: bigint; usd: bigint }>()
      const point = series.get(Number(row.t)) ?? { hdx: 0n, usd: 0n }
      point.hdx += hdx
      point.usd += usd
      series.set(Number(row.t), point)
      bySeries.set(pot, series)
      rangeHdx += hdx
      rangeUsd += usd
    }
    const allTime = allTimePromise ? await allTimePromise : { hdx: rangeHdx, usd: rangeUsd }

    return {
      range,
      bucketSeconds: RANGE_BUCKET_SECONDS[range],
      series: STAKER_POTS_ORDERED
        .filter(pot => (bySeries.get(pot)?.size ?? 0) > 0)
        .map(pot => ({
          pot,
          points: [...(bySeries.get(pot) ?? new Map<number, { hdx: bigint; usd: bigint }>())]
            .sort(([a], [b]) => a - b)
            .map(([t, v]) => ({ t, hdx: Number(v.hdx) / HDX_UNIT, usd: Number(v.usd) / USD_UNIT })),
        })),
      totals: { hdx: Number(rangeHdx) / HDX_UNIT, usd: Number(rangeUsd) / USD_UNIT },
      allTime: { hdx: Number(allTime.hdx) / HDX_UNIT, usd: Number(allTime.usd) / USD_UNIT },
    }
  })
}

/** Accounts per top-account-sums read: ~35 KiB of parameter, well under the server's field cap. */
export const TOP_ACCOUNT_SUMS_CHUNK = 500

/** The first calendar month (YYYYMM) that starts at or after `s`. */
export function firstMonthInside(s: number): number {
  const d = new Date(s * 1000)
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  return s <= monthStart ? Number(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
    : Number(`${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, '0')}`)
}

/**
 * Each swapper's share of the Uniswap v3 vault realizations from `fromMonth`
 * on: account_revenue's uniswap_v3_fee row (accrued + realization share, one
 * key) less the account's accrued rows in revenue_events for the same month.
 * Only months whose account_revenue build is at least as new as their
 * revenue_events publication take part — the two halves then come from one
 * input, and the difference is exactly the share the job distributed.
 */
export function uniswapV3RealizationPayersSql(fromMonth: number): string {
  return `-- rev:dashboard:v3-realization-payers
WITH months AS (
  SELECT a.month AS month
  FROM (
    SELECT month, max(computed_at) AS built
    FROM price_data.account_revenue
    WHERE stream = 'uniswap_v3_fee' AND month >= ${fromMonth}
    GROUP BY month
  ) AS a
  INNER JOIN (
    -- Through the computed_by_hour projection's exact shape, so this reads it
    -- rather than every row's timestamp.
    SELECT toYYYYMM(hour) AS p, max(hour_published) AS published
    FROM (
      SELECT toStartOfHour(block_timestamp) AS hour, max(computed_at) AS hour_published
      FROM price_data.revenue_events
      GROUP BY hour
    )
    GROUP BY p
  ) AS r ON r.p = a.month
  WHERE a.built >= r.published
)
SELECT account, toString(sum(part)) AS usd
FROM (
  SELECT account, sum(revenue_usd) AS part
  FROM price_data.account_revenue
  WHERE stream = 'uniswap_v3_fee' AND account != '' AND month IN (SELECT month FROM months)
  GROUP BY account
  UNION ALL
  SELECT account, -sum(amount_usd) AS part
  FROM price_data.revenue_events
  WHERE stream = 'uniswap_v3_fee' AND dest = 'accrued' AND account != ''
    AND ${PROTOCOL_REVENUE_PREDICATE_SQL}
    AND toUInt32(toYYYYMM(block_timestamp)) IN (SELECT month FROM months)
  GROUP BY account
)
GROUP BY account
HAVING sum(part) > 0`
}

export async function getRevenueDashboard(range: RevenueRange): Promise<RevenueDashboard> {
  return cachedSwr(`revenue:dashboard:${range}`, 60_000, 300_000, async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const marks = await coldMarks()
    const caps = coldCapPredicateSql(marks)
    const bucketSeconds = RANGE_BUCKET_SECONDS[range]
    const rangeStart = RANGE_SECONDS[range] == null ? 0 : nowSeconds - (RANGE_SECONDS[range] ?? 0)
    const bucketSql = RANGE_BUCKET_SQL[range]

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
      .filter(row => isProtocolRevenue(row.stream, row.dest, row.internal_payer))

    // Integer 1e-12 USD end to end; one float conversion at the wire below. The
    // headline windows are the shared composition the public platform stats state.
    const totals = await protocolRevenueWindows(client, marks, tail, nowSeconds)
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
    // they borrowed. asset_reserve joins from account_revenue for months
    // FULLY inside the range — the range ends now, so the live month counts
    // once it starts inside it — exact for "all", and a mint in a month that
    // began before the range simply stays out of the ranking rather than
    // being time-scaled onto payers.
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
      // The internal payers' interest was already carved out of the booked
      // total, so their weight must come out of the split too — leaving it in
      // would hand their share to the borrowers beside them.
      const internal = await loadInternalPayerAccounts(client)
      const weights = (await weightsRes.json<{ account: string; interest: string }>())
        .map(r => ({ account: r.account, weight: BigInt(r.interest) }))
        .filter(w => !internal.has(w.account.toLowerCase()))
      for (const [account, usd] of distributeUsd1e12(hollarRangeUsd, weights)) addTop(account, usd)
    }
    if ((rangeTotals.get('asset_reserve') ?? 0n) > 0n) {
      const reserveRes = await client.query({
        query: `-- rev:dashboard:reserve-payers
SELECT account, toString(sum(revenue_usd)) AS usd
FROM price_data.account_revenue
WHERE stream = 'asset_reserve' AND account != ''
  AND month >= ${firstMonthInside(Math.max(rangeStart, 0))}
GROUP BY account`,
        format: 'JSONEachRow',
        clickhouse_settings: DECIMAL_STRINGS,
      })
      for (const row of await reserveRes.json<{ account: string; usd: string }>()) {
        addTop(row.account, scaledUsd(row.usd))
      }
    }

    // Uniswap v3 vault realizations are booked in revenue_events with no payer
    // (a vault's lump to the Treasury covers many swaps), so the cold ranking
    // above counts only the stream's accrued half. account_revenue holds each
    // swapper's share of those lumps beside the accrued half, under one key, so
    // the share is that row less the account's accrued rows of the same month —
    // for months fully inside the range (the range ends now, so the live month
    // counts once it starts inside it) and only where the month's attribution is
    // at least as new as its revenue_events publication, which is what makes the
    // difference exact. A month still awaiting its rebuild stays out of the
    // ranking for that refresh rather than being approximated.
    if ((rangeTotals.get('uniswap_v3_fee') ?? 0n) > 0n) {
      const sharesRes = await client.query({
        query: uniswapV3RealizationPayersSql(firstMonthInside(Math.max(rangeStart, 0))),
        format: 'JSONEachRow',
        clickhouse_settings: DECIMAL_STRINGS,
      })
      for (const row of await sharesRes.json<{ account: string; usd: string }>()) {
        addTop(row.account, scaledUsd(row.usd))
      }
    }

    // An account with adds but outside the cold top 10 still owns cold
    // eventful revenue the LIMIT dropped; without it the combined ranking
    // would compare partial totals. Fetch those accounts' exact cold sums
    // (bounded: tail actors + borrowers + reserve payers), then merge.
    // The list travels as a URL parameter, which the server caps at
    // http_max_field_value_size (128 KiB, ~1,800 quoted account ids) — the all-time
    // range's reserve payers and borrowers alone reach that — so it goes in chunks.
    const missing = [...adds.keys()].filter(account => !top.has(account))
    const sumChunks: string[][] = []
    for (let i = 0; i < missing.length; i += TOP_ACCOUNT_SUMS_CHUNK) sumChunks.push(missing.slice(i, i + TOP_ACCOUNT_SUMS_CHUNK))
    const sumRows = await Promise.all(sumChunks.map(async accounts => {
      const sumsRes = await client.query({
        query: `-- rev:dashboard:top-account-sums
SELECT account, toString(sum(amount_usd)) AS usd
FROM price_data.revenue_events
WHERE ${PROTOCOL_REVENUE_PREDICATE_SQL} AND ${caps}
  AND block_timestamp >= toDateTime('${chTimestamp(rangeStart)}')
  AND account IN {accounts:Array(String)}
GROUP BY account`,
        query_params: { accounts },
        format: 'JSONEachRow',
        clickhouse_settings: DECIMAL_STRINGS,
      })
      return sumsRes.json<{ account: string; usd: string }>()
    }))
    for (const row of sumRows.flat()) {
      top.set(row.account, scaledUsd(row.usd))
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

function afterCursor(row: Pick<TailRow, 'block_height' | 'event_index' | 'leg_index'>, [block, event, leg]: [number, number, number]): boolean {
  if (row.block_height !== block) return row.block_height > block
  if (row.event_index !== event) return row.event_index > event
  return row.leg_index > leg
}

/** The cursor just before the head block: an empty first page must not skip the head block's event 0. */
const cursorBeforeHead = (head: number): string => `${Math.max(0, head - 1)}-4294967295-65535`

/**
 * On a cursorless first call, only the most recent minute seeds the river — the
 * minute ending at the tail's NEWEST row, not at the wall clock: rows land most
 * of a minute after their block, so a wall-clock minute is mostly empty.
 */
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
 * Far enough back to find the sparsest market's last touch: gigahdx's HOLLAR
 * reserve is observed every few days, and a lookback shorter than a pool's
 * touch interval drops that pool from the river entirely.
 */
const DRIP_LOOKBACK_HOURS = 14 * 24

/**
 * The borrow drip: HOLLAR interest accrues every block, so the river shows it
 * as a per-block trickle at the LAST OBSERVED hourly accrual rate — measured
 * from our own booked math (hollarBorrowHourlyRows over the last closed
 * hours), not modeled from rate parameters, so the drip and the books always
 * agree at hour grain. Reserve-factor interest has no drip while
 * MintedToTreasury lies dormant; when mints resume they surface as booked
 * history, never as invented flow items.
 *
 * A booked row is an AMOUNT over `hoursCovered`, not an hourly figure: the
 * markets differ by orders of magnitude in how often they are touched (core
 * every few minutes, gigahdx every few days), so a quiet pool's row can carry
 * days of interest. Divide by the span to recover the rate, and look back far
 * enough to FIND the sparse markets at all — a window shorter than a pool's
 * touch interval drops that pool's whole share from the river rather than
 * showing it late.
 */
async function borrowDrips(blockSeconds: number): Promise<RevenueFlowResponse['drips']> {
  return cached('revenue:drips', 60_000, async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const rows = await hollarBorrowHourlyRows(client, nowSeconds - DRIP_LOOKBACK_HOURS * 3_600, nowSeconds)
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
      // Debt fully repaid means nothing is accruing any more, so carrying this
      // pool's last rate forward would invent flow the chain is not producing.
      // Interest the protocol owes itself is not revenue and must not stream
      // into the river either, so the rate is the external half of the accrual.
      .map(r => ({ ...r, usd1e12: r.usd1e12 - r.internalUsd1e12 }))
      .filter(r => r.usd1e12 > 0n && r.debtScaledAfter > 0n)
      .map(r => ({
        key: r.poolAddress,
        label: `HOLLAR interest · ${markets.get(r.poolAddress) ?? 'money market'}`,
        stream: 'hollar_borrow' as RevenueStream,
        // Integer-divide the money, then scale to a per-block rate.
        usdPerBlock: (Number(r.usd1e12 / BigInt(r.hoursCovered)) / USD_UNIT) * (blockSeconds / 3_600),
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
  const streamed = rows.filter(row => isProtocolRevenue(row.stream, row.dest, row.internal_payer))
  const seedFrom = streamed.reduce((m, row) => (row.block_timestamp ? Math.max(m, tailSeconds(row)) : m), 0) - FLOW_SEED_SECONDS
  const items = streamed
    // asset_reserve (MintedToTreasury) rides along as ITEMS: there is no
    // reserve-factor drip because that accrual is not observable from events at
    // all — it accumulates in each reserve's on-chain `accruedToTreasury` and
    // becomes a row only when someone calls `mintToTreasury` (last 2026-06-25),
    // so each mint is revenue the river has not streamed yet. The factor is not
    // zero; a drip would have to be modelled from chain state rather than
    // measured from our books, which is why there isn't one. Only hollar_borrow
    // drips, and its hourly reserve rows never reach the flow (they are not
    // eventful-stream rows).
    .filter(row => scaledUsd(row.amount_usd) > 0n)
    .filter(row => (after ? afterCursor(row, cursor) : tailSeconds(row) > seedFrom))
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
    cursor: last ? `${last.block}-${last.eventIndex}-${last.legIndex}` : (after ?? cursorBeforeHead(head)),
    head,
    blockSeconds,
  }
}

// ---------------------------------------------------------------------------
// User Revenue — what users EARN on Hydration (the second river)
// ---------------------------------------------------------------------------
//
// Read from the published folds only (services/userRevenueRead.ts): closed
// hours through `publishedThrough`, never a raw tail. Protocol Revenue above and
// User Revenue here are NOT additive — the LP-retained part of an Omnipool fee is
// user revenue, the protocol's part protocol revenue, and the HDX sub-pool's POL
// is both — so no surface adds them.

export interface UserRevenueSummary {
  totals: { day: number | null; week: number | null; month: number | null; allTime: number | null }
  /** End of the newest folded hour (ISO): every total is "through" it. */
  publishedThrough: string | null
  firstHour: string | null
  complete: boolean
  unpricedCells: number
  unmeasured: readonly UserRevenueUnmeasured[]
}

const isoOf = (s: number | null): string | null => (s == null ? null : new Date(s * 1000).toISOString())
const usdNum = (v: bigint | null): number | null => (v == null ? null : Number(v) / USD_UNIT)

export async function getUserRevenueSummary(): Promise<UserRevenueSummary> {
  const w = await userRevenueWindows(client)
  return {
    totals: { day: usdNum(w.day), week: usdNum(w.week), month: usdNum(w.month), allTime: usdNum(w.allTime) },
    publishedThrough: isoOf(w.coverage.publishedThrough),
    firstHour: isoOf(w.coverage.firstHour),
    complete: w.coverage.complete,
    unpricedCells: w.unpricedCells,
    unmeasured: w.coverage.unmeasured,
  }
}

export interface UserRevenueStreamSummary {
  stream: string
  label: string
  sign: 'earned' | 'paid' | 'both'
  revisable: boolean
  toggle: boolean
  coverage: string
  earned: number
  paid: number
  net: number
  unpriced: number
}

/** A history bucket: net, and the earned (Σ positive) and paid (Σ negative) account-day facts it nets. */
export interface UserRevenuePoint { t: number; usd: number; earned: number; paid: number }

export interface UserRevenueDashboard extends UserRevenueSummary {
  range: RevenueRange
  bucketSeconds: number
  /**
   * The account fold's cut (ISO): the history, breakdown, not-user and ranking
   * sections are account-grain facts "through" it; the headline totals are the
   * hourly fold's, through `publishedThrough`. Both are closed-hour cuts; the
   * account one trails by up to about an hour.
   */
  accountPublishedThrough: string | null
  /**
   * The ACCOUNT fold's completeness (every month since its first published,
   * reaching back to the price floor) — what the history, breakdown, not-user and
   * ranking sections stand on; `complete` above is the hourly fold's, for the
   * headline totals only.
   */
  accountComplete: boolean
  /** First UTC day of the range's day window (the breakdown, history and rankings), ending at the account cut. */
  fromDay: string | null
  history: { series: { stream: string; points: UserRevenuePoint[] }[] }
  /** Holder class `user`, per stream: earned / paid / net at the account-day grain. */
  breakdown: UserRevenueStreamSummary[]
  /** The breakdown's totals, summed exactly over every user stream's facts and snapped once (never a sum of the snapped rows). */
  breakdownTotal?: { earned: number; paid: number; net: number }
  /** What the fold booked but no user holds — named, never folded into User Revenue. */
  notUser: { holderClass: 'protocol' | 'unattributed'; net: number; causes: { via: string; net: number }[] }[]
  topEarners: { account: AccountRef; usd: number }[]
  topPayers: { account: AccountRef; usd: number }[]
}

const USER_RANGE_DAYS: Record<RevenueRange, number | null> = { '30d': 30, '1y': 365, all: null }
const USER_RANGE_GRAIN: Record<RevenueRange, 'day' | 'week' | 'month'> = { '30d': 'day', '1y': 'week', all: 'month' }

/** The sections below the headline: account-grain facts only. */
type UserRevenueDashboardSections = Omit<UserRevenueDashboard, keyof UserRevenueSummary>

/**
 * The /revenue/users dashboard over a day window ending at the fold's cut. The
 * HEADLINE is the summary itself, read per request from the same cache /revenue
 * reads (getUserRevenueSummary), so the two pages never disagree; the sections
 * below it are cached apart, as the generation of the account facts they read
 * (the account cut and the newest month build): a rebuild — at a new cut or the
 * same one — revalidates them, served stale meanwhile with the account cut they
 * were built at.
 */
export async function getUserRevenueDashboard(range: RevenueRange): Promise<UserRevenueDashboard> {
  const [summary, account] = await Promise.all([getUserRevenueSummary(), accountFoldCoverage(client)])
  const sections = await cachedSwr(`revenue:user-dashboard:${range}`, 120_000, 1_800_000, () => userRevenueDashboardSections(range, account), publicationGeneration(account))
  return { ...summary, ...sections }
}

async function userRevenueDashboardSections(range: RevenueRange, account: AccountFoldCoverage): Promise<UserRevenueDashboardSections> {
  // Every section below the headline reads the ACCOUNT facts, so its window ends at the account fold's cut.
  const through = account.publishedThrough
  const days = USER_RANGE_DAYS[range]
  const fromDay = through == null ? null
    : days == null ? (account.firstMonth != null ? `${Math.floor(account.firstMonth / 100)}-${String(account.firstMonth % 100).padStart(2, '0')}-01` : null)
    : windowFirstDay(through, days)
  const empty: UserRevenueDashboardSections = {
    range, bucketSeconds: RANGE_BUCKET_SECONDS[range], accountPublishedThrough: isoOf(through), accountComplete: account.complete, fromDay,
    history: { series: [] }, breakdown: [], notUser: [], topEarners: [], topPayers: [],
  }
  if (through == null || fromDay == null) return empty
  // The top earners and payers in ONE pass: whole months from the by_account_month projection (selected by
  // `_partition_id`, the form the projection's planner accepts — a `toYYYYMM(day)` range is not), the window's
  // first partial month from day rows; ten per sign.
  // Ranked by identity under the directory's rule (userRevenueTwinOwners): a twin a substrate account owns is
  // that account's, so the top earners name the accounts the directory ranks.
  const rankSql = `-- rev:user:top
SELECT who AS account, toString(s) AS usd FROM (
SELECT ${userRevenueOwnerKeySql('account')} AS who, sum(s) AS s FROM (
  SELECT account, sum(amount_usd) AS s FROM ${USER_REVENUE_DAILY_TABLE}
  WHERE _partition_id > {fromMonth:String} AND stream != '' AND holder_class = 'user' AND account != ''
  GROUP BY account
  UNION ALL
  SELECT account, sum(amount_usd) AS s FROM ${USER_REVENUE_DAILY_TABLE}
  WHERE _partition_id = {fromMonth:String} AND day >= toDate({from:String}) AND stream != '' AND holder_class = 'user' AND account != ''
  GROUP BY account)
GROUP BY who)
WHERE abs(s) >= 0.005
ORDER BY sign(s) DESC, abs(s) DESC, who
LIMIT 10 BY sign(s)`
  const [buckets, totals, vias, rankedRes] = await Promise.all([
    // Under the DISPLAY streams (userRevenueStreams.ts): HOLLAR's borrow interest is its own line.
    userRevenueDayBuckets(client, { grain: USER_RANGE_GRAIN[range], fromDay, holderClass: 'user', display: true }),
    userRevenueStreamTotals(client, { fromDay, display: true }),
    userRevenueViaTotals(client, { fromDay }),
    client.query({ query: rankSql, query_params: { from: fromDay, fromMonth: fromDay.slice(0, 7).replace('-', '') }, format: 'JSONEachRow' }),
  ])
  // The read rows are EXACT (userRevenueRead): every sum below is taken on them, and only a
  // figure the page states is snapped (shown) — so a class net or the page's total keeps
  // the sub-cent facts its rows carry.
  const shown = (v: bigint): number => Number(snapUserRevenueDust(v)) / USD_UNIT
  const series = new Map<string, UserRevenuePoint[]>()
  for (const b of buckets) {
    (series.get(b.stream) ?? series.set(b.stream, []).get(b.stream)!)
      .push({ t: b.t, usd: shown(b.net), earned: shown(b.earned), paid: shown(b.paid) })
  }
  // A stream whose every figure is dust (and nothing unpriced) is no row at all: "— — $0.00" states nothing.
  const userTotals = totals.filter(t => t.holderClass === 'user')
  const byStream = new Map(userTotals
    .filter(t => t.unpriced > 0 || [t.earned, t.paid, t.net].some(v => snapUserRevenueDust(v) !== 0n))
    .map(t => [t.stream, t]))
  const notUser = (['protocol', 'unattributed'] as const).map(holderClass => {
    const causes = vias.filter(v => v.holderClass === holderClass)
    return {
      holderClass,
      net: shown(causes.reduce((a, v) => a + v.net, 0n)),
      causes: causes.filter(v => snapUserRevenueDust(v.net) !== 0n).sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0))
        .map(v => ({ via: v.via || 'direct', net: shown(v.net) })),
    }
  }).filter(c => c.causes.length > 0)
  // The breakdown's own total row, summed exactly over EVERY user stream (dust rows included) and snapped once.
  const sumOf = (pick: (t: (typeof userTotals)[number]) => bigint) => userTotals.reduce((a, t) => a + pick(t), 0n)
  const rankedRows = (await rankedRes.json<{ account: string; usd: string }>())
    .map(r => ({ account: accountRef(r.account), usd: Number(scaledUsd(r.usd)) / USD_UNIT }))
  return {
    ...empty,
    history: {
      series: USER_REVENUE_DISPLAY_STREAMS.filter(d => series.has(d.id)).map(d => ({ stream: d.id, points: series.get(d.id)! })),
    },
    breakdown: USER_REVENUE_DISPLAY_STREAMS.filter(d => byStream.has(d.id)).map(d => {
      const t = byStream.get(d.id)!
      return {
        stream: d.id, label: d.label, sign: d.sign, revisable: d.revisable, toggle: d.toggle ?? false, coverage: d.coverage,
        earned: shown(t.earned), paid: shown(t.paid), net: shown(t.net), unpriced: t.unpriced,
      }
    }),
    breakdownTotal: { earned: shown(sumOf(t => t.earned)), paid: shown(sumOf(t => t.paid)), net: shown(sumOf(t => t.net)) },
    notUser,
    topEarners: rankedRows.filter(r => r.usd > 0),
    topPayers: rankedRows.filter(r => r.usd < 0),
  }
}

/** Revisable streams (a later event still moves their recent hours) stream their mean over this many closed hours. */
export const USER_FLOW_REVISABLE_MEAN_HOURS = 24

export interface UserRevenueFlowResponse {
  /** Start of the newest folded hour (ISO) whose rate the river streams (revisable streams: the mean of the 24 hours ending with it). */
  hour: string | null
  /** The trailing window revisable streams are averaged over (hours, ending with `hour`). */
  revisableMeanHours: number
  publishedThrough: string | null
  blockSeconds: number
  head: number
  /** Earnings only: every drip is positive (costs are the dashboard breakdown's Paid column, never streamed). */
  drips: { key: string; stream: string; label: string; assetId: number; usdPerBlock: number }[]
}

/**
 * The user river's feed. User Revenue accrues continuously and is booked per
 * closed hour, so the river streams the NEWEST folded hour's rate per
 * (stream, asset), one block at a time — the same measured-not-modelled rule as
 * the protocol river's borrow drip — and says which hour it is streaming. A
 * REVISABLE stream's newest hours are not decided yet (a token's pending peg, a
 * farm's next sync, a voter's record), so it streams its mean over the trailing
 * 24 closed hours instead of an hour that can read negative before it is restated.
 * The river shows only what users EARN: a (stream, asset) whose rate nets to a
 * cost (borrow interest, exit fees, forfeits) is no drip.
 */
export async function getUserRevenueFlow(): Promise<UserRevenueFlowResponse> {
  const [head, blockMs, flow] = await Promise.all([
    indexedHead(),
    measuredParaBlockMs(client),
    cached('revenue:user-flow', 60_000, async () => {
      // The newest folded hour comes from its MARKER, read on its own: an hour with no user fact is still published.
      const markerRes = await client.query({
        query: `-- rev:user-flow-hour
SELECT toUnixTimestamp(max(hour)) AS h, count() AS n FROM ${USER_REVENUE_HOURLY_TABLE} WHERE stream = ''`,
        format: 'JSONEachRow',
      })
      const marker = (await markerRes.json<{ h: string; n: string }>())[0]
      const newest = marker && Number(marker.n) > 0 ? Number(marker.h) : null
      if (newest == null) return { hour: null, rows: [] }
      // A token's accrual is valued in its UNDERLYING (PRIME and uBIL in HOLLAR): its drip is keyed and labelled by
      // the token its pot names (token:<id>), never by the asset it is valued in.
      const res = await client.query({
        query: `-- rev:user-flow
SELECT stream, if(startsWith(stream, 'token_accrual') AND startsWith(pot, 'token:'), toUInt32OrZero(substring(pot, 7)), asset_id) AS asset_id,
       toString(sumIf(amount_usd, hour = toDateTime({h:UInt32}))) AS last, toString(sum(amount_usd)) AS trailing
FROM ${USER_REVENUE_HOURLY_TABLE}
WHERE hour > toDateTime({h:UInt32}) - INTERVAL ${USER_FLOW_REVISABLE_MEAN_HOURS} HOUR AND hour <= toDateTime({h:UInt32})
  AND stream != '' AND holder_class = 'user' AND NOT startsWith(via, 'unmeasured:')
GROUP BY stream, asset_id`,
        query_params: { h: newest },
        format: 'JSONEachRow',
      })
      const revisable = new Set(USER_REVENUE_DISPLAY_STREAMS.filter(d => d.revisable).map(d => d.id))
      // Each drip under its DISPLAY stream: a HOLLAR loan's interest is "HOLLAR interest".
      const rows = (await res.json<{ stream: string; asset_id: string; last: string; trailing: string }>())
        .map(r => ({ ...r, stream: userRevenueDisplayStream(r.stream, Number(r.asset_id)) }))
        .map(r => ({ stream: r.stream, asset_id: r.asset_id, usd: revisable.has(r.stream) ? scaledUsd(r.trailing) / BigInt(USER_FLOW_REVISABLE_MEAN_HOURS) : scaledUsd(r.last) }))
      return { hour: newest, rows }
    }),
  ])
  const blockSeconds = blockMs / 1_000
  const labels = new Map(USER_REVENUE_DISPLAY_STREAMS.map(d => [d.id, d.label]))
  const hour = flow.hour
  return {
    hour: isoOf(hour),
    revisableMeanHours: USER_FLOW_REVISABLE_MEAN_HOURS,
    publishedThrough: isoOf(hour == null ? null : hour + 3_600),
    blockSeconds,
    head,
    drips: flow.rows
      .filter(r => r.usd >= USD_DUST)
      .map(r => ({
        key: `${r.stream}:${r.asset_id}`,
        stream: r.stream,
        label: `${labels.get(r.stream) ?? r.stream} · ${displayDescriptor(Number(r.asset_id)).symbol}`,
        assetId: Number(r.asset_id),
        usdPerBlock: (Number(r.usd) / USD_UNIT) * (blockSeconds / 3_600),
      }))
      .sort((a, b) => b.usdPerBlock - a.usdPerBlock),
  }
}
