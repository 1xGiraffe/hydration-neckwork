import type { ClickHouseClient } from '../../db/client.ts'
import { attachExtrinsicHashes, type WithExtrinsicHash } from './extrinsicHashes.ts'
import { iso } from '../schemas/common.ts'
import { renderUsd } from '../../services/valuation.ts'
import { accountRefOrNull, type AccountRef } from './address.ts'
import { eventTimePricer } from './eventTimePrices.ts'
import { DEDUP_SLACK, dedupPage, orderSql, positionCursorSql, windowSql, type Order, type PositionCursor, type WindowFilters } from './feed.ts'

// Asset-first activity feeds for /v1/assets/{id}/transfers and /swaps, over
// transfer_activity and asset_swap_activity — both keyed (asset_id,
// block_height, event_index), so a page is a key-range read at any depth of
// one asset's history.

export interface AssetFeedOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
}

export interface AssetTransferItem {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  eventName: string
  from: AccountRef | null
  to: AccountRef | null
  amount: string
  valueUsd: string | null
}

export async function assetTransfers(client: ClickHouseClient, assetId: number, options: AssetFeedOptions): Promise<{ items: Array<WithExtrinsicHash<AssetTransferItem>>; hasMore: boolean }> {
  const params: Record<string, unknown> = { assetId, bound: options.limit + 1 + DEDUP_SLACK }
  const res = await client.query({
    query: `-- data:assets:transfers
        SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, from_account, to_account, amount
        FROM price_data.transfer_activity
        WHERE asset_id = {assetId:UInt32}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; ts: string; event_name: string; from_account: string; to_account: string; amount: string }>(),
    row => `${row.block_height}:${row.event_index}`,
    options.limit,
  )
  // Event-time USD for the page: one closes read over the asset and the span.
  const times = page.map(row => Math.floor(Date.parse(iso(row.ts)) / 1000))
  const pricer = page.length ? await eventTimePricer(client, [assetId], Math.min(...times), Math.max(...times)) : null
  return {
    items: await attachExtrinsicHashes(client, page.map((row, i) => {
      const usd = pricer?.usdAt(assetId, BigInt(String(row.amount || '0') || '0'), times[i]) ?? null
      return {
        blockHeight: Number(row.block_height),
        eventIndex: Number(row.event_index),
        extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
        timestamp: iso(row.ts),
        eventName: row.event_name,
        from: accountRefOrNull(row.from_account),
        to: accountRefOrNull(row.to_account),
        amount: row.amount,
        valueUsd: usd == null ? null : renderUsd(usd),
      }
    })),
    hasMore,
  }
}

export interface AssetSwapItem {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  eventName: string
  who: AccountRef | null
  assetIn: string
  assetOut: string
  amountIn: string
  amountOut: string
}

export async function assetSwaps(client: ClickHouseClient, assetId: number, options: AssetFeedOptions): Promise<{ items: Array<WithExtrinsicHash<AssetSwapItem>>; hasMore: boolean }> {
  const params: Record<string, unknown> = { assetId, bound: options.limit + 1 + DEDUP_SLACK }
  const res = await client.query({
    query: `-- data:assets:swaps
        SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, who, asset_in, asset_out, amount_in, amount_out
        FROM price_data.asset_swap_activity
        WHERE asset_id = {assetId:UInt32}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; ts: string; event_name: string; who: string; asset_in: number; asset_out: number; amount_in: string; amount_out: string }>(),
    row => `${row.block_height}:${row.event_index}`,
    options.limit,
  )
  return {
    items: await attachExtrinsicHashes(client, page.map(row => ({
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
      timestamp: iso(row.ts),
      eventName: row.event_name,
      who: accountRefOrNull(row.who),
      assetIn: String(row.asset_in),
      assetOut: String(row.asset_out),
      amountIn: row.amount_in,
      amountOut: row.amount_out,
    }))),
    hasMore,
  }
}
