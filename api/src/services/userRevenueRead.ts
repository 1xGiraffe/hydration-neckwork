// The ONE read model of User Revenue's published facts
// (clickhouse/schema/016_user_revenue.sql), shared by the explorer, the public
// /v1/stats/platform headline and the Data API, so a total cannot be stated two
// ways. Definitions (streams, classes, coverage) live in userRevenueStreams.ts;
// this module only reads what the derivations jobs published.
//
// Freshness is the fold's, never a raw tail: User Revenue is booked per CLOSED
// chain hour, so every window here is "the last N closed hours through
// `publishedThrough`" (the end of the newest folded hour), not "the last N hours
// to now". Every folded hour carries a MARKER row (stream = ''), so an hour that
// earned nothing is still a folded hour, and a window whose hours are not all
// folded is INCOMPLETE — its amount is null, never a plausible 0.
//
// Amounts are 1e-12 USD integers (bigint) end to end, exact (never dust-snapped) until a
// surface states a figure: sums over rows are taken on the exact values, and only the
// figure shown is snapped (snapUserRevenueDust) or rendered (renderUsd rounds to cents).

import type { ClickHouseClient } from '../db/client.ts'
import { mapParamChunks } from '../db/queryParams.ts'
import { cachedSwr } from './cache.ts'
import { assetDescriptor } from './explorerAssets.ts'
import { scaledUsd } from './valuation.ts'
import {
  HOLDER_CLASSES, USER_REVENUE_STREAMS, USER_REVENUE_UNMEASURED, hollarInterestFactSql, userRevenueDisplayStream, userRevenueDisplayStreamSql,
  type HolderClass, type UserRevenueUnmeasured,
} from './userRevenueStreams.ts'

/**
 * Dust: a published amount under half a cent either way is shown and ranked as
 * exactly 0 on every surface — a ±$0.001 net is a rounding residue of opposite
 * cells, not a user who earned or paid.
 */
export const USER_REVENUE_DUST_1E12 = 5_000_000_000n
export const snapUserRevenueDust = (v: bigint): bigint => (v < USER_REVENUE_DUST_1E12 && v > -USER_REVENUE_DUST_1E12 ? 0n : v)
// A FINAL figure (a headline window: the whole class summed in SQL) snaps as it is read.
const readShownUsd = (text: string): bigint => snapUserRevenueDust(scaledUsd(text))
// Every other row is an INPUT to a surface's own totals (a class net over its causes, a
// page's sum over streams), so it stays exact: snapping each row first would drop every
// sub-cent fact before it reaches the sum. The surface snaps only the figures it shows.
const readUsd = (text: string): bigint => scaledUsd(text)

/**
 * The stream column a reader groups by: the fold's own, or (`display`) the
 * explorer's display stream (userRevenueStreams.ts USER_REVENUE_DISPLAY_STREAMS:
 * HOLLAR's borrow interest apart). Aliased `ds`, never `stream`, so the WHERE
 * clause keeps reading the column. A `stream` filter is always the fold's.
 */
const streamSelectSql = (display?: boolean): string => `${display ? userRevenueDisplayStreamSql() : 'stream'} AS ds`

/** The HOLLAR-interest slice of a row (zero for every other stream): the Data API states it beside `mm_borrow_interest`. */
const HOLLAR_SLICE_SQL = `,
       toString(sumIf(amount_usd, amount_usd > 0 AND ${hollarInterestFactSql()})) AS h_earned,
       toString(sumIf(amount_usd, amount_usd < 0 AND ${hollarInterestFactSql()})) AS h_paid,
       toString(sumIf(amount_usd, ${hollarInterestFactSql()})) AS h_net`

/** Earned / paid / net of one slice of a row (1e-12 USD; paid ≤ 0). */
export interface UserRevenueSlice { earned: bigint; paid: bigint; net: bigint }

export const USER_REVENUE_HOURLY_TABLE = 'price_data.user_revenue_hourly'
export const USER_REVENUE_DAILY_TABLE = 'price_data.account_user_revenue_daily'

const HOUR_S = 3_600
const DAY_S = 86_400

/** The headline windows, in closed hours ending at `publishedThrough`. */
export const USER_REVENUE_WINDOW_HOURS = { day: 24, week: 168, month: 720 } as const

const ACCOUNT_RE = /^0x[0-9a-f]{64}$/

/**
 * A booked fact: not a fold marker (stream '') and not an UNMEASURED marker
 * (a zero-amount row per (hour, token) whose via is 'unmeasured:<reason>',
 * which states a gap rather than an amount). Listing reads filter on it; sums
 * need not (both kinds carry 0).
 */
export const FACT_SQL = "stream != '' AND NOT startsWith(via, 'unmeasured:')"

export interface UserRevenueCoverage {
  /** Start (unix s) of the first folded hour; null while nothing is published. */
  firstHour: number | null
  /** Start (unix s) of the newest folded hour. */
  lastHour: number | null
  /** End (unix s) of the newest folded hour: every figure is "through" this instant. */
  publishedThrough: number | null
  /** Folded hours between firstHour and lastHour. */
  foldedHours: number
  /** No unfolded hour between the first and the newest folded one. */
  complete: boolean
  /** What User Revenue does not measure, stated beside every total. */
  unmeasured: readonly UserRevenueUnmeasured[]
}

export interface UserRevenueWindows {
  coverage: UserRevenueCoverage
  /** Net USD (1e-12) of the class over the last 24 / 168 / 720 closed hours and all time; null when a window is not fully folded. */
  day: bigint | null
  week: bigint | null
  month: bigint | null
  allTime: bigint | null
  /** Facts the fold booked but could not value, all time (counted, never valued at 0). */
  unpricedCells: number
}

interface WindowRow {
  first_hour: string; last_hour: string; folded: string; expected_first?: string
  folded_day: string; folded_week: string; folded_month: string
  day: string; week: string; month: string; all_time: string; unpriced: string
}

