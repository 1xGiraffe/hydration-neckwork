import type { ClickHouseClient } from '../../db/client.ts'
import { iso } from '../schemas/common.ts'
import { accountRefFor, type AccountRef } from './address.ts'
import { DEDUP_SLACK, dedupPage, orderSql, positionCursorSql, windowSql, type Order, type PositionCursor, type WindowFilters } from './feed.ts'

// ICE intents for /v1/intents/*. Runtime 443 (block 14,362,830) added the Intent
// pallet: a SWAP intent is the product's limit order, a DCA intent is the new
// DCA. Both rest on chain with the owner's `assetIn` under a named reserve until
// a solver's ICE.submit_solution fills them.
//
// Only Intent.IntentSubmitted names the owner and the pair — every later event
// carries the u128 id alone — so the order lives in `intent_orders` (keyed by
// intent id, with an owner-first twin in `intent_orders_by_account`) and its
// life in `intent_events` (keyed by block/event). A per-id read of the events
// table therefore takes the placement block as its lower bound: no event of an
// order can precede it, and that is what prunes the read.
//
// Ids are u128 and travel as DECIMAL STRINGS everywhere; `seq` (the low 64 bits,
// the short "#n" handle the explorer shows) is a display value only.

export type IntentKind = 'swap' | 'dca'
export type IntentStatus = 'open' | 'filled' | 'partially_filled' | 'cancelled' | 'expired' | 'completed'

export interface IntentOrderItem {
  intentId: string
  seq: number
  owner: AccountRef
  kind: IntentKind
  assetIn: string
  assetOut: string
  /** For a swap intent the whole order; for a DCA intent one period's trade. */
  amountIn: string
  amountOut: string
  /** Whether a swap intent accepts partial fills. Always false for a DCA intent. */
  partial: boolean
  partialMin: string | null
  slippagePpm: number
  /**
   * A DCA intent's total budget. Null on a swap intent, and null on a DCA intent
   * that set none — the pallet's rolling re-reserve, which spends whatever the
   * owner holds. Never 0 standing in for "unset".
   */
  budget: string | null
  /** Blocks between a DCA intent's trades; null on a swap intent. */
  periodBlocks: number | null
  deadline: string | null
  /** The contract a LazyExecutor callback forwards to on resolution, if any. */
  forwardContract: string | null
  createdAt: string
  createdAtBlock: number
  /** Event index of the placement within its block — the page cursor's second half. */
  createdAtEventIndex: number
}

export interface IntentOrderDetailItem extends IntentOrderItem {
  status: IntentStatus
  /** Exact integer sums over the order's fills. */
  filledAmountIn: string
  filledAmountOut: string
  fillCount: number
  /** A DCA intent's budget after its newest trade, as the pallet reported it. */
  remainingBudget: string | null
  lastEventAt: string | null
  lastEventBlock: number | null
}

interface OrderRow {
  intent_id: string
  seq: string | number
  owner: string
  kind: string
  asset_in: number
  asset_out: number
  amount_in: string
  amount_out: string
  partial: number
  partial_min: string
  slippage_ppm: number
  budget: string
  period: number
  deadline_ms: string | number
  forward_contract: string
  block_height: number
  event_index: number
  ts: string
}

// `toString(intent_id) AS intent_id` may not sit in a statement that also filters
// on `intent_id`: ClickHouse resolves the later reference to the alias and would
// compare a string to a u128. Every read below therefore casts in an OUTER select
// over a subquery that does the filtering.
const ORDER_COLUMNS_SQL = `
      toString(intent_id) AS intent_id, seq, owner, kind, asset_in, asset_out,
      amount_in, amount_out, partial, partial_min, slippage_ppm, budget, period,
      deadline_ms, forward_contract, block_height, event_index, toString(block_timestamp) AS ts`
const ORDER_INNER_COLUMNS_SQL = `
      intent_id, seq, owner, kind, asset_in, asset_out, amount_in, amount_out,
      partial, partial_min, slippage_ppm, budget, period, deadline_ms,
      forward_contract, block_height, event_index, block_timestamp`

function orderItem(row: OrderRow): IntentOrderItem {
  const dca = row.kind === 'dca'
  const deadlineMs = Number(row.deadline_ms)
  return {
    intentId: String(row.intent_id),
    // Exact below 2^53; above it this is a rounded display handle, never a key.
    seq: Number(row.seq),
    owner: accountRefFor(row.owner),
    kind: dca ? 'dca' : 'swap',
    assetIn: String(row.asset_in),
    assetOut: String(row.asset_out),
    amountIn: row.amount_in,
    amountOut: row.amount_out,
    partial: Number(row.partial) === 1,
    partialMin: row.partial_min || null,
    slippagePpm: Number(row.slippage_ppm),
    budget: dca && row.budget ? row.budget : null,
    periodBlocks: dca && Number(row.period) > 0 ? Number(row.period) : null,
    deadline: Number.isFinite(deadlineMs) && deadlineMs > 0 ? iso(deadlineMs) : null,
    forwardContract: row.forward_contract || null,
    createdAt: iso(row.ts),
    createdAtBlock: Number(row.block_height),
    createdAtEventIndex: Number(row.event_index),
  }
}

