import type { ClickHouseClient } from '../../db/client.ts'
import { iso } from '../schemas/common.ts'
import { resolveSingleAccountForms } from './accountBalances.ts'

// ICE intents for /v1/intents. Runtime 443 (block 14,362,830) added the Intent
// pallet: a SWAP intent is the product's limit order, a DCA intent is the new
// DCA. Both rest on chain with the owner's `assetIn` under a named reserve until
// a solver's ICE.submit_solution fills them.
//
// Public-owned (spec: "Isolation rule"), so the status rule the explorer's intent
// page uses is restated here rather than imported — but it MUST agree with it: an
// order that reads "open" on one surface may not read "filled" on the other.

export type IntentStatus = 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'expired' | 'completed'
export type IntentKind = 'swap' | 'dca'

export const INTENT_STATUSES: readonly IntentStatus[] = ['open', 'partially_filled', 'filled', 'cancelled', 'expired', 'completed']
export const INTENT_KINDS: readonly IntentKind[] = ['swap', 'dca']

// The partial-resolution event is spelled `IntentResovedPartially` on chain (sic).
const SUBMITTED_EVENT = 'Intent.IntentSubmitted'
const CANCELLED_EVENT = 'Intent.IntentCanceled'
const EXPIRED_EVENT = 'Intent.IntentExpired'
const RESOLVED_EVENT = 'Intent.IntentResolved'
const PARTIAL_EVENT = 'Intent.IntentResovedPartially'
const DCA_TRADE_EVENT = 'Intent.DcaTradeExecuted'
const DCA_COMPLETED_EVENT = 'Intent.DcaCompleted'
const CALLBACK_FAILED_EVENT = 'Intent.FailedToQueueCallback'
const FILL_EVENTS = [RESOLVED_EVENT, PARTIAL_EVENT, DCA_TRADE_EVENT, DCA_COMPLETED_EVENT] as const

/**
 * The whole vocabulary of an intent's life, and the wire kind each event takes.
 *
 * Both the event page and its count filter on these names, so the two cannot
 * disagree: a count that included an event the page drops would report a page
 * the caller can never reach.
 */
export const INTENT_EVENT_KIND = {
  [SUBMITTED_EVENT]: 'submitted',
  [RESOLVED_EVENT]: 'resolved',
  [PARTIAL_EVENT]: 'partially_resolved',
  [DCA_TRADE_EVENT]: 'dca_trade',
  [DCA_COMPLETED_EVENT]: 'dca_completed',
  [CANCELLED_EVENT]: 'cancelled',
  [EXPIRED_EVENT]: 'expired',
  [CALLBACK_FAILED_EVENT]: 'callback_failed',
} as const satisfies Record<string, string>

export type IntentEventKind = typeof INTENT_EVENT_KIND[keyof typeof INTENT_EVENT_KIND]

export const INTENT_EVENT_KINDS: readonly IntentEventKind[] = [
  'submitted', 'resolved', 'partially_resolved', 'dca_trade',
  'dca_completed', 'cancelled', 'expired', 'callback_failed',
]

const INTENT_EVENT_NAMES = Object.keys(INTENT_EVENT_KIND)

/**
 * 9999-12-31T23:59:59.999Z, the last instant `zIsoTimestamp` accepts.
 *
 * `deadline_ms` is an unbounded UInt64 the submitter chooses, and "no deadline"
 * is expressed on chain as a sentinel far past any real date. It is the only
 * integer on this surface nothing at the edge bounds, and both ways past the
 * calendar are fatal for the WHOLE page, not for the one order: past ±8.64e15 ms
 * `new Date()` is Invalid and `iso()` throws, and below that but past year 9999
 * `toISOString()` renders the expanded-year form (`+275760-09-13T…`) that the
 * response schema rejects. Anything beyond this reports `deadline: null`, which
 * is already this field's word for "none" (a `deadline_ms` of 0).
 */
const MAX_TIMESTAMP_MS = 253_402_300_799_999

export interface IntentStatusInput {
  kind: IntentKind
  hasCancelled: boolean
  hasExpired: boolean
  hasResolved: boolean
  hasPartial: boolean
  hasDcaCompleted: boolean
}

