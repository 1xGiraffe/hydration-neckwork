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
const CANCELLED_EVENT = 'Intent.IntentCanceled'
const EXPIRED_EVENT = 'Intent.IntentExpired'
const RESOLVED_EVENT = 'Intent.IntentResolved'
const PARTIAL_EVENT = 'Intent.IntentResovedPartially'
const DCA_TRADE_EVENT = 'Intent.DcaTradeExecuted'
const DCA_COMPLETED_EVENT = 'Intent.DcaCompleted'
const FILL_EVENTS = [RESOLVED_EVENT, PARTIAL_EVENT, DCA_TRADE_EVENT, DCA_COMPLETED_EVENT] as const

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
    // FINAL: intent_orders replaces on intent_id, and one row per order is the
    // premise of everything below. The table holds one row per intent ever
    // submitted and `owner` is not part of its key, so this is a bounded full
    // pass by design — the same shape the DCA listing beside it uses.
    query: `
        SELECT toString(intent_id) AS intent_id, seq, owner, kind, asset_in, asset_out,
               amount_in, amount_out, partial, slippage_ppm, budget, period, deadline_ms,
               block_height, toString(block_timestamp) AS ts
        FROM (
          SELECT intent_id, seq, owner, kind, asset_in, asset_out, amount_in, amount_out,
                 partial, slippage_ppm, budget, period, deadline_ms, block_height, block_timestamp
          FROM price_data.intent_orders FINAL
          WHERE owner IN {accounts:Array(String)}
        )`,
    query_params: { accounts },
    format: 'JSONEachRow',
  })
  const orders = await res.json<OrderSqlRow>()
  if (!orders.length) return { items: [], totalCount: 0 }

  const aggregates = await intentEventAggregates(
    client,
    orders.map(o => String(o.intent_id)),
    Math.min(...orders.map(o => Number(o.block_height))),
  )
  const assets = new Set(options.assets.map(Number).filter(Number.isInteger))
  const wantedStatus = new Set(options.statuses)
  const wantedKind = new Set(options.kinds)

  const rows: IntentRow[] = []
  for (const raw of orders) {
    if (assets.size && !assets.has(Number(raw.asset_in)) && !assets.has(Number(raw.asset_out))) continue
    const kind: IntentKind = raw.kind === 'dca' ? 'dca' : 'swap'
    if (wantedKind.size && !wantedKind.has(kind)) continue
    const agg = aggregates.get(String(raw.intent_id))
    const status = computeIntentStatus({
      kind,
      hasCancelled: positive(agg?.cancelled),
      hasExpired: positive(agg?.expired),
      hasResolved: positive(agg?.resolved),
      hasPartial: positive(agg?.partial),
      hasDcaCompleted: positive(agg?.dca_completed),
    })
    if (wantedStatus.size && !wantedStatus.has(status)) continue
    const fillIn = agg?.fill_in ?? '0'
    const deadlineMs = Number(raw.deadline_ms)
    // A dca intent's whole commitment is its budget; a swap intent's is the one
    // amount it placed. Both shrink by what the fills have taken.
    const committed = kind === 'dca' && raw.budget ? raw.budget : raw.amount_in
    rows.push({
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
      deadline: Number.isFinite(deadlineMs) && deadlineMs > 0 ? iso(new Date(deadlineMs)) : null,
      createdAt: iso(raw.ts),
      createdAtBlock: Number(raw.block_height),
      lastEventAt: agg?.last_ts ? iso(agg.last_ts) : null,
    })
  }
  // Most recent activity first, a never-touched order by its submission; ties by
  // id so a page boundary is deterministic.
  rows.sort((a, b) =>
    Date.parse(b.lastEventAt ?? b.createdAt) - Date.parse(a.lastEventAt ?? a.createdAt)
    || (a.intentId < b.intentId ? 1 : a.intentId > b.intentId ? -1 : 0))
  return { items: rows.slice(options.offset, options.offset + options.limit), totalCount: rows.length }
}
