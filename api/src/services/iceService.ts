import type { ClickHouseClient } from '../db/client.ts'
import { cachedSwr } from './cache.ts'
import { ICE_FEE_ACCOUNT, ICE_POT_ACCOUNT, applyEventTimeUsd, dcaMigrationReason, ensurePrices, getIntentOrders, iceSettlementsFor, usdValue, type AssetRef, type PriceInfo, type RawIntentEvent } from './explorerService.ts'
import { assetDescriptor } from './explorerAssets.ts'

// ICE dashboard — the intent venue runtime 443 added: swap intents (the product's
// "limit orders") and DCA intents, settled inside unsigned `ICE.submit_solution`
// extrinsics by an off-chain solver. Venue status comes from the governance events,
// orders and fills from the intent tables, the AMM-routed part of a solution from
// the pot's own swap legs, the matched-volume fee from the revenue model, and the
// DCA→intent migration from dca_events. CH-only: no substrate RPC.
//
// Every read is bounded by the launch block (nothing about intents exists below
// it) or, for the daily series, by a 30-day window on the partition column, and
// runs under explicit memory/thread caps.

let client: ClickHouseClient
export function initIceService(c: ClickHouseClient): void { client = c }

// Runtime 443 went live in this block; no intent, solution or governance event
// can exist below it, so it is the lower bound of every intent read.
export const ICE_LAUNCH_BLOCK = 14362830
const WINDOW_DAYS = 30
const TOP_PAIRS = 10
// The price-vs-limit distribution is read per fill (the ratio is integer
// arithmetic in TypeScript), so the sample is capped at the newest fills in the
// window rather than left to the client's result-row ceiling to reject.
const BP_SAMPLE_LIMIT = 50_000
// A fill is any settlement the solver made for an intent: a limit order's full or
// partial resolution, or one DCA-intent trade. These three state their amounts; the
// budget-exhausting DCA trade is `Intent.DcaCompleted` alone, read separately below
// with its amounts recovered from the settlement legs. A terminal event closes the intent.
const FILL_EVENTS_SQL = ['Intent.IntentResolved', 'Intent.IntentResovedPartially', 'Intent.DcaTradeExecuted'].map(n => `'${n}'`).join(', ')
const DCA_COMPLETED_EVENT = 'Intent.DcaCompleted'
const TERMINAL_EVENTS_SQL = ['Intent.IntentResolved', 'Intent.IntentCanceled', 'Intent.IntentExpired', 'Intent.DcaCompleted'].map(n => `'${n}'`).join(', ')

const asset = (id: number): AssetRef => assetDescriptor(id)

function safeJsonObj(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v as Record<string, unknown> : {}
  } catch { return {} }
}

// Raw-unit amounts arrive as decimal strings; anything else (an empty column, the
// literal 'null' a JSON null leaks into the MV) is "no amount", never zero.
const DIGITS = /^\d+$/
function bigOrNull(v: string | null | undefined): bigint | null {
  return v != null && DIGITS.test(v) ? BigInt(v) : null
}

// A continuous `n`-day axis (today inclusive), the idiom of the explorer's other
// daily charts — a quiet day renders as zero rather than compressing the timeline.
function dayGrid(n: number): string[] {
  const day = 86_400_000
  const today = Math.floor(Date.now() / day) * day
  return Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * day).toISOString().slice(0, 10))
}

// pure helpers (unit-tested)

export interface GovernanceEventRow { event_name: string; args_json: string; block_height: number }
export type SolverMode = 'V4' | 'Passthrough' | 'Disabled'
export interface IceStatus {
  solverMode: SolverMode
  protocolFeePpm: number
  dcaMigrationEnabled: boolean
  uniswapV3: { factory: string; swapRouter: string; quoter: string } | null
  // The block of the newest governance event applied, or the launch block when
  // every value is still the runtime-443 default.
  asOfBlock: number
}
const SOLVER_MODES: ReadonlySet<string> = new Set<SolverMode>(['V4', 'Passthrough', 'Disabled'])

// An enum as the indexer serialises it (`{ __kind: 'V4' }`), or a bare string.
function kindOf(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && typeof (v as { __kind?: unknown }).__kind === 'string') return (v as { __kind: string }).__kind
  return null
}
function hexOf(v: unknown): string | null {
  return typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? v : null
}
function ppmOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && DIGITS.test(v) ? Number(v) : NaN
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : null
}

