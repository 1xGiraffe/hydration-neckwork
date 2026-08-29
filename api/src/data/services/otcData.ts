import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { iso } from '../schemas/common.ts'
import { accountRefOrNull, type AccountRef } from './address.ts'
import { liveHeadTag } from './head.ts'

// OTC reads for /v1/otc/*. Order state folds from otc_order_events at read
// time (the public API's foldOtcOrder rule, restated locally — the data tree
// may not import public/): open until a terminal event, then filled or
// cancelled; partial fills never end an order.
//
// The whole event table is ~4.6k rows for ~1.6k orders (measured live), so the
// directory fold reads it once per head behind a short cache, deduplicates the
// replay identity in TS (no unbounded FINAL), and pages the fold in memory.
//
// Consumer warning, normative: the pair/size/partiallyFillable fields are
// populated ONLY on an order's Placed row — on every other row an absent field
// defaults to 0, which is also HDX's real asset id, so they are never read
// from a fill or cancel row. An order whose placement is not indexed has no
// knowable pair and is not listed. `owner` does not exist on this surface at
// all: OTC.Placed does not carry it, and the placing extrinsic's signatory
// would be wrong for a proxied or batched placement.

export type OtcOrderStatus = 'open' | 'filled' | 'cancelled'
export type OtcEventType = 'placed' | 'filled' | 'partiallyFilled' | 'cancelled'

export interface OtcOrderEventItem {
  type: OtcEventType
  blockHeight: number
  eventIndex: number
  timestamp: string
  amountIn: string | null
  amountOut: string | null
  filler: AccountRef | null
}

export interface OtcOrderItem {
  orderId: number
  assetIn: string
  assetOut: string
  amountIn: string
  amountOut: string
  partiallyFillable: boolean
  status: OtcOrderStatus
  filledAmountIn: string
  filledAmountOut: string
  placedAtBlock: number
  placedAt: string
}

export interface OtcOrderDetail extends OtcOrderItem {
  events: OtcOrderEventItem[]
}

interface EventRow {
  order_id: number
  event_name: string
  asset_in: number
  asset_out: number
  amount_in: string
  amount_out: string
  partially_fillable: number
  filler: string
  block_height: number
  event_index: number
  ts: string
}

const EVENT_TYPES: Record<string, OtcEventType> = {
  Placed: 'placed',
  Filled: 'filled',
  PartiallyFilled: 'partiallyFilled',
  Cancelled: 'cancelled',
}

// The wire `type` of an OTC.* event name; null for a name outside the vocabulary.
export function otcEventType(eventName: string): OtcEventType | null {
  return EVENT_TYPES[eventName] ?? null
}

function rawAmount(value: unknown): string | null {
  const input = String(value ?? '').trim()
  return /^\d+$/.test(input) ? input : null
}

export function foldOtcOrder(orderId: number, rows: EventRow[]): OtcOrderDetail | null {
  const ordered = [...rows].sort((a, b) => Number(a.block_height) - Number(b.block_height) || Number(a.event_index) - Number(b.event_index))
  const placed = ordered.find(row => row.event_name === 'Placed')
  if (!placed) return null

  let status: OtcOrderStatus = 'open'
  let filledIn = 0n
  let filledOut = 0n
  const events: OtcOrderEventItem[] = []
  for (const row of ordered) {
    const type = EVENT_TYPES[row.event_name]
    if (!type) continue
    if (type === 'filled') status = 'filled'
    if (type === 'cancelled') status = 'cancelled'
    const amountIn = rawAmount(row.amount_in)
    const amountOut = rawAmount(row.amount_out)
    if (type === 'filled' || type === 'partiallyFilled') {
      filledIn += BigInt(amountIn ?? '0')
      filledOut += BigInt(amountOut ?? '0')
    }
    events.push({
      type,
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      timestamp: iso(row.ts),
      amountIn: type === 'placed' || type === 'filled' || type === 'partiallyFilled' ? amountIn : null,
      amountOut: type === 'placed' || type === 'filled' || type === 'partiallyFilled' ? amountOut : null,
      filler: type === 'filled' || type === 'partiallyFilled' ? accountRefOrNull(row.filler) : null,
    })
  }

  return {
    orderId,
    assetIn: String(placed.asset_in),
    assetOut: String(placed.asset_out),
    amountIn: rawAmount(placed.amount_in) ?? '0',
    amountOut: rawAmount(placed.amount_out) ?? '0',
    partiallyFillable: Number(placed.partially_fillable) === 1,
    status,
    filledAmountIn: filledIn.toString(),
    filledAmountOut: filledOut.toString(),
    placedAtBlock: Number(placed.block_height),
    placedAt: iso(placed.ts),
    events,
  }
}

const EVENT_COLUMNS_SQL = `
      order_id, event_name, asset_in, asset_out, amount_in, amount_out, partially_fillable, filler,
      block_height, event_index, toString(block_timestamp) AS ts`

function dedupEvents(rows: (EventRow & { ingested_at?: string })[]): EventRow[] {
  const seen = new Set<string>()
  const out: EventRow[] = []
  for (const row of rows) {
    const key = `${row.order_id}:${row.block_height}:${row.event_index}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

// Every order's fold, newest order first — one whole-table read per head
// behind the cache; the routes filter and page over this.
export async function allOtcOrders(client: ClickHouseClient): Promise<OtcOrderDetail[]> {
  const head = await liveHeadTag(client)
  return cached(`data:otc:orders:${head}`, 5_000, async () => {
    const res = await client.query({
      query: `-- data:otc:orders
          SELECT ${EVENT_COLUMNS_SQL}, ingested_at
          FROM price_data.otc_order_events
          ORDER BY order_id, block_height, event_index, ingested_at DESC`,
      format: 'JSONEachRow',
    })
    const byOrder = new Map<number, EventRow[]>()
    for (const row of dedupEvents(await res.json<EventRow & { ingested_at: string }>())) {
      const id = Number(row.order_id)
      const bucket = byOrder.get(id)
      if (bucket) bucket.push(row)
      else byOrder.set(id, [row])
    }
    const orders: OtcOrderDetail[] = []
    for (const [orderId, rows] of byOrder) {
      const folded = foldOtcOrder(orderId, rows)
      if (folded) orders.push(folded)
    }
    return orders.sort((a, b) => b.orderId - a.orderId)
  })
}

// One order's fold, from its own key range (fresh, uncached — a watched order).
export async function otcOrderById(client: ClickHouseClient, orderId: number): Promise<OtcOrderDetail | null> {
  const res = await client.query({
    query: `-- data:otc:order-by-id
        SELECT ${EVENT_COLUMNS_SQL}, ingested_at
        FROM price_data.otc_order_events
        WHERE order_id = {orderId:UInt32}
        ORDER BY block_height, event_index, ingested_at DESC`,
    query_params: { orderId },
    format: 'JSONEachRow',
  })
  return foldOtcOrder(orderId, dedupEvents(await res.json<EventRow & { ingested_at: string }>()))
}