/**
 * Which of the six states an intent is in.
 *
 * A PARTIAL resolution is not terminal: pallet_ice leaves the remainder resting
 * and keeps filling it (verified on id …96250533888086, which took eight partials
 * before its owner cancelled), so `partially_filled` is a LIVE state. A DCA
 * intent never resolves — it trades once per period until the trade that spends
 * the last of its budget emits DcaCompleted.
 */
export function computeIntentStatus(input: IntentStatusInput): IntentStatus {
  if (input.hasCancelled) return 'cancelled'
  if (input.hasExpired) return 'expired'
  if (input.kind === 'dca') return input.hasDcaCompleted ? 'completed' : 'open'
  if (input.hasResolved) return 'filled'
  if (input.hasPartial) return 'partially_filled'
  return 'open'
}

/** An intent still holds the owner's funds in exactly these states. */
export function intentIsResting(status: IntentStatus): boolean {
  return status === 'open' || status === 'partially_filled'
}

export interface IntentRow {
  intentId: string
  seq: number
  owner: string
  kind: IntentKind
  assetIn: string
  assetOut: string
  amountIn: string
  amountOut: string
  partiallyFillable: boolean
  slippagePpm: number
  budget: string | null
  isRollingBudget: boolean | null
  periodBlocks: number | null
  status: IntentStatus
  filledAmountIn: string
  filledAmountOut: string
  fillCount: number
  remainingAmountIn: string
  remainingBudget: string | null
  deadline: string | null
  createdAt: string
  createdAtBlock: number
  lastEventAt: string | null
}

interface OrderSqlRow {
  intent_id: string
  seq: string | number
  owner: string
  kind: string
  asset_in: number
  asset_out: number
  amount_in: string
  amount_out: string
  partial: number
  slippage_ppm: number
  budget: string
  period: number
  deadline_ms: string | number
  block_height: number
  ts: string
}

interface AggregateSqlRow {
  intent_id: string
  cancelled: string | number
  expired: string | number
  resolved: string | number
  partial: string | number
  dca_completed: string | number
  fills: string | number
  fill_in: string
  fill_out: string
  last_ts: string
  last_rb: string
}

const positive = (v: string | number | undefined): boolean => Number(v ?? 0) > 0
const amount = (v: string | undefined): string | null => v != null && /^\d+$/.test(v) ? v : null

// Integer subtraction that refuses to go negative or to guess.
function restingLeg(placed: string, filled: string): string {
  if (!/^\d+$/.test(placed) || !/^\d+$/.test(filled)) return placed
  const left = BigInt(placed) - BigInt(filled)
  return left > 0n ? left.toString() : '0'
}

// One fold per order over its own stretch of intent_events. The table is keyed
// (block_height, event_index) and cannot prune on an intent id, so the read is
// bounded below by the OLDEST submission in the set — no event of any of these
// orders can precede it. FINAL because the totals are summed and counted: a
// replayed range must be collapsed before it is added up.
async function intentEventAggregates(client: ClickHouseClient, ids: string[], fromBlock: number): Promise<Map<string, AggregateSqlRow>> {
  const out = new Map<string, AggregateSqlRow>()
  if (!ids.length) return out
  const fillList = FILL_EVENTS.map(name => `'${name}'`).join(',')
  const res = await client.query({
    // Two u128 hazards in one statement.
    //
    // The ids are bound as Array(String), never Array(UInt128): the client
    // serialises string elements quoted, and ClickHouse refuses a quoted value
    // for a UInt128 element ("cannot be parsed as Array(UInt128)"). They are cast
    // inside a subquery set instead, which is also what keeps the membership test
    // a set lookup rather than a per-row array scan.
    //
    // And `toString(intent_id) AS intent_id` may not sit in a statement that also
    // filters on `intent_id`: ClickHouse resolves the later reference to the
    // alias and would compare a string to a u128. Hence the outer cast.
    query: `
        SELECT toString(intent_id) AS intent_id, cancelled, expired, resolved, partial,
               dca_completed, fills, fill_in, fill_out, last_ts, last_rb
        FROM (
          SELECT intent_id,
                 countIf(event_name = '${CANCELLED_EVENT}') AS cancelled,
                 countIf(event_name = '${EXPIRED_EVENT}') AS expired,
                 countIf(event_name = '${RESOLVED_EVENT}') AS resolved,
                 countIf(event_name = '${PARTIAL_EVENT}') AS partial,
                 countIf(event_name = '${DCA_COMPLETED_EVENT}') AS dca_completed,
                 countIf(event_name IN (${fillList})) AS fills,
                 toString(sumIf(toUInt256OrZero(amount_in), event_name IN (${fillList}))) AS fill_in,
                 toString(sumIf(toUInt256OrZero(amount_out), event_name IN (${fillList}))) AS fill_out,
                 toString(max(block_timestamp)) AS last_ts,
                 argMaxIf(remaining_budget, toUInt64(block_height) * 4294967296 + event_index, event_name = '${DCA_TRADE_EVENT}') AS last_rb
          FROM price_data.intent_events FINAL
          WHERE block_height >= {from:UInt32}
            AND intent_id IN (SELECT toUInt128(arrayJoin({ids:Array(String)})))
          GROUP BY intent_id
        )`,
    query_params: { ids, from: fromBlock },
    format: 'JSONEachRow',
  })
  for (const row of await res.json<AggregateSqlRow>()) out.set(row.intent_id, row)
  return out
}