// Folds the venue's governance events (ascending by block/event index) into its
// current settings: the latest event of each kind wins, a kind that never fired
// keeps the value runtime 443 shipped with (V4 solver, 200 ppm fee, migration off,
// no Uniswap v3 addresses). A row whose payload cannot be read is skipped rather
// than adopted — a misparsed setter must not display as a governance change.
export function latestGovernanceStatus(rows: GovernanceEventRow[], launchBlock: number = ICE_LAUNCH_BLOCK): IceStatus {
  const status: IceStatus = { solverMode: 'V4', protocolFeePpm: 200, dcaMigrationEnabled: false, uniswapV3: null, asOfBlock: launchBlock }
  for (const r of rows) {
    const a = safeJsonObj(r.args_json)
    let applied = false
    switch (r.event_name) {
      case 'ICE.SolverModeSet': {
        const mode = kindOf(a.mode)
        if (mode && SOLVER_MODES.has(mode)) { status.solverMode = mode as SolverMode; applied = true }
        break
      }
      case 'ICE.ProtocolFeeSet': {
        const fee = ppmOf(a.fee)
        if (fee != null) { status.protocolFeePpm = fee; applied = true }
        break
      }
      case 'DCA.MigrationEnabledSet': {
        if (typeof a.enabled === 'boolean') { status.dcaMigrationEnabled = a.enabled; applied = true }
        break
      }
      case 'Parameters.UniswapV3AddressesSet': {
        const factory = hexOf(a.factory), swapRouter = hexOf(a.swapRouter), quoter = hexOf(a.quoter)
        if (factory && swapRouter && quoter) { status.uniswapV3 = { factory, swapRouter, quoter }; applied = true }
        break
      }
    }
    if (applied) status.asOfBlock = Math.max(status.asOfBlock, r.block_height)
  }
  return status
}

// How a fill's price compares with the order's limit, in basis points:
// (fillOut / fillIn) / (limitOut / limitIn) − 1. Positive means the owner got more
// per unit sold than the limit demanded. Integer arithmetic throughout — 128-bit
// amounts exist — kept to a tenth of a basis point; null when either ratio is
// undefined or degenerate (a zero amount on either side) or an amount is not a
// number — a zero-output fill is not a price, and would sit at −10,000 bp.
export function priceVsLimitBp(order: { amountIn: string; amountOut: string }, fill: { amountIn: string; amountOut: string }): number | null {
  const limitIn = bigOrNull(order.amountIn), limitOut = bigOrNull(order.amountOut)
  const fillIn = bigOrNull(fill.amountIn), fillOut = bigOrNull(fill.amountOut)
  if (limitIn == null || limitOut == null || fillIn == null || fillOut == null) return null
  const denominator = fillIn * limitOut
  if (denominator === 0n || limitIn === 0n || fillOut === 0n) return null
  const tenths = (fillOut * limitIn * 100_000n) / denominator - 100_000n
  return Number(tenths) / 10
}

// Nearest-rank deciles of a sample; all null without one.
export function bpQuantiles(sample: number[]): { p10: number | null; p50: number | null; p90: number | null } {
  if (!sample.length) return { p10: null, p50: null, p90: null }
  const sorted = [...sample].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9) }
}

// response shape

export interface IceDashboard {
  status: IceStatus
  openOrders: { total: number; limit: number; dca: number; byAsset: { asset: AssetRef; reserved: string; reservedUsd: number | null; orders: number }[] }
  fillsPerDay: { day: string; fills: number; solutions: number; usd: number; matchedUsd: number; routedUsd: number }[]
  quality: { medianTimeToFillSec: number | null; partialShare: number | null; cancelRate: number | null; expiryRate: number | null; priceVsLimitBp: { p10: number | null; p50: number | null; p90: number | null } }
  feeRevenue: { perDay: { day: string; usd: number }[]; potHoldings: { asset: AssetRef; amount: string; valueUsd: number | null }[] }
  migration: { migrated: number; cancelled: number; byReason: { reason: string; count: number }[]; remainingSchedules: number; perDay: { day: string; migrated: number; cancelled: number }[] }
  topPairs: { assetIn: AssetRef; assetOut: AssetRef; fills: number; usd: number }[]
  generatedAt: string
}

// ClickHouse loaders

