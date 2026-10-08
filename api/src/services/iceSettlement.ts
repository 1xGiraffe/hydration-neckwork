import type { ClickHouseClient } from '../db/client.ts'

// ---------------------------------------------------------------------------
// The DCA intent's final trade. For the trade that exhausts a DCA's budget
// pallet_intent emits `Intent.DcaCompleted { id }` INSTEAD of DcaTradeExecuted, so
// that one trade states no amounts. Every surface that reports what an intent
// traded — the explorer's feed, order page and order history, the ICE stats, the
// public API and the Data API — reads them HERE, from the solution's settlement:
//
// - OUT: pallet_ice pays every fill out of its pot as one Currencies.Transferred
//   pot→owner in the order's asset_out (what the owner received, net). Present on
//   every completion ever indexed (320 of 320 by October 2026).
// - IN: until ~block 15,140,000 the owner paid in with a Currencies.Transferred
//   owner→pot; since then the pallet repatriates the owner's RESERVED budget to the
//   pot instead (`Tokens.ReserveRepatriated` / `Balances.ReserveRepatriated` for
//   HDX, read from raw_events), and an Erc20-backed asset_in (HOLLAR, the aTokens)
//   leaves no owner→pot leg at all (unreserve + withdraw). Of the 320 completions,
//   63 settled by transfer, 118 by repatriation and 139 by neither.
//
// The measured legs are summed per (solution, owner, asset, direction) and the
// sibling fills that state their own amounts are subtracted; one completion per
// (owner, asset) in a solution is then exact. Where the IN side cannot be measured
// (no leg, or two completions of one owner in one asset that the legs cannot tell
// apart) it falls back to what the pallet spends on the final trade: the order's
// per-trade amount, capped by the budget left before it — the newest
// DcaTradeExecuted's remainingBudget, else the order's budget. That rule matches
// the measured leg on every one of the 170 completions where one exists alone (a
// final trade spends min(amountIn, left) and the pallet unreserves any dust left
// over, so "the previous remainingBudget" alone would overstate 125 of them).
// The OUT side has no such rule and stays null when it cannot be measured.
//
// A leaf: no imports but the client type, so the public API and the Data API can
// share it (their isolation tests allow-list it). Integer arithmetic throughout.
// ---------------------------------------------------------------------------

/** The ICE solver's holding pot: `modl` + `ice_ice#`. */
export const ICE_POT_ACCOUNT = '0x6d6f646c6963655f696365230000000000000000000000000000000000000000'
export const DCA_COMPLETED_EVENT = 'Intent.DcaCompleted'
const DCA_TRADE_EVENT = 'Intent.DcaTradeExecuted'
// The events that settled amounts — the sibling fills a solution's legs also carry.
const SETTLED_FILL_EVENTS = ['Intent.IntentResolved', 'Intent.IntentResovedPartially', DCA_TRADE_EVENT, DCA_COMPLETED_EVENT]
// The reserved-budget repatriations that pay an owner's input into the pot.
const REPATRIATION_EVENTS = ['Tokens.ReserveRepatriated', 'Balances.ReserveRepatriated']
// Block lists are bound as Array(UInt32): ≤ 11 bytes a block, so 2,000 stay far
// below the 64 KiB per-parameter budget (db/queryParams.ts) in the default runner.
const BLOCK_CHUNK = 2_000

/** The order terms the settlement reader needs. `IntentOrder` satisfies it. */
export interface IceSettlementOrder { owner: string; assetIn: number; assetOut: number; amountIn: string; budget: string | null; blockHeight: number }
export interface IceSettlementLeg { blockHeight: number; extrinsicIndex: number; from: string; to: string; assetId: number; amount: string }
export interface IceSettlementFill { blockHeight: number; extrinsicIndex: number | null; eventIndex: number; eventName: string; intentId: string; amountIn: string | null; amountOut: string | null }
export interface IceSettlementAmounts { amountIn: string | null; amountOut: string | null }
/** A DcaCompleted to resolve, keyed in the result by `${blockHeight}:${eventIndex}`. */
export interface IceCompletionRef { blockHeight: number; eventIndex: number; extrinsicIndex: number | null; eventName: string; intentId: string }

const big = (v: string | null | undefined): bigint | null => v != null && /^\d+$/.test(v) ? BigInt(v) : null

/**
 * What a completion spent when no leg measures it: min(order amountIn, budget left
 * before the trade). `priorBudget` is that budget (newest DcaTradeExecuted's
 * remainingBudget, else the order's budget); null when neither is known.
 */