/**
 * The first hour the folds can value — the derivations' price floor
 * (jobs.PRICED_FLOOR_SQL; pinned equal by tests/userRevenueRead.test.ts): the
 * first chain hour that has a block and a closed candle before it. All-time is
 * complete only when the folded hours reach back to it.
 */
export const USER_REVENUE_EXPECTED_FIRST_HOUR_SQL = `greatest(
    toStartOfHour((SELECT min(block_timestamp) FROM price_data.blocks WHERE _partition_id != '197001')),
    (SELECT min(interval_start) FROM price_data.ohlc_1h WHERE _partition_id != '197001') + INTERVAL 1 HOUR)`

/** The windowed SQL: one pass over the hourly facts, markers and amounts together. */
export function userRevenueWindowsSql(): string {
  const w = USER_REVENUE_WINDOW_HOURS
  const inWindow = (hours: number) => `hour > newest - INTERVAL ${hours} HOUR`
  return `-- ur:windows
WITH (SELECT max(hour) FROM ${USER_REVENUE_HOURLY_TABLE} WHERE stream = '') AS newest
SELECT toUnixTimestamp(${USER_REVENUE_EXPECTED_FIRST_HOUR_SQL}) AS expected_first,
       toUnixTimestamp(minIf(hour, stream = '')) AS first_hour,
       toUnixTimestamp(newest) AS last_hour,
       uniqExactIf(hour, stream = '') AS folded,
       uniqExactIf(hour, stream = '' AND ${inWindow(w.day)}) AS folded_day,
       uniqExactIf(hour, stream = '' AND ${inWindow(w.week)}) AS folded_week,
       uniqExactIf(hour, stream = '' AND ${inWindow(w.month)}) AS folded_month,
       toString(sumIf(amount_usd, stream != '' AND holder_class = {cls:String} AND ${inWindow(w.day)})) AS day,
       toString(sumIf(amount_usd, stream != '' AND holder_class = {cls:String} AND ${inWindow(w.week)})) AS week,
       toString(sumIf(amount_usd, stream != '' AND holder_class = {cls:String} AND ${inWindow(w.month)})) AS month,
       toString(sumIf(amount_usd, stream != '' AND holder_class = {cls:String})) AS all_time,
       sumIf(unpriced, stream != '' AND holder_class = {cls:String}) AS unpriced
FROM ${USER_REVENUE_HOURLY_TABLE}
WHERE hour <= newest`
}

/** Pure: the query row → windows, nulling every window whose hours are not all folded. */
export function windowsFromRow(r: WindowRow | undefined): UserRevenueWindows {
  const folded = Number(r?.folded ?? 0)
  if (!r || folded === 0) {
    return {
      coverage: { firstHour: null, lastHour: null, publishedThrough: null, foldedHours: 0, complete: false, unmeasured: UNMEASURED_ERAS },
      day: null, week: null, month: null, allTime: null, unpricedCells: 0,
    }
  }
  const firstHour = Number(r.first_hour)
  const lastHour = Number(r.last_hour)
  const span = Math.floor((lastHour - firstHour) / HOUR_S) + 1
  // Contiguous from the first folded hour is not enough: the first one must be the floor the folds start at
  // (a history whose early months are not published yet is not "all time").
  const expectedFirst = r.expected_first != null ? Number(r.expected_first) : null
  const complete = folded === span && expectedFirst != null && firstHour <= expectedFirst
  const w = USER_REVENUE_WINDOW_HOURS
  // A window reaching back before the first folded hour is not covered either.
  const full = (n: string, hours: number) => Number(n) === hours && lastHour - (hours - 1) * HOUR_S >= firstHour
  return {
    coverage: { firstHour, lastHour, publishedThrough: lastHour + HOUR_S, foldedHours: folded, complete, unmeasured: UNMEASURED_ERAS },
    day: full(r.folded_day, w.day) ? readShownUsd(r.day) : null,
    week: full(r.folded_week, w.week) ? readShownUsd(r.week) : null,
    month: full(r.folded_month, w.month) ? readShownUsd(r.month) : null,
    allTime: complete ? readShownUsd(r.all_time) : null,
    unpricedCells: Number(r.unpriced ?? 0),
  }
}

/**
 * The headline: net User Revenue (holder class `user` by default) over the last
 * 24 / 168 / 720 closed hours and all time. The fold publishes about once an
 * hour, so a 60 s fresh / 10 min stale cache is never more than one hour behind
 * what the tables hold.
 */
export async function userRevenueWindows(client: ClickHouseClient, holderClass: HolderClass = 'user'): Promise<UserRevenueWindows> {
  return cachedSwr(`user-revenue:windows:${holderClass}`, 60_000, 600_000, async () => {
    const [res, gaps] = await Promise.all([
      client.query({ query: userRevenueWindowsSql(), query_params: { cls: holderClass }, format: 'JSONEachRow' }),
      unmeasuredTokenRows(client),
    ])
    const w = windowsFromRow((await res.json<WindowRow>())[0])
    return { ...w, coverage: { ...w.coverage, unmeasured: unmeasuredList(gaps) } }
  })
}

export interface UnmeasuredTokenRow { assetId: number; reason: string; hours: number; lastHour: number; stream?: string }

/**
 * The fold's own UNMEASURED markers over the last 30 folded days: per token
 * and reason, how many hours it could not measure and the newest one.
 */
export async function unmeasuredTokenRows(client: ClickHouseClient): Promise<UnmeasuredTokenRow[]> {
  const res = await client.query({
    query: `-- ur:unmeasured
WITH (SELECT max(hour) FROM ${USER_REVENUE_HOURLY_TABLE} WHERE stream = '') AS newest
SELECT stream, asset_id, substring(via, 12) AS reason, uniqExact(hour) AS hours, toUnixTimestamp(max(hour)) AS last_hour
FROM ${USER_REVENUE_HOURLY_TABLE}
WHERE hour > newest - INTERVAL ${USER_REVENUE_WINDOW_HOURS.month} HOUR AND startsWith(via, 'unmeasured:')
GROUP BY stream, asset_id, reason
ORDER BY stream, asset_id, reason`,
    format: 'JSONEachRow',
  })
  return (await res.json<{ stream: string; asset_id: string; reason: string; hours: string; last_hour: string }>())
    .map(r => ({ stream: r.stream, assetId: Number(r.asset_id), reason: r.reason, hours: Number(r.hours), lastHour: Number(r.last_hour) }))
}