async function loadStatus(): Promise<IceStatus> {
  const res = await client.query({
    query: `
      SELECT event_name, args_json, block_height
      FROM price_data.raw_events
      WHERE block_height >= {launch:UInt32}
        AND event_name IN ('ICE.SolverModeSet', 'ICE.ProtocolFeeSet', 'DCA.MigrationEnabledSet', 'Parameters.UniswapV3AddressesSet')
      ORDER BY block_height, event_index
      SETTINGS max_memory_usage=1000000000, max_threads=2`,
    query_params: { launch: ICE_LAUNCH_BLOCK },
    format: 'JSONEachRow',
  })
  // Replayed rows repeat an event verbatim; the fold is last-wins, so a duplicate
  // changes nothing and the table needs no FINAL.
  return latestGovernanceStatus(await res.json<GovernanceEventRow>())
}

interface OpenOrderRow { id: string; kind: string; asset_in: number; amount_in: string; budget: string }
interface OrderProgressRow { id: string; partial_in: string; remaining: string }
// Orders without a terminal event, and what each still holds: a swap order its
// amount less the partial fills so far, a DCA intent the budget its last trade
// left (else its whole budget; a rolling one — no budget — its per-trade amount).
async function loadOpenOrders(): Promise<{ orders: OpenOrderRow[]; progress: Map<string, OrderProgressRow> }> {
  const [ordersRes, progressRes] = await Promise.all([
    client.query({
      query: `
        SELECT toString(intent_id) AS id, kind, asset_in, amount_in, budget
        FROM price_data.intent_orders FINAL
        WHERE block_height >= {launch:UInt32}
          AND intent_id NOT IN (
            SELECT intent_id FROM price_data.intent_events
            WHERE block_height >= {launch:UInt32} AND event_name IN (${TERMINAL_EVENTS_SQL}))
        SETTINGS max_memory_usage=1000000000, max_threads=2`,
      query_params: { launch: ICE_LAUNCH_BLOCK },
      format: 'JSONEachRow',
    }),
    // Summing partial fills needs the replacements resolved first (FINAL); the
    // latest remaining budget is an argMax and would survive a duplicate anyway.
    client.query({
      query: `
        SELECT toString(intent_id) AS id,
          toString(sumIf(toUInt256OrZero(amount_in), event_name = 'Intent.IntentResovedPartially')) AS partial_in,
          argMaxIf(remaining_budget, (block_height, event_index), event_name = 'Intent.DcaTradeExecuted') AS remaining
        FROM price_data.intent_events FINAL
        WHERE block_height >= {launch:UInt32}
          AND event_name IN ('Intent.IntentResovedPartially', 'Intent.DcaTradeExecuted')
        GROUP BY intent_id
        SETTINGS max_memory_usage=1000000000, max_threads=2`,
      query_params: { launch: ICE_LAUNCH_BLOCK },
      format: 'JSONEachRow',
    }),
  ])
  const [orders, progressRows] = await Promise.all([ordersRes.json<OpenOrderRow>(), progressRes.json<OrderProgressRow>()])
  return { orders, progress: new Map(progressRows.map(r => [r.id, r])) }
}

function foldOpenOrders(orders: OpenOrderRow[], progress: Map<string, OrderProgressRow>, prices: Map<number, PriceInfo>): IceDashboard['openOrders'] {
  const byAsset = new Map<number, { reserved: bigint; orders: number }>()
  let limit = 0, dca = 0
  for (const o of orders) {
    const p = progress.get(o.id)
    let reserved: bigint
    if (o.kind === 'dca') {
      dca += 1
      reserved = bigOrNull(p?.remaining) ?? bigOrNull(o.budget) ?? bigOrNull(o.amount_in) ?? 0n
    } else {
      limit += 1
      const total = bigOrNull(o.amount_in) ?? 0n
      const filled = bigOrNull(p?.partial_in) ?? 0n
      reserved = total > filled ? total - filled : 0n
    }
    const e = byAsset.get(o.asset_in) ?? { reserved: 0n, orders: 0 }
    e.reserved += reserved
    e.orders += 1
    byAsset.set(o.asset_in, e)
  }
  // Reserved notional is what the orders still hold today, so current prices.
  const rows = [...byAsset].map(([assetId, e]) => {
    const a = asset(assetId)
    return { asset: a, reserved: e.reserved.toString(), reservedUsd: usdValue(prices, a.assetId, e.reserved.toString(), a.decimals), orders: e.orders }
  })
  rows.sort((x, y) => (y.reservedUsd ?? -1) - (x.reservedUsd ?? -1) || y.orders - x.orders)
  return { total: orders.length, limit, dca, byAsset: rows }
}