export function dcaFinalTradeIn(orderAmountIn: string | null | undefined, priorBudget: string | null | undefined): string | null {
  const per = big(orderAmountIn), left = big(priorBudget)
  if (per == null || left == null) return null
  const spent = per < left ? per : left
  return spent > 0n ? spent.toString() : null
}

/**
 * Pure: each completion among `fills` → its amounts, keyed `${blockHeight}:${eventIndex}`.
 * `fills` are every settled fill of the solutions involved (siblings included),
 * `legs` their pot transfers and repatriations, `priorBudgets` the budget each
 * completing intent had left before its final trade (see dcaFinalTradeIn).
 */
export function iceSettlementAmounts(
  fills: readonly IceSettlementFill[],
  orders: ReadonlyMap<string, IceSettlementOrder>,
  legs: readonly IceSettlementLeg[],
  priorBudgets: ReadonlyMap<string, string | null> = new Map(),
): Map<string, IceSettlementAmounts> {
  const out = new Map<string, IceSettlementAmounts>()
  const add = (map: Map<string, bigint>, key: string, v: bigint) => map.set(key, (map.get(key) ?? 0n) + v)
  const legKey = (b: number, x: number, owner: string, asset: number, dir: 'in' | 'out') => `${b}:${x}:${owner.toLowerCase()}:${asset}:${dir}`
  const moved = new Map<string, bigint>()
  for (const leg of legs) {
    const amount = big(leg.amount)
    if (amount == null) continue
    if (leg.to.toLowerCase() === ICE_POT_ACCOUNT) add(moved, legKey(leg.blockHeight, leg.extrinsicIndex, leg.from, leg.assetId, 'in'), amount)
    else if (leg.from.toLowerCase() === ICE_POT_ACCOUNT) add(moved, legKey(leg.blockHeight, leg.extrinsicIndex, leg.to, leg.assetId, 'out'), amount)
  }
  const stated = new Map<string, bigint>()
  const claimants = new Map<string, number>()
  const completions: { fill: IceSettlementFill; order: IceSettlementOrder; inKey: string; outKey: string }[] = []
  for (const fill of fills) {
    if (fill.extrinsicIndex == null) continue
    const order = orders.get(fill.intentId)
    if (!order) {
      if (fill.eventName === DCA_COMPLETED_EVENT) out.set(`${fill.blockHeight}:${fill.eventIndex}`, { amountIn: null, amountOut: null })
      continue
    }
    const inKey = legKey(fill.blockHeight, fill.extrinsicIndex, order.owner, order.assetIn, 'in')
    const outKey = legKey(fill.blockHeight, fill.extrinsicIndex, order.owner, order.assetOut, 'out')
    if (fill.eventName === DCA_COMPLETED_EVENT) {
      completions.push({ fill, order, inKey, outKey })
      claimants.set(inKey, (claimants.get(inKey) ?? 0) + 1)
      claimants.set(outKey, (claimants.get(outKey) ?? 0) + 1)
      continue
    }
    const ai = big(fill.amountIn), ao = big(fill.amountOut)
    if (ai != null) add(stated, inKey, ai)
    if (ao != null) add(stated, outKey, ao)
  }
  const rest = (key: string): bigint | null => {
    if (claimants.get(key) !== 1) return null
    const total = moved.get(key)
    if (total == null) return null
    const left = total - (stated.get(key) ?? 0n)
    return left >= 0n ? left : null
  }
  for (const c of completions) {
    // A final trade always spends something: a measured zero is a leg that belongs
    // to the siblings, not this trade's input, and falls back like a missing one.
    const measuredIn = rest(c.inKey)
    const amountIn = measuredIn != null && measuredIn > 0n
      ? measuredIn.toString()
      : dcaFinalTradeIn(c.order.amountIn, priorBudgets.has(c.fill.intentId) ? priorBudgets.get(c.fill.intentId) : c.order.budget)
    out.set(`${c.fill.blockHeight}:${c.fill.eventIndex}`, { amountIn, amountOut: rest(c.outKey)?.toString() ?? null })
  }
  return out
}

/**
 * Parse a raw `*.ReserveRepatriated` event into a pot leg (owner → pot), or null.
 * `Balances.*` is HDX (asset 0) and names no currency.
 */
export function repatriationLeg(row: { block_height: number; extrinsic_index: number | null; event_name: string; args_json: string }): IceSettlementLeg | null {
  if (row.extrinsic_index == null) return null
  let args: Record<string, unknown>
  try { args = JSON.parse(row.args_json) as Record<string, unknown> } catch { return null }
  const from = typeof args.from === 'string' ? args.from : null
  const to = typeof args.to === 'string' ? args.to : null
  const amount = typeof args.amount === 'string' ? args.amount : typeof args.amount === 'number' ? String(args.amount) : null
  const assetId = row.event_name === 'Balances.ReserveRepatriated' ? 0 : Number(args.currencyId)
  if (!from || !to || !amount || !Number.isInteger(assetId) || to.toLowerCase() !== ICE_POT_ACCOUNT) return null
  return { blockHeight: Number(row.block_height), extrinsicIndex: Number(row.extrinsic_index), from, to, assetId, amount }
}

