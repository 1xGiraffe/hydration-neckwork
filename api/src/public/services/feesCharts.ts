import type { ClickHouseClient } from '../../db/client.ts'
import { cachedSwr } from '../../services/cache.ts'
import { buildRevenueEventRowsSql, type EventfulRevenueStream } from '../../services/revenueStreams.ts'
import { DECIMAL_STRINGS, scaledUsd } from './poolVolumes.ts'

// GET /api/v1/fees/charts — the revenue/fees page's data source.
//
// This endpoint is a DROP-IN for hydration-metrics-aggregator's
// /api/v1/fees/charts. Its consumer is the Hydration UI's `useFeesChartsData`
// (apps/main/src/api/stats.ts), which fires seven of these in parallel and
// zod-parses each response as
//
//     { data: [{ timestamp: string, value: number }], periodAggregate: number }
//
// so the parameter names, the response shape and the bucket timestamps below are
// the incumbent's, not this surface's. Its values are JSON NUMBERS rather than
// decimal strings, which makes it one of the inherited-contract exceptions to the
// design spec's § Wire conventions (with /defillama/v1, /hydration-web/v1 and
// /lending/v1) — every one of them reproduces a contract this API did not write.
// Everything numeric is still accumulated as an integer count of 1e-12 USD
// (poolVolumes' scale) and converted to a double exactly once, at the wire.
//
// WHERE THE NUMBERS COME FROM. The per-stream revenue DEFINITIONS live in
// services/revenueStreams.ts — the same definitions the derivations jobs
// materialize into price_data.revenue_events and the explorer's /revenue
// surfaces read — so this endpoint, the explorer and the account attribution
// can never drift apart. Each request composes two arms in ONE query:
//
//   cold  — revenue_events rows at or below the stream's own high-water mark
//           (`cold_mark`, a scalar WITH alias resolved once, so a REPLACE
//           PARTITION landing mid-query cannot make the arms overlap or gap);
//   tail  — the shared builder run over raw for everything past the mark.
//
// An empty or lagging table degrades to the raw arm (max() of an empty
// DateTime column is the epoch), so the split is a performance boundary and
// never a coverage gate. Backfill below the mark under-reports for at most one
// derivations cycle — the same freshness contract every partition-incremental
// model here carries.
//
// WHAT EACH STREAM MEANS is documented on the builders in revenueStreams.ts
// (they were pinned against the incumbent here first — see the git history for
// the measured ratios):
//
//  * omnipool/asset      — the Omnipool's per-asset trade fee: every non-hub fee
//                          leg. The runtime splits it per recipient, so
//                          `feeDestination` maps onto the rows' `dest` class:
//                          lp = the pool account's share, protocol = routed out
//                          or burned, total = everything including the legacy
//                          pre-2025-01-25 legs whose destination the chain never
//                          recorded ('unknown' — counted in total, claimed by
//                          neither share).
//  * omnipool/protocol   — the hub (H2O) fee legs. Both destinations of the
//                          2025-02→2026-02 overlap are protocol revenue, so
//                          `protocol` and `total` take all rows and `burned` is
//                          the burn component alone.
//  * money-market/liquidation_penalty
//                        — the protocol's cut of a liquidation bonus: the aToken
//                          BalanceTransfer into the Aave collector, per event
//                          (revenue_events carries it split per liquidated
//                          borrower; the split sums to the transfer exactly).
//  * money-market/pepl_liquidation_profit
//                        — the profit the protocol's own liquidator booked.
//  * money-market/asset_reserve
//                        — the reserve-factor share of borrow interest
//                          (`MintedToTreasury`). Zero since 2026-06-25; the
//                          incumbent reports zeros for the same reason.
//  * hollar/borrow_apr   — interest accrued on HOLLAR debt, all protocol
//                          revenue (facilitator-minted, no suppliers). Computed
//                          in TS from the reserve-state view — see
//                          hollarBorrowInterest below.
//  * hollar/hsm_revenue  — the HSM's stablepool arbitrage profit plus its
//                          buyback fee, per fill.
//
// USD is event-time throughout: a fill is valued at the 1h candle that had
// already CLOSED when it happened. The incumbent prices off the money-market
// oracle instead, which is why per-bucket values agree in magnitude rather than
// to the cent.
//
// ONE DEVIATION FROM THE SPEC'S NAMED SOURCE. It lists `borrow_apr` as coming
// from `money_market_reserve_rates`. This reads
// `money_market_reserve_state_history` instead, because a rate alone is not an
// amount: turning `variable_borrow_rate` into revenue needs the outstanding debt
// it applies to, and that view is the only model that carries debt over time.
// Having it, the rate is redundant — Aave's own accrual is
// `debt_scaled × Δ variable_borrow_index / RAY`, an exact identity rather than a
// rate × elapsed-time approximation, and the view returns that index alongside
// the debt. `money_market_reserve_rates` remains the source for the APR a caller
// would quote; it is not the source for interest earned.