// Fills bucketed per hour and pair. The feed values a flow at the latest price
// known at its hour (the closed hourly candle), so bucketing fills by hour before
// valuing loses nothing against that semantic and keeps the read a few thousand
// rows however busy the venue gets. Each bucket is then valued through the shared
// event-time helper off its most reliably priced leg, at the bucket's last block.
interface FillBucketRow { hour: string; day: string; a_in: number; a_out: number; fills: string; sum_in: string; sum_out: string; block: number }
type Valued<T> = T & { valueUsd: number | null }
async function loadFillBuckets(): Promise<Valued<FillBucketRow>[]> {
  // A fill whose order is not indexed has no pair and cannot be valued; the two
  // tables fill from the same raw, so the inner join drops nothing raw holds.
  const res = await client.query({
    query: `
      SELECT toString(toStartOfHour(ie.block_timestamp)) AS hour, toString(toDate(ie.block_timestamp)) AS day,
        o.asset_in AS a_in, o.asset_out AS a_out, count() AS fills,
        toString(sum(toUInt256OrZero(ie.amount_in))) AS sum_in, toString(sum(toUInt256OrZero(ie.amount_out))) AS sum_out,
        max(ie.block_height) AS block
      FROM (
        SELECT intent_id, block_height, block_timestamp, amount_in, amount_out
        FROM price_data.intent_events FINAL
        WHERE block_height >= {launch:UInt32} AND block_timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY
          AND event_name IN (${FILL_EVENTS_SQL})
      ) AS ie
      INNER JOIN (
        SELECT intent_id, asset_in, asset_out FROM price_data.intent_orders FINAL WHERE block_height >= {launch:UInt32}
      ) AS o ON o.intent_id = ie.intent_id
      GROUP BY hour, day, a_in, a_out
      ORDER BY hour
      SETTINGS max_memory_usage=1000000000, max_threads=2`,
    query_params: { launch: ICE_LAUNCH_BLOCK },
    format: 'JSONEachRow',
  })
  const buckets: Valued<FillBucketRow>[] = (await res.json<FillBucketRow>()).map(r => ({ ...r, valueUsd: null }))
  buckets.push(...await loadCompletionFills())
  await applyEventTimeUsd(buckets, b => ({ block: Number(b.block), legs: [priceLeg(b.a_in, b.sum_in), priceLeg(b.a_out, b.sum_out)] }))
  return buckets
}
// The DCA intents' final trades: one DcaCompleted per intent, so one row each, with
// the amounts the feed's own settlement reader recovers from the pot's legs. A
// completion whose legs cannot be told apart counts as a fill with no amounts.
type CompletionRow = RawIntentEvent & { hour: string; day: string; intent_id: string; a_in: number; a_out: number }
async function loadCompletionFills(): Promise<Valued<FillBucketRow>[]> {
  const res = await client.query({
    query: `
      SELECT toString(toStartOfHour(ie.block_timestamp)) AS hour, toString(toDate(ie.block_timestamp)) AS day,
        ie.block_height AS block_height, toString(ie.block_timestamp) AS ts, ie.event_index AS event_index, ie.extrinsic_index AS extrinsic_index,
        ie.event_name AS event_name, ie.args_json AS args_json, toString(ie.intent_id) AS intent_id, o.asset_in AS a_in, o.asset_out AS a_out
      FROM (
        SELECT intent_id, block_height, block_timestamp, event_index, extrinsic_index, event_name, args_json
        FROM price_data.intent_events FINAL
        WHERE block_height >= {launch:UInt32} AND block_timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY
          AND event_name = '${DCA_COMPLETED_EVENT}'
      ) AS ie
      INNER JOIN (
        SELECT intent_id, asset_in, asset_out FROM price_data.intent_orders FINAL WHERE block_height >= {launch:UInt32}
      ) AS o ON o.intent_id = ie.intent_id
      ORDER BY ie.block_height, ie.event_index
      SETTINGS max_memory_usage=1000000000, max_threads=2`,
    query_params: { launch: ICE_LAUNCH_BLOCK },
    format: 'JSONEachRow',
  })
  const rows = await res.json<CompletionRow>()
  if (!rows.length) return []
  const settled = await iceSettlementsFor(rows, await getIntentOrders(rows.map(r => r.intent_id)))
  return rows.map(r => {
    const s = settled.get(`${r.block_height}:${r.event_index}`)
    return { hour: r.hour, day: r.day, a_in: r.a_in, a_out: r.a_out, fills: '1', sum_in: s?.amountIn ?? '0', sum_out: s?.amountOut ?? '0', block: r.block_height, valueUsd: null }
  })
}
function priceLeg(assetId: number, raw: string): { assetId: number; decimals: number; raw: string } {
  const a = asset(assetId)
  return { assetId: a.assetId, decimals: a.decimals, raw }
}