/** The era gaps (always stated); the token gaps come from the fold's own markers. */
export const UNMEASURED_ERAS: readonly UserRevenueUnmeasured[] = USER_REVENUE_UNMEASURED.filter(u => u.scope === 'era')

/** One unmeasured entry as a single wire string: an era by its label, a token gap with its reason. */
export const unmeasuredText = (u: UserRevenueUnmeasured): string => (u.scope === 'token' ? `${u.label}: ${u.reason}` : u.label)

/**
 * Why a token's accrual is unmeasured, per the fold's `unmeasured:<reason>`
 * marker (userRevenueTokens.ts), as every surface states it.
 */
export const UNMEASURED_REASON_LABEL: Record<string, string> = {
  'peg-pending': 'accrued since its last decided rate move — booked once the next move decides it',
  'peg-gave-back': 'its rate fell more than 1 % under its 30-day high — a relayed price, not a yield',
  'peg-jump': 'a rate move implying more than 50 % APR, or within a day of one — a relayed price, not accrual',
  'under-high-water': 'oracle noise, totals exact — its rate stood at or under its high-water mark, so those hours recover value already booked and add no new yield',
  'farm-unstated': 'the farm entry\'s claimable could not be stated at the hours\' edges (no opening to difference from) — not booked, never 0',
  'farm-state-unknown': 'no configuration or sync of the entry\'s farm is indexed, so its rewards cannot be stated — not booked, never 0',
  'peg-source-changed': 'its pool switched the rate\'s source — from the old source\'s last move to the new source\'s first reading, not a move of the rate',
  'peg-never-moved': 'its on-chain rate never moved (a static governance-set peg)',
  'no-rate-yet': 'held before the token had any on-chain rate',
  'no-rate-indexed': 'no on-chain redemption rate is indexed for it',
  'decimals-unknown': 'its decimals are unknown',
}
export const unmeasuredReasonLabel = (reason: string): string => UNMEASURED_REASON_LABEL[reason] ?? reason.replace(/[-_]/g, ' ')

/**
 * Pure: what is unmeasured, as surfaces list it — every era no source states,
 * then each (token, reason) the fold itself marked unmeasured in the last 30
 * folded days, with how many of those hours it covers.
 */
export function unmeasuredList(rows: UnmeasuredTokenRow[]): UserRevenueUnmeasured[] {
  // Real gaps first; a rate standing under its high-water mark is oracle noise with exact totals, listed last.
  const noise = (r: UnmeasuredTokenRow) => (r.reason === 'under-high-water' ? 1 : 0)
  return [
    ...UNMEASURED_ERAS,
    ...[...rows].sort((a, b) => noise(a) - noise(b)).map(r => {
      // u32::MAX is a farm marker's "reward asset unknown" (userRevenueFarms.FARM_UNKNOWN_REWARD_ASSET).
      const symbol = r.assetId === 4_294_967_295 ? 'Unknown-asset' : assetDescriptor(r.assetId)?.symbol ?? `#${r.assetId}`
      const what = r.stream === 'farm_rewards' ? 'farm rewards' : r.reason === 'under-high-water' ? 'rate (oracle noise)' : 'accrual'
      return {
        id: `unmeasured:${r.stream && r.stream !== 'token_accrual' ? `${r.stream}:` : ''}${r.assetId}:${r.reason}`,
        scope: 'token' as const,
        label: `${symbol} ${what}`,
        reason: `${unmeasuredReasonLabel(r.reason)} (${r.hours.toLocaleString('en-US')} of the last ${USER_REVENUE_WINDOW_HOURS.month} published hours)`,
      }
    }),
  ]
}

// ---------------------------------------------------------------------------
// Bucketed series (global, from the hourly facts)
// ---------------------------------------------------------------------------

export type UserRevenueGrain = 'hour' | 'day' | 'week' | 'month'

const GRAIN_SQL: Record<UserRevenueGrain, string> = {
  hour: 'hour',
  day: 'toStartOfDay(hour)',
  week: 'toStartOfWeek(hour, 1)',
  month: 'toStartOfMonth(hour)',
}

export interface UserRevenueBucketRow {
  /** Bucket start, unix s (UTC; weeks Monday-anchored). */
  t: number
  stream: string
  holderClass: HolderClass
  /** Net, 1e-12 USD. */
  usd: bigint
  unpriced: number
}

/**
 * NET USD per (bucket, stream, holder class) over `[from, to)` (unix s, hour
 * starts), from the hourly facts — a cell there already nets every account's
 * facts of the hour, so it cannot be split by sign: a chart that shows earned and
 * paid apart reads userRevenueDayBuckets.
 */
export async function userRevenueBuckets(client: ClickHouseClient, opts: {
  grain: UserRevenueGrain; from: number; to: number; stream?: string; holderClass?: HolderClass
}): Promise<UserRevenueBucketRow[]> {
  const res = await client.query({
    query: `-- ur:buckets
SELECT toUnixTimestamp(${GRAIN_SQL[opts.grain]}) AS t, stream, holder_class,
       toString(sum(amount_usd)) AS usd, sum(unpriced) AS unpriced
FROM ${USER_REVENUE_HOURLY_TABLE}
WHERE hour >= toDateTime({from:UInt32}) AND hour < toDateTime({to:UInt32}) AND ${FACT_SQL}
  ${opts.stream ? 'AND stream = {stream:String}' : ''}
  ${opts.holderClass ? 'AND holder_class = {cls:String}' : ''}
GROUP BY t, stream, holder_class
ORDER BY t, stream, holder_class`,
    query_params: { from: opts.from, to: opts.to, stream: opts.stream ?? '', cls: opts.holderClass ?? '' },
    format: 'JSONEachRow',
  })
  return (await res.json<{ t: string; stream: string; holder_class: HolderClass; usd: string; unpriced: string }>())
    .map(r => ({ t: Number(r.t), stream: r.stream, holderClass: r.holder_class, usd: readUsd(r.usd), unpriced: Number(r.unpriced) }))
}