/** Runs `run` over chunks of `items` and returns the results in chunk order. */
export type IceChunkRunner = <T, R>(items: readonly T[], run: (chunk: T[]) => Promise<R>) => Promise<R[]>
// The default runner: fixed-size chunks, all at once. A completion set is a few
// hundred blocks across ICE's whole history, so this is one chunk in practice;
// the explorer passes its byte-bounded, concurrency-capped mapParamChunks.
const allChunks: IceChunkRunner = (items, run) => {
  const parts: (typeof items[number])[][] = []
  for (let at = 0; at < items.length; at += BLOCK_CHUNK) parts.push(items.slice(at, at + BLOCK_CHUNK))
  return Promise.all(parts.map(run))
}

type OrderSqlRow = { intent_id: string; owner: string; asset_in: number; asset_out: number; amount_in: string; budget: string; block_height: number }
async function loadSettlementOrders(client: ClickHouseClient, ids: readonly string[]): Promise<Map<string, IceSettlementOrder>> {
  const out = new Map<string, IceSettlementOrder>()
  const valid = [...new Set(ids)].filter(id => /^\d+$/.test(id))
  if (!valid.length) return out
  const res = await client.query({
    // The id predicate sits on the inner relation: `toString(intent_id) AS intent_id`
    // beside it would capture the comparison (ClickHouse resolves the alias).
    query: `-- ice:settlement-orders
        SELECT toString(intent_id) AS intent_id, owner, asset_in, asset_out, amount_in, budget, block_height
        FROM (
          SELECT intent_id, owner, asset_in, asset_out, amount_in, budget, block_height
          FROM price_data.intent_orders FINAL
          WHERE intent_id IN (SELECT toUInt128(arrayJoin({ids:Array(String)})))
        )`,
    query_params: { ids: valid }, format: 'JSONEachRow',
  })
  for (const r of await res.json<OrderSqlRow>()) {
    out.set(String(r.intent_id), { owner: r.owner, assetIn: Number(r.asset_in), assetOut: Number(r.asset_out), amountIn: r.amount_in, budget: r.budget || null, blockHeight: Number(r.block_height) })
  }
  return out
}

/**
 * Reads what `iceSettlementAmounts` needs for every DcaCompleted among `events` —
 * the solutions' pot legs (transfer projection + repatriations), their sibling
 * fills and each completing intent's budget before its final trade — all
 * primary-key reads on the handful of blocks (and orders) involved. Empty when no
 * completion is present. `orders` is consulted first and NOT mutated; ids it lacks
 * are read from intent_orders (or `loadOrders`, when the caller has a memo).
 */