// What the solver routed through the AMMs: what each of the pot's ROUTES took in,
// once per route. A route is several Broadcast hops sharing one op_key, and every
// hop has an `in` leg — summing them counted a 4-hop route four times (the hub
// asset and the intermediates included; $112.6k "routed" against $16.6k of fills).
// Netting the route's legs per asset cancels each intermediate (bought by one hop,
// sold by the next; the hub's `in` is its `out` less the protocol fee) and leaves
// the route's input on its positive side, valued the same way as the fills so
// matched = fills − routed compares like with like.
interface RoutedBucketRow { hour: string; day: string; asset_id: number; sum_in: string; block: number }
async function loadRoutedBuckets(): Promise<Valued<RoutedBucketRow>[]> {
  const res = await client.query({
    query: `
      SELECT toString(toStartOfHour(t)) AS hour, toString(toDate(t)) AS day, asset_id,
        toString(sum(net_in)) AS sum_in, max(block) AS block
      FROM (
        SELECT min(block_timestamp) AS t, block_height AS block, op_key, asset_id,
          greatest(toInt256(sumIf(toUInt256OrZero(amount), leg_kind = 'in')) - toInt256(sumIf(toUInt256OrZero(amount), leg_kind = 'out')), toInt256(0)) AS net_in
        FROM price_data.pool_swap_legs_by_account FINAL
        WHERE swapper = {pot:String} AND block_height >= {launch:UInt32}
          AND block_timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY AND leg_kind IN ('in', 'out')
        GROUP BY block_height, op_key, asset_id
      )
      WHERE net_in > 0
      GROUP BY hour, day, asset_id
      ORDER BY hour
      SETTINGS max_memory_usage=1000000000, max_threads=2`,
    query_params: { pot: ICE_POT_ACCOUNT, launch: ICE_LAUNCH_BLOCK },
    format: 'JSONEachRow',
  })
  const buckets: Valued<RoutedBucketRow>[] = (await res.json<RoutedBucketRow>()).map(r => ({ ...r, valueUsd: null }))
  await applyEventTimeUsd(buckets, b => ({ block: Number(b.block), legs: [priceLeg(b.asset_id, b.sum_in)] }))
  return buckets
}

// Solutions per day: one `ICE.submit_solution` extrinsic emits one
// ICE.SolutionExecuted, so distinct (block, extrinsic) pairs count them; a
// distinct count is idempotent under replay.
async function loadSolutionsPerDay(): Promise<Map<string, number>> {
  const res = await client.query({
    query: `
      SELECT toString(toDate(block_timestamp)) AS day, uniqExact(block_height, ifNull(extrinsic_index, toUInt32(0))) AS solutions
      FROM price_data.intent_events
      WHERE block_height >= {launch:UInt32} AND block_timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY
        AND event_name = 'ICE.SolutionExecuted'
      GROUP BY day
      SETTINGS max_memory_usage=1000000000, max_threads=2`,
    query_params: { launch: ICE_LAUNCH_BLOCK },
    format: 'JSONEachRow',
  })
  return new Map((await res.json<{ day: string; solutions: string }>()).map(r => [r.day, Number(r.solutions)]))
}

// Closed swap orders (anything not a DCA intent, as the feed classifies them) in
// the window and how they closed. Each flag is an
// existence test and the first fill a minimum, so replayed rows change nothing;
// a fill-then-cancel order counts as filled, never twice. A limit order lives at
// most until its deadline, so a 30-day window on its events holds whole
// lifecycles except at the window's edge.
interface QualityRow { closed: string; filled: string; cancelled: string; expired: string; filled_partially: string; median_ttf: number | string | null }
async function loadQuality(): Promise<QualityRow | undefined> {
  const res = await client.query({
    query: `
      WITH per AS (
        SELECT intent_id,
          countIf(event_name = 'Intent.IntentResolved') > 0 AS filled,
          countIf(event_name = 'Intent.IntentCanceled') > 0 AS cancelled,
          countIf(event_name = 'Intent.IntentExpired') > 0 AS expired,
          countIf(event_name = 'Intent.IntentResovedPartially') > 0 AS partial,
          minIf(block_timestamp, event_name IN ('Intent.IntentResolved', 'Intent.IntentResovedPartially')) AS first_fill
        FROM price_data.intent_events
        WHERE block_height >= {launch:UInt32} AND block_timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY
          AND event_name IN ('Intent.IntentResolved', 'Intent.IntentResovedPartially', 'Intent.IntentCanceled', 'Intent.IntentExpired')
        GROUP BY intent_id
      )
      SELECT count() AS closed, countIf(p.filled) AS filled,
        countIf(p.cancelled AND NOT p.filled) AS cancelled,
        countIf(p.expired AND NOT p.filled AND NOT p.cancelled) AS expired,
        countIf(p.filled AND p.partial) AS filled_partially,
        quantileExactIf(0.5)(dateDiff('second', o.block_timestamp, p.first_fill), p.filled) AS median_ttf
      FROM per AS p
      INNER JOIN (
        SELECT intent_id, block_timestamp FROM price_data.intent_orders FINAL
        WHERE block_height >= {launch:UInt32} AND kind != 'dca'
      ) AS o ON o.intent_id = p.intent_id
      WHERE p.filled OR p.cancelled OR p.expired
      SETTINGS max_memory_usage=1000000000, max_threads=2`,
    query_params: { launch: ICE_LAUNCH_BLOCK },
    format: 'JSONEachRow',
  })
  return (await res.json<QualityRow>())[0]
}

