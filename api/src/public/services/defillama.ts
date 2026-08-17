import type { ClickHouseClient } from '../../db/client.ts'
import { cachedSwr } from '../../services/cache.ts'
import {
  DECIMAL_STRINGS, PRICE_LOOKBACK_DAYS, priceSourceSql, renderUsd, routedNettedCteSql,
  routedTradesUsd, scaledUsd,
} from './poolVolumes.ts'

// The DefiLlama facade (spec § Phase 2 → "DefiLlama facade"). Two endpoints,
// both shaped by HydraDX-api's incumbent /defillama/v1/* so that repointing the
// adapter is a base-URL swap:
//
//   GET /defillama/v1/volume   → [{volume_usd}] over the rolling 24 hours
//   GET /defillama/v1/backfill → [{date, volume_usd, dailyFees, …}] per UTC day
//
// Both carry USD as JSON NUMBERS, not the /v1 surface's 2-decimal strings. That
// is the incumbent's body shape (verified live 2026-08-12:
// `[{"volume_usd":1368416.7209106}]`), and a facade that changes the type of the
// only field its consumer reads is not a facade. The values are still computed
// at the full Decimal(38,12) scale as BigInt and rounded to cents exactly once,
// at the wire — the double only ever holds an already-final 2-decimal value.
//
// Both numbers come from the same netted-trade chain the /v1 volume surface uses
// (routedNettedCteSql in poolVolumes.ts), so the facade cannot drift from
// /v1/stats/platform: a trade counts ONCE, at the larger of its two boundary
// sides, per the spec's § Semantics 2.
//
// The Hydration Data Lake's platformTotalVolumesByPeriod, which the DefiLlama
// adapter reads today, counts one side of every FILL instead — so a routed
// multi-hop swap counts once per hop, and an Omnipool swap counts twice because
// the router reports A→LRNA and LRNA→B separately. MEASURED over the closed week
// 2026-08-03..09: 6,333,852.59 here against 16,974,943.20 there, a ratio of
// 0.373, and per day the ratio moves between 0.29 and 0.50 with the day's
// routing mix. Our own per-fill (unnetted) sum for 2026-08-09 is 1,931,579
// against their 1,748,112, so the underlying leg data agrees within 10% and the
// gap is the netting rule, not the trades.
//
// Fees are reported, never added to volume. Three destination classes exist in
// `pool_swap_legs` and they mean different things:
//
//   'account'  the fee was credited to an account — a pool, a referrer, staking,
//              the treasury. Which one is not decided here.
//   'burned'   the fee was destroyed (the legacy Omnipool LRNA protocol fee:
//              115,913 of 115,913 such legs at the era boundary were Burned).
//              It accrues to nobody.
//   ''         UNKNOWN. The pre-Broadcast Omnipool events name no destination,
//              and the same measurement found the asset fee reaching the pool,
//              referrals and staking in comparable numbers — so the legacy era's
//              asset fees cannot be booked as accrued revenue, and must not be
//              silently folded into the 'account' class.
//
// `dailyFees` is the class-COMPLETE total (a separate sum over every fee leg, so
// a destination class this code has never seen still lands in it): the fee the
// traders paid. It is not revenue. The breakdown fields are how a consumer
// derives revenue honestly, and `dailyProtocolFees` is the real Omnipool
// hub-asset fee that the DefiLlama adapter today approximates with a hardcoded
// 80/20 asset-vs-protocol split.

/**
 * The largest range one backfill request may ask for, in inclusive days.
 *
 * This bounds the REQUEST, not the individual query — `MAX_CHUNK_LEGS` does that.
 * A consumer reindexing the whole era (1,218 valued days) walks it in 22
 * requests, each chunk computed once and then cached for a day.
 *
 * Deliberately left at 62 rather than lowered for the 2 s move: it is quoted in
 * the 400 body, so a consumer's paging loop is written against it, and the
 * failure it used to guard against (a single query breaching the memory cap) is
 * now handled per chunk instead. What it does NOT bound is a request's total wall
 * time, which is the sum of its chunks: 62 days of the busiest era is ~7.7 M legs
 * today (about 6 chunks, ~22 s cold) and ~23 M at 3 x the block rate (about 16
 * chunks, ~60 s cold). That is a slow response for a bulk reindex endpoint whose
 * every answer is then cached for 24 h, not a failed one — but if it becomes a
 * problem, lowering this constant is the lever, and it is a contract change.
 */
