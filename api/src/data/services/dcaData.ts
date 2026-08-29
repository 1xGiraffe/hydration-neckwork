import type { ClickHouseClient } from '../../db/client.ts'
import { iso } from '../schemas/common.ts'
import { accountRefFor, type AccountRef } from './address.ts'
import { DEDUP_SLACK, dedupPage, orderSql, positionCursorSql, windowSql, type Order, type PositionCursor, type WindowFilters } from './feed.ts'

// DCA reads for /v1/dca/*. Schedules are keyed by id (a point read / an id
// cursor); a schedule's events are reached OWNER-FIRST through
// dca_events_by_account — dca_events itself is keyed (event_name, block,
// event, id), so a per-id read of it cannot prune, while the by-account twin
// makes it a key-range read within one owner's rows.
//
// This surface publishes the schedule AS STORED. Pre-router schedules
// (DCA.Scheduled carried only {id, who} before the router era; 2,354 rows,
// exactly the rows with direction = '') have NO recorded order, so their pair
// and terms are null — never the stored zeros, which would read as an
// HDX→HDX schedule with a zero budget (asset id 0 IS HDX). The explorer/public
// surfaces recover some of those orders from the scheduling call; this
// contract reports indexed facts and says so.

export interface DcaScheduleItem {
  scheduleId: number
  owner: AccountRef
  assetIn: string | null
  assetOut: string | null
  direction: 'sell' | 'buy' | null
  amountPer: string | null
  totalAmount: string | null
  periodBlocks: number | null
  maxRetries: number
  createdAt: string
  createdAtBlock: number
}

interface ScheduleRow {
  id: string | number
  block_height: number
  ts: string
  who: string
  asset_in: number
  asset_out: number
  direction: string
  amount_per: string
  total_amount: string
  period: number
  max_retries: number
}

const SCHEDULE_COLUMNS_SQL = `
      id, block_height, toString(block_timestamp) AS ts, who, asset_in, asset_out,
      direction, amount_per, total_amount, period, max_retries`

function scheduleItem(row: ScheduleRow): DcaScheduleItem {
  const preRouter = row.direction === ''
  return {
    scheduleId: Number(row.id),
    owner: accountRefFor(row.who),
    assetIn: preRouter ? null : String(row.asset_in),
    assetOut: preRouter ? null : String(row.asset_out),
    direction: preRouter ? null : (row.direction.toLowerCase() as 'sell' | 'buy'),
    amountPer: preRouter ? null : row.amount_per,
    totalAmount: preRouter ? null : row.total_amount,
    periodBlocks: preRouter ? null : Number(row.period),
    maxRetries: Number(row.max_retries),
    createdAt: iso(row.ts),
    createdAtBlock: Number(row.block_height),
  }
}

export interface SchedulesPageOptions {
  limit: number
  order: Order
  cursorId: number | null
  ownerAccountId?: string
}