// Every fill of a swap order in the window with the order's limit beside it, the
// newest first, capped (see BP_SAMPLE_LIMIT). The ratio itself is computed in
// TypeScript by integer arithmetic (priceVsLimitBp).
interface BpSampleRow { fill_in: string; fill_out: string; limit_in: string; limit_out: string }
async function loadBpSample(): Promise<BpSampleRow[]> {
  const res = await client.query({
    query: `
      SELECT ie.amount_in AS fill_in, ie.amount_out AS fill_out, o.amount_in AS limit_in, o.amount_out AS limit_out
      FROM (
        SELECT intent_id, block_height, event_index, amount_in, amount_out
        FROM price_data.intent_events FINAL
        WHERE block_height >= {launch:UInt32} AND block_timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY
          AND event_name IN ('Intent.IntentResolved', 'Intent.IntentResovedPartially')
      ) AS ie
      INNER JOIN (
        SELECT intent_id, amount_in, amount_out FROM price_data.intent_orders FINAL
        WHERE block_height >= {launch:UInt32} AND kind != 'dca'
      ) AS o ON o.intent_id = ie.intent_id
      ORDER BY ie.block_height DESC, ie.event_index DESC
      LIMIT {sample:UInt32}
      SETTINGS max_memory_usage=1000000000, max_threads=2`,
    query_params: { launch: ICE_LAUNCH_BLOCK, sample: BP_SAMPLE_LIMIT },
    format: 'JSONEachRow',
  })
  return res.json<BpSampleRow>()
}

// The matched-volume fee as the revenue model books it (stream written by the
// derivations service, valued at event time there). FINAL: the model replaces on
// its computed_at version and a sum must not see two generations of a row.
async function loadFeePerDay(): Promise<Map<string, number>> {
  const res = await client.query({
    query: `
      SELECT toString(toDate(block_timestamp)) AS day, toFloat64(sum(amount_usd)) AS usd
      FROM price_data.revenue_events FINAL
      WHERE stream = 'ice_matched_fee' AND block_height >= {launch:UInt32}
        AND block_timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY
      GROUP BY day
      ORDER BY day
      SETTINGS max_memory_usage=1000000000, max_threads=2`,
    query_params: { launch: ICE_LAUNCH_BLOCK },
    format: 'JSONEachRow',
  })
  return new Map((await res.json<{ day: string; usd: number }>()).map(r => [r.day, Number(r.usd)]))
}

// What the fee receiver holds right now — the same event-folded balance table
// the account page reads, one account, so a primary-key point read.
async function loadFeeAccountHoldings(prices: Map<number, PriceInfo>): Promise<IceDashboard['feeRevenue']['potHoldings']> {
  const res = await client.query({
    query: `
      SELECT asset_id, toString(toUInt256OrZero(argMaxMerge(total_state))) AS bal
      FROM price_data.account_asset_latest_balances
      WHERE account_id = {account:String}
      GROUP BY asset_id
      SETTINGS max_memory_usage=1000000000, max_threads=2`,
    query_params: { account: ICE_FEE_ACCOUNT },
    format: 'JSONEachRow',
  })
  return (await res.json<{ asset_id: string; bal: string }>())
    .filter(r => (bigOrNull(r.bal) ?? 0n) > 0n)
    .map(r => {
      const a = asset(Number(r.asset_id))
      return { asset: a, amount: r.bal, valueUsd: usdValue(prices, a.assetId, r.bal, a.decimals) }
    })
    .sort((x, y) => (y.valueUsd ?? -1) - (x.valueUsd ?? -1))
}