/** Earned / paid / net per (bucket, stream, holder class) from the ACCOUNT facts. */
export interface UserRevenueSignedBucketRow {
  /** Bucket start, unix s (UTC; weeks Monday-anchored). */
  t: number
  stream: string
  holderClass: HolderClass
  /** Σ of the positive account-day facts (1e-12 USD). */
  earned: bigint
  /** Σ of the negative account-day facts (≤ 0). */
  paid: bigint
  net: bigint
  unpriced: number
  /** `hollarSlice` only: the HOLLAR-interest part of this row (mm_borrow_interest rows; zero elsewhere). */
  hollar?: UserRevenueSlice
}

const DAY_GRAIN_SQL: Record<'day' | 'week' | 'month', string> = {
  day: 'day',
  week: 'toStartOfWeek(day, 1)',
  month: 'toStartOfMonth(day)',
}

/**
 * The series every chart splits by sign: per (bucket, stream, class) the sum of
 * the positive and of the negative ACCOUNT-DAY facts over UTC days
 * `[fromDay, toDay]` — the grain the breakdown's earned / paid use, so a chart
 * column and the table agree, and a signed stream (supply interest passed to a
 * wrapper's borrowers, a farm write-down) shows both sides instead of netting
 * them away. Read from the account fold: "through" its cut.
 */
export async function userRevenueDayBuckets(client: ClickHouseClient, opts: {
  grain: 'day' | 'week' | 'month'; fromDay: string; toDay?: string; stream?: string; holderClass?: HolderClass
  /** Group by the explorer's display streams (HOLLAR interest apart). */
  display?: boolean
  /** Add each row's HOLLAR-interest slice (`hollar`). */
  hollarSlice?: boolean
}): Promise<UserRevenueSignedBucketRow[]> {
  const res = await client.query({
    query: `-- ur:day-buckets
SELECT toUnixTimestamp(toDateTime(${DAY_GRAIN_SQL[opts.grain]})) AS t, ${streamSelectSql(opts.display)}, holder_class,
       toString(sumIf(amount_usd, amount_usd > 0)) AS earned,
       toString(sumIf(amount_usd, amount_usd < 0)) AS paid,
       toString(sum(amount_usd)) AS net, sum(unpriced) AS unpriced${opts.hollarSlice ? HOLLAR_SLICE_SQL : ''}
FROM ${USER_REVENUE_DAILY_TABLE}
WHERE day >= toDate({from:String}) ${opts.toDay ? 'AND day <= toDate({to:String})' : ''} AND ${FACT_SQL}
  ${opts.stream ? 'AND stream = {stream:String}' : ''}
  ${opts.holderClass ? 'AND holder_class = {cls:String}' : ''}
GROUP BY t, ds, holder_class
ORDER BY t, ds, holder_class`,
    query_params: { from: opts.fromDay, to: opts.toDay ?? '', stream: opts.stream ?? '', cls: opts.holderClass ?? '' },
    format: 'JSONEachRow',
  })
  type Raw = { t: string; ds: string; holder_class: HolderClass; earned: string; paid: string; net: string; unpriced: string; h_earned?: string; h_paid?: string; h_net?: string }
  return (await res.json<Raw>())
    .map(r => ({
      t: Number(r.t), stream: r.ds, holderClass: r.holder_class, earned: readUsd(r.earned), paid: readUsd(r.paid), net: readUsd(r.net), unpriced: Number(r.unpriced),
      ...(opts.hollarSlice ? { hollar: { earned: readUsd(r.h_earned ?? '0'), paid: readUsd(r.h_paid ?? '0'), net: readUsd(r.h_net ?? '0') } } : {}),
    }))
}

// ---------------------------------------------------------------------------
// Earned / paid / net (from the account facts: a sign is an ACCOUNT's sign)
// ---------------------------------------------------------------------------

export interface UserRevenueStreamTotals {
  stream: string
  holderClass: HolderClass
  /** Σ of the positive account-day facts (1e-12 USD). */
  earned: bigint
  /** Σ of the negative account-day facts (≤ 0). */
  paid: bigint
  net: bigint
  unpriced: number
}

export interface UserRevenueViaTotal { holderClass: HolderClass; via: string; net: bigint }

/**
 * Earned / paid / net per (stream, holder class) over UTC days `[fromDay, toDay]`
 * (inclusive, 'YYYY-MM-DD'), optionally for a set of accounts. Earned and paid
 * are summed at the account-day grain — the hourly facts net different
 * accounts into one row, so only the account facts can tell an account's
 * borrow interest from another's supply interest of the same stream.
 */
export async function userRevenueStreamTotals(client: ClickHouseClient, opts: {
  fromDay: string; toDay?: string; accounts?: string[]
  /** Group by the explorer's display streams (HOLLAR interest apart). */
  display?: boolean
}): Promise<UserRevenueStreamTotals[]> {
  const accounts = opts.accounts ? safeAccounts(opts.accounts) : null
  if (accounts && !accounts.length) return []
  const res = await client.query({
    query: `-- ur:stream-totals
SELECT ${streamSelectSql(opts.display)}, holder_class,
       toString(sumIf(amount_usd, amount_usd > 0)) AS earned,
       toString(sumIf(amount_usd, amount_usd < 0)) AS paid,
       toString(sum(amount_usd)) AS net,
       sum(unpriced) AS unpriced
FROM ${USER_REVENUE_DAILY_TABLE}
WHERE ${accounts ? 'account IN {accounts:Array(String)} AND ' : ''}day >= toDate({from:String})
  ${opts.toDay ? 'AND day <= toDate({to:String})' : ''} AND ${FACT_SQL}
GROUP BY ds, holder_class`,
    query_params: { from: opts.fromDay, to: opts.toDay ?? '', accounts: accounts ?? [] },
    format: 'JSONEachRow',
  })
  return (await res.json<{ ds: string; holder_class: HolderClass; earned: string; paid: string; net: string; unpriced: string }>())
    .map(r => ({ stream: r.ds, holderClass: r.holder_class, earned: readUsd(r.earned), paid: readUsd(r.paid), net: readUsd(r.net), unpriced: Number(r.unpriced) }))
}

