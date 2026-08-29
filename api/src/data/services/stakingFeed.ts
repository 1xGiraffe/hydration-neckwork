import type { ClickHouseClient } from '../../db/client.ts'
import { attachExtrinsicHashes, type WithExtrinsicHash } from './extrinsicHashes.ts'
import { iso } from '../schemas/common.ts'
import { accountRefOrNull, type AccountRef } from './address.ts'
import { parseJsonColumn } from './chainCore.ts'
import { DEDUP_SLACK, dedupPage, orderSql, positionCursorSql, versionedPageSql, windowSql, type Order, type PositionCursor, type WindowFilters } from './feed.ts'

// The global staking feed for /v1/staking/events: staking_activity holds ONLY
// the staking-family events (198k rows live), keyed (block_height,
// event_index), so a name filter is a post-key filter over an already-small
// stream and needs no bounded window.

// The event vocabulary the projection's MV captures (003_materialized_views).
// Pinned here so a typo in ?type= is a 400 naming the real names instead of a
// silently empty feed; a new pallet event extends this list alongside the MV.
export const STAKING_EVENT_NAMES = [
  'CollatorRewards.CollatorRewarded',
  'GigaHdx.Staked',
  'GigaHdx.Unstaked',
  'GigaHdx.UnstakeCancelled',
  'GigaHdx.Unlocked',
  'GigaHdx.MigratedFromLegacy',
  'GigaHdxRewards.RewardsClaimed',
  'Staking.PositionCreated',
  'Staking.StakeAdded',
  'Staking.Unstaked',
  'Staking.ForceUnstaked',
  'Staking.RewardsClaimed',
] as const

// One staking event, the same shape on the global feed and under an account.
export interface StakingEventItem {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  eventName: string
  who: AccountRef | null
  args: unknown
}

export interface StakingRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  ts: string
  event_name: string
  who: string
  args_json: string
}

export function stakingItem(row: StakingRow): StakingEventItem {
  return {
    blockHeight: Number(row.block_height),
    eventIndex: Number(row.event_index),
    extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
    timestamp: iso(row.ts),
    eventName: row.event_name,
    who: accountRefOrNull(row.who),
    args: parseJsonColumn(row.args_json),
  }
}

export interface StakingFeedOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
  names?: string[]
}

export async function stakingFeed(client: ClickHouseClient, options: StakingFeedOptions): Promise<{ items: Array<WithExtrinsicHash<StakingEventItem>>; hasMore: boolean }> {
  const params: Record<string, unknown> = { bound: options.limit + 1 + DEDUP_SLACK }
  const clauses: string[] = ['1 = 1']
  if (options.names?.length) { clauses.push('event_name IN {names:Array(String)}'); params.names = [...options.names].sort() }
  const res = await client.query({
    query: versionedPageSql(`-- data:staking:events
        SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, who, args_json, ingested_at
        FROM price_data.staking_activity
        WHERE ${clauses.join(' AND ')}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`, orderSql(options.order, 'event_index')),
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(await res.json<StakingRow>(), row => `${row.block_height}:${row.event_index}`, options.limit)
  return { items: await attachExtrinsicHashes(client, page.map(stakingItem)), hasMore }
}
