import type { ClickHouseClient } from '../../db/client.ts'
import { iso } from '../schemas/common.ts'
import { resolveSingleAccountForms } from './accountBalances.ts'

// DCA schedules and their executions, for the three /v1/dca endpoints. Public-owned
// (spec: "Isolation rule"), so the status rule the explorer's DCA page uses is
// restated here rather than imported — but it MUST agree with it: a schedule that
// reads "cancelled" on one surface may not read "terminated" on the other.

export type DcaStatus = 'created' | 'completed' | 'terminated' | 'cancelled'

/** The lifecycle events dca_events carries, with their pallet prefix. */
const COMPLETED_EVENT = 'DCA.Completed'
const TERMINATED_EVENT = 'DCA.Terminated'
const EXECUTION_EVENTS = ['DCA.TradeExecuted', 'DCA.TradeFailed', 'DCA.ExecutionPlanned'] as const

/** The wire state each execution event maps to. */
const EXECUTION_STATUS: Record<string, 'executed' | 'failed' | 'planned'> = {
  'DCA.TradeExecuted': 'executed',
  'DCA.TradeFailed': 'failed',
  'DCA.ExecutionPlanned': 'planned',
}

export interface DcaStatusInput {
  hasCompleted: boolean
  hasTerminated: boolean
  /**
   * Whether the DCA.Terminated event was carried by a signed extrinsic. Null when
   * the schedule was never terminated, or when the signal is unavailable.
   */
  terminatedByExtrinsic: boolean | null
  /** The newest of the schedule's execution events, or null if it has none. */
  lastExecEventName: string | null
}

/**
 * Which of the four states a schedule is in.
 *
 * A termination is the owner's own `dca.terminate` call ("cancelled") when its
 * DCA.Terminated event came from a signed extrinsic, and the pallet ending the
 * schedule on an error ("terminated") when it came from a block hook. That signal is
 * authoritative and is what the explorer's DCA page uses.
 *
 * Without it (a caller that cannot read the event's extrinsic) the older data-lake
 * heuristic applies: terminated with the last execution still only planned means the
 * owner cancelled before it ran. It is kept only as a fallback because it mislabels
 * an error termination that left a pending plan.
 */
export function computeDcaStatus(input: DcaStatusInput): DcaStatus {
  if (input.hasTerminated) {
    const manual = input.terminatedByExtrinsic ?? input.lastExecEventName === 'DCA.ExecutionPlanned'
    return manual ? 'cancelled' : 'terminated'
  }
  return input.hasCompleted ? 'completed' : 'created'
}

// ---------------------------------------------------------------------------
// Pre-router schedules
//
// Before block ~4.22 M the runtime emitted DCA.Scheduled with only {id, who}: no
// order, period or amounts. dca_schedules reads that event, so 2,354 real schedules
// (every id below 2,354) store a BLANK direction, asset_in = asset_out = 0 and empty
// amounts — and asset 0 is HDX, so a WETH->HDX schedule published as "HDX -> HDX"
// with a zero budget and `isRollingBudget: true`, a constraint it never had.
//
// The order survives in the DCA.schedule CALL args. Only the id is event-only, so no
// materialized view can join the two halves; it is recovered per request instead, from
// one primary-key-addressed raw_calls read. Where no call is addressable (batch- or
// hook-created schedules), the traded PAIR alone is recovered from the first
// execution's own swap leg — the terms are never invented from a swap.
//
// Both rules are the ones the explorer's DCA page uses. They are restated here rather
// than imported (spec: "Isolation rule") and MUST keep agreeing with it: a schedule
// that reads WETH->HDX on one surface may not read HDX->HDX on the other.
// ---------------------------------------------------------------------------

/** A blank `direction` is the pre-router marker: the event carried no order at all. */
const LEGACY_ORDER_MARKER = ''

/** The call whose args carry a pre-router schedule's whole order. */
const SCHEDULE_CALL = 'DCA.schedule'

/** The AMM/router events whose args name a swap's pair and its `who`. */
const SWAP_EVENTS = [
  'Router.Executed', 'Router.RouteExecuted',
  'Omnipool.SellExecuted', 'Omnipool.BuyExecuted',
  'Stableswap.SellExecuted', 'Stableswap.BuyExecuted',
  'XYK.SellExecuted', 'XYK.BuyExecuted',
  'LBP.SellExecuted', 'LBP.BuyExecuted',
]