export const MAX_BACKFILL_DAYS = 62

/**
 * The most deduplicated swap legs one chunk's fold may cover.
 *
 * The per-day fold's cost is set by the LEG COUNT in its range, not by its day
 * span, so this is what actually keeps the query inside the api client's caps
 * (`max_memory_usage` 4 GB — 3.73 GiB as ClickHouse reports it — and
 * `max_execution_time` 20 s). Calendar-month chunks did not: MEASURED live on the
 * true worst month, 2025-05 at 4,647,377 legs folds in **10.0 s at 2.56 GiB**,
 * which is 69 % of the memory cap and 50 % of the time cap TODAY, and at 3 x the
 * block rate the same calendar month carries ~14 M legs and breaches both.
 *
 * Calibrated against five measured folds of that month (legs → peak memory /
 * duration), which are close to linear at ~0.6-0.7 GiB per million legs over a
 * ~0.35 GiB floor:
 *
 *   4,647,377 (31 d) → 2.56 GiB / 10,012 ms
 *   2,484,185 (15 d) → 1.73 GiB /  5,899 ms
 *   2,163,192 (16 d) → 1.29 GiB /  5,152 ms
 *   1,415,954  (8 d) → 1.00 GiB /  3,713 ms
 *   1,244,485  (8 d) → 0.88 GiB /  3,595 ms
 *
 * 1.5 M legs therefore lands a worst chunk at ~1.05 GiB and ~3.8 s: 3.5 x headroom
 * on memory and 5 x on time.
 *
 * THE BOUND IS CADENCE-PROOF BY CONSTRUCTION. It counts legs, not days, so a
 * chunk costs the same whenever those legs were produced — at 2 s blocks the
 * splitter simply emits chunks covering a third as many days, and the worst chunk
 * stays ~1 GiB. Nothing here needs re-tuning when the block time changes; it
 * needs re-tuning only if the fold's own shape changes.
 */
export const MAX_CHUNK_LEGS = 1_500_000

/** A UTC calendar day as 'YYYY-MM-DD', or null if the string is not one. */
function parseUtcDay(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const parsed = new Date(`${day}T00:00:00.000Z`)
  // Rejects 2026-02-30 and 2026-13-01, which Date rolls over into a real day.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return null
  return parsed
}

const DAY_MS = 86_400_000

function addDays(day: string, count: number): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + count * DAY_MS).toISOString().slice(0, 10)
}

/** The first day of the month after `day`. */
function startOfNextMonth(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)
}

/**
 * Why the request is not answerable, or null when it is. Both endpoints of the
 * incumbent treat `endDate` as INCLUSIVE, so a one-day range is start === end.
 */
export function backfillRangeError(startDate: string, endDate: string): string | null {
  const from = parseUtcDay(startDate)
  const to = parseUtcDay(endDate)
  if (!from) return `startDate '${startDate}' is not a calendar day in YYYY-MM-DD form`
  if (!to) return `endDate '${endDate}' is not a calendar day in YYYY-MM-DD form`
  if (to.getTime() < from.getTime()) return `endDate '${endDate}' is before startDate '${startDate}'`
  const days = (to.getTime() - from.getTime()) / DAY_MS + 1
  if (days > MAX_BACKFILL_DAYS) {
    return `range spans ${days} days; at most ${MAX_BACKFILL_DAYS} days per request — split the reindex into consecutive requests`
  }
  return null
}

export interface DayRange { from: string; to: string }

/**
 * A half-open [from, to) day range split on UTC month boundaries, with the two
 * ends clipped to the request.
 *
 * Calendar months are `pool_swap_legs`'s own partitions (PARTITION BY
 * toYYYYMM(block_timestamp)), so a chunk reads exactly one partition — and a
 * chunk boundary is a midnight, which no block straddles, so each fill lands in
 * exactly one chunk and each day in exactly one chunk's output. That is what
 * makes chunking arithmetic-free: the per-day rows concatenate, nothing is
 * merged across a boundary.
 */
export function monthChunks(from: string, to: string): DayRange[] {
  const chunks: DayRange[] = []
  let cursor = from
  while (cursor < to) {
    const next = startOfNextMonth(cursor)
    chunks.push({ from: cursor, to: next < to ? next : to })
    cursor = next
  }
  return chunks
}

