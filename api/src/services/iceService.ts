import type { ClickHouseClient } from '../db/client.ts'
import { cacheInstall, cached, cachedSwr, peekCached } from './cache.ts'
import { ICE_FEE_ACCOUNT, ICE_POT_ACCOUNT, accountRef, applyEventTimeUsd, dcaMigrationReason, ensurePrices, getOpenIntentLists, usdValue, type AccountRef, type ActiveDca, type AssetRef, type OpenLimitOrder, type PriceInfo } from './explorerService.ts'
import { displayDescriptor } from './explorerAssets.ts'
import { DCA_COMPLETED_EVENT, dcaFinalTradeIn } from './iceSettlement.ts'
import { MAX_TAIL_HOURS, buildRevenueEventRowsSql } from './revenueStreams.ts'
import { chTimestamp } from './clickhouseTime.ts'

// The intents dashboard — the ICE venue runtime 443 added: swap intents (the
// product's "limit orders") and DCA intents, settled inside unsigned
// `ICE.submit_solution` extrinsics by an off-chain solver. Venue status comes from
// the governance events, orders and fills from the intent tables, the AMM-routed
// part of a solution from the solver pot's own swap legs, the matched-volume fee
// from the revenue model, and the DCA→intent migration from dca_events. CH-only:
// no substrate RPC. The explorer serves it at /intents; the API route is
// /explorer/ice.
//
// Every read is bounded by the launch block (nothing about intents exists below
// it) and, for the daily series, by the day's own block range, and runs under
// explicit memory/thread caps. The daily series is built one calendar day at a
// time: a day that has closed is cached for hours, so a rebuild reads today.

let client: ClickHouseClient
export function initIceService(c: ClickHouseClient): void { client = c }

// Runtime 443 went live in this block; no intent, solution or governance event
// can exist below it, so it is the lower bound of every intent read.
export const ICE_LAUNCH_BLOCK = 14362830
const WINDOW_DAYS = 30
const TOP_PAIRS = 10
const TOP_TRADERS = 10
// The price-vs-limit distribution is read per fill (the ratio is integer
// arithmetic in TypeScript), so the sample is capped at the newest fills in the
// window rather than left to the client's result-row ceiling to reject.
const BP_SAMPLE_LIMIT = 50_000
// A fill no more than this many blocks after its order was placed is a
// market-style order: the app submits a swap as an intent whose limit is the
// quote less its slippage allowance, and the solver fills it at once — so its
// "price vs limit" is that allowance, not price improvement. Measured over 30
// days: those fills sit at a median +100 bp, the later ones at 0 bp.
export const IMMEDIATE_FILL_BLOCKS = 2
// A closed day is cached this long. Its key carries the day's block range, so a
// block indexed into it later is a new key; the lifetime bounds the rarer case of
// an intent row landing inside an unchanged range.
const CLOSED_DAY_TTL_MS = 6 * 3_600_000
// A day counts as closed once the indexed head is this far past its end: late
// price rows and the finalized tail have landed by then.
const DAY_FINALITY_SEC = 3_600
// What every dashboard read runs under.
const CAPS = 'SETTINGS max_memory_usage=1000000000, max_threads=2'
// A fill is any settlement the solver made for an intent: a limit order's full or
// partial resolution, or one DCA-intent trade. These three state their amounts; the
// budget-exhausting DCA trade is `Intent.DcaCompleted` alone (see completionIn).
const FILL_EVENTS = ['Intent.IntentResolved', 'Intent.IntentResovedPartially', 'Intent.DcaTradeExecuted']
const FILL_EVENTS_SQL = FILL_EVENTS.map(n => `'${n}'`).join(', ')
const ICE_FEE_STREAM = 'ice_matched_fee'

const asset = (id: number): AssetRef => displayDescriptor(id)

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
// Every published dollar figure: sub-cent float residue reads as zero.
export const snapUsd = (v: number): number => Math.abs(v) < 0.005 ? 0 : v

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
// One entry of `ICE.SolverRouting` — a venue governance included in or excluded
// from what the solver may route through (`ICE.update_routing`, runtime 447). The
// target is the pallet's own enum: an Omnipool asset, a stableswap pool (its share
// asset id), an XYK pair, an Aave wrap (underlying, aToken), a Uniswap v3 pool, or
// a list of wraps / pairs / pools set at once. `assets` holds the ids each target
// names, one tuple per pair (a single id for an asset or a pool), `contracts` the
// v3 pool addresses.
export interface IceRoutingRule {
  kind: string
  assets: number[][]
  contracts: string[]
  state: 'Included' | 'Excluded'
  block: number
}
export interface IceStatus {
  solverMode: SolverMode
  protocolFeePpm: number
  dcaMigrationEnabled: boolean
  uniswapV3: { factory: string; swapRouter: string; quoter: string } | null
  // The block of the newest governance event applied, or the launch block when
  // every value is still the runtime-443 default.
  asOfBlock: number
  // The solver's routing overrides in force, newest first.
  routing: IceRoutingRule[]
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
function idOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && DIGITS.test(v) ? Number(v) : NaN
  return Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null
}
function idTuple(v: unknown): number[] | null {
  if (!Array.isArray(v) || !v.length) return null
  const ids = v.map(idOf)
  return ids.every((x): x is number => x != null) ? ids : null
}
// A RoutingTarget as the indexer serialises it, to the ids or contracts it names;
// null when the payload is not one the pallet defines.
export function routingTargetOf(target: unknown): { kind: string; assets: number[][]; contracts: string[] } | null {
  const kind = kindOf(target)
  const value = (target as { value?: unknown } | null)?.value
  switch (kind) {
    case 'OmnipoolAsset': case 'StableswapPool': {
      const id = idOf(value)
      return id == null ? null : { kind, assets: [[id]], contracts: [] }
    }
    case 'XykPool': case 'AaveWrap': {
      const pair = idTuple(value)
      return pair?.length === 2 ? { kind, assets: [pair], contracts: [] } : null
    }
    case 'XykPools': case 'AaveWraps': {
      if (!Array.isArray(value)) return null
      const pairs = value.map(idTuple)
      return pairs.every(p => p?.length === 2) ? { kind, assets: pairs as number[][], contracts: [] } : null
    }
    case 'UniswapV3Pool': {
      const h = hexOf(value)
      return h ? { kind, assets: [], contracts: [h.toLowerCase()] } : null
    }
    case 'UniswapV3Pools': {
      if (!Array.isArray(value)) return null
      const hs = value.map(hexOf)
      return hs.every((h): h is string => h != null) ? { kind, assets: [], contracts: hs.map(h => h.toLowerCase()) } : null
    }
    default: return null
  }
}