/**
 * (block_height, extrinsic_index) as one integer, so a set of calls can be addressed
 * exactly while the leading `block_height IN (...)` predicate still prunes by the
 * primary key. Extrinsic indices are far below the stride.
 */
const INDEX_STRIDE = 1_000_000
const callKey = (blockHeight: number, index: number) => blockHeight * INDEX_STRIDE + index

/** What a pre-router schedule's stored row is missing, as far as it is recoverable. */
export interface DcaLegacyOrder {
  assetIn: number
  assetOut: number
  /**
   * Whether the schedule's TERMS (per-trade amount, budget, period) were recovered too,
   * or only its pair. The execution-leg path recovers a pair from a swap, which says
   * nothing about the order's size or cadence — so the terms stay unknown, and the wire
   * reports them as null rather than as the stored blank.
   */
  termsKnown: boolean
  /** Empty / 0 when only the pair could be recovered (`termsKnown: false`). */
  amountPer: string
  totalAmount: string
  period: number
}

/**
 * The order inside a `DCA.schedule` call's args, or null when the call carries none.
 *
 * Returns null rather than a partial order, so a genuinely zero-asset schedule is
 * never invented from a malformed or unrelated call.
 */
export function legacyOrderFromCallArgs(argsJson: string): DcaLegacyOrder | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
  } catch {
    return null
  }
  const schedule = (parsed as { schedule?: unknown } | null)?.schedule as Record<string, unknown> | undefined
  const order = schedule?.order as Record<string, unknown> | undefined
  if (!schedule || !order || typeof order !== 'object') return null
  const int = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null)
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const assetIn = int(order.assetIn)
  const assetOut = int(order.assetOut)
  // The order's __kind is what dca_schedules stores as `direction`; without it this is
  // not a schedule order.
  if (assetIn == null || assetOut == null || !text(order.__kind)) return null
  return {
    assetIn,
    assetOut,
    // The call carries the WHOLE order, so this path knows the terms as exactly as a
    // router-era event does.
    termsKnown: true,
    // A Sell order fixes the input per trade, a Buy order the output — the same single
    // `amount_per` column the router-era rows carry.
    amountPer: text(order.amountIn) || text(order.amountOut),
    totalAmount: text(schedule.totalAmount),
    period: int(schedule.period) ?? 0,
  }
}

interface LegacyScheduleRef {
  id: string
  block_height: number
  extrinsic_index: number | null
}

/**
 * Pick each schedule's own swap out of its first execution's block: the nearest swap
 * event BEFORE the execution event whose `who` is the schedule's owner. An owner
 * running several schedules in one block has several swaps there, and the block's
 * first one may belong to a different schedule.
 */
export function pickPairFromFirstExecution(
  first: { blockHeight: number; eventIndex: number; who: string },
  swaps: Array<{ blockHeight: number; eventIndex: number; who: string; assetIn: number; assetOut: number }>,
): { assetIn: number; assetOut: number } | null {
  const candidates = swaps
    .filter(swap => swap.blockHeight === first.blockHeight && swap.eventIndex < first.eventIndex && swap.who === first.who)
    .sort((a, b) => a.eventIndex - b.eventIndex)
  const hit = candidates[candidates.length - 1]
  return hit && (hit.assetIn || hit.assetOut) ? { assetIn: hit.assetIn, assetOut: hit.assetOut } : null
}