// The DCA→intent migration: every schedule the hook converted or refused, since
// launch (the programme is finite; the per-day series takes the window from these
// same rows). A refusal's `error` column holds the raw `reason` JSON — a bare
// string for a dataless variant, `{"__kind": …}` for one with data — so rows are
// grouped by that raw text and decoded with the shared dcaMigrationReason.
export interface MigrationRow { day: string; event_name: string; reason_raw: string; n: string }
async function loadMigration(): Promise<{ rows: MigrationRow[]; remaining: number }> {
  const [rowsRes, remainingRes] = await Promise.all([
    client.query({
      query: `
        SELECT toString(toDate(block_timestamp)) AS day, event_name, error AS reason_raw, count() AS n
        FROM price_data.dca_events FINAL
        WHERE event_name IN ('DCA.Migrated', 'DCA.MigrationCancelled') AND block_height >= {launch:UInt32}
        GROUP BY day, event_name, reason_raw
        ORDER BY day
        SETTINGS max_memory_usage=1000000000, max_threads=2`,
      query_params: { launch: ICE_LAUNCH_BLOCK },
      format: 'JSONEachRow',
    }),
    // Old schedules still to be migrated: every schedule without a terminal event
    // — completed, terminated, or already taken through the migration either way.
    // dca_schedules holds one row per schedule ever (tens of thousands), so the
    // set difference is the bound; a distinct count needs no FINAL.
    client.query({
      query: `
        SELECT uniqExact(id) AS n
        FROM price_data.dca_schedules
        WHERE id NOT IN (
          SELECT id FROM price_data.dca_events
          WHERE event_name IN ('DCA.Completed', 'DCA.Terminated', 'DCA.Migrated', 'DCA.MigrationCancelled'))
        SETTINGS max_memory_usage=1000000000, max_threads=2`,
      format: 'JSONEachRow',
    }),
  ])
  const [rows, remainingRows] = await Promise.all([rowsRes.json<MigrationRow>(), remainingRes.json<{ n: string }>()])
  return { rows, remaining: Number(remainingRows[0]?.n ?? 0) }
}

export function foldMigration(rows: MigrationRow[], remaining: number, days: string[]): IceDashboard['migration'] {
  let migrated = 0, cancelled = 0
  const byReason = new Map<string, number>()
  const byDay = new Map<string, { migrated: number; cancelled: number }>()
  for (const r of rows) {
    const n = Number(r.n)
    const d = byDay.get(r.day) ?? { migrated: 0, cancelled: 0 }
    if (r.event_name === 'DCA.Migrated') { migrated += n; d.migrated += n } else {
      cancelled += n
      d.cancelled += n
      const reason = dcaMigrationReason(r.reason_raw) ?? 'Unknown'
      byReason.set(reason, (byReason.get(reason) ?? 0) + n)
    }
    byDay.set(r.day, d)
  }
  return {
    migrated, cancelled, remainingSchedules: remaining,
    byReason: [...byReason].map(([reason, count]) => ({ reason, count })).sort((x, y) => y.count - x.count),
    perDay: days.map(day => ({ day, ...(byDay.get(day) ?? { migrated: 0, cancelled: 0 }) })),
  }
}