/**
 * The non-user classes' net per named cause (`via`'s leaf: the last custody
 * segment — 'omnipool-hub-channel', 'sovereign', 'voting-unrecorded', …), over
 * the same days. What no user holds is stated, never folded into a user total.
 */
export async function userRevenueViaTotals(client: ClickHouseClient, opts: { fromDay: string; toDay?: string }): Promise<UserRevenueViaTotal[]> {
  const res = await client.query({
    query: `-- ur:via-totals
SELECT holder_class, if(via = '', '', arrayElement(splitByChar('>', via), -1)) AS cause, toString(sum(amount_usd)) AS net
FROM ${USER_REVENUE_DAILY_TABLE}
WHERE day >= toDate({from:String}) ${opts.toDay ? 'AND day <= toDate({to:String})' : ''}
  AND ${FACT_SQL} AND holder_class != 'user'
GROUP BY holder_class, cause`,
    query_params: { from: opts.fromDay, to: opts.toDay ?? '' },
    format: 'JSONEachRow',
  })
  return (await res.json<{ holder_class: HolderClass; cause: string; net: string }>())
    .map(r => ({ holderClass: r.holder_class, via: r.cause, net: readUsd(r.net) }))
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function safeAccounts(accounts: string[]): string[] {
  return [...new Set(accounts.map(a => a.toLowerCase()).filter(a => ACCOUNT_RE.test(a)))]
}

export interface AccountFoldCoverage {
  /** Months (YYYYMM) the account fold has published, oldest and newest. */
  firstMonth: number | null
  lastMonth: number | null
  /** Every month from the first to the current UTC month is published. */
  complete: boolean
  /** When the newest month was computed (unix s). */
  computedAt: number | null
  /**
   * The account fold's CUT (unix s): the end of the last hour its newest month
   * folded — every account-grain figure (per-account facts, breakdowns, rankings,
   * earned / paid series) is "through" this instant, which can trail the hourly
   * fold's publishedThrough by up to about an hour.
   */
  publishedThrough: number | null
  /** When each published month (YYYYMM) was last computed (unix s): a rebuild at the same cut still moves it. */
  computedByMonth: ReadonlyMap<number, number>
}

/**
 * The PUBLICATION GENERATION of the account facts a window reads: the newest
 * build among the months it covers (all months when unbounded). A cache keyed
 * on the cut alone keeps serving a month rebuilt at the same cut (a registry,
 * peg or anchor restatement); keyed on this as well it turns over with the
 * rebuild. 0 while nothing is published.
 */
export function publicationGeneration(coverage: Pick<AccountFoldCoverage, 'computedByMonth'>, fromDay?: string | null, toDay?: string | null): number {
  const monthOfDay = (d: string) => Number(d.slice(0, 4)) * 100 + Number(d.slice(5, 7))
  const lo = fromDay ? monthOfDay(fromDay) : 0
  const hi = toDay ? monthOfDay(toDay) : Number.MAX_SAFE_INTEGER
  let g = 0
  for (const [m, computed] of coverage.computedByMonth) if (m >= lo && m <= hi && computed > g) g = computed
  return g
}

/** The account fold's coverage, from its per-month marker rows (account '' / stream ''). */
export async function accountFoldCoverage(client: ClickHouseClient): Promise<AccountFoldCoverage> {
  return cachedSwr('user-revenue:account-coverage', 60_000, 600_000, async () => {
    const res = await client.query({
      query: `-- ur:account-coverage
SELECT toYYYYMM(day) AS m, toUnixTimestamp(max(computed_at)) AS computed, toUnixTimestamp(max(folded_through)) AS through,
       toYYYYMM(${USER_REVENUE_EXPECTED_FIRST_HOUR_SQL}) AS expected_first
FROM ${USER_REVENUE_DAILY_TABLE}
WHERE account = '' AND stream = ''
GROUP BY m ORDER BY m`,
      format: 'JSONEachRow',
    })
    const rows = await res.json<{ m: string; computed: string; through: string; expected_first: string }>()
    const months = rows.map(r => ({ m: Number(r.m), computed: Number(r.computed), through: Number(r.through) }))
    const expectedFirst = rows.length ? Number(rows[0].expected_first) || null : null
    return accountCoverageFromMonths(months, Math.floor(Date.now() / 1000), expectedFirst)
  })
}

/**
 * Pure: the published months → coverage, against the current UTC month and the
 * month the folds start at (`expectedFirstMonth`, the price floor's month). A
 * run of months that is contiguous to today but starts LATER than that floor is
 * a history with a missing prefix — incomplete, so every all-time account figure
 * stays unpublished (null), never a $0 standing in for the months not folded yet.
 */
export function accountCoverageFromMonths(months: { m: number; computed: number; through?: number }[], nowSeconds: number, expectedFirstMonth: number | null): AccountFoldCoverage {
  if (!months.length) return { firstMonth: null, lastMonth: null, complete: false, computedAt: null, publishedThrough: null, computedByMonth: new Map() }
  const now = new Date(nowSeconds * 1000)
  const current = now.getUTCFullYear() * 100 + now.getUTCMonth() + 1
  const first = months[0].m
  const last = months[months.length - 1].m
  let expected = 0
  for (let m = first; m <= current; m = m % 100 === 12 ? (Math.floor(m / 100) + 1) * 100 + 1 : m + 1) expected += 1
  const through = months[months.length - 1].through
  return {
    firstMonth: first, lastMonth: last,
    complete: last === current && months.length === expected && expectedFirstMonth != null && first <= expectedFirstMonth,
    computedAt: months[months.length - 1].computed,
    publishedThrough: through && through > 0 ? through : null,
    computedByMonth: new Map(months.map(x => [x.m, x.computed])),
  }
}

/**
 * Net User Revenue (holder class `user`) per account, all time, EXACT (1e-12 USD, never dust-snapped: a row or a
 * group sums its accounts first and snaps once, `userRevenueUsdOf`). An account the facts never name is 0 while
 * the account fold's coverage is complete, and absent from the map otherwise — the caller renders "not published",
 * never 0.
 */
export async function userRevenueNetByAccount(client: ClickHouseClient, accounts: string[]): Promise<{ complete: boolean; byAccount: Map<string, bigint> }> {
  const coverage = await accountFoldCoverage(client)
  const safe = safeAccounts(accounts)
  const byAccount = new Map<string, bigint>()
  if (!coverage.complete || !safe.length) return { complete: coverage.complete, byAccount }
  // A directory page's members plus their ETH twins pass the server's
  // bound-parameter ceiling, so the list is asked in byte-bounded chunks
  // (db/queryParams.ts); grouped per account, the chunks are exact.
  const chunks = await mapParamChunks(safe, async accounts => {
    const res = await client.query({
      query: `-- ur:net-by-account
SELECT account, toString(sum(amount_usd)) AS usd
FROM ${USER_REVENUE_DAILY_TABLE}
WHERE account IN {accounts:Array(String)} AND stream != '' AND holder_class = 'user'
GROUP BY account`,
      query_params: { accounts },
      format: 'JSONEachRow',
    })
    return res.json<{ account: string; usd: string }>()
  })
  for (const a of safe) byAccount.set(a, 0n)
  for (const r of chunks.flat()) byAccount.set(r.account, scaledUsd(r.usd))
  return { complete: true, byAccount }
}

/** A set of accounts' User Revenue in USD from the exact per-account sums: summed first, dust snapped once. */
export function userRevenueUsdOf(byAccount: ReadonlyMap<string, bigint>, accounts: Iterable<string>): number {
  let sum = 0n
  for (const a of new Set(accounts)) sum += byAccount.get(a) ?? 0n
  return Number(snapUserRevenueDust(sum)) / 1e12
}

/**
 * THE identity rule of every per-account User Revenue ranking and display (the directory's sort and its rows, the
 * dashboard's top earners and payers): an UNBOUND ETH-mapped twin (0x45544800 + H160 + zero padding — a bound one is
 * folded into its owner at write time, FactSink.ownerOf) whose H160 is the first 20 bytes of a substrate account the
 * directory lists (one holding a balance; the lowest id if several) belongs to that account's row, folded from the
 * substrate side exactly as the money-market value is (mm_acct, MM_ETH_FORM_SQL). A twin that is also its own
 * directory row (it holds balances of its own) shows its facts on the OWNER's row only, never twice. A twin no
 * substrate account claims is its own identity. Map: twin → owner, over the twins the facts name.
 */
const userRevenueTwinOwnersSql = (): string => `SELECT tw.account AS twin, min(s.account_id) AS owner
FROM (
  -- GROUP BY, not DISTINCT: answered by the daily table's by_account_month projection (~40 MiB, not the table).
  SELECT account FROM ${USER_REVENUE_DAILY_TABLE}
  WHERE startsWith(account, '${ETH_MAPPED_PREFIX}') AND endsWith(account, '0000000000000000') AND stream != ''
  GROUP BY account
) AS tw
INNER JOIN (
  SELECT account_id, substring(account_id, 3, 40) AS h160 FROM price_data.account_asset_latest_balances
  WHERE NOT startsWith(account_id, '${ETH_MAPPED_PREFIX}')
  GROUP BY account_id
) AS s ON s.h160 = substring(tw.account, 11, 40)
GROUP BY twin`

export async function userRevenueTwinOwners(client: ClickHouseClient): Promise<Map<string, string>> {
  const coverage = await accountFoldCoverage(client)
  return cachedSwr('user-revenue:twin-owners', 600_000, 3_600_000, async () => {
    const res = await client.query({
      query: `-- ur:twin-owners
${userRevenueTwinOwnersSql()}`,
      format: 'JSONEachRow',
    })
    const out = new Map<string, string>()
    for (const r of await res.json<{ twin: string; owner: string }>()) if (ACCOUNT_RE.test(r.owner)) out.set(r.twin, r.owner)
    return out
  }, publicationGeneration(coverage))
}

/** A pallet ('modl'), sibling ('sibl') or parent ('para') account: 20 bytes and zero padding. */
const MODULE_FULL_RE = /^0x(6d6f646c|7369626c|70617261)[0-9a-f]{32}0{24}$/

/** The ETH-mapped twin of a substrate account (0x45544800 + its first 20 bytes + zero padding); null for an ETH-mapped id. */
export const userRevenueTwinOf = (account: string): string | null =>
  ACCOUNT_RE.test(account) && !account.startsWith(ETH_MAPPED_PREFIX) ? `${ETH_MAPPED_PREFIX}${account.slice(2, 42)}0000000000000000` : null

/**
 * Pure: the accounts whose facts a directory row (members) shows under userRevenueTwinOwners' rule — each member,
 * except a twin another account owns (its facts are that owner's), plus each substrate member's twin it owns.
 */
export function userRevenueRowAccounts(members: readonly string[], owners: ReadonlyMap<string, string>): string[] {
  const own = new Set(members)
  const out = new Set<string>()
  for (const m of members) {
    const owner = owners.get(m)
    if (owner == null || own.has(owner)) out.add(m)
    const twin = userRevenueTwinOf(m)
    // A pallet or sovereign account's truncated form is always its own (the directory's boundAccountSql remap).
    if (twin && (owners.get(twin) === m || MODULE_FULL_RE.test(m))) out.add(twin)
  }
  return [...out]
}

/**
 * The rule as SQL over a fact account column, with the twin → owner relation computed IN ClickHouse (the same
 * statement userRevenueTwinOwners reads, ~70 ms) rather than bound as parameters: 1,440 twins (2026-10-05) already
 * encode to ~104 KB per array, against the server's 131,072-byte field ceiling. The pairs are sorted, so the two
 * arrays transform() takes pair up however often the scalar subquery is evaluated.
 */
export const userRevenueOwnerKeySql = (column: string): string => {
  const pairs = `(SELECT arraySort(groupArray((twin, owner))) FROM (${userRevenueTwinOwnersSql()}) WHERE match(owner, '^0x[0-9a-f]{64}$'))`
  return `transform(${column}, arrayMap(p -> p.1, ${pairs}), arrayMap(p -> p.2, ${pairs}), ${column})`
}

const ETH_MAPPED_PREFIX = '0x45544800'

/**
 * The key the account fold books an identity's facts under: an ETH-mapped
 * account (0x45544800 + H160 + zero padding) whose H160 a substrate account
 * bound (`EVMAccounts.Bound`, `account_alias_directory` explicit_binding) is
 * booked under that owner — the fold's own rule (`FactSink.ownerOf`, the
 * explorer's `resolveDisplayAccountId`) — so a reader asking for the bound
 * address must read the owner's facts. Anything else books under itself.
 */
export async function userRevenueBookingKey(client: ClickHouseClient, accountId: string): Promise<string> {
  const id = accountId.toLowerCase()
  if (!ACCOUNT_RE.test(id) || !id.startsWith(ETH_MAPPED_PREFIX) || !id.endsWith('0'.repeat(16))) return id
  const h160 = `0x${id.slice(10, 50)}`
  return cachedSwr(`user-revenue:booking-key:${h160}`, 60_000, 600_000, async () => {
    const res = await client.query({
      query: `-- ur:booking-key
SELECT min(lower(account_id)) AS owner
FROM price_data.account_alias_directory
WHERE evm_address = {h:String} AND relationship = 'explicit_binding' AND alias_type = 'substrate_account_id' AND account_id != ''`,
      query_params: { h: h160 },
      format: 'JSONEachRow',
    })
    const owner = (await res.json<{ owner: string }>())[0]?.owner ?? ''
    return ACCOUNT_RE.test(owner) ? owner : id
  })
}

export interface AccountUserRevenueRow {
  stream: string
  pot: string
  via: string
  assetId: number
  holderClass: HolderClass
  earned: bigint
  paid: bigint
  net: bigint
  unpriced: number
}

export interface AccountUserRevenueDay { day: string; stream: string; holderClass: HolderClass; net: bigint; earned: bigint; paid: bigint }

/**
 * An account set's facts over UTC days `[fromDay, …]`: per (stream, pot, via,
 * asset, class) earned / paid / net, and per (day, stream, class) for the chart.
 * Bounded by the account-first sort key.
 *
 * A list tag's set reaches 2,000 members plus their EVM forms, past one bound
 * parameter's ceiling, so the set is read in byte-bounded chunks and the chunks'
 * integer sums are added per key — an account sits in exactly one chunk, so the
 * sum over chunks is the sum over the set. The sums are EXACT (never dust-snapped):
 * the renderer sums items into stream and total figures first and snaps each
 * figure it shows once (foldUserRevenueBreakdown), so the tab's total equals the
 * header stat's to the cent.
 */
export async function accountUserRevenueDetail(client: ClickHouseClient, accounts: string[], fromDay: string, opts: {
  days?: boolean
  /** Rows and days under the explorer's display streams (HOLLAR interest apart); the Borrow tab's slice reads the fold's. */
  display?: boolean
} = {}): Promise<{ rows: AccountUserRevenueRow[]; days: AccountUserRevenueDay[] }> {
  const withDays = opts.days ?? true
  const safe = safeAccounts(accounts)
  if (!safe.length) return { rows: [], days: [] }
  type RowRaw = { stream: string; pot: string; via: string; asset_id: string; holder_class: HolderClass; earned: string; paid: string; net: string; unpriced: string }
  type DayRaw = { d: string; ds: string; holder_class: HolderClass; net: string; earned: string; paid: string }
  const parts = await mapParamChunks(safe, async chunk => {
    const params = { accounts: chunk, from: fromDay }
    // The per-day series feeds a chart only; a reader that needs the items alone (the Borrow tab's per-market slice) skips it.
    const [rowsRes, daysRes] = await Promise.all([
      client.query({
        query: `-- ur:account-detail
SELECT stream, pot, via, asset_id, holder_class,
       toString(sumIf(amount_usd, amount_usd > 0)) AS earned,
       toString(sumIf(amount_usd, amount_usd < 0)) AS paid,
       toString(sum(amount_usd)) AS net, sum(unpriced) AS unpriced
FROM ${USER_REVENUE_DAILY_TABLE}
WHERE account IN {accounts:Array(String)} AND day >= toDate({from:String}) AND ${FACT_SQL}
GROUP BY stream, pot, via, asset_id, holder_class`,
        query_params: params,
        format: 'JSONEachRow',
      }),
      !withDays ? null : client.query({
        query: `-- ur:account-days
SELECT toString(day) AS d, ${streamSelectSql(opts.display)}, holder_class,
       toString(sum(amount_usd)) AS net,
       toString(sumIf(amount_usd, amount_usd > 0)) AS earned,
       toString(sumIf(amount_usd, amount_usd < 0)) AS paid
FROM ${USER_REVENUE_DAILY_TABLE}
WHERE account IN {accounts:Array(String)} AND day >= toDate({from:String}) AND ${FACT_SQL}
GROUP BY d, ds, holder_class
ORDER BY d`,
        query_params: params,
        format: 'JSONEachRow',
      }),
    ])
    return { rows: await rowsRes.json<RowRaw>(), days: daysRes ? await daysRes.json<DayRaw>() : [] }
  }, { concurrency: 2 })
  const rowsByKey = new Map<string, AccountUserRevenueRow>()
  for (const r of parts.flatMap(p => p.rows)) {
    const key = `${r.stream}\u0000${r.pot}\u0000${r.via}\u0000${r.asset_id}\u0000${r.holder_class}`
    const row = rowsByKey.get(key)
    if (row) {
      row.earned += scaledUsd(r.earned); row.paid += scaledUsd(r.paid); row.net += scaledUsd(r.net); row.unpriced += Number(r.unpriced)
    } else {
      rowsByKey.set(key, { stream: opts.display ? userRevenueDisplayStream(r.stream, Number(r.asset_id)) : r.stream, pot: r.pot, via: r.via, assetId: Number(r.asset_id), holderClass: r.holder_class, earned: scaledUsd(r.earned), paid: scaledUsd(r.paid), net: scaledUsd(r.net), unpriced: Number(r.unpriced) })
    }
  }
  const daysByKey = new Map<string, AccountUserRevenueDay>()
  for (const r of parts.flatMap(p => p.days)) {
    const key = `${r.d}\u0000${r.ds}\u0000${r.holder_class}`
    const day = daysByKey.get(key)
    if (day) {
      day.net += scaledUsd(r.net); day.earned += scaledUsd(r.earned); day.paid += scaledUsd(r.paid)
    } else {
      daysByKey.set(key, { day: r.d, stream: r.ds, holderClass: r.holder_class, net: scaledUsd(r.net), earned: scaledUsd(r.earned), paid: scaledUsd(r.paid) })
    }
  }
  // One chunk keeps the query's own ORDER BY d; several are merged back into it.
  const days = [...daysByKey.values()]
  if (parts.length > 1) days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  return { rows: [...rowsByKey.values()], days }
}

/** Account facts per (bucket, stream, class) — the Data API's earnings series. Chunked like accountUserRevenueDetail. */
export async function accountUserRevenueBuckets(client: ClickHouseClient, accounts: string[], opts: {
  grain: 'day' | 'month'; fromDay: string; toDay: string
  /** Add each row's HOLLAR-interest slice (`hollar`), summed and snapped like the row. */
  hollarSlice?: boolean
}): Promise<{ t: number; stream: string; holderClass: HolderClass; earned: bigint; paid: bigint; net: bigint; unpriced: number; hollar?: UserRevenueSlice }[]> {
  const safe = safeAccounts(accounts)
  if (!safe.length) return []
  const bucket = opts.grain === 'day' ? 'day' : 'toStartOfMonth(day)'
  type Raw = { t: string; stream: string; holder_class: HolderClass; earned: string; paid: string; net: string; unpriced: string; h_earned?: string; h_paid?: string; h_net?: string }
  const parts = await mapParamChunks(safe, async chunk => {
    const res = await client.query({
      query: `-- ur:account-buckets
SELECT toUnixTimestamp(toDateTime(${bucket})) AS t, stream, holder_class,
       toString(sumIf(amount_usd, amount_usd > 0)) AS earned,
       toString(sumIf(amount_usd, amount_usd < 0)) AS paid,
       toString(sum(amount_usd)) AS net, sum(unpriced) AS unpriced${opts.hollarSlice ? HOLLAR_SLICE_SQL : ''}
FROM ${USER_REVENUE_DAILY_TABLE}
WHERE account IN {accounts:Array(String)} AND day >= toDate({from:String}) AND day <= toDate({to:String}) AND ${FACT_SQL}
GROUP BY t, stream, holder_class
ORDER BY t, stream, holder_class`,
      query_params: { accounts: chunk, from: opts.fromDay, to: opts.toDay },
      format: 'JSONEachRow',
    })
    return res.json<Raw>()
  }, { concurrency: 2 })
  type Bucket = { t: number; stream: string; holderClass: HolderClass; earned: bigint; paid: bigint; net: bigint; unpriced: number; hollar?: UserRevenueSlice }
  const byKey = new Map<string, Bucket>()
  for (const r of parts.flat()) {
    const key = `${r.t}\u0000${r.stream}\u0000${r.holder_class}`
    const b = byKey.get(key)
    if (b) {
      b.earned += scaledUsd(r.earned); b.paid += scaledUsd(r.paid); b.net += scaledUsd(r.net); b.unpriced += Number(r.unpriced)
      if (b.hollar) { b.hollar.earned += scaledUsd(r.h_earned ?? '0'); b.hollar.paid += scaledUsd(r.h_paid ?? '0'); b.hollar.net += scaledUsd(r.h_net ?? '0') }
    } else {
      byKey.set(key, {
        t: Number(r.t), stream: r.stream, holderClass: r.holder_class, earned: scaledUsd(r.earned), paid: scaledUsd(r.paid), net: scaledUsd(r.net), unpriced: Number(r.unpriced),
        ...(opts.hollarSlice ? { hollar: { earned: scaledUsd(r.h_earned ?? '0'), paid: scaledUsd(r.h_paid ?? '0'), net: scaledUsd(r.h_net ?? '0') } } : {}),
      })
    }
  }
  // One chunk keeps the query's own ORDER BY t, stream, holder_class; several are
  // merged back into it.
  // Summed exactly over the chunks; each published bucket snapped once.
  const snap = (v: UserRevenueSlice): UserRevenueSlice => ({ earned: snapUserRevenueDust(v.earned), paid: snapUserRevenueDust(v.paid), net: snapUserRevenueDust(v.net) })
  const out = [...byKey.values()].map(b => ({ ...b, ...snap(b), ...(b.hollar ? { hollar: snap(b.hollar) } : {}) }))
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  if (parts.length > 1) out.sort((a, b) => a.t - b.t || cmp(a.stream, b.stream) || cmp(a.holderClass, b.holderClass))
  return out
}

// ---------------------------------------------------------------------------
// Helpers every surface shares
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' of a unix-seconds instant (UTC). */
export const utcDay = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10)

/** The first UTC day of a `days`-long day window ending on the day holding `throughSeconds` (exclusive end instant). */
export function windowFirstDay(throughSeconds: number, days: number): string {
  const lastDayStart = Math.floor((throughSeconds - 1) / DAY_S) * DAY_S
  return utcDay(lastDayStart - (days - 1) * DAY_S)
}

/** Stream ids in the shared order, and the class list — re-exported so surfaces import one module. */
export const USER_REVENUE_STREAM_ORDER: readonly string[] = USER_REVENUE_STREAMS.map(s => s.id)
export { HOLDER_CLASSES }