/** Product groupings, exactly as the UI's `ProductType` enum spells them. */
export const FEES_PRODUCT_TYPES = ['omnipool', 'money-market', 'hollar'] as const
export type FeesProductType = (typeof FEES_PRODUCT_TYPES)[number]

/** Streams, exactly as the UI's `StreamType` enum spells them. */
export const FEES_STREAM_TYPES = [
  'asset', 'protocol', 'liquidation_penalty', 'pepl_liquidation_profit',
  'asset_reserve', 'borrow_apr', 'hsm_revenue',
] as const
export type FeesStreamType = (typeof FEES_STREAM_TYPES)[number]

/** Fee destinations, as the UI's `FeeDestination` enum spells them, plus `burned`. */
export const FEES_DESTINATIONS = ['protocol', 'total', 'lp', 'burned'] as const
export type FeesDestination = (typeof FEES_DESTINATIONS)[number]

/** Bucket widths, as the UI's `BucketSize` enum spells them. */
export const FEES_BUCKET_SIZES = ['1hour', '6hour', '24hour', '7day', '30day'] as const
export type FeesBucketSize = (typeof FEES_BUCKET_SIZES)[number]

export const BUCKET_SECONDS: Record<FeesBucketSize, number> = {
  '1hour': 3_600, '6hour': 21_600, '24hour': 86_400, '7day': 604_800, '30day': 2_592_000,
}

/**
 * The bucket grid's origin: 2000-01-03T00:00:00Z, a Monday.
 *
 * Not a free choice — it is the incumbent's, and it is observable. Its 30-day
 * buckets over the UI's "ALL" range start 2025-02-20, 2025-03-22, … and every one
 * of those instants is an exact multiple of 30 days after 2000-01-03; its 7-day
 * buckets land on Mondays the same way. (That origin is TimescaleDB's default for
 * intervals of a day or more, which is where the incumbent gets it.) Aligning to
 * the Unix epoch instead would shift every 7-day and 30-day bucket of this
 * endpoint against the one it replaces — the 30-day grid by 9 days.
 *
 * For 1hour/6hour/24hour the origin is inert: it is an exact multiple of all
 * three, so those buckets are plain UTC hours and days either way.
 */
export const BUCKET_ORIGIN_EPOCH = 946_857_600

/**
 * Combinations the incumbent accepts, as productType+streamType+feeDestination.
 * Taken from its own 400 body, minus the `total` stream (see FEES_TOTAL_MESSAGE).
 *
 * The UI only ever sends seven of these; the other two exist so a caller that
 * asks the incumbent's questions gets the incumbent's answers.
 */
export const FEES_COMBINATIONS: ReadonlyArray<[FeesProductType, FeesStreamType, FeesDestination]> = [
  ['omnipool', 'asset', 'lp'],
  ['omnipool', 'asset', 'protocol'],
  ['omnipool', 'asset', 'total'],
  ['omnipool', 'protocol', 'protocol'],
  ['omnipool', 'protocol', 'burned'],
  ['omnipool', 'protocol', 'total'],
  ['money-market', 'liquidation_penalty', 'protocol'],
  ['money-market', 'pepl_liquidation_profit', 'protocol'],
  ['money-market', 'asset_reserve', 'protocol'],
  ['hollar', 'borrow_apr', 'protocol'],
  ['hollar', 'hsm_revenue', 'protocol'],
]