/** Per pre-router schedule id, whatever of its order could be recovered. */
async function recoverLegacyOrders(client: ClickHouseClient, legacy: LegacyScheduleRef[]): Promise<Map<string, DcaLegacyOrder>> {
  const out = new Map<string, DcaLegacyOrder>()
  const addressable = legacy.filter(row => row.extrinsic_index != null)
  if (addressable.length) {
    const res = await client.query({
      // `call_address = 'root'` is the extrinsic's own outermost call: a batch or proxy
      // wrapper is not a DCA.schedule, and pretending otherwise would read a sibling
      // schedule's order.
      //
      // raw_calls is a ReplacingMergeTree, so the newest ingest wins explicitly —
      // the same argMax(…, ingested_at) pattern trades.ts uses on raw_extrinsics. A
      // replay normally re-inserts identical args, but a re-DECODE would not, and
      // without this the winner would be whichever part the scan reached first.
      query: `
          SELECT block_height, extrinsic_index, argMax(args_json, ingested_at) AS args_json
          FROM price_data.raw_calls
          WHERE block_height IN {blocks:Array(UInt32)}
            AND toUInt64(block_height) * {stride:UInt64} + extrinsic_index IN {keys:Array(UInt64)}
            AND call_name = {scheduleCall:String} AND call_address = 'root'
          GROUP BY block_height, extrinsic_index`,
      query_params: {
        blocks: [...new Set(addressable.map(row => Number(row.block_height)))],
        keys: addressable.map(row => callKey(Number(row.block_height), Number(row.extrinsic_index))),
        stride: INDEX_STRIDE,
        scheduleCall: SCHEDULE_CALL,
      },
      format: 'JSONEachRow',
    })
    const byKey = new Map<number, DcaLegacyOrder>()
    for (const row of await res.json<{ block_height: number; extrinsic_index: number; args_json: string }>()) {
      const order = legacyOrderFromCallArgs(row.args_json)
      if (order) byKey.set(callKey(Number(row.block_height), Number(row.extrinsic_index)), order)
    }
    for (const row of addressable) {
      const order = byKey.get(callKey(Number(row.block_height), Number(row.extrinsic_index!)))
      if (order) out.set(String(row.id), order)
    }
  }

  // Whatever the calls could not answer: the pair alone, from the first execution.
  const remaining = legacy.filter(row => !out.has(String(row.id)))
  if (!remaining.length) return out
  const ids = remaining.map(row => Number(row.id))
  const firstRes = await client.query({
    // `id` is the last column of dca_events' sorting key, so this is a narrow pass
    // rather than a key lookup — one grouped read for the whole set, never one each.
    query: `
        SELECT toString(id) AS id, min(block_height) AS bh,
               argMin(event_index, (block_height, event_index)) AS ei,
               argMin(who, (block_height, event_index)) AS who
        FROM price_data.dca_events
        WHERE id IN {ids:Array(UInt64)} AND event_name = 'DCA.TradeExecuted'
        GROUP BY id`,
    query_params: { ids },
    format: 'JSONEachRow',
  })
  const firsts = (await firstRes.json<{ id: string; bh: number; ei: number; who: string }>())
    .map(row => ({ id: String(row.id), blockHeight: Number(row.bh), eventIndex: Number(row.ei), who: row.who }))
  if (!firsts.length) return out

  const swapRes = await client.query({
    // raw_events replaces on (block_height, event_index) too, so the newest decode of
    // each event wins rather than an arbitrary one; the extract runs on the winner.
    query: `
        SELECT block_height, event_index,
               JSONExtractString(args, 'who') AS who,
               toUInt32(greatest(0, JSONExtractInt(args, 'assetIn'))) AS asset_in,
               toUInt32(greatest(0, JSONExtractInt(args, 'assetOut'))) AS asset_out
        FROM (
          SELECT block_height, event_index, argMax(args_json, ingested_at) AS args
          FROM price_data.raw_events
          WHERE block_height IN {blocks:Array(UInt32)} AND event_name IN {swapEvents:Array(String)}
          GROUP BY block_height, event_index
        )`,
    query_params: { blocks: [...new Set(firsts.map(row => row.blockHeight))], swapEvents: SWAP_EVENTS },
    format: 'JSONEachRow',
  })
  const swaps = (await swapRes.json<{ block_height: number; event_index: number; who: string; asset_in: number; asset_out: number }>())
    .map(row => ({
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      who: row.who,
      assetIn: Number(row.asset_in),
      assetOut: Number(row.asset_out),
    }))
  for (const first of firsts) {
    const pair = pickPairFromFirstExecution(first, swaps)
    // Pair only: a swap leg says nothing about the schedule's budget or cadence, so the
    // terms stay UNKNOWN and reach the wire as null.
    if (pair) out.set(first.id, { ...pair, termsKnown: false, amountPer: '', totalAmount: '', period: 0 })
  }
  return out
}

export interface DcaErrorState {
  kind: string
  error: string
  index: number
}

/**
 * The failure of a DCA.TradeFailed attempt, in the shape the UI parses.
 *
 * `error` holds the raw DispatchError JSON the MV decoded. A Module error names a
 * pallet index and an error byte string ({kind:'Module', error:'0x0c000000',
 * index:66}); every other kind is self-describing, so its sub-kind travels in
 * `error` and `index` is 0 — the pallet index is not invented.
 */