/**
 * The oldest block any of these orders was placed in — the floor the event
 * aggregate's window starts at.
 *
 * Folded rather than spread: `Math.min(...rows.map(…))` throws
 * `RangeError: Maximum call stack size exceeded` once an owner has more orders
 * than the call stack takes arguments, which is a permanent 500 for that owner
 * and for nobody else.
 */
export function oldestOrderBlock(rows: ReadonlyArray<{ block_height: number | string }>): number {
  let oldest = Number.POSITIVE_INFINITY
  for (const row of rows) {
    const block = Number(row.block_height)
    if (block < oldest) oldest = block
  }
  return oldest
}

/**
 * One placement plus the fold over its own events, as the wire publishes it.
 *
 * The listing and the per-id route both build their row HERE rather than each
 * restating the arithmetic: a progress page reached from a list must not
 * contradict the list it came from, and status, `remainingAmountIn` and
 * `remainingBudget` are exactly the fields two implementations would drift on.
 */
function intentRow(raw: OrderSqlRow, agg: AggregateSqlRow | undefined): IntentRow {
  const kind: IntentKind = raw.kind === 'dca' ? 'dca' : 'swap'
  const status = computeIntentStatus({
    kind,
    hasCancelled: positive(agg?.cancelled),
    hasExpired: positive(agg?.expired),
    hasResolved: positive(agg?.resolved),
    hasPartial: positive(agg?.partial),
    hasDcaCompleted: positive(agg?.dca_completed),
  })
  const fillIn = agg?.fill_in ?? '0'
  const deadlineMs = Number(raw.deadline_ms)
  // A dca intent's whole commitment is its budget; a swap intent's is the one
  // amount it placed. Both shrink by what the fills have taken.
  const committed = kind === 'dca' && raw.budget ? raw.budget : raw.amount_in
  return {
    intentId: String(raw.intent_id),
    // Exact below 2^53; above it a rounded display handle, never a key.
    seq: Number(raw.seq),
    owner: raw.owner,
    kind,
    assetIn: String(raw.asset_in),
    assetOut: String(raw.asset_out),
    amountIn: raw.amount_in,
    amountOut: raw.amount_out,
    partiallyFillable: Number(raw.partial) === 1,
    slippagePpm: Number(raw.slippage_ppm),
    budget: kind === 'dca' ? (raw.budget || '0') : null,
    // A dca intent with no budget is the pallet's rolling re-reserve: it keeps
    // spending whatever the owner holds, the same shape a schedule's
    // total_amount = 0 has.
    isRollingBudget: kind === 'dca' ? !raw.budget : null,
    periodBlocks: kind === 'dca' && Number(raw.period) > 0 ? Number(raw.period) : null,
    status,
    filledAmountIn: fillIn,
    filledAmountOut: agg?.fill_out ?? '0',
    fillCount: Number(agg?.fills ?? 0),
    remainingAmountIn: restingLeg(committed, fillIn),
    remainingBudget: kind !== 'dca' ? null
      : positive(agg?.dca_completed) ? '0'
        : amount(agg?.last_rb),
    deadline: deadlineMs > 0 && deadlineMs <= MAX_TIMESTAMP_MS ? iso(new Date(deadlineMs)) : null,
    createdAt: iso(raw.ts),
    createdAtBlock: Number(raw.block_height),
    lastEventAt: agg?.last_ts ? iso(agg.last_ts) : null,
  }
}