export async function readIceSettlements(
  client: ClickHouseClient,
  events: readonly IceCompletionRef[],
  orders: ReadonlyMap<string, IceSettlementOrder> = new Map(),
  loadOrders: (ids: string[]) => Promise<ReadonlyMap<string, IceSettlementOrder>> = ids => loadSettlementOrders(client, ids),
  mapChunks: IceChunkRunner = allChunks,
): Promise<Map<string, IceSettlementAmounts>> {
  const done = events.filter(e => e.eventName === DCA_COMPLETED_EVENT && e.extrinsicIndex != null)
  const blocks = [...new Set(done.map(e => Number(e.blockHeight)))].sort((a, b) => a - b)
  if (!blocks.length) return new Map()
  type LegRow = { block_height: number; event_index: number; extrinsic_index: number; from_account: string; to_account: string; asset_id: number; amount: string }
  type RepatRow = { block_height: number; event_index: number; extrinsic_index: number | null; event_name: string; args_json: string }
  type FillRow = { intent_id: string; block_height: number; event_index: number; extrinsic_index: number; event_name: string; amount_in: string; amount_out: string }
  const chunked = await mapChunks(blocks, async part => {
    const [legRes, repatRes, fillRes] = await Promise.all([
      client.query({
        query: `-- ice:settlement-legs
            SELECT block_height, event_index, extrinsic_index, from_account, to_account, asset_id, amount
            FROM price_data.transfer_activity_by_time
            WHERE block_height IN ({blocks:Array(UInt32)}) AND event_name = 'Currencies.Transferred' AND extrinsic_index IS NOT NULL
              AND (from_account = {pot:String} OR to_account = {pot:String})`,
        query_params: { blocks: part, pot: ICE_POT_ACCOUNT }, format: 'JSONEachRow',
      }),
      client.query({
        query: `-- ice:settlement-repatriations
            SELECT block_height, event_index, extrinsic_index, event_name, args_json
            FROM price_data.raw_events
            WHERE block_height IN ({blocks:Array(UInt32)}) AND event_name IN {names:Array(String)} AND extrinsic_index IS NOT NULL`,
        query_params: { blocks: part, names: REPATRIATION_EVENTS }, format: 'JSONEachRow',
      }),
      client.query({
        query: `-- ice:settlement-fills
            SELECT toString(intent_id) AS intent_id, block_height, event_index, extrinsic_index, event_name, amount_in, amount_out
            FROM price_data.intent_events FINAL
            WHERE block_height IN ({blocks:Array(UInt32)}) AND extrinsic_index IS NOT NULL AND event_name IN {names:Array(String)}`,
        query_params: { blocks: part, names: SETTLED_FILL_EVENTS }, format: 'JSONEachRow',
      }),
    ])
    return Promise.all([legRes.json<LegRow>(), repatRes.json<RepatRow>(), fillRes.json<FillRow>()])
  })
  const legRows = chunked.flatMap(([l]) => l)
  const repatRows = chunked.flatMap(([, r]) => r)
  const fillRows = chunked.flatMap(([, , f]) => f)
  // The projection and raw_events replace without FINAL here, so a replayed range
  // can hold an event twice until it merges: one leg per (block, event).
  const seen = new Set<string>()
  const legs: IceSettlementLeg[] = []
  const once = (b: number, i: number): boolean => {
    const key = `${b}:${i}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
  for (const l of legRows) {
    if (!once(Number(l.block_height), Number(l.event_index))) continue
    legs.push({ blockHeight: Number(l.block_height), extrinsicIndex: Number(l.extrinsic_index), from: l.from_account, to: l.to_account, assetId: Number(l.asset_id), amount: l.amount })
  }
  for (const r of repatRows) {
    const leg = repatriationLeg(r)
    if (leg && once(leg.blockHeight, Number(r.event_index))) legs.push(leg)
  }
  const fills: IceSettlementFill[] = fillRows.map(f => ({
    blockHeight: Number(f.block_height), extrinsicIndex: Number(f.extrinsic_index), eventIndex: Number(f.event_index),
    eventName: f.event_name, intentId: String(f.intent_id), amountIn: f.amount_in || null, amountOut: f.amount_out || null,
  }))
  const allOrders = new Map(orders)
  const missing = [...new Set([...fills.map(f => f.intentId), ...done.map(e => e.intentId)])].filter(id => !allOrders.has(id))
  if (missing.length) for (const [id, o] of await loadOrders(missing)) allOrders.set(id, o)
  const priorBudgets = await readPriorBudgets(client, done, allOrders)
  return iceSettlementAmounts(fills, allOrders, legs, priorBudgets)
}

// Each completing intent's budget before its final trade: the newest
// DcaTradeExecuted's remainingBudget, else (no earlier trade) the order's budget.
// intent_events is keyed (block_height, event_index), so the read is bounded below
// by the oldest placement involved and above by the newest completion.
async function readPriorBudgets(client: ClickHouseClient, done: readonly IceCompletionRef[], orders: ReadonlyMap<string, IceSettlementOrder>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  const ids = [...new Set(done.map(e => e.intentId))].filter(id => orders.has(id))
  if (!ids.length) return out
  for (const id of ids) out.set(id, orders.get(id)!.budget)
  // Folded, not spread: a spread of a long list overflows the call stack.
  const from = ids.reduce((m, id) => Math.min(m, orders.get(id)!.blockHeight), Number.POSITIVE_INFINITY)
  const to = done.reduce((m, e) => Math.max(m, Number(e.blockHeight)), 0)
  const res = await client.query({
    query: `-- ice:settlement-prior-budget
        SELECT toString(iid) AS intent_id, rb
        FROM (
          SELECT intent_id AS iid, argMax(remaining_budget, toUInt64(block_height) * 4294967296 + event_index) AS rb
          FROM price_data.intent_events FINAL
          WHERE block_height >= {from:UInt32} AND block_height <= {to:UInt32} AND event_name = '${DCA_TRADE_EVENT}'
            AND intent_id IN (SELECT toUInt128(arrayJoin({ids:Array(String)})))
          GROUP BY intent_id
        )`,
    query_params: { from, to, ids }, format: 'JSONEachRow',
  })
  for (const r of await res.json<{ intent_id: string; rb: string }>()) if (/^\d+$/.test(r.rb)) out.set(String(r.intent_id), r.rb)
  return out
}