export function parseDcaErrorState(error: string | null | undefined): DcaErrorState | null {
  const raw = (error ?? '').trim()
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const record = parsed as Record<string, unknown> | null
  const kind = typeof record?.__kind === 'string' ? record.__kind : null
  if (!kind) return null
  const value = record?.value as Record<string, unknown> | undefined
  if (kind === 'Module') {
    const index = Number(value?.index)
    return { kind, error: typeof value?.error === 'string' ? value.error : '', index: Number.isInteger(index) ? index : 0 }
  }
  return { kind, error: typeof value?.__kind === 'string' ? value.__kind : kind, index: 0 }
}

export interface DcaScheduleRow {
  scheduleId: number
  owner: string
  assetIn: string
  assetOut: string
  /**
   * The registered terms, or null when they are UNKNOWN — a pre-router schedule whose
   * order could not be recovered (see "Pre-router schedules" above). Null is never
   * "no budget": `budget: "0"` with `isRollingBudget: true` is a schedule that really
   * set no cap, and only those four fields can be null together.
   */
  singleTradeAmount: string | null
  budget: string | null
  isRollingBudget: boolean | null
  executedAmountIn: string
  executedAmountOut: string
  periodBlocks: number | null
  status: DcaStatus
  createdAt: string
  createdAtBlock: number
  lastEventAt: string | null
}

export interface DcaSchedulesOptions {
  /** Required: the whole owner's set is computed, which is what keeps the path bounded. */
  owner: string
  statuses: DcaStatus[]
  assets: string[]
  limit: number
  offset: number
}

interface ScheduleSqlRow {
  id: string
  block_height: number
  extrinsic_index: number | null
  ts: string
  who: string
  asset_in: number
  asset_out: number
  direction: string
  amount_per: string
  total_amount: string
  period: number
}

interface AggregateSqlRow {
  id: string
  completed: number
  terminated: number
  terminated_signed: number
  last_exec: string
  last_at: string
  executed_in: string
  executed_out: string
}

/** Raw on-chain amounts stay integer strings end to end; anything else reads as 0. */
function rawAmount(value: unknown): string {
  const input = String(value ?? '').trim()
  return /^\d+$/.test(input) ? input : '0'
}

/**
 * A pre-router row with whatever its order recovery found folded in. An empty
 * recovered field leaves the stored one alone: the pair-only path knows nothing about
 * the schedule's budget or cadence, and reporting a swap-derived guess there would be
 * worse than the honest zero.
 */
function applyLegacyOrder(row: ScheduleSqlRow, order: DcaLegacyOrder | undefined): ScheduleSqlRow {
  if (!order) return row
  return {
    ...row,
    asset_in: order.assetIn,
    asset_out: order.assetOut,
    amount_per: order.amountPer || row.amount_per,
    total_amount: order.totalAmount || row.total_amount,
    period: order.period || row.period,
  }
}

/**
 * One owner's schedules with their status, newest activity first.
 *
 * The status is computed in TypeScript from the schedule's own events, so the
 * `status` filter cannot be pushed into SQL. It is therefore applied to the owner's
 * WHOLE set before the page is cut — filtering after a LIMIT would make page 2
 * depend on how many rows page 1 happened to drop. That is affordable precisely
 * because `owner` is required: an owner has tens of schedules, not millions.
 */
