import type { ClickHouseClient } from '../../db/client.ts'
import { attachExtrinsicHashes, type WithExtrinsicHash } from './extrinsicHashes.ts'
import { iso } from '../schemas/common.ts'
import { accountRefOrNull, type AccountRef } from './address.ts'
import { DEDUP_SLACK, dedupPage, orderSql, positionCursorSql, versionedPageSql, type Order, type PositionCursor } from './feed.ts'

// The global XCM flow feed for /v1/xcm/transfers, over xcm_event_activity.
// That table's key is (event_name, asset_id, block_height, event_index) — NOT
// time-first — so a time-ordered global read cannot use the key and is bounded
// by the WINDOW instead (partition pruning): measured live, one day holds
// ~147k rows and counts in ~170 ms.
//
// Direction is a NAME-SET classification, pinned against the feeding MV
// (003_materialized_views.sql, xcm_event_activity_mv) and measured live:
//
//  * `out` — the explicit send events, which name the sender and assets:
//    XTokens.TransferredAssets (current era), XTokens.TransferredMultiAssets
//    (pre-MessageQueue era), PolkadotXcm.Sent.
//  * `in` — the deposit-family events in HOOK context (extrinsic_index IS
//    NULL): the same rows the explorer's inbound-XCM walk consumes. This is a
//    SUPERSET of true XCM arrivals — any block-hook credit (a scheduler
//    payout, a fee sweep) lands in hook context too — and the walk's
//    MessageQueue barrier pairing that disambiguates them is per-block context
//    a flat feed cannot reproduce. Documented on the route.
//
//  Deliberately in NEITHER set: the queue barriers (MessageQueue.Processed,
//  DmpQueue.ExecutedDownward, XcmpQueue.Success/Fail — bookkeeping, no flow),
//  System.NewAccount, and Currencies.Withdrawn — measured over one live day,
//  9.7k Withdrawn rows against 258 explicit sends, i.e. it overwhelmingly
//  fires for NON-XCM withdrawals (swap legs, fees) and classifying it `out`
//  would misstate the feed ~40:1.

export const XCM_OUT_EVENTS = ['XTokens.TransferredAssets', 'XTokens.TransferredMultiAssets', 'PolkadotXcm.Sent'] as const
export const XCM_IN_EVENTS = [
  'Currencies.Deposited', 'Tokens.Deposited', 'Balances.Deposit', 'Balances.Issued',
  'Balances.Endowed', 'Tokens.Endowed', 'Balances.Minted',
] as const

export const XCM_DEFAULT_WINDOW_S = 86_400
export const XCM_MAX_WINDOW_S = 7 * 86_400

export interface XcmTransferItem {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  eventName: string
  direction: 'in' | 'out'
  who: AccountRef | null
  assetId: string
  amount: string | null
}

interface XcmRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  ts: string
  event_name: string
  asset_id: number
  who: string
  amount: string
  ingested_at: string
}

export interface XcmFeedOptions {
  limit: number
  order: Order
  cursor: PositionCursor | null
  direction?: 'in' | 'out'
  assetId?: number
  fromTime: number
  toTime: number
}

const OUT_SET = new Set<string>(XCM_OUT_EVENTS)

export async function xcmFeed(client: ClickHouseClient, options: XcmFeedOptions): Promise<{ items: Array<WithExtrinsicHash<XcmTransferItem>>; hasMore: boolean }> {
  const params: Record<string, unknown> = {
    bound: options.limit + 1 + DEDUP_SLACK,
    fromTime: options.fromTime,
    toTime: options.toTime,
    outNames: [...XCM_OUT_EVENTS],
    inNames: [...XCM_IN_EVENTS],
  }
  const out = 'event_name IN {outNames:Array(String)}'
  const inbound = '(event_name IN {inNames:Array(String)} AND extrinsic_index IS NULL)'
  const directionSql = options.direction === 'out' ? out : options.direction === 'in' ? inbound : `(${out} OR ${inbound})`
  const clauses = [
    'block_timestamp >= toDateTime({fromTime:UInt32})',
    'block_timestamp <= toDateTime({toTime:UInt32})',
    directionSql,
  ]
  if (options.assetId != null) { clauses.push('asset_id = {assetId:UInt32}'); params.assetId = options.assetId }
  const res = await client.query({
    query: versionedPageSql(`-- data:xcm:transfers
        SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts,
               event_name, asset_id, who, amount, ingested_at
        FROM price_data.xcm_event_activity
        WHERE ${clauses.join(' AND ')}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`, orderSql(options.order, 'event_index')),
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(await res.json<XcmRow>(), row => `${row.block_height}:${row.event_index}`, options.limit)
  const items = page.map(row => {
      const amount = String(row.amount ?? '').trim()
      return {
        blockHeight: Number(row.block_height),
        eventIndex: Number(row.event_index),
        extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
        timestamp: iso(row.ts),
        eventName: row.event_name,
        direction: OUT_SET.has(row.event_name) ? 'out' as const : 'in' as const,
        who: accountRefOrNull(row.who),
        assetId: String(Number(row.asset_id) || 0),
        amount: /^\d+$/.test(amount) ? amount : null,
      }
    })
  return { items: await attachExtrinsicHashes(client, items), hasMore }
}