// ---------------------------------------------------------------------------
// The intent event vocabulary, and the status it folds to
// ---------------------------------------------------------------------------

// The partial-resolution event is spelled `IntentResovedPartially` on chain
// (sic — the typo is in the runtime, not here).
export const INTENT_FILL_EVENTS = [
  'Intent.IntentResolved',
  'Intent.IntentResovedPartially',
  'Intent.DcaTradeExecuted',
  'Intent.DcaCompleted',
] as const

// Status is folded from the order's events at read time, never stored. A PARTIAL
// resolution is not terminal: pallet_ice leaves the remainder resting and keeps
// filling it, so `partially_filled` is a live state — an order pulled after two
// partials is `cancelled`, with its progress in filledAmountIn/Out.
export function foldIntentStatus(kind: IntentKind, events: readonly string[]): IntentStatus {
  if (events.includes('Intent.IntentCanceled')) return 'cancelled'
  if (events.includes('Intent.IntentExpired')) return 'expired'
  if (kind === 'dca') return events.includes('Intent.DcaCompleted') ? 'completed' : 'open'
  if (events.includes('Intent.IntentResolved')) return 'filled'
  if (events.includes('Intent.IntentResovedPartially')) return 'partially_filled'
  return 'open'
}

export type IntentEventKind =
  | 'submitted' | 'resolved' | 'partially_resolved' | 'dca_trade'
  | 'dca_completed' | 'cancelled' | 'expired' | 'callback_failed'

const EVENT_KIND: Record<string, IntentEventKind> = {
  'Intent.IntentSubmitted': 'submitted',
  'Intent.IntentResolved': 'resolved',
  'Intent.IntentResovedPartially': 'partially_resolved',
  'Intent.DcaTradeExecuted': 'dca_trade',
  'Intent.DcaCompleted': 'dca_completed',
  'Intent.IntentCanceled': 'cancelled',
  'Intent.IntentExpired': 'expired',
  'Intent.FailedToQueueCallback': 'callback_failed',
}

export interface IntentEventItem {
  kind: IntentEventKind
  eventName: string
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  amountIn: string | null
  amountOut: string | null
  remainingBudget: string | null
}

interface EventRow {
  event_name: string
  block_height: number
  event_index: number
  extrinsic_index: number | null
  ts: string
  amount_in: string
  amount_out: string
  remaining_budget: string
}

const amount = (v: string): string | null => /^\d+$/.test(v) ? v : null