export async function queryDcaSchedules(
  client: ClickHouseClient,
  options: DcaSchedulesOptions,
): Promise<{ items: DcaScheduleRow[]; totalCount: number }> {
  // Both halves of an EVM identity, exactly as the accounts endpoints resolve them.
  const accounts = await resolveSingleAccountForms(client, options.owner)
  const schedRes = await client.query({
    // FINAL: dca_schedules replaces on `id`, and one row per schedule is the
    // premise of everything below. The table is small (tens of thousands of rows)
    // and `who` is not part of its key, so this is a bounded full pass by design.
    query: `
        SELECT toString(id) AS id, block_height, extrinsic_index, toString(block_timestamp) AS ts, who,
               asset_in, asset_out, direction, amount_per, total_amount, period
        FROM price_data.dca_schedules FINAL
        WHERE who IN {accounts:Array(String)}`,
    query_params: { accounts },
    format: 'JSONEachRow',
  })
  const schedules = await schedRes.json<ScheduleSqlRow>()
  if (!schedules.length) return { items: [], totalCount: 0 }

  // Pre-router rows first: the recovered order is what the asset filter, the pair and
  // the terms below are read from, so recovering after filtering would answer a filter
  // on the real asset with nothing and match every legacy row on HDX.
  const legacy = schedules.filter(row => row.direction === LEGACY_ORDER_MARKER)
  const recovered = legacy.length ? await recoverLegacyOrders(client, legacy) : new Map<string, DcaLegacyOrder>()

  const aggregates = await scheduleEventAggregates(client, schedules.map(row => Number(row.id)))
  const assets = new Set(options.assets.map(Number).filter(Number.isInteger))
  const wanted = new Set(options.statuses)

  const rows: DcaScheduleRow[] = []
  for (const raw of schedules) {
    const order = recovered.get(String(raw.id))
    const schedule = applyLegacyOrder(raw, order)
    // A pre-router row's blank terms are the ABSENCE of the event's payload, not a
    // schedule that set no budget and no cadence. Unless the recovery supplied them,
    // they are unknown, and the wire says so with null instead of inheriting a zero
    // that `isRollingBudget` would turn into a positive claim.
    const termsKnown = raw.direction !== LEGACY_ORDER_MARKER || (order?.termsKnown ?? false)
    if (assets.size && !assets.has(Number(schedule.asset_in)) && !assets.has(Number(schedule.asset_out))) continue
    const aggregate = aggregates.get(String(schedule.id))
    const status = computeDcaStatus({
      hasCompleted: Number(aggregate?.completed ?? 0) > 0,
      hasTerminated: Number(aggregate?.terminated ?? 0) > 0,
      terminatedByExtrinsic: aggregate && Number(aggregate.terminated) > 0 ? Number(aggregate.terminated_signed) > 0 : null,
      lastExecEventName: aggregate?.last_exec || null,
    })
    if (wanted.size && !wanted.has(status)) continue
    rows.push({
      scheduleId: Number(schedule.id),
      owner: schedule.who,
      assetIn: String(schedule.asset_in),
      assetOut: String(schedule.asset_out),
      singleTradeAmount: termsKnown ? rawAmount(schedule.amount_per) : null,
      budget: termsKnown ? rawAmount(schedule.total_amount) : null,
      // A schedule with no budget spends whatever the owner holds, one trade at a time.
      isRollingBudget: termsKnown ? rawAmount(schedule.total_amount) === '0' : null,
      executedAmountIn: rawAmount(aggregate?.executed_in),
      executedAmountOut: rawAmount(aggregate?.executed_out),
      periodBlocks: termsKnown ? Number(schedule.period) : null,
      status,
      createdAt: iso(schedule.ts),
      createdAtBlock: Number(schedule.block_height),
      lastEventAt: aggregate?.last_at ? iso(aggregate.last_at) : null,
    })
  }
  // Most recently touched first. A schedule with no events yet sorts last, and the
  // id breaks every tie, so the order is total and a page boundary is stable.
  rows.sort((a, b) => (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? '') || b.scheduleId - a.scheduleId)
  return { items: rows.slice(options.offset, options.offset + options.limit), totalCount: rows.length }
}

/**
 * Per-schedule event facts for a set of ids, in one grouped read.
 *
 * `id` is the last column of dca_events' sorting key, so this is a full pass over a
 * narrow projection rather than a key lookup — measured at ~12 ms for 5.7 M rows,
 * which is why the page is enriched in ONE query instead of one per schedule. The
 * inner LIMIT 1 BY deduplicates the ReplacingMergeTree before the sums: a replayed
 * range would otherwise double every executed amount.
 */
async function scheduleEventAggregates(client: ClickHouseClient, ids: number[]): Promise<Map<string, AggregateSqlRow>> {
  const res = await client.query({
    query: `
        SELECT toString(id) AS id,
          max(event_name = {completed:String}) AS completed,
          max(event_name = {terminated:String}) AS terminated,
          -- A DCA.Terminated event inside a signed extrinsic is the owner's own
          -- dca.terminate call; from a block hook it is the pallet giving up.
          max(event_name = {terminated:String} AND extrinsic_index IS NOT NULL) AS terminated_signed,
          argMaxIf(event_name, (block_height, event_index), event_name IN {executionEvents:Array(String)}) AS last_exec,
          toString(max(block_timestamp)) AS last_at,
          toString(sumIf(toUInt256OrZero(amount_in), event_name = 'DCA.TradeExecuted')) AS executed_in,
          toString(sumIf(toUInt256OrZero(amount_out), event_name = 'DCA.TradeExecuted')) AS executed_out
        FROM (
          SELECT id, event_name, block_height, event_index, extrinsic_index, block_timestamp, amount_in, amount_out
          FROM price_data.dca_events
          WHERE id IN {ids:Array(UInt64)}
          LIMIT 1 BY event_name, block_height, event_index, id
        )
        GROUP BY id`,
    query_params: {
      ids,
      completed: COMPLETED_EVENT,
      terminated: TERMINATED_EVENT,
      executionEvents: [...EXECUTION_EVENTS],
    },
    format: 'JSONEachRow',
  })
  return new Map((await res.json<AggregateSqlRow>()).map(row => [String(row.id), row]))
}