/**
 * One month chunk split further so no piece covers more than `maxLegs` legs.
 *
 * A DAY IS ATOMIC. The fold's output granularity is a UTC day, so a day cannot be
 * split across two chunks without one of them holding a partial day — which is
 * the one thing that would make chunking arithmetic-dependent. A single day
 * heavier than `maxLegs` is therefore emitted alone and allowed to exceed it; the
 * heaviest day of the busiest month measures ~150 k legs today and ~450 k at 3 x,
 * so the floor is an order of magnitude below the cap rather than a live concern.
 *
 * The walk is greedy and forward-only: accumulate days until the next one would
 * cross the cap, then cut. Cutting BEFORE crossing rather than after is what keeps
 * the guarantee one-sided — every chunk except a single oversized day is at or
 * under the cap.
 *
 * `legsByDay` is a SIZE HINT AND NOTHING ELSE. Chunk boundaries decide only how
 * the work is divided, never what it computes: every boundary is a midnight, no
 * block straddles one, and the per-day rows concatenate. So a missing or stale
 * hint can only produce badly-sized chunks — never a wrong number. A day the hint
 * does not know counts as 0 and simply rides along with its neighbours.
 */
export function splitByLegs(chunk: DayRange, legsByDay: ReadonlyMap<string, number>, maxLegs: number): DayRange[] {
  const out: DayRange[] = []
  let start = chunk.from
  let running = 0
  for (let day = chunk.from; day < chunk.to; day = addDays(day, 1)) {
    const legs = legsByDay.get(day) ?? 0
    // `day > start` keeps a single over-cap day from producing an empty chunk.
    if (running > 0 && day > start && running + legs > maxLegs) {
      out.push({ from: start, to: day })
      start = day
      running = 0
    }
    running += legs
  }
  if (start < chunk.to) out.push({ from: start, to: chunk.to })
  return out
}

/**
 * Legs per UTC day over the requested range, read from the hourly pre-aggregate.
 *
 * `pool_swap_hourly` (clickhouse/schema/006_public.sql) stores `leg_count` per
 * (venue, …, hour) already deduplicated, so this is a sum over a few thousand
 * rows of a 3 M-row table instead of a count over the 65 M-leg projection —
 * MEASURED at 10 ms / 34 MiB for the WHOLE era, and it prunes to the requested
 * months here. That is what makes size-aware chunking affordable enough to do on
 * every cold request rather than baking a fixed day count into the code.
 *
 * The aggregate holds only CLOSED hours and may lag its source by a derivations
 * cycle. That is harmless by the argument in splitByLegs: an under-reported tail
 * makes the last chunk larger than intended, never the answer wrong. The backfill
 * only serves closed days anyway, which are the days the aggregate has long since
 * covered.
 */
export function buildDayLegsSql(): string {
  return `-- pub:dl:day-legs
SELECT toString(toDate(hour)) AS day, toString(sum(leg_count)) AS legs
FROM price_data.pool_swap_hourly
WHERE hour >= toDateTime({from:String}, 'UTC') AND hour < toDateTime({to:String}, 'UTC')
GROUP BY day
ORDER BY day`
}

/**
 * The chunks one request is answered in: month-aligned first, then size-split.
 *
 * The month split stays the OUTER one and is not negotiable — calendar months are
 * `pool_swap_legs`' own partitions, so it is what keeps a chunk reading exactly
 * one partition. The leg split only subdivides within a month, so that property
 * survives while the per-query cost stops depending on how busy a month was.
 */
export async function backfillChunks(client: ClickHouseClient, from: string, to: string): Promise<DayRange[]> {
  const months = monthChunks(from, to)
  if (!months.length) return []
  const res = await client.query({
    query: buildDayLegsSql(),
    query_params: { from: `${from} 00:00:00`, to: `${to} 00:00:00` },
    format: 'JSONEachRow',
  })
  const legsByDay = new Map<string, number>()
  for (const row of await res.json<{ day: string; legs: string }>()) legsByDay.set(row.day, Number(row.legs))
  return months.flatMap(month => splitByLegs(month, legsByDay, MAX_CHUNK_LEGS))
}

const DAILY_LEG_WINDOW = `block_timestamp >= toDateTime({from:String}, 'UTC')
      AND block_timestamp < toDateTime({to:String}, 'UTC')`

const DAILY_PRICE_WINDOW = `interval_start > toDateTime({from:String}, 'UTC') - INTERVAL ${PRICE_LOOKBACK_DAYS} DAY
        AND interval_start <= toDateTime({to:String}, 'UTC')`