function eventItem(row: EventRow): IntentEventItem | null {
  const kind = EVENT_KIND[row.event_name]
  if (!kind) return null
  return {
    kind,
    eventName: row.event_name,
    blockHeight: Number(row.block_height),
    eventIndex: Number(row.event_index),
    extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
    timestamp: iso(row.ts),
    amountIn: amount(row.amount_in),
    amountOut: amount(row.amount_out),
    // Only a DCA trade carries one; a completion spent the last of the budget,
    // and the event that says so carries no amounts at all.
    remainingBudget: kind === 'dca_trade' ? amount(row.remaining_budget) : kind === 'dca_completed' ? '0' : null,
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface IntentsPageOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
  ownerAccountId?: string
  kind?: IntentKind
  asset?: string
}

// Newest first over (block, event index) — the placement's own position, which
// is the sort key of `intent_orders_by_account` and the natural order of
// `intent_orders`. An owner-scoped page reads the by-account twin as a key range;
// the global page reads `intent_orders`, whose whole extent is one row per intent
// ever submitted.
export async function intentOrders(client: ClickHouseClient, options: IntentsPageOptions): Promise<{ items: IntentOrderItem[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { bound: options.limit + 1 + DEDUP_SLACK }
  const clauses: string[] = []
  const table = options.ownerAccountId ? 'price_data.intent_orders_by_account' : 'price_data.intent_orders'
  if (options.ownerAccountId) { clauses.push('owner = {owner:String}'); params.owner = options.ownerAccountId }
  if (options.kind) { clauses.push('kind = {kind:String}'); params.kind = options.kind }
  if (options.asset != null) {
    clauses.push('(asset_in = {asset:UInt32} OR asset_out = {asset:UInt32})')
    params.asset = Number(options.asset)
  }
  clauses.push(`1 = 1${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}`)
  const res = await client.query({
    query: `-- data:intents:orders
        SELECT ${ORDER_COLUMNS_SQL}
        FROM (
          SELECT ${ORDER_INNER_COLUMNS_SQL}
          FROM ${table}
          WHERE ${clauses.join(' AND ')}
          ORDER BY ${orderSql(options.order, 'event_index')}
          LIMIT {bound:UInt32}
        )
        ORDER BY ${orderSql(options.order, 'event_index')}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<OrderRow>(),
    row => String(row.intent_id),
    options.limit,
  )
  return { items: page.map(orderItem), hasMore }
}

export async function intentOrderById(client: ClickHouseClient, intentId: string): Promise<IntentOrderDetailItem | null> {
  const res = await client.query({
    query: `-- data:intents:order-by-id
        SELECT ${ORDER_COLUMNS_SQL}
        FROM (
          SELECT ${ORDER_INNER_COLUMNS_SQL}
          FROM price_data.intent_orders FINAL
          WHERE intent_id = toUInt128({id:String})
          LIMIT 1
        )`,
    query_params: { id: intentId },
    format: 'JSONEachRow',
  })
  const [row] = await res.json<OrderRow>()
  if (!row) return null
  const order = orderItem(row)
  const totals = await intentAggregates(client, intentId, order.createdAtBlock, order.kind)
  return { ...order, ...totals }
}

interface AggregateRow {
  names: string[]
  fill_in: string
  fill_out: string
  fills: string | number
  last_block: string | number
  last_ts: string
  last_rb: string
}

// One fold over the order's own stretch of intent_events: which event names it
// has seen (for the status), the exact integer fill totals, and its newest
// trade's remaining budget. FINAL because the totals are summed and counted —
// a replayed range must be collapsed before it is added up.
async function intentAggregates(client: ClickHouseClient, intentId: string, fromBlock: number, kind: IntentKind): Promise<Pick<IntentOrderDetailItem, 'status' | 'filledAmountIn' | 'filledAmountOut' | 'fillCount' | 'remainingBudget' | 'lastEventAt' | 'lastEventBlock'>> {
  const fillList = INTENT_FILL_EVENTS.map(name => `'${name}'`).join(',')
  const res = await client.query({
    query: `-- data:intents:aggregates
        SELECT groupUniqArray(event_name) AS names,
               toString(sumIf(toUInt256OrZero(amount_in), event_name IN (${fillList}))) AS fill_in,
               toString(sumIf(toUInt256OrZero(amount_out), event_name IN (${fillList}))) AS fill_out,
               countIf(event_name IN (${fillList})) AS fills,
               max(block_height) AS last_block,
               toString(max(block_timestamp)) AS last_ts,
               argMaxIf(remaining_budget, toUInt64(block_height) * 4294967296 + event_index, event_name = 'Intent.DcaTradeExecuted') AS last_rb
        FROM price_data.intent_events FINAL
        WHERE block_height >= {from:UInt32} AND intent_id = toUInt128({id:String})`,
    query_params: { id: intentId, from: fromBlock },
    format: 'JSONEachRow',
  })
  const [row] = await res.json<AggregateRow>()
  const names = row?.names ?? []
  const lastBlock = Number(row?.last_block ?? 0)
  return {
    status: foldIntentStatus(kind, names),
    filledAmountIn: row?.fill_in ?? '0',
    filledAmountOut: row?.fill_out ?? '0',
    fillCount: Number(row?.fills ?? 0),
    // A completed DCA spent its budget to the last unit; the event that ends it
    // carries no figure, so the fold states the zero its name asserts.
    remainingBudget: kind !== 'dca' ? null
      : names.includes('Intent.DcaCompleted') ? '0'
        : amount(row?.last_rb ?? ''),
    lastEventAt: lastBlock > 0 ? iso(row!.last_ts) : null,
    lastEventBlock: lastBlock > 0 ? lastBlock : null,
  }
}

export interface IntentEventsOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
}

// One intent's events. `fromBlock` is the placement block: intent_events is keyed
// (block_height, event_index), so this bound is what turns a per-id read into a
// key range rather than a scan of the whole table.
export async function intentEvents(client: ClickHouseClient, intentId: string, fromBlock: number, options: IntentEventsOptions): Promise<{ items: IntentEventItem[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { id: intentId, from: fromBlock, bound: options.limit + 1 + DEDUP_SLACK }
  const res = await client.query({
    query: `-- data:intents:events
        SELECT event_name, block_height, event_index, extrinsic_index,
               toString(block_timestamp) AS ts, amount_in, amount_out, remaining_budget
        FROM price_data.intent_events FINAL
        WHERE block_height >= {from:UInt32} AND intent_id = toUInt128({id:String})${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<EventRow>(),
    row => `${row.block_height}:${row.event_index}`,
    options.limit,
  )
  const items: IntentEventItem[] = []
  for (const row of page) {
    const item = eventItem(row)
    if (item) items.push(item)
  }
  return { items, hasMore }
}