const ORDER_COLUMNS_SQL = `
        toString(intent_id) AS intent_id, seq, owner, kind, asset_in, asset_out,
        amount_in, amount_out, partial, slippage_ppm, budget, period, deadline_ms,
        block_height, toString(block_timestamp) AS ts`
const ORDER_INNER_COLUMNS_SQL = `
          intent_id, seq, owner, kind, asset_in, asset_out, amount_in, amount_out,
          partial, slippage_ppm, budget, period, deadline_ms, block_height, block_timestamp`

export interface IntentOrdersOptions {
  owner: string
  statuses: IntentStatus[]
  kinds: IntentKind[]
  assets: string[]
  limit: number
  offset: number
}

export async function queryIntentOrders(
  client: ClickHouseClient,
  options: IntentOrdersOptions,
): Promise<{ items: IntentRow[]; totalCount: number }> {
  // Both halves of an EVM identity, exactly as the accounts endpoints resolve them.
  const accounts = await resolveSingleAccountForms(client, options.owner)
  const res = await client.query({
    // The owner-first twin (009_data.sql), whose sort key starts at `owner`, so
    // this reads one key range instead of the whole-table FINAL pass
    // `intent_orders` (keyed on intent_id alone) would force. Its column list is
    // the source's minus `args_json`, which this query does not read. FINAL on
    // the twin's own key collapses a replayed placement; `intent_id` is
    // deduplicated again below, because that — not (owner, block, event) — is
    // the identity the wire promises one row per.
    query: `
        SELECT ${ORDER_COLUMNS_SQL}
        FROM (
          SELECT ${ORDER_INNER_COLUMNS_SQL}
          FROM price_data.intent_orders_by_account FINAL
          WHERE owner IN {accounts:Array(String)}
        )`,
    query_params: { accounts },
    format: 'JSONEachRow',
  })
  const byIntent = new Map<string, OrderSqlRow>()
  for (const row of await res.json<OrderSqlRow>()) {
    const held = byIntent.get(String(row.intent_id))
    if (!held || Number(row.block_height) > Number(held.block_height)) byIntent.set(String(row.intent_id), row)
  }
  const orders = [...byIntent.values()]
  if (!orders.length) return { items: [], totalCount: 0 }

  const aggregates = await intentEventAggregates(
    client,
    orders.map(o => String(o.intent_id)),
    oldestOrderBlock(orders),
  )
  const assets = new Set(options.assets.map(Number).filter(Number.isInteger))
  const wantedStatus = new Set(options.statuses)
  const wantedKind = new Set(options.kinds)

  const rows: IntentRow[] = []
  for (const raw of orders) {
    if (assets.size && !assets.has(Number(raw.asset_in)) && !assets.has(Number(raw.asset_out))) continue
    const kind: IntentKind = raw.kind === 'dca' ? 'dca' : 'swap'
    if (wantedKind.size && !wantedKind.has(kind)) continue
    const row = intentRow(raw, aggregates.get(String(raw.intent_id)))
    if (wantedStatus.size && !wantedStatus.has(row.status)) continue
    rows.push(row)
  }
  // Most recent activity first, a never-touched order by its submission; ties by
  // id so a page boundary is deterministic.
  rows.sort((a, b) =>
    Date.parse(b.lastEventAt ?? b.createdAt) - Date.parse(a.lastEventAt ?? a.createdAt)
    || (a.intentId < b.intentId ? 1 : a.intentId > b.intentId ? -1 : 0))
  return { items: rows.slice(options.offset, options.offset + options.limit), totalCount: rows.length }
}

// ---------------------------------------------------------------------------
// One order, by its id
// ---------------------------------------------------------------------------