// Folds the venue's governance events (ascending by block/event index) into its
// current settings: the latest event of each kind wins, a kind that never fired
// keeps the value runtime 443 shipped with (V4 solver, 200 ppm fee, migration off,
// no Uniswap v3 addresses). A row whose payload cannot be read is skipped rather
// than adopted — a misparsed setter must not display as a governance change.
export function latestGovernanceStatus(rows: GovernanceEventRow[], launchBlock: number = ICE_LAUNCH_BLOCK): IceStatus {
  const status: IceStatus = { solverMode: 'V4', protocolFeePpm: 200, dcaMigrationEnabled: false, uniswapV3: null, asOfBlock: launchBlock, routing: [] }
  // SolverRouting is a map keyed by the target: a later update of the same target
  // replaces its state, and a `state: None` removes the entry.
  const routing = new Map<string, IceRoutingRule>()
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
      case 'ICE.RoutingUpdated': {
        const target = routingTargetOf(a.target)
        if (!target) break
        const key = JSON.stringify([target.kind, target.assets, target.contracts])
        const state = a.state == null ? null : kindOf(a.state)
        if (state === 'Included' || state === 'Excluded') { routing.set(key, { ...target, state, block: r.block_height }); applied = true }
        else if (a.state == null) { routing.delete(key); applied = true }
        break
      }
    }
    if (applied) status.asOfBlock = Math.max(status.asOfBlock, r.block_height)
  }
  status.routing = [...routing.values()].sort((x, y) => y.block - x.block)
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

// response shape

export interface IceRoutingEntry { kind: string; assets: AssetRef[][]; contracts: string[]; state: 'Included' | 'Excluded'; block: number }
export interface IceOpenOrders { total: number; limit: number; dca: number; byAsset: { asset: AssetRef; reserved: string; reservedUsd: number | null; orders: number }[] }
export interface BpQuantiles { p10: number | null; p50: number | null; p90: number | null }
export interface IceDashboard {
  status: Omit<IceStatus, 'routing'> & { routing: IceRoutingEntry[] }
  // Every intent ever placed, by kind, and how many accounts placed them.
  allTime: { intents: number; limit: number; dca: number; owners: number }
  openOrders: IceOpenOrders
  fillsPerDay: { day: string; fills: number; solutions: number; usd: number; matchedUsd: number; routedUsd: number }[]
  // Intent owners with at least one fill in the window, and the fills whose value
  // could not be stated (no price at the fill's block, or a final DCA trade whose
  // amount cannot be told) — counted in `fills`, left out of every USD figure.
  traders: number
  unpricedFills: number
  topTraders: { account: AccountRef; fills: number; usd: number }[]
  quality: {
    // Placement to first fill. Measured in blocks: block timestamps advance in
    // 6-second relay steps while blocks come every ~2s, so a next-block fill would
    // read as 0s by timestamp. The seconds are the blocks at the window's own pace.
    medianTimeToFillSec: number | null; medianBlocksToFill: number | null
    partialShare: number | null; cancelRate: number | null; expiryRate: number | null
    // Every limit-order fill in the window, then split at IMMEDIATE_FILL_BLOCKS:
    // market-style fills (the app's swaps) and fills of orders that rested.
    priceVsLimitBp: BpQuantiles
    priceVsLimitBpImmediate: BpQuantiles & { fills: number }
    priceVsLimitBpResting: BpQuantiles & { fills: number }
  }
  feeRevenue: { perDay: { day: string; usd: number }[]; potHoldings: { asset: AssetRef; amount: string; valueUsd: number | null }[] }
  migration: { migrated: number; cancelled: number; byReason: { reason: string; count: number }[]; remainingSchedules: number; perDay: { day: string; migrated: number; cancelled: number }[] }
  topPairs: { assetIn: AssetRef; assetOut: AssetRef; fills: number; usd: number }[]
  generatedAt: string
}

// ClickHouse loaders

async function loadStatus(): Promise<IceStatus> {
  const res = await client.query({
    query: `-- ice:status
      SELECT event_name, args_json, block_height
      FROM price_data.raw_events
      WHERE block_height >= {launch:UInt32}
        AND event_name IN ('ICE.SolverModeSet', 'ICE.ProtocolFeeSet', 'ICE.RoutingUpdated', 'DCA.MigrationEnabledSet', 'Parameters.UniswapV3AddressesSet')
      ORDER BY block_height, event_index
      ${CAPS}`,
    query_params: { launch: ICE_LAUNCH_BLOCK },
    format: 'JSONEachRow',
  })
  // Replayed rows repeat an event verbatim; the fold is last-wins, so a duplicate
  // changes nothing and the table needs no FINAL.
  return latestGovernanceStatus(await res.json<GovernanceEventRow>())
}

function routingEntry(r: IceRoutingRule): IceRoutingEntry {
  return { kind: r.kind, assets: r.assets.map(ids => ids.map(asset)), contracts: r.contracts, state: r.state, block: r.block }
}