export const FEES_TOTAL_MESSAGE
  = 'streamType=total is not served here: on the metrics aggregator it answers with a composite '
  + 'object ({ data: { total, asset, protocol, granular }, periodAggregate: {…} }) rather than the '
  + 'documented { data, periodAggregate } shape. Request the individual streams instead.'

export function combinationsMessage(): string {
  const list = FEES_COMBINATIONS.map(([p, s, d]) => `${p}+${s}+${d}`).join(', ')
  return `invalid filter combination. Valid combinations (productType+streamType+feeDestination): ${list}`
}

export function isValidCombination(product: string, stream: string, destination: string): boolean {
  return FEES_COMBINATIONS.some(([p, s, d]) => p === product && s === stream && d === destination)
}

export interface FeesChartQuery {
  productType: FeesProductType
  streamType: FeesStreamType
  feeDestination: FeesDestination
  /** Inclusive lower bound, epoch seconds (UTC). */
  startSeconds: number
  /** Inclusive upper bound, epoch seconds (UTC). */
  endSeconds: number
  bucketSize: FeesBucketSize
}

export interface FeesChartPoint { timestamp: string; value: number }
export interface FeesChartResponse { data: FeesChartPoint[]; periodAggregate: number }

/**
 * The most buckets one response may carry. 1-hour buckets over the UI's longest
 * range would be 13 000 points that no chart can draw and that no consumer asks
 * for; refusing is better than serving a payload whose cost is unbounded in the
 * caller's choice of two independent parameters.
 */
export const MAX_BUCKETS = 5_000

/** USD is accumulated as an integer count of 1e-12 USD, as everywhere else here. */
const USD_UNIT = 1e12

/** Aave's RAY, the scale of every rate and index the money market reports. */
const RAY = 10n ** 27n

/** HOLLAR's registry id, and the reserve address it is listed under. */
const HOLLAR_ASSET_ID = 222
const HOLLAR_RESERVE_ADDRESS = '0x531a654d1696ed52e7275a8cede955e82620f99a'

/** The bucket a timestamp falls in, on the BUCKET_ORIGIN_EPOCH grid. */
function bucketSql(expr: string): string {
  return `toDateTime(${BUCKET_ORIGIN_EPOCH} + intDiv(toUInt32(${expr}) - ${BUCKET_ORIGIN_EPOCH}, {bucket:UInt32}) * {bucket:UInt32})`
}

/** The first grid instant at or after `seconds`. */
export function firstBucketStart(seconds: number, bucketSeconds: number): number {
  const offset = seconds - BUCKET_ORIGIN_EPOCH
  return BUCKET_ORIGIN_EPOCH + Math.ceil(offset / bucketSeconds) * bucketSeconds
}

/** The last grid instant at or before `seconds`. */
export function lastBucketStart(seconds: number, bucketSeconds: number): number {
  const offset = seconds - BUCKET_ORIGIN_EPOCH
  return BUCKET_ORIGIN_EPOCH + Math.floor(offset / bucketSeconds) * bucketSeconds
}

/** How many grid buckets START inside [startSeconds, endSeconds]. */
export function bucketCount(startSeconds: number, endSeconds: number, bucketSeconds: number): number {
  const first = firstBucketStart(startSeconds, bucketSeconds)
  const last = lastBucketStart(endSeconds, bucketSeconds)
  return last < first ? 0 : Math.floor((last - first) / bucketSeconds) + 1
}

/**
 * `periodAggregate` per stream.
 *
 * Every stream sums except `hsm_revenue`, which averages — the incumbent's own
 * rule, measured rather than guessed: over 2026-07-12 … 2026-08-11 it returned
 * 16 buckets summing to 203 730.79 against a periodAggregate of 12 733.17 =
 * 203 730.79/16, and over the two-bucket 2026-07-28 … 2026-07-29 window it
 * returned 58.599 and 29.087 against 43.843, the mean. A drop-in that "fixed"
 * that would move the number the fees page prints.
 */
export const AGGREGATE_MODE: Record<FeesStreamType, 'sum' | 'mean'> = {
  asset: 'sum',
  protocol: 'sum',
  liquidation_penalty: 'sum',
  pepl_liquidation_profit: 'sum',
  asset_reserve: 'sum',
  borrow_apr: 'sum',
  hsm_revenue: 'mean',
}