/**
 * Netted volume and fees per UTC calendar day over one chunk.
 *
 * The netting is the SQL form of nettedTradeScaled: per trade, the larger of the
 * two boundary sides. The rolling /volume endpoint streams one row per trade and
 * folds in TS; a multi-month range cannot, so the same rule is written here as
 * `greatest(sum(in side), sum(out side))` and pinned against the TS definition
 * by test.
 *
 * The leg window is half-open, `[from, to)`, unlike the anchored rolling windows
 * — because these bounds are midnights, and block timestamps land exactly on
 * midnight often enough that `(from, to]` would drop the first block of a
 * request and hand the last one to the following chunk.
 */
export function buildDailySql(): string {
  const zero = 'toDecimal256(0, 12)'
  return `-- pub:dl:daily
WITH ${routedNettedCteSql(DAILY_LEG_WINDOW, priceSourceSql(DAILY_PRICE_WINDOW))}
SELECT toString(day) AS day,
       toString(sum(volume)) AS volume_usd,
       toString(sum(fee_total)) AS fee_total_usd,
       toString(sum(fee_account)) AS fee_account_usd,
       toString(sum(fee_burned)) AS fee_burned_usd,
       toString(sum(fee_unknown)) AS fee_unknown_usd,
       toString(sum(fee_hub)) AS fee_hub_usd
FROM (
  SELECT day,
         greatest(sum(greatest(-net_usd, ${zero})), sum(greatest(net_usd, ${zero}))) AS volume,
         sum(fee_total) AS fee_total, sum(fee_account) AS fee_account,
         sum(fee_burned) AS fee_burned, sum(fee_unknown) AS fee_unknown, sum(fee_hub) AS fee_hub
  FROM netted
  GROUP BY day, trade_key
  HAVING min(all_aave) = 0
)
GROUP BY day
ORDER BY day`
}

/**
 * The per-day fold is the one query on this surface whose leg dedup dominates
 * memory. `pool_swap_legs` is sorted by exactly the GROUP BY that collapses its
 * replacement key, so aggregating in order streams it: measured over three
 * months, 490 MiB instead of 1.64 GiB for the same result.
 */
const DAILY_SETTINGS = { ...DECIMAL_STRINGS, optimize_aggregation_in_order: 1 } as const

interface DailyRow {
  day: string
  volume_usd: string
  fee_total_usd: string
  fee_account_usd: string
  fee_burned_usd: string
  fee_unknown_usd: string
  fee_hub_usd: string
}

/** One day of the facade's history. Field names and casing are the incumbent's. */
export interface BackfillDay {
  date: string
  volume_usd: number
  dailyFees: number
  dailyFeesToAccounts: number
  dailyFeesBurned: number
  dailyFeesUnknownDestination: number
  dailyProtocolFees: number
}

/** A full-scale integer USD value as the wire's 2-decimal JSON number. */
function usdNumber(scaled: bigint): number {
  return Number(renderUsd(scaled))
}

/**
 * One chunk's days, cached under its exact bounds.
 *
 * Every bound is a closed day (the caller clips the range at the indexer's
 * current day), so a chunk's answer is immutable except under a re-index — which
 * is what the 24-hour stale window covers. The key is the normalized range
 * rather than the caller's request, so the whole-month chunks two overlapping
 * requests share are computed once.
 */
async function dailyChunk(client: ClickHouseClient, range: DayRange): Promise<BackfillDay[]> {
  return cachedSwr(`pub:dl:daily:${range.from}:${range.to}`, 3_600_000, 86_400_000, async () => {
    const res = await client.query({
      query: buildDailySql(),
      query_params: { from: `${range.from} 00:00:00`, to: `${range.to} 00:00:00` },
      format: 'JSONEachRow',
      clickhouse_settings: DAILY_SETTINGS,
    })
    const rows = await res.json<DailyRow>()
    const days = rows.filter(row => scaledUsd(row.volume_usd) !== 0n || scaledUsd(row.fee_total_usd) !== 0n)
      .map(row => ({
        date: row.day,
        volume_usd: usdNumber(scaledUsd(row.volume_usd)),
        dailyFees: usdNumber(scaledUsd(row.fee_total_usd)),
        dailyFeesToAccounts: usdNumber(scaledUsd(row.fee_account_usd)),
        dailyFeesBurned: usdNumber(scaledUsd(row.fee_burned_usd)),
        dailyFeesUnknownDestination: usdNumber(scaledUsd(row.fee_unknown_usd)),
        dailyProtocolFees: usdNumber(scaledUsd(row.fee_hub_usd)),
      }))
    // A day the query answered for but that valued to nothing is a day whose
    // assets had no closed candle — not a day with no trading. Publishing 0 for
    // it would be the same fabrication as zero-filling a day with no fills, so
    // it is dropped like one, and said out loud because nothing else would.
    // MEASURED: this is every day from 2023-01-06 (the first Omnipool fill) to
    // 2023-04-11, whose assets are older than the price feed.
    const unvalued = rows.length - days.length
    if (unvalued > 0) {
      console.warn(`[public-api] defillama backfill ${range.from}..${range.to}: ${unvalued} of ${rows.length} `
        + 'days had indexed fills but no priceable asset — omitted rather than published as 0')
    }
    return days
  })
}