async function loadAllTime(): Promise<IceDashboard['allTime']> {
  const res = await client.query({
    query: `-- ice:all-time
      SELECT count() AS intents, countIf(kind != 'dca') AS lim, countIf(kind = 'dca') AS dca, uniqExact(owner) AS owners
      FROM price_data.intent_orders FINAL
      WHERE block_height >= {launch:UInt32}
      ${CAPS}`,
    query_params: { launch: ICE_LAUNCH_BLOCK },
    format: 'JSONEachRow',
  })
  const r = (await res.json<{ intents: string; lim: string; dca: string; owners: string }>())[0]
  return { intents: Number(r?.intents ?? 0), limit: Number(r?.lim ?? 0), dca: Number(r?.dca ?? 0), owners: Number(r?.owners ?? 0) }
}

// The open book's per-asset reserves, from the same order lists the tables show
// (getOpenIntentLists): a limit order still holds what it sells less its partial
// fills (`remainingIn`); a DCA intent holds its remaining budget — the newest
// DcaTradeExecuted's remainingBudget, else the reserve its submission stated (the
// budget, or for a rolling intent twice the per-trade amount), read by
// loadDcaReserves. Checked against `Intent.Intents`: per asset, the same orders and
// the same reserved amount to the unit.
export function openBookSummary(limitOrders: readonly OpenLimitOrder[], dcaIntents: readonly ActiveDca[], dcaReserved: ReadonlyMap<string, string>, prices: Map<number, PriceInfo>): IceOpenOrders {
  const byAsset = new Map<number, { asset: AssetRef; reserved: bigint; orders: number }>()
  const add = (a: AssetRef, raw: string | null | undefined) => {
    const e = byAsset.get(a.assetId) ?? { asset: a, reserved: 0n, orders: 0 }
    e.reserved += bigOrNull(raw) ?? 0n
    e.orders += 1
    byAsset.set(a.assetId, e)
  }
  for (const o of limitOrders) add(o.assetIn, o.remainingIn)
  for (const d of dcaIntents) add(d.assetIn, d.intentId != null ? dcaReserved.get(d.intentId) : null)
  // Reserved notional is what the orders still hold today, so current prices.
  const rows = [...byAsset.values()].map(e => ({
    asset: e.asset, reserved: e.reserved.toString(), orders: e.orders,
    reservedUsd: usdValue(prices, e.asset.assetId, e.reserved.toString(), e.asset.decimals),
  }))
  rows.sort((x, y) => (y.reservedUsd ?? -1) - (x.reservedUsd ?? -1) || y.orders - x.orders)
  return { total: limitOrders.length + dcaIntents.length, limit: limitOrders.length, dca: dcaIntents.length, byAsset: rows }
}

async function loadDcaReserves(ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const res = await client.query({
    query: `-- ice:dca-reserves
      SELECT toString(o.intent_id) AS id,
        if(t.rb != '', t.rb, replaceAll(JSONExtractRaw(o.args_json, 'intent', 'data', 'value', 'remainingBudget'), '"', '')) AS reserved
      FROM (
        SELECT intent_id, args_json FROM price_data.intent_orders FINAL
        WHERE block_height >= {launch:UInt32} AND toString(intent_id) IN {ids:Array(String)}
      ) AS o
      LEFT JOIN (
        SELECT intent_id, argMax(remaining_budget, (block_height, event_index)) AS rb
        FROM price_data.intent_events FINAL
        WHERE block_height >= {launch:UInt32} AND event_name = 'Intent.DcaTradeExecuted' AND toString(intent_id) IN {ids:Array(String)}
        GROUP BY intent_id
      ) AS t ON t.intent_id = o.intent_id
      ${CAPS}`,
    query_params: { launch: ICE_LAUNCH_BLOCK, ids: [...ids] },
    format: 'JSONEachRow',
  })
  return new Map((await res.json<{ id: string; reserved: string }>()).map(r => [r.id, r.reserved]))
}

// ---------------------------------------------------------------------------
// The daily series. ICE settles at most one solution per block (submit_solution is
// an unsigned extrinsic the runtime admits once per block, and no indexed block
// holds two), so a block IS a solution. Everything is read per solution and valued at that
// solution's own block (applyEventTimeUsd: the latest price before it), then
// rolled up to days — the matched volume in particular nets per solution, as the
// pallet does, never per day.
// ---------------------------------------------------------------------------

// One fill as settled. `amountIn`/`amountOut` are null where the event states none
// and the order does not determine it (a final DCA trade's output; see below).
export interface SolutionFill { block: number; owner: string; assetIn: number; assetOut: number; amountIn: string | null; amountOut: string | null }
// What the pot's AMM routes took in, per solution and input asset.
export interface SolutionRoute { block: number; assetId: number; netIn: string }

// matched_X = intent_in − pool_in, per solution and asset, floored at zero — the
// pallet's own fee base (`settle_matched_fees`). intent_in sums what the solution's
// intents put in; pool_in what its routes took in. The routes are the swap legs as
// executed (each route netted per asset across its hops), where the pallet counts
// each trade's stated amount_in; the two differ only on an exact-out trade that
// spent under its maximum and on dust trades the pallet skips, both small against
// what they route.
export function matchedPerSolution(fills: readonly SolutionFill[], routes: readonly SolutionRoute[]): { block: number; assetId: number; matched: bigint }[] {
  const key = (block: number, assetId: number) => `${block}:${assetId}`
  const intentIn = new Map<string, { block: number; assetId: number; raw: bigint }>()
  for (const f of fills) {
    const raw = bigOrNull(f.amountIn)
    if (raw == null) continue
    const k = key(f.block, f.assetIn)
    const e = intentIn.get(k) ?? { block: f.block, assetId: f.assetIn, raw: 0n }
    e.raw += raw
    intentIn.set(k, e)
  }
  const poolIn = new Map<string, bigint>()
  for (const r of routes) {
    const k = key(r.block, r.assetId)
    poolIn.set(k, (poolIn.get(k) ?? 0n) + (bigOrNull(r.netIn) ?? 0n))
  }
  const out: { block: number; assetId: number; matched: bigint }[] = []
  for (const [k, e] of intentIn) {
    const matched = e.raw - (poolIn.get(k) ?? 0n)
    if (matched > 0n) out.push({ block: e.block, assetId: e.assetId, matched })
  }
  return out.sort((x, y) => x.block - y.block || x.assetId - y.assetId)
}