export function aggregate(values: number[], mode: 'sum' | 'mean'): number {
  if (!values.length) return 0
  const total = values.reduce((a, b) => a + b, 0)
  return mode === 'mean' ? total / values.length : total
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * `revenueStreams`' builders and the price windows they carry are anchored on
 * ({anchor}, {hours}); this endpoint is anchored on (start, end). Binding
 * anchor = end and hours = ⌈(end − start)/3600⌉ makes the source window a
 * superset of [start, end], and the outer `bucket_start >= start` narrows it
 * back — which is the same rule that decides bucket membership, so nothing
 * lands in a bucket the response does not carry.
 */
function windowParams(q: FeesChartQuery): { anchor: string; hours: number; bucket: number; start: string; end: string } {
  const chSeconds = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
  return {
    anchor: chSeconds(q.endSeconds),
    hours: Math.max(1, Math.ceil((q.endSeconds - q.startSeconds) / 3600)),
    bucket: BUCKET_SECONDS[q.bucketSize],
    start: chSeconds(firstBucketStart(q.startSeconds, BUCKET_SECONDS[q.bucketSize])),
    end: chSeconds(q.endSeconds),
  }
}

/** The public streamType → canonical revenue stream key. */
const STREAM_TO_REVENUE: Record<Exclude<FeesStreamType, 'borrow_apr'>, EventfulRevenueStream> = {
  asset: 'omnipool_asset_fee',
  protocol: 'omnipool_protocol_fee',
  liquidation_penalty: 'liquidation_penalty',
  pepl_liquidation_profit: 'pepl_liquidation_profit',
  asset_reserve: 'asset_reserve',
  hsm_revenue: 'hsm_revenue',
}

/** The marker comment each stream's query carries (test/dispatch anchor). */
const STREAM_MARKER: Record<Exclude<FeesStreamType, 'borrow_apr'>, string> = {
  asset: '-- pub:fees:omnipool',
  protocol: '-- pub:fees:omnipool',
  liquidation_penalty: '-- pub:fees:liquidation-penalty',
  pepl_liquidation_profit: '-- pub:fees:pepl-profit',
  asset_reserve: '-- pub:fees:asset-reserve',
  hsm_revenue: '-- pub:fees:hsm-revenue',
}

/**
 * `feeDestination` on the rows' destination class.
 *
 * On `asset` the runtime splits one fee across recipients and revenue_events
 * classifies each leg: `lp` is the pool account's share, `protocol` the legs
 * routed anywhere else PLUS the burned component, `total` everything — the
 * legacy pre-2025-01-25 legs ('unknown': the chain recorded no destination)
 * count in `total` and in neither share, which understates both before that
 * boundary exactly as the projection's coverage does.
 *
 * On `protocol` (the hub/H2O fee) `burned` is the burn component and `total` takes all
 * rows. `protocol` is NOT all rows: since 2026-03 the burned/treasury split stopped and
 * every hub fee leg is paid to the Omnipool account, so it stays in the pool. Counting
 * the stream in full reported 21% of one 30-day window as protocol revenue that the
 * protocol never received. The exception is a fee retained in the protocol-provided HDX
 * position, which the derivation marks 'pol'.
 */
export function feesDestinationPredicateSql(destination: FeesDestination): string {
  if (destination === 'lp') return "dest = 'lp'"
  if (destination === 'protocol') return "dest IN ('protocol', 'burned', 'pol')"
  if (destination === 'burned') return "dest = 'burned'"
  return '1'
}

/**
 * One stream's bucketed series: the cold arm from revenue_events at or below
 * the stream's high-water mark, the tail from the shared builder past it —
 * both cut at `cold_mark`, a scalar WITH alias ClickHouse evaluates ONCE, so a
 * REPLACE PARTITION landing mid-query cannot leave the arms overlapping on an
 * hour or straddling a gap. Keying buckets on their start (and keeping only
 * those inside the range) is the incumbent's rule, unchanged.
 */
export function buildFeesStreamSql(streamType: Exclude<FeesStreamType, 'borrow_apr'>, destination: FeesDestination): string {
  const stream = STREAM_TO_REVENUE[streamType]
  // The destination split applies to the two omnipool fee streams; the money-market
  // streams have a single destination and take every row.
  const destSql = streamType === 'asset' || streamType === 'protocol'
    ? feesDestinationPredicateSql(destination)
    : '1'
  return `${STREAM_MARKER[streamType]}
WITH (
  SELECT max(block_timestamp) FROM price_data.revenue_events WHERE stream = '${stream}'
) AS cold_mark
SELECT toString(bucket_start) AS bucket, toString(sum(v)) AS value
FROM (
  SELECT ${bucketSql('block_timestamp')} AS bucket_start, amount_usd AS v
  FROM price_data.revenue_events
  WHERE stream = '${stream}' AND (${destSql})
    AND block_timestamp > {anchor:DateTime} - INTERVAL {hours:UInt32} HOUR
    AND block_timestamp <= {anchor:DateTime}
    AND block_timestamp <= cold_mark
  UNION ALL
  SELECT ${bucketSql('block_timestamp')} AS bucket_start, amount_usd AS v
  FROM (
${buildRevenueEventRowsSql(stream, 'block_timestamp > cold_mark')}
  )
  WHERE (${destSql})
)
WHERE bucket_start >= {start:DateTime} AND bucket_start <= {end:DateTime}
GROUP BY bucket_start
ORDER BY bucket_start`
}

/**
 * Per-bucket HOLLAR debt and borrow index, for the interest accrual.
 *
 * `money_market_reserve_state_history` is a parameterised VIEW, and its three
 * parameters are interpolated rather than bound: ClickHouse resolves view
 * parameters while parsing the table expression, before query_params exist. The
 * two numbers are integers this module computed and the two timestamps are
 * formatted from epoch seconds, so nothing caller-supplied reaches the text
 * unvalidated.
 *
 * It is always asked for HOURLY buckets, never for the response's bucket width.
 * The view buckets with `toStartOfInterval(…, toIntervalSecond(n))`, which aligns
 * to the Unix epoch; this endpoint's grid is anchored at 2000-01-03 (see
 * BUCKET_ORIGIN_EPOCH). The two coincide for an hour, six hours and a day, and
 * they do NOT for seven or thirty — measured as the 1Y and ALL ranges answering
 * with an empty series because not one view bucket landed on a grid instant. An
 * hour is a common divisor of both grids, so the accrual is differenced hourly
 * and folded into whatever bucket the response asks for, which is also the finer
 * (and therefore more exactly priced) computation.
 *
 * `start_time` reaches BEHIND the requested window by one hour on purpose: the
 * accrual over an hour is a DIFFERENCE of indices, so the first hour needs its
 * predecessor. The view is a step function — an hour in which the reserve saw
 * neither a balance delta nor a `ReserveDataUpdated` emits no row — so the caller
 * carries the last observed row forward.
 *
 * An EMPTY result is not zero: the view's contract (clickhouse/schema/
 * 007_money_market_history.sql) is that it returns nothing at all when the aToken
 * anchor has not been snapshotted. The caller answers with an empty series, never
 * a zeroed one.
 */
export function buildHollarDebtSql(bucketSeconds: number, fromSeconds: number, toSeconds: number): string {
  const ch = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
  return `-- pub:fees:hollar-debt
SELECT toString(bucket_start) AS bucket, pool_address,
       toString(debt_scaled) AS debt_scaled, toString(variable_borrow_index) AS borrow_index
FROM price_data.money_market_reserve_state_history(
  bucket_seconds = ${Math.trunc(bucketSeconds)},
  start_time = '${ch(fromSeconds)}',
  end_time = '${ch(toSeconds)}')
WHERE reserve_address = {reserve:String}
ORDER BY pool_address, bucket_start`
}

/**
 * HOLLAR's price per hour, keyed by the hour the candle became USABLE
 * (`interval_start + 1 HOUR`) — the bucketed-history rule from AGENTS.md, so an
 * hour's accrual is never valued at a candle that had not closed yet.
 */
export function buildHollarPriceSql(): string {
  return `-- pub:fees:hollar-price
SELECT toString(interval_start + INTERVAL 1 HOUR) AS bucket, toString(argMaxMerge(close_state)) AS close
FROM price_data.ohlc_1h
WHERE asset_id = ${HOLLAR_ASSET_ID}
  AND interval_start > {anchor:DateTime} - INTERVAL {hours:UInt32} HOUR - INTERVAL 30 DAY
  AND interval_start <= {anchor:DateTime}
GROUP BY interval_start
ORDER BY interval_start`
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface BucketRow { bucket: string; value: string }
interface DebtRow { bucket: string; pool_address: string; debt_scaled: string; borrow_index: string }
interface PriceRow { bucket: string; close: string }

/** ClickHouse hands DateTime back as 'YYYY-MM-DD hh:mm:ss' in UTC (server.ts asserts it). */
function bucketIso(chDateTime: string): string {
  return `${chDateTime.trim().replace(' ', 'T')}.000Z`
}

function bucketSeconds(chDateTime: string): number {
  return Math.floor(Date.parse(bucketIso(chDateTime)) / 1000)
}

async function readBuckets(client: ClickHouseClient, query: string, q: FeesChartQuery): Promise<Map<number, bigint>> {
  const res = await client.query({
    query,
    query_params: windowParams(q),
    format: 'JSONEachRow',
    clickhouse_settings: DECIMAL_STRINGS,
  })
  const out = new Map<number, bigint>()
  for (const row of await res.json<BucketRow>()) out.set(bucketSeconds(row.bucket), scaledUsd(row.value))
  return out
}

/**
 * HOLLAR borrow interest per bucket.
 *
 * Aave's accrual is exact and needs no rate integration: a reserve's debt grows
 * by `debt_scaled × Δ variable_borrow_index / RAY`, and for HOLLAR every unit of
 * it is protocol revenue — the asset is facilitator-minted, so there are no
 * suppliers earning a liquidity rate out of it. The two markets that list HOLLAR
 * (core and gigahdx) carry independent debt and independent indices, so each is
 * differenced on its own and the results are added.
 *
 * This recognises interest as it ACCRUES. The incumbent recognises it when a
 * borrower repays, which is why its series is spiky where this one is smooth;
 * over a window long enough for the repayments to land, the two measure the same
 * interest. The report records the measured window ratio.
 *
 * Kept as the request path (rather than reading revenue_events' hourly
 * hollar_borrow rows) deliberately: the accrual is differenced against the
 * response's own grid here, and the view is the authoritative debt/index model
 * both this and the derivations job compute from — one source, two consumers.
 */
async function hollarBorrowInterest(client: ClickHouseClient, q: FeesChartQuery): Promise<Map<number, bigint>> {
  const HOUR = 3_600
  const width = BUCKET_SECONDS[q.bucketSize]
  const first = firstBucketStart(q.startSeconds, width)
  const last = lastBucketStart(q.endSeconds, width)
  const params = windowParams(q)

  const debtRes = await client.query({
    // Hourly, whatever the response's bucket width, and one hour of lead-in so
    // the first hour has a predecessor to difference against.
    query: buildHollarDebtSql(HOUR, first - HOUR, q.endSeconds),
    query_params: { reserve: HOLLAR_RESERVE_ADDRESS },
    format: 'JSONEachRow',
    clickhouse_settings: DECIMAL_STRINGS,
  })
  const debtRows = await debtRes.json<DebtRow>()
  // Empty means the anchor is not snapshotted, which is "no model", not "no
  // interest" (007_money_market_history.sql). An empty series says so.
  if (!debtRows.length) return new Map()

  const priceRes = await client.query({
    query: buildHollarPriceSql(),
    query_params: params,
    format: 'JSONEachRow',
    clickhouse_settings: DECIMAL_STRINGS,
  })
  const prices = new Map<number, bigint>()
  for (const row of await priceRes.json<PriceRow>()) prices.set(bucketSeconds(row.bucket), scaledUsd(row.close))

  // Resolve the last CLOSED price for every hour once, independently of the
  // reserve observations. Price time must advance even through an hour where
  // debt did not change: otherwise the next accrual reuses an older candle.
  // Starting from the sorted 30-day lead-in also gives the first accrual the
  // latest price that predates the requested window. Keeping this timeline out
  // of the per-pool loop is load-bearing: a mutable lastPrice shared by the two
  // isolated HOLLAR markets lets the first pool's later hours leak a FUTURE
  // price into the second pool's earlier accruals.
  const priceAtHour = new Map<number, bigint>()
  const sortedPrices = [...prices].sort(([a], [b]) => a - b)
  let priceIndex = 0
  let lastPrice = 0n
  for (let t = first - HOUR; t <= q.endSeconds; t += HOUR) {
    while (priceIndex < sortedPrices.length && sortedPrices[priceIndex][0] <= t) {
      const p = sortedPrices[priceIndex][1]
      if (p > 0n) lastPrice = p
      priceIndex += 1
    }
    priceAtHour.set(t, lastPrice)
  }

  // HOLLAR is 18-decimal, so an interest amount in planck becomes 1e-12 USD as
  // planck × price(1e-12 USD) / 1e18 — all integer, no float on the money path.
  const HOLLAR_UNIT = 10n ** 18n
  const byPool = new Map<string, DebtRow[]>()
  for (const row of debtRows) {
    const list = byPool.get(row.pool_address)
    if (list) list.push(row)
    else byPool.set(row.pool_address, [row])
  }

  const interest = new Map<number, bigint>()

  for (const rows of byPool.values()) {
    const observed = new Map(rows.map(r => [bucketSeconds(r.bucket), r]))
    let prevDebt: bigint | null = null
    let prevIndex: bigint | null = null
    // Walk the lead-in hour too, so the first counted hour differences against
    // real state rather than against nothing.
    for (let t = first - HOUR; t <= q.endSeconds; t += HOUR) {
      const row = observed.get(t)
      if (!row) continue
      const debt = BigInt(row.debt_scaled)
      const index = BigInt(row.borrow_index)
      if (prevDebt != null && prevIndex != null && index > prevIndex && t >= first) {
        const planck = (prevDebt * (index - prevIndex)) / RAY
        const usd = (planck * (priceAtHour.get(t) ?? 0n)) / HOLLAR_UNIT
        // Fold the hour into the response's bucket. `last` bounds it so a partial
        // trailing bucket is not reported as a whole one.
        const bucket = lastBucketStart(t, width)
        if (bucket >= first && bucket <= last) interest.set(bucket, (interest.get(bucket) ?? 0n) + usd)
      }
      // A row whose index is 0 is a delta-only hour the view could not carry an
      // index into; keep the previous index rather than differencing to zero.
      prevDebt = debt
      if (index > 0n) prevIndex = index
    }
  }
  // A bucket the reserve did not move in emits nothing: a bucket exists when its
  // source did, and the grid is never filled with zeros.
  return interest
}

/**
 * One stream, bucketed and aggregated.
 *
 * Cached deliberately rather than incidentally: the money-market history view
 * costs ~1.1 s whatever the window, and this endpoint's consumer polls with a
 * one-hour staleTime, so a 5-minute fresh window with a 15-minute stale-while-
 * revalidate tail keeps every repeat request off ClickHouse while never serving
 * anything a chart would notice as old. It matches the route's own max-age.
 */
export async function feesChart(client: ClickHouseClient, q: FeesChartQuery): Promise<FeesChartResponse> {
  const key = `pub:fees:${q.productType}:${q.streamType}:${q.feeDestination}:${q.bucketSize}:${q.startSeconds}:${q.endSeconds}`
  return cachedSwr(key, 300_000, 900_000, async () => {
    const scaled = q.streamType === 'borrow_apr'
      ? await hollarBorrowInterest(client, q)
      : await readBuckets(client, buildFeesStreamSql(q.streamType, q.feeDestination), q)

    const data: FeesChartPoint[] = [...scaled.keys()].sort((a, b) => a - b).map(t => ({
      timestamp: new Date(t * 1000).toISOString(),
      value: Number(scaled.get(t)!) / USD_UNIT,
    }))
    return { data, periodAggregate: aggregate(data.map(p => p.value), AGGREGATE_MODE[q.streamType]) }
  })
}