export async function dcaSchedules(client: ClickHouseClient, options: SchedulesPageOptions): Promise<{ items: DcaScheduleItem[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { bound: options.limit + 1 + DEDUP_SLACK }
  const clauses: string[] = []
  if (options.ownerAccountId) { clauses.push('who = {owner:String}'); params.owner = options.ownerAccountId }
  if (options.cursorId != null) {
    clauses.push(`id ${options.order === 'desc' ? '<' : '>'} {cursorId:UInt64}`)
    params.cursorId = options.cursorId
  }
  const res = await client.query({
    query: `-- data:dca:schedules
        SELECT ${SCHEDULE_COLUMNS_SQL}
        FROM price_data.dca_schedules
        WHERE ${clauses.length ? clauses.join(' AND ') : '1 = 1'}
        ORDER BY id ${options.order === 'desc' ? 'DESC' : 'ASC'}, block_height DESC
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const seen = new Set<string>()
  const deduped: ScheduleRow[] = []
  for (const row of await res.json<ScheduleRow>()) {
    const key = String(row.id)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(row)
  }
  return { items: deduped.slice(0, options.limit).map(scheduleItem), hasMore: deduped.length > options.limit }
}

export async function dcaScheduleById(client: ClickHouseClient, id: number): Promise<DcaScheduleItem | null> {
  const res = await client.query({
    query: `-- data:dca:schedule-by-id
        SELECT ${SCHEDULE_COLUMNS_SQL}
        FROM price_data.dca_schedules FINAL
        WHERE id = {id:UInt64}
        LIMIT 1`,
    query_params: { id },
    format: 'JSONEachRow',
  })
  const [row] = await res.json<ScheduleRow>()
  return row ? scheduleItem(row) : null
}

// ---------------------------------------------------------------------------
// Executions and lifecycle events of one schedule, owner-first. A schedule's
// history is NOT bounded in practice — the treasury buyback (#30104) holds
// 370k+ events, past the client's 100k-row cap — so nothing here reads a
// schedule whole: the detail aggregates fold in SQL and the executions feed is
// a cursor page, both key-range reads within the owner's rows.
// ---------------------------------------------------------------------------

export type DcaExecutionStatus = 'executed' | 'failed' | 'planned' | 'completed' | 'terminated'

// The complete event vocabulary of the DCA pallet as indexed (pinned against
// the live table: exactly these five names).
const EVENT_STATUS: Record<string, DcaExecutionStatus> = {
  'DCA.TradeExecuted': 'executed',
  'DCA.TradeFailed': 'failed',
  'DCA.ExecutionPlanned': 'planned',
  'DCA.Completed': 'completed',
  'DCA.Terminated': 'terminated',
}

export interface DcaExecutionItem {
  status: DcaExecutionStatus
  blockHeight: number
  eventIndex: number
  timestamp: string
  amountIn: string | null
  amountOut: string | null
  error: string | null
}

export interface DcaExecutionsOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
}

export async function dcaScheduleExecutions(client: ClickHouseClient, ownerAccountId: string, id: number, options: DcaExecutionsOptions): Promise<{ items: DcaExecutionItem[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { owner: ownerAccountId, id, bound: options.limit + 1 + DEDUP_SLACK }
  const res = await client.query({
    query: `-- data:dca:schedule-executions
        SELECT event_name, block_height, event_index, toString(block_timestamp) AS ts, amount_in, amount_out, error
        FROM price_data.dca_events_by_account
        WHERE who = {owner:String} AND id = {id:UInt64}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<{ event_name: string; block_height: number; event_index: number; ts: string; amount_in: string; amount_out: string; error: string }>(),
    row => `${row.block_height}:${row.event_index}`,
    options.limit,
  )
  const items: DcaExecutionItem[] = []
  for (const row of page) {
    const status = EVENT_STATUS[row.event_name]
    if (!status) continue
    const executed = status === 'executed'
    items.push({
      status,
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      timestamp: iso(row.ts),
      amountIn: executed && /^\d+$/.test(row.amount_in) ? row.amount_in : null,
      amountOut: executed && /^\d+$/.test(row.amount_out) ? row.amount_out : null,
      error: row.error || null,
    })
  }
  return { items, hasMore }
}

export interface DcaScheduleAggregates {
  executedAmountIn: string
  executedAmountOut: string
  executionCount: number
  failureCount: number
  completed: boolean
  terminated: boolean
  lastEventAt: string | null
}

// The detail's lifetime aggregates, folded by ClickHouse over the schedule's
// own rows (FINAL collapses replays; the owner predicate keeps it bounded).
export async function dcaScheduleAggregates(client: ClickHouseClient, ownerAccountId: string, id: number): Promise<DcaScheduleAggregates> {
  const res = await client.query({
    query: `-- data:dca:schedule-aggregates
        SELECT toUInt64(countIf(event_name = 'DCA.TradeExecuted')) AS executed,
               toString(sumIf(toUInt256OrZero(amount_in), event_name = 'DCA.TradeExecuted')) AS in_sum,
               toString(sumIf(toUInt256OrZero(amount_out), event_name = 'DCA.TradeExecuted')) AS out_sum,
               toUInt64(countIf(event_name = 'DCA.TradeFailed')) AS failed,
               toUInt8(countIf(event_name = 'DCA.Completed') > 0) AS completed,
               toUInt8(countIf(event_name = 'DCA.Terminated') > 0) AS terminated,
               toString(max(block_timestamp)) AS last_ts,
               toUInt64(count()) AS n
        FROM price_data.dca_events_by_account FINAL
        WHERE who = {owner:String} AND id = {id:UInt64}`,
    query_params: { owner: ownerAccountId, id },
    format: 'JSONEachRow',
  })
  const [row] = await res.json<{ executed: string; in_sum: string; out_sum: string; failed: string; completed: number; terminated: number; last_ts: string; n: string }>()
  const count = Number(row?.n ?? 0)
  return {
    executedAmountIn: String(row?.in_sum ?? '0'),
    executedAmountOut: String(row?.out_sum ?? '0'),
    executionCount: Number(row?.executed ?? 0),
    failureCount: Number(row?.failed ?? 0),
    completed: Number(row?.completed ?? 0) === 1,
    terminated: Number(row?.terminated ?? 0) === 1,
    lastEventAt: count > 0 ? iso(row.last_ts) : null,
  }
}

export interface DcaScheduleDetail extends DcaScheduleItem, DcaScheduleAggregates {}