// Unlike the listing, a per-id read needs no owner: the id alone bounds both
// tables. `intent_orders` is ORDER BY intent_id, so the placement is a point
// read there (the owner-first twin could not prune on an id at all), and the
// placement block it returns is what turns the event read into a key range —
// `intent_events` is keyed (block_height, event_index) and no event of an order
// can precede its submission.
async function intentOrderRow(client: ClickHouseClient, intentId: string): Promise<OrderSqlRow | null> {
  const res = await client.query({
    // `toString(intent_id) AS intent_id` may not sit in a statement that also
    // filters on `intent_id`: ClickHouse resolves the later reference to the
    // alias and would compare a string to a u128. Hence the outer cast.
    query: `-- pub:intents:order-by-id
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
  const [row] = await res.json<OrderSqlRow>()
  return row ?? null
}

/** One intent with the same folded progress the listing reports for it. */
export async function queryIntentOrderById(client: ClickHouseClient, intentId: string): Promise<IntentRow | null> {
  const raw = await intentOrderRow(client, intentId)
  if (!raw) return null
  const aggregates = await intentEventAggregates(client, [String(raw.intent_id)], Number(raw.block_height))
  return intentRow(raw, aggregates.get(String(raw.intent_id)))
}

export interface IntentEventRow {
  kind: IntentEventKind
  eventName: string
  blockHeight: number
  eventIndex: number
  /** Fills happen inside the UNSIGNED ICE.submit_solution: an extrinsic, never a signer. */
  extrinsicIndex: number | null
  timestamp: string
  amountIn: string | null
  amountOut: string | null
  remainingBudget: string | null
}

export interface IntentEventsPage {
  items: IntentEventRow[]
  totalCount: number
  /** The order's pair. Only the submission names it, and it labels every amount. */
  assetIn: string
  assetOut: string
}

interface EventSqlRow {
  event_name: string
  block_height: number
  event_index: number
  extrinsic_index: number | null
  ts: string
  amount_in: string
  amount_out: string
  remaining_budget: string
}

function intentEventRow(row: EventSqlRow): IntentEventRow {
  const kind = INTENT_EVENT_KIND[row.event_name as keyof typeof INTENT_EVENT_KIND]
  return {
    kind,
    eventName: row.event_name,
    blockHeight: Number(row.block_height),
    eventIndex: Number(row.event_index),
    extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
    timestamp: iso(row.ts),
    // A submission, cancellation or expiry traded nothing, so its amounts are
    // absent rather than a zero standing in for one.
    amountIn: amount(row.amount_in),
    amountOut: amount(row.amount_out),
    // Only a dca trade carries a budget figure. The completion carries none —
    // the trade that exhausts a budget states its amounts in the solution's
    // settlement transfers — so the fold states the zero its name asserts.
    remainingBudget: kind === 'dca_trade' ? amount(row.remaining_budget)
      : kind === 'dca_completed' ? '0'
        : null,
  }
}

/** One order's lifecycle events, newest first. Null when the id was never submitted. */
export async function queryIntentEvents(
  client: ClickHouseClient,
  intentId: string,
  options: { limit: number; offset: number },
): Promise<IntentEventsPage | null> {
  const order = await intentOrderRow(client, intentId)
  if (!order) return null
  const window = { id: intentId, from: Number(order.block_height), names: INTENT_EVENT_NAMES }
  const [pageRes, totalRes] = await Promise.all([
    client.query({
      // LIMIT 1 BY the table's own replacement key, then page: a replayed range
      // must not shift a page by a duplicate row.
      query: `-- pub:intents:events
          SELECT event_name, block_height, event_index, extrinsic_index,
                 toString(block_timestamp) AS ts, amount_in, amount_out, remaining_budget
          FROM (
            SELECT event_name, block_height, event_index, extrinsic_index, block_timestamp,
                   amount_in, amount_out, remaining_budget
            FROM price_data.intent_events
            WHERE block_height >= {from:UInt32} AND intent_id = toUInt128({id:String})
              AND event_name IN {names:Array(String)}
            LIMIT 1 BY block_height, event_index
          )
          ORDER BY block_height DESC, event_index DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      query_params: { ...window, limit: options.limit, offset: options.offset },
      format: 'JSONEachRow',
    }),
    client.query({
      query: `-- pub:intents:events-count
          SELECT toString(uniqExact((block_height, event_index))) AS total
          FROM price_data.intent_events
          WHERE block_height >= {from:UInt32} AND intent_id = toUInt128({id:String})
            AND event_name IN {names:Array(String)}`,
      query_params: window,
      format: 'JSONEachRow',
    }),
  ])
  const [totals] = await totalRes.json<{ total: string }>()
  return {
    items: (await pageRes.json<EventSqlRow>()).map(intentEventRow),
    totalCount: Number(totals?.total ?? 0),
    assetIn: String(order.asset_in),
    assetOut: String(order.asset_out),
  }
}