/**
 * The newest fill in the leg model — the clock the closed-day cut runs on.
 *
 * Deliberately NOT the shared `readAnchor`, which reports the newest indexed
 * BLOCK. A block is indexed before the materialized view has projected its legs,
 * so while the MV lags, the blocks head sits in a day whose fills are still
 * arriving; cutting on it would declare that day closed and publish an
 * undercount as a complete day. The leg head cannot outrun the legs by
 * construction, so the lag delays a day instead of truncating it.
 *
 * It is also free: `max()` over the partition key is answered from part
 * metadata, measured at 159 rows / 3.73 KiB / 2 ms against the 65.4 M-leg table.
 * (What made the shared anchor expensive was `max(block_height)` in the same
 * SELECT — block_height is not a leading sort key, so that one really did scan.)
 */
const LEG_HEAD_SQL = `-- pub:dl:leg-head
SELECT toString(max(block_timestamp)) AS head FROM price_data.pool_swap_legs`

async function legHeadDay(client: ClickHouseClient): Promise<string | null> {
  const res = await client.query({ query: LEG_HEAD_SQL, format: 'JSONEachRow' })
  const [row] = await res.json<{ head: string }>()
  const head = row?.head ?? ''
  // An empty model's max() is the DateTime epoch; that is "no data", not 1970.
  return head && !head.startsWith('1970-01-01') ? head.slice(0, 10) : null
}

/**
 * The facade's history over an inclusive day range.
 *
 * Only CLOSED days are published: the range is cut at the start of the day the
 * newest indexed FILL sits in (legHeadDay), so the day in progress — which would
 * report the fraction of its volume that happens to be indexed — is never served
 * as a complete day. A day the projection has no fill for is OMITTED rather than
 * published as 0: before 2023-01-06 there was no Omnipool to trade in, and "no
 * trade indexed" is not the claim "zero volume traded". So is a day whose fills
 * could not be valued at all (see dailyChunk).
 */
export async function defillamaBackfill(client: ClickHouseClient, startDate: string, endDate: string): Promise<BackfillDay[]> {
  // ClickHouse hands DateTime back in the session timezone, which the public
  // service asserts is UTC at boot (src/public/server.ts).
  const openDay = await legHeadDay(client)
  if (!openDay) return []
  const requestedTo = addDays(endDate, 1)
  const to = requestedTo < openDay ? requestedTo : openDay
  if (to <= startDate) return []
  const days: BackfillDay[] = []
  // Sequential on purpose: the chunks share one ClickHouse, and a request that
  // fanned four of these out at once would take four times the memory to answer
  // no faster than the disk can feed it. That is also why the per-chunk cap is
  // sized against the whole memory budget rather than a share of it.
  for (const chunk of await backfillChunks(client, startDate, to)) days.push(...await dailyChunk(client, chunk))
  return days
}

/**
 * The rolling 24-hour netted total, in the incumbent's one-element array.
 *
 * This is the SAME cached value /v1/stats/platform publishes, so the facade and
 * the first-party surface can never disagree. The window is anchored to the
 * newest indexed swap fill rather than to wall clock or the blocks head. A lag
 * therefore delays the anchor while preserving a complete 24-hour window; it
 * cannot move the window past fills the projection has not produced yet.
 */
export async function defillamaVolume(client: ClickHouseClient): Promise<Array<{ volume_usd: number }>> {
  const { totalUsd } = await routedTradesUsd(client, '24h')
  return [{ volume_usd: Number(totalUsd) }]
}