export interface DcaExecutionRow {
  status: 'executed' | 'failed' | 'planned'
  amountIn: string | null
  amountOut: string | null
  blockHeight: number
  eventIndex: number
  timestamp: string
  errorState: DcaErrorState | null
}

export interface DcaExecutionsPage {
  items: DcaExecutionRow[]
  totalCount: number
  assetIn: string
  assetOut: string
}

/**
 * One schedule's executions, newest first, or null when the schedule was never
 * indexed. Planned executions are rows of the same feed: a schedule's next attempt
 * is part of its history, and the wire `status` says which is which.
 */
export async function queryDcaExecutions(
  client: ClickHouseClient,
  scheduleId: number,
  options: { limit: number; offset: number },
): Promise<DcaExecutionsPage | null> {
  // Numeric, not string: the client quotes a string array, which ClickHouse
  // cannot read as Array(UInt64).
  const ids = [scheduleId]
  const [schedRes, pageRes, totalRes] = await Promise.all([
    client.query({
      query: `
          SELECT toString(id) AS id, block_height, extrinsic_index, asset_in, asset_out, direction
          FROM price_data.dca_schedules FINAL
          WHERE id IN {ids:Array(UInt64)}`,
      query_params: { ids },
      format: 'JSONEachRow',
    }),
    client.query({
      // LIMIT 1 BY the model's own replacement key, then page: a replayed range
      // must not shift a page by a duplicate row.
      query: `
          SELECT event_name, block_height, event_index, toString(block_timestamp) AS ts,
                 amount_in, amount_out, error
          FROM (
            SELECT event_name, block_height, event_index, id, block_timestamp, amount_in, amount_out, error
            FROM price_data.dca_events
            WHERE id IN {ids:Array(UInt64)} AND event_name IN {executionEvents:Array(String)}
            LIMIT 1 BY event_name, block_height, event_index, id
          )
          ORDER BY block_height DESC, event_index DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      query_params: { ids, executionEvents: [...EXECUTION_EVENTS], limit: options.limit, offset: options.offset },
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
          SELECT toString(uniqExact((event_name, block_height, event_index))) AS total
          FROM price_data.dca_events
          WHERE id IN {ids:Array(UInt64)} AND event_name IN {executionEvents:Array(String)}`,
      query_params: { ids, executionEvents: [...EXECUTION_EVENTS] },
      format: 'JSONEachRow',
    }),
  ])
  interface ScheduleHeadRow { id: string; block_height: number; extrinsic_index: number | null; asset_in: number; asset_out: number; direction: string }
  const schedule = (await schedRes.json<ScheduleHeadRow>())[0]
  if (!schedule) return null
  // A pre-router schedule stored no pair, and the wire pair is what labels every
  // amount below: without this the UI reads a WETH->HDX schedule as HDX->HDX.
  const pair = schedule.direction === LEGACY_ORDER_MARKER
    ? (await recoverLegacyOrders(client, [schedule])).get(String(schedule.id)) ?? null
    : null

  interface ExecutionSqlRow {
    event_name: string
    block_height: number
    event_index: number
    ts: string
    amount_in: string
    amount_out: string
    error: string
  }
  const items = (await pageRes.json<ExecutionSqlRow>()).map(row => {
    const status = EXECUTION_STATUS[row.event_name] ?? 'planned'
    // A failed or still-planned attempt traded nothing, so its amounts are null
    // rather than a zero standing in for one.
    const executed = status === 'executed'
    return {
      status,
      amountIn: executed ? rawAmount(row.amount_in) : null,
      amountOut: executed ? rawAmount(row.amount_out) : null,
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      timestamp: iso(row.ts),
      errorState: parseDcaErrorState(row.error),
    }
  })
  return {
    items,
    totalCount: Number((await totalRes.json<{ total: string }>())[0]?.total ?? 0),
    assetIn: String(pair?.assetIn ?? schedule.asset_in),
    assetOut: String(pair?.assetOut ?? schedule.asset_out),
  }
}