// What a final DCA trade spent. `Intent.DcaCompleted` states no amounts; the pallet
// spends the per-trade amount, capped by what the budget had left — the newest
// DcaTradeExecuted's remainingBudget, else the budget as placed, else (a rolling
// intent, which holds one trade's amount) the per-trade amount itself. The same
// rule as the settlement reader's fallback (iceSettlement.dcaFinalTradeIn), which
// matches the measured settlement leg wherever one exists. Its output is not
// recovered: the trade is valued on its input leg alone.
export function completionIn(order: { amountIn: string; budget: string }, priorRemaining: string | null | undefined): string | null {
  const prior = priorRemaining && DIGITS.test(priorRemaining) ? priorRemaining
    : order.budget && DIGITS.test(order.budget) ? order.budget
      : order.amountIn
  return dcaFinalTradeIn(order.amountIn, prior)
}

export interface DayRange { day: string; lo: number; hi: number; closed: boolean }
interface FillEventRow { block: number; ev: string; intent_id: string; amount_in: string; amount_out: string; owner: string; a_in: number; a_out: number; order_in: string; budget: string; placed: number }

// Each grid day's block range, and whether it has closed (the indexed head is
// DAY_FINALITY_SEC past its end); beside them the head's own time.
async function loadDayRanges(days: readonly string[]): Promise<{ ranges: DayRange[]; headSec: number }> {
  const res = await client.query({
    query: `-- ice:day-ranges
      SELECT toString(toDate(block_timestamp)) AS day, min(block_height) AS lo, max(block_height) AS hi
      FROM price_data.blocks
      WHERE block_height >= {launch:UInt32} AND block_timestamp >= {from:DateTime}
      GROUP BY day
      ${CAPS}`,
    query_params: { launch: ICE_LAUNCH_BLOCK, from: `${days[0]} 00:00:00` },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ day: string; lo: number; hi: number }>()
  const head = await client.query({
    query: `-- ice:head
      SELECT toUnixTimestamp(block_timestamp) AS t FROM price_data.blocks
      WHERE block_height >= {launch:UInt32} ORDER BY block_height DESC LIMIT 1 ${CAPS}`,
    query_params: { launch: ICE_LAUNCH_BLOCK },
    format: 'JSONEachRow',
  })
  const headSec = Number((await head.json<{ t: number }>())[0]?.t ?? 0)
  const byDay = new Map(rows.map(r => [r.day, r]))
  const ranges = days.flatMap(day => {
    const r = byDay.get(day)
    if (!r) return []
    const endSec = Date.parse(`${day}T00:00:00Z`) / 1000 + 86_400
    return [{ day, lo: Number(r.lo), hi: Number(r.hi), closed: headSec >= endSec + DAY_FINALITY_SEC }]
  })
  return { ranges, headSec }
}
// The chain's pace over the window: seconds of block time per block, from the
// window's first block (at or after its first midnight) to the head.
export function secondsPerBlock(ranges: readonly DayRange[], fromSec: number, headSec: number): number | null {
  if (!ranges.length) return null
  const blocks = ranges[ranges.length - 1].hi - ranges[0].lo, seconds = headSec - fromSec
  return blocks > 0 && seconds > 0 ? seconds / blocks : null
}

// Every fill settled in [lo, hi]. One read for the whole span: these tables are
// block-keyed but hold many small parts, so a read per day pays the part overhead
// thirty times over.
async function loadFills(lo: number, hi: number): Promise<SolutionFill[]> {
  const res = await client.query({
    query: `-- ice:fills
      SELECT ie.block_height AS block, ie.event_name AS ev, toString(ie.intent_id) AS intent_id,
        ie.amount_in AS amount_in, ie.amount_out AS amount_out,
        o.owner AS owner, o.asset_in AS a_in, o.asset_out AS a_out, o.amount_in AS order_in, o.budget AS budget, o.block_height AS placed
      FROM (
        SELECT intent_id, block_height, event_name, amount_in, amount_out
        FROM price_data.intent_events FINAL
        WHERE block_height >= {lo:UInt32} AND block_height <= {hi:UInt32}
          AND event_name IN (${FILL_EVENTS_SQL}, '${DCA_COMPLETED_EVENT}')
      ) AS ie
      INNER JOIN (
        SELECT intent_id, owner, asset_in, asset_out, amount_in, budget, block_height FROM price_data.intent_orders FINAL
        WHERE block_height >= {launch:UInt32} AND block_height <= {hi:UInt32}
      ) AS o ON o.intent_id = ie.intent_id
      ${CAPS}`,
    query_params: { launch: ICE_LAUNCH_BLOCK, lo, hi },
    format: 'JSONEachRow',
  })
  const rows = await res.json<FillEventRow>()
  const completions = rows.filter(r => r.ev === DCA_COMPLETED_EVENT)
  const prior = new Map<string, string>()
  if (completions.length) {
    // The budget each completing intent had left: its newest DCA trade, which (the
    // completion being its last event) is the newest it has. No trade of an intent
    // precedes its placement, which bounds the read.
    const res2 = await client.query({
      query: `-- ice:completion-budgets
        SELECT toString(intent_id) AS id, argMax(remaining_budget, (block_height, event_index)) AS rb
        FROM price_data.intent_events FINAL
        WHERE block_height >= {placed:UInt32} AND block_height <= {hi:UInt32}
          AND event_name = 'Intent.DcaTradeExecuted' AND toString(intent_id) IN {ids:Array(String)}
        GROUP BY intent_id
        ${CAPS}`,
      query_params: { placed: Math.max(ICE_LAUNCH_BLOCK, Math.min(...completions.map(c => Number(c.placed)))), hi, ids: [...new Set(completions.map(c => c.intent_id))] },
      format: 'JSONEachRow',
    })
    for (const r of await res2.json<{ id: string; rb: string }>()) prior.set(r.id, r.rb)
  }
  return rows.map(r => {
    const done = r.ev === DCA_COMPLETED_EVENT
    return {
      block: Number(r.block), owner: r.owner, assetIn: Number(r.a_in), assetOut: Number(r.a_out),
      amountIn: done ? completionIn({ amountIn: r.order_in, budget: r.budget }, prior.get(r.intent_id)) : bigOrNull(r.amount_in)?.toString() ?? null,
      amountOut: done ? null : bigOrNull(r.amount_out)?.toString() ?? null,
    }
  })
}

// What the solver routed through the AMMs: what each of the pot's ROUTES took in,
// once per route. A route is several Broadcast hops sharing one op_key, and every
// hop has an `in` leg — summing them counted a 4-hop route four times (the hub
// asset and the intermediates included). Netting the route's legs per asset
// cancels each intermediate (bought by one hop, sold by the next) and leaves the
// route's input on its positive side.
async function loadRoutes(lo: number, hi: number): Promise<SolutionRoute[]> {
  const res = await client.query({
    query: `-- ice:routes
      SELECT block, asset_id, toString(sum(net_in)) AS routed_in
      FROM (
        SELECT block_height AS block, op_key, asset_id,
          greatest(toInt256(sumIf(toUInt256OrZero(amount), leg_kind = 'in')) - toInt256(sumIf(toUInt256OrZero(amount), leg_kind = 'out')), toInt256(0)) AS net_in
        FROM price_data.pool_swap_legs_by_account FINAL
        WHERE swapper = {pot:String} AND block_height >= {lo:UInt32} AND block_height <= {hi:UInt32}
          AND leg_kind IN ('in', 'out')
        GROUP BY block_height, op_key, asset_id
      )
      WHERE net_in > 0
      GROUP BY block, asset_id
      ${CAPS}`,
    query_params: { pot: ICE_POT_ACCOUNT, lo, hi },
    format: 'JSONEachRow',
  })
  return (await res.json<{ block: number; asset_id: number; routed_in: string }>()).map(r => ({ block: Number(r.block), assetId: Number(r.asset_id), netIn: r.routed_in }))
}

// The blocks that carried a solution: each emits one ICE.SolutionExecuted; a
// distinct block is idempotent under replay.
async function loadSolutionBlocks(lo: number, hi: number): Promise<number[]> {
  const res = await client.query({
    query: `-- ice:solutions
      SELECT DISTINCT block_height AS block
      FROM price_data.intent_events
      WHERE block_height >= {lo:UInt32} AND block_height <= {hi:UInt32} AND event_name = 'ICE.SolutionExecuted'
      ${CAPS}`,
    query_params: { lo, hi },
    format: 'JSONEachRow',
  })
  return (await res.json<{ block: number }>()).map(r => Number(r.block))
}

export interface DayFacts {
  day: string; fills: number; solutions: number; usd: number; matchedUsd: number; routedUsd: number; unpriced: number
  owners: Map<string, { fills: number; usd: number }>
  pairs: Map<string, { assetIn: number; assetOut: number; fills: number; usd: number }>
}

function priceLeg(assetId: number, raw: string): { assetId: number; decimals: number; raw: string } {
  const a = asset(assetId)
  return { assetId: a.assetId, decimals: a.decimals, raw }
}

const emptyDay = (day: string): DayFacts => ({ day, fills: 0, solutions: 0, usd: 0, matchedUsd: 0, routedUsd: 0, unpriced: 0, owners: new Map(), pairs: new Map() })

// The days' fills, matched and routed volume: every row valued at its solution's
// own block, then filed under the day whose block range holds it.
export async function foldDays(ranges: readonly DayRange[], fills: readonly SolutionFill[], routes: readonly SolutionRoute[], solutionBlocks: readonly number[],
  value: typeof applyEventTimeUsd = applyEventTimeUsd): Promise<DayFacts[]> {
  const dayOf = (block: number): DayFacts | undefined => {
    const r = ranges.find(x => block >= x.lo && block <= x.hi)
    return r ? facts.get(r.day) : undefined
  }
  const facts = new Map(ranges.map(r => [r.day, emptyDay(r.day)]))
  const fillRows = fills.map(f => ({ f, valueUsd: null as number | null }))
  const matched = matchedPerSolution(fills, routes).map(m => ({ ...m, valueUsd: null as number | null }))
  const routed = routes.map(r => ({ r, valueUsd: null as number | null }))
  await Promise.all([
    value(fillRows, ({ f }) => {
      const legs = [
        ...(f.amountIn != null ? [priceLeg(f.assetIn, f.amountIn)] : []),
        ...(f.amountOut != null ? [priceLeg(f.assetOut, f.amountOut)] : []),
      ]
      return legs.length ? { block: f.block, legs } : null
    }),
    value(matched, m => ({ block: m.block, legs: [priceLeg(m.assetId, m.matched.toString())] })),
    value(routed, ({ r }) => ({ block: r.block, legs: [priceLeg(r.assetId, r.netIn)] })),
  ])
  for (const b of solutionBlocks) { const d = dayOf(b); if (d) d.solutions += 1 }
  for (const m of matched) { const d = dayOf(m.block); if (d) d.matchedUsd += m.valueUsd ?? 0 }
  for (const { r, valueUsd } of routed) { const d = dayOf(r.block); if (d) d.routedUsd += valueUsd ?? 0 }
  for (const { f, valueUsd } of fillRows) {
    const d = dayOf(f.block)
    if (!d) continue
    d.fills += 1
    if (valueUsd == null) d.unpriced += 1
    else d.usd += valueUsd
    const o = d.owners.get(f.owner) ?? { fills: 0, usd: 0 }
    o.fills += 1
    o.usd += valueUsd ?? 0
    d.owners.set(f.owner, o)
    const pk = `${f.assetIn}:${f.assetOut}`
    const p = d.pairs.get(pk) ?? { assetIn: f.assetIn, assetOut: f.assetOut, fills: 0, usd: 0 }
    p.fills += 1
    p.usd += valueUsd ?? 0
    d.pairs.set(pk, p)
  }
  return ranges.map(r => facts.get(r.day)!)
}

// The window's days: a closed day comes from the cache when it is there, every
// other day is read in one span and the closed ones among it are cached. The key
// carries the day's block range, so a block indexed into a closed day later makes
// it a new key.
const dayKey = (r: DayRange) => `explorer:ice-day:${r.day}:${r.lo}-${r.hi}`
async function loadDays(ranges: readonly DayRange[]): Promise<DayFacts[]> {
  const have = new Map<string, DayFacts>()
  for (const r of ranges) {
    const hit = r.closed ? peekCached<DayFacts>(dayKey(r)) : undefined
    if (hit) have.set(r.day, hit)
  }
  const todo = ranges.filter(r => !have.has(r.day))
  if (todo.length) {
    const lo = Math.min(...todo.map(r => r.lo)), hi = Math.max(...todo.map(r => r.hi))
    const [fills, routes, blocks] = await Promise.all([loadFills(lo, hi), loadRoutes(lo, hi), loadSolutionBlocks(lo, hi)])
    for (const f of await foldDays(todo, fills, routes, blocks)) {
      have.set(f.day, f)
      const r = todo.find(x => x.day === f.day)!
      if (r.closed) cacheInstall(dayKey(r), f, CLOSED_DAY_TTL_MS)
    }
  }
  return ranges.map(r => have.get(r.day)!)
}

// The window's days rolled up: the series, the top traders and pairs, and the
// owners and fills behind them.
export function foldWindow(days: readonly string[], facts: readonly DayFacts[]) {
  const byDay = new Map(facts.map(f => [f.day, f]))
  const owners = new Map<string, { fills: number; usd: number }>()
  const pairs = new Map<string, { assetIn: number; assetOut: number; fills: number; usd: number }>()
  let unpriced = 0
  for (const f of facts) {
    unpriced += f.unpriced
    for (const [k, v] of f.owners) { const e = owners.get(k) ?? { fills: 0, usd: 0 }; e.fills += v.fills; e.usd += v.usd; owners.set(k, e) }
    for (const [k, v] of f.pairs) { const e = pairs.get(k) ?? { ...v, fills: 0, usd: 0 }; e.fills += v.fills; e.usd += v.usd; pairs.set(k, e) }
  }
  const series = days.map(day => {
    const f = byDay.get(day) ?? emptyDay(day)
    return { day, fills: f.fills, solutions: f.solutions, usd: snapUsd(f.usd), matchedUsd: snapUsd(f.matchedUsd), routedUsd: snapUsd(f.routedUsd) }
  })
  const topTraders = [...owners].map(([owner, e]) => ({ owner, fills: e.fills, usd: snapUsd(e.usd) }))
    .sort((x, y) => y.usd - x.usd || y.fills - x.fills || (x.owner < y.owner ? -1 : 1))
    .slice(0, TOP_TRADERS)
  const topPairs = [...pairs.values()].map(p => ({ ...p, usd: snapUsd(p.usd) }))
    .sort((x, y) => y.usd - x.usd || y.fills - x.fills)
    .slice(0, TOP_PAIRS)
  return { series, traders: owners.size, unpriced, topTraders, topPairs }
}

// Closed swap orders (anything not a DCA intent, as the feed classifies them):
// every order whose terminal event falls in the window, read over its WHOLE life —
// an order may rest for weeks (it needs no deadline), so its first fill can sit
// before the window it closed in. Each flag is an existence test and the first fill
// a minimum, so replayed rows change nothing; a fill-then-cancel order counts as
// filled, never twice.
interface QualityRow { closed: string; filled: string; cancelled: string; expired: string; filled_partially: string; median_blocks: number | string | null }
async function loadQuality(from: string): Promise<QualityRow | undefined> {
  const res = await client.query({
    query: `-- ice:quality
      WITH per AS (
        SELECT intent_id,
          countIf(event_name = 'Intent.IntentResolved') > 0 AS filled,
          countIf(event_name = 'Intent.IntentCanceled') > 0 AS cancelled,
          countIf(event_name = 'Intent.IntentExpired') > 0 AS expired,
          countIf(event_name = 'Intent.IntentResovedPartially') > 0 AS partial,
          minIf(block_height, event_name IN ('Intent.IntentResolved', 'Intent.IntentResovedPartially')) AS first_fill_block,
          minIf(block_timestamp, event_name IN ('Intent.IntentResolved', 'Intent.IntentCanceled', 'Intent.IntentExpired')) AS closed_at
        FROM price_data.intent_events
        WHERE block_height >= {launch:UInt32}
          AND event_name IN ('Intent.IntentResolved', 'Intent.IntentResovedPartially', 'Intent.IntentCanceled', 'Intent.IntentExpired')
        GROUP BY intent_id
        HAVING (filled OR cancelled OR expired) AND closed_at >= {from:DateTime}
      )
      SELECT count() AS closed, countIf(p.filled) AS filled,
        countIf(p.cancelled AND NOT p.filled) AS cancelled,
        countIf(p.expired AND NOT p.filled AND NOT p.cancelled) AS expired,
        countIf(p.filled AND p.partial) AS filled_partially,
        quantileExactIf(0.5)(toInt64(p.first_fill_block) - toInt64(o.block_height), p.filled) AS median_blocks
      FROM per AS p
      INNER JOIN (
        SELECT intent_id, block_height FROM price_data.intent_orders FINAL
        WHERE block_height >= {launch:UInt32} AND kind != 'dca'
      ) AS o ON o.intent_id = p.intent_id
      ${CAPS}`,
    query_params: { launch: ICE_LAUNCH_BLOCK, from },
    format: 'JSONEachRow',
  })
  return (await res.json<QualityRow>())[0]
}

// Every fill of a swap order in the window with the order's limit and placement
// beside it, the newest first, capped (see BP_SAMPLE_LIMIT). The ratio itself is
// computed in TypeScript by integer arithmetic (priceVsLimitBp).
export interface BpSampleRow { fill_in: string; fill_out: string; limit_in: string; limit_out: string; blocks_after: number | string }
async function loadBpSample(from: string): Promise<BpSampleRow[]> {
  const res = await client.query({
    query: `-- ice:bp-sample
      SELECT ie.amount_in AS fill_in, ie.amount_out AS fill_out, o.amount_in AS limit_in, o.amount_out AS limit_out,
        toInt64(ie.block_height) - toInt64(o.block_height) AS blocks_after
      FROM (
        SELECT intent_id, block_height, event_index, amount_in, amount_out
        FROM price_data.intent_events FINAL
        WHERE block_height >= {launch:UInt32} AND block_timestamp >= {from:DateTime}
          AND event_name IN ('Intent.IntentResolved', 'Intent.IntentResovedPartially')
      ) AS ie
      INNER JOIN (
        SELECT intent_id, block_height, amount_in, amount_out FROM price_data.intent_orders FINAL
        WHERE block_height >= {launch:UInt32} AND kind != 'dca'
      ) AS o ON o.intent_id = ie.intent_id
      ORDER BY ie.block_height DESC, ie.event_index DESC
      LIMIT {sample:UInt32}
      ${CAPS}`,
    query_params: { launch: ICE_LAUNCH_BLOCK, from, sample: BP_SAMPLE_LIMIT },
    format: 'JSONEachRow',
  })
  return res.json<BpSampleRow>()
}

// The matched-volume fee as the revenue model books it: the published hours from
// revenue_events (written by the derivations service, valued at event time there)
// up to this stream's own cold mark, then its raw tail past the mark through the
// revenue model's own row builder — the split the Protocol Revenue page reads.
// revenue_events months are published whole by REPLACE PARTITION, so it is read
// without FINAL, as that page reads it.
async function loadFeeMark(): Promise<string | null> {
  const res = await client.query({
    query: `-- ice:fee-mark
      SELECT toString(max(block_timestamp)) AS mark, count() AS n
      FROM price_data.revenue_events
      WHERE stream = {stream:String} AND block_height >= {launch:UInt32}
      ${CAPS}`,
    query_params: { stream: ICE_FEE_STREAM, launch: ICE_LAUNCH_BLOCK },
    format: 'JSONEachRow',
  })
  const r = (await res.json<{ mark: string; n: string }>())[0]
  return r && Number(r.n) > 0 ? r.mark : null
}
export async function loadFeePerDay(from: string, nowSec: number = Math.floor(Date.now() / 1000)): Promise<Map<string, number>> {
  const mark = await loadFeeMark() ?? '1970-01-01 00:00:00'
  // The raw arm reaches back to the mark (an hour of slack), never further than the
  // revenue model's own tail bound; a mark older than that is a quiet stream whose
  // published hours already hold everything before it.
  const markSec = Math.floor(Date.parse(`${mark.replace(' ', 'T')}Z`) / 1000)
  const hours = Math.max(1, Math.min(MAX_TAIL_HOURS, Math.ceil((nowSec - markSec) / 3600) + 1))
  const [coldRes, tailRes] = await Promise.all([
    client.query({
      query: `-- ice:fee-cold
        SELECT toString(toDate(block_timestamp)) AS day, toFloat64(sum(amount_usd)) AS usd
        FROM price_data.revenue_events
        WHERE stream = {stream:String} AND block_height >= {launch:UInt32}
          AND block_timestamp >= {from:DateTime} AND block_timestamp <= toDateTime({mark:String})
        GROUP BY day
        ${CAPS}`,
      query_params: { stream: ICE_FEE_STREAM, launch: ICE_LAUNCH_BLOCK, from, mark },
      format: 'JSONEachRow',
    }),
    client.query({
      query: `-- ice:fee-tail
        SELECT toString(toDate(block_timestamp)) AS day, toFloat64(sum(amount_usd)) AS usd
        FROM (${buildRevenueEventRowsSql(ICE_FEE_STREAM)})
        WHERE block_height >= {launch:UInt32} AND block_timestamp > toDateTime({mark:String}) AND block_timestamp >= {from:DateTime}
        GROUP BY day
        ${CAPS}`,
      query_params: { launch: ICE_LAUNCH_BLOCK, from, mark, anchor: chTimestamp(nowSec), hours },
      format: 'JSONEachRow',
    }),
  ])
  const out = new Map<string, number>()
  for (const r of [...await coldRes.json<{ day: string; usd: number }>(), ...await tailRes.json<{ day: string; usd: number }>()]) {
    out.set(r.day, (out.get(r.day) ?? 0) + Number(r.usd))
  }
  return out
}

// What the fee receiver holds right now — the same event-folded balance table
// the account page reads, one account, so a primary-key point read.
async function loadFeeAccountHoldings(prices: Map<number, PriceInfo>): Promise<IceDashboard['feeRevenue']['potHoldings']> {
  const res = await client.query({
    query: `-- ice:fee-holdings
      SELECT asset_id, toString(toUInt256OrZero(argMaxMerge(total_state))) AS bal
      FROM price_data.account_asset_latest_balances
      WHERE account_id = {account:String}
      GROUP BY asset_id
      ${CAPS}`,
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
// grouped by that raw text and decoded with the shared dcaMigrationReason. Until
// governance switches it on (DCA.set_migration_enabled), pallet schedules keep
// running beside the DCA intents.
export interface MigrationRow { day: string; event_name: string; reason_raw: string; n: string }
async function loadMigration(): Promise<{ rows: MigrationRow[]; remaining: number }> {
  const [rowsRes, remainingRes] = await Promise.all([
    client.query({
      query: `-- ice:migration
        SELECT toString(toDate(block_timestamp)) AS day, event_name, error AS reason_raw, count() AS n
        FROM price_data.dca_events FINAL
        WHERE event_name IN ('DCA.Migrated', 'DCA.MigrationCancelled') AND block_height >= {launch:UInt32}
        GROUP BY day, event_name, reason_raw
        ORDER BY day
        ${CAPS}`,
      query_params: { launch: ICE_LAUNCH_BLOCK },
      format: 'JSONEachRow',
    }),
    // Pallet schedules still running: every schedule without a terminal event —
    // completed, terminated, or taken through the migration either way. (Storage
    // can keep a schedule that emitted DCA.Completed; it is not a running order.)
    // dca_schedules holds one row per schedule ever (tens of thousands), so the
    // set difference is the bound; a distinct count needs no FINAL.
    client.query({
      query: `-- ice:pallet-dca
        SELECT uniqExact(id) AS n
        FROM price_data.dca_schedules
        WHERE id NOT IN (
          SELECT id FROM price_data.dca_events
          WHERE event_name IN ('DCA.Completed', 'DCA.Terminated', 'DCA.Migrated', 'DCA.MigrationCancelled'))
        ${CAPS}`,
      query_params: {},
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

export function foldQuality(row: QualityRow | undefined, secondsPerBlock: number | null, sample: readonly BpSampleRow[]): IceDashboard['quality'] {
  const closed = Number(row?.closed ?? 0), filled = Number(row?.filled ?? 0)
  const cancelled = Number(row?.cancelled ?? 0), expired = Number(row?.expired ?? 0), filledPartially = Number(row?.filled_partially ?? 0)
  const medianBlocks = row?.median_blocks == null ? NaN : Number(row.median_blocks)
  const blocks = filled > 0 && Number.isFinite(medianBlocks) && medianBlocks >= 0 ? medianBlocks : null
  const all: number[] = [], immediate: number[] = [], resting: number[] = []
  for (const r of sample) {
    const bp = priceVsLimitBp({ amountIn: r.limit_in, amountOut: r.limit_out }, { amountIn: r.fill_in, amountOut: r.fill_out })
    if (bp == null) continue
    all.push(bp)
    ;(Number(r.blocks_after) <= IMMEDIATE_FILL_BLOCKS ? immediate : resting).push(bp)
  }
  return {
    medianBlocksToFill: blocks,
    medianTimeToFillSec: blocks != null && secondsPerBlock != null ? Math.round(blocks * secondsPerBlock * 10) / 10 : null,
    partialShare: filled > 0 ? filledPartially / filled : null,
    cancelRate: closed > 0 ? cancelled / closed : null,
    expiryRate: closed > 0 ? expired / closed : null,
    priceVsLimitBp: bpQuantiles(all),
    priceVsLimitBpImmediate: { ...bpQuantiles(immediate), fills: immediate.length },
    priceVsLimitBpResting: { ...bpQuantiles(resting), fills: resting.length },
  }
}

// dashboard payload

export async function getIceDashboard(): Promise<IceDashboard> {
  return cachedSwr('explorer:ice-dashboard:model', 300_000, 48 * 3_600_000, async () => {
    const days = dayGrid(WINDOW_DAYS)
    const from = `${days[0]} 00:00:00`
    const [prices, status, allTime, open, { ranges, headSec }, quality, bpSample, feePerDay, migration] = await Promise.all([
      ensurePrices(), loadStatus(), loadAllTime(), getOpenIntents(), loadDayRanges(days),
      loadQuality(from), loadBpSample(from), loadFeePerDay(from), loadMigration(),
    ])
    const win = foldWindow(days, await loadDays(ranges))
    const potHoldings = await loadFeeAccountHoldings(prices)
    return {
      status: { ...status, routing: status.routing.map(routingEntry) },
      allTime,
      openOrders: open.summary,
      fillsPerDay: win.series,
      traders: win.traders,
      unpricedFills: win.unpriced,
      topTraders: win.topTraders.map(t => ({ account: accountRef(t.owner), fills: t.fills, usd: t.usd })),
      quality: foldQuality(quality, secondsPerBlock(ranges, Date.parse(`${days[0]}T00:00:00Z`) / 1000, headSec), bpSample),
      feeRevenue: { perDay: days.map(day => ({ day, usd: snapUsd(feePerDay.get(day) ?? 0) })), potHoldings },
      migration: foldMigration(migration.rows, migration.remaining, days),
      topPairs: win.topPairs.map(p => ({ assetIn: asset(p.assetIn), assetOut: asset(p.assetOut), fills: p.fills, usd: p.usd })),
      generatedAt: new Date().toISOString(),
    }
  })
}

// The open book, live: every resting limit order and running DCA intent, in the
// explorer's order shapes so the asset and account pages' tables render them, and
// the per-asset reserves folded from those same lists. The lists are sorted by value
// over the whole set and then cut to OPEN_LIST_LIMIT each; `*Total` states how many
// there are. Cached 15s, the asset page's order-book freshness.
const OPEN_LIST_LIMIT = 200
export interface IceOpenIntents {
  summary: IceOpenOrders
  limitOrders: OpenLimitOrder[]; limitOrdersTotal: number
  dcaIntents: ActiveDca[]; dcaIntentsTotal: number
  generatedAt: string
}
export async function getOpenIntents(): Promise<IceOpenIntents> {
  return cached('explorer:ice-open-intents', 15_000, async () => {
    const [prices, lists] = await Promise.all([ensurePrices(), getOpenIntentLists()])
    const reserves = await loadDcaReserves(lists.dcaIntents.flatMap(d => d.intentId != null ? [d.intentId] : []))
    return {
      summary: openBookSummary(lists.limitOrders, lists.dcaIntents, reserves, prices),
      limitOrders: lists.limitOrders.slice(0, OPEN_LIST_LIMIT), limitOrdersTotal: lists.limitOrders.length,
      dcaIntents: lists.dcaIntents.slice(0, OPEN_LIST_LIMIT), dcaIntentsTotal: lists.dcaIntents.length,
      generatedAt: new Date().toISOString(),
    }
  })
}