// Matched volume never touched an AMM: per day and input asset, what the fills took
// in less what the pot's routes took in — `intent_in − pool_in`, the pallet's own
// matched-fee base, in raw units and floored at zero — valued at the day's fills'
// own implied price for that asset. Never a difference of two USD figures: the fill
// and the route are priced off different legs, and that read price noise as
// matched volume on days that routed every unit.
export function foldFills(fills: readonly Valued<FillBucketRow>[], routed: readonly Valued<RoutedBucketRow>[], solutions: ReadonlyMap<string, number>, days: readonly string[]): IceDashboard['fillsPerDay'] {
  const byDay = new Map<string, { fills: number; usd: number; routedUsd: number; inRaw: Map<number, bigint>; inUsd: Map<number, number>; routedRaw: Map<number, bigint> }>()
  const at = (day: string) => {
    const e = byDay.get(day) ?? { fills: 0, usd: 0, routedUsd: 0, inRaw: new Map(), inUsd: new Map(), routedRaw: new Map() }
    byDay.set(day, e)
    return e
  }
  const raw = (v: string): bigint => /^\d+$/.test(v) ? BigInt(v) : 0n
  for (const b of fills) {
    const e = at(b.day)
    e.fills += Number(b.fills)
    e.usd += b.valueUsd ?? 0
    e.inRaw.set(b.a_in, (e.inRaw.get(b.a_in) ?? 0n) + raw(b.sum_in))
    if (b.valueUsd != null) e.inUsd.set(b.a_in, (e.inUsd.get(b.a_in) ?? 0) + b.valueUsd)
  }
  for (const b of routed) {
    const e = at(b.day)
    e.routedUsd += b.valueUsd ?? 0
    e.routedRaw.set(b.asset_id, (e.routedRaw.get(b.asset_id) ?? 0n) + raw(b.sum_in))
  }
  return days.map(day => {
    const e = byDay.get(day) ?? { fills: 0, usd: 0, routedUsd: 0, inRaw: new Map<number, bigint>(), inUsd: new Map<number, number>(), routedRaw: new Map<number, bigint>() }
    let matchedUsd = 0
    for (const [assetId, intentIn] of e.inRaw) {
      const matched = intentIn - (e.routedRaw.get(assetId) ?? 0n)
      const priced = e.inUsd.get(assetId)
      if (matched <= 0n || priced == null || intentIn === 0n) continue
      matchedUsd += Number(matched) * (priced / Number(intentIn))
    }
    return { day, fills: e.fills, solutions: solutions.get(day) ?? 0, usd: e.usd, matchedUsd, routedUsd: e.routedUsd }
  })
}

function foldTopPairs(fills: Valued<FillBucketRow>[]): IceDashboard['topPairs'] {
  const byPair = new Map<string, { assetIn: number; assetOut: number; fills: number; usd: number }>()
  for (const b of fills) {
    const key = `${b.a_in}:${b.a_out}`
    const e = byPair.get(key) ?? { assetIn: b.a_in, assetOut: b.a_out, fills: 0, usd: 0 }
    e.fills += Number(b.fills)
    e.usd += b.valueUsd ?? 0
    byPair.set(key, e)
  }
  return [...byPair.values()]
    .sort((x, y) => y.usd - x.usd || y.fills - x.fills)
    .slice(0, TOP_PAIRS)
    .map(p => ({ assetIn: asset(p.assetIn), assetOut: asset(p.assetOut), fills: p.fills, usd: p.usd }))
}

function foldQuality(row: QualityRow | undefined, sample: BpSampleRow[]): IceDashboard['quality'] {
  const closed = Number(row?.closed ?? 0), filled = Number(row?.filled ?? 0)
  const cancelled = Number(row?.cancelled ?? 0), expired = Number(row?.expired ?? 0), filledPartially = Number(row?.filled_partially ?? 0)
  const medianTtf = Number(row?.median_ttf)
  const bps = sample
    .map(r => priceVsLimitBp({ amountIn: r.limit_in, amountOut: r.limit_out }, { amountIn: r.fill_in, amountOut: r.fill_out }))
    .filter((v): v is number => v != null)
  return {
    medianTimeToFillSec: filled > 0 && Number.isFinite(medianTtf) ? medianTtf : null,
    partialShare: filled > 0 ? filledPartially / filled : null,
    cancelRate: closed > 0 ? cancelled / closed : null,
    expiryRate: closed > 0 ? expired / closed : null,
    priceVsLimitBp: bpQuantiles(bps),
  }
}

// dashboard payload

export async function getIceDashboard(): Promise<IceDashboard> {
  return cachedSwr('explorer:ice-dashboard:model', 300_000, 48 * 3_600_000, async () => {
    const days = dayGrid(WINDOW_DAYS)
    const [prices, status, open, fills, routed, solutions, qualityRow, bpSample, feePerDay, migration] = await Promise.all([
      ensurePrices(), loadStatus(), loadOpenOrders(), loadFillBuckets(), loadRoutedBuckets(), loadSolutionsPerDay(),
      loadQuality(), loadBpSample(), loadFeePerDay(), loadMigration(),
    ])
    const potHoldings = await loadFeeAccountHoldings(prices)
    return {
      status,
      openOrders: foldOpenOrders(open.orders, open.progress, prices),
      fillsPerDay: foldFills(fills, routed, solutions, days),
      quality: foldQuality(qualityRow, bpSample),
      feeRevenue: { perDay: days.map(day => ({ day, usd: feePerDay.get(day) ?? 0 })), potHoldings },
      migration: foldMigration(migration.rows, migration.remaining, days),
      topPairs: foldTopPairs(fills),
      generatedAt: new Date().toISOString(),
    }
  })
}
