import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { iso } from '../schemas/common.ts'
import { DEDUP_SLACK, blockCursorSql, dedupPage, versionedPageSql, windowSql, type Order, type WindowFilters } from './feed.ts'
import { poolSnapshot } from './poolSnapshot.ts'

// Pool reads for /v1/pools*. CURRENT state comes from the per-block snapshot
// (poolSnapshot.ts — exact at the indexed head, one point read); the three
// per-venue history tables are the 600-block samples of that same snapshot,
// each pool-first keyed, so a per-pool history page is a key-range read.

export interface OmnipoolAssetState {
  assetId: string
  reserve: string
  hubReserve: string
  shares: string
  protocolShares: string
  blockHeight: number
}

export interface StableswapPoolState {
  poolId: string
  assetIds: string[]
  reserves: string[]
  amplification: number
  feePermill: number
  totalIssuance: string
  blockHeight: number
}

export interface XykPoolState {
  poolAccountId: string
  lpAssetId: string | null
  assetA: string
  assetB: string
  reserveA: string
  reserveB: string
  blockHeight: number
}

export async function omnipoolState(client: ClickHouseClient): Promise<OmnipoolAssetState[]> {
  const snapshot = await poolSnapshot(client)
  return [...snapshot.omnipool.values()]
    .sort((a, b) => a.assetId - b.assetId)
    .map(a => ({
      assetId: String(a.assetId),
      reserve: a.reserve.toString(),
      hubReserve: a.hubReserve.toString(),
      shares: a.shares.toString(),
      protocolShares: a.protocolShares.toString(),
      blockHeight: snapshot.blockHeight,
    }))
}

export async function stableswapState(client: ClickHouseClient): Promise<StableswapPoolState[]> {
  const snapshot = await poolSnapshot(client)
  return [...snapshot.stableswap.values()]
    .sort((a, b) => a.poolId - b.poolId)
    .map(p => ({
      poolId: String(p.poolId),
      assetIds: p.assetIds.map(String),
      reserves: p.reserves.map(r => r.toString()),
      amplification: p.amplification,
      feePermill: p.feePermill,
      totalIssuance: p.totalIssuance.toString(),
      blockHeight: snapshot.blockHeight,
    }))
}

// The XYK registry maps a pool account to its LP share token: a few hundred
// rows that change only when a pool is created.
export function xykLpAssetIds(client: ClickHouseClient): Promise<Map<string, number>> {
  return cached('data:pools:xyk-registry', 60_000, async () => {
    const res = await client.query({
      query: `-- data:pools:xyk-registry
          SELECT pool_account, lp_asset_id FROM price_data.xyk_pool_registry FINAL`,
      format: 'JSONEachRow',
    })
    const out = new Map<string, number>()
    for (const row of await res.json<{ pool_account: string; lp_asset_id: number }>()) out.set(row.pool_account.toLowerCase(), Number(row.lp_asset_id))
    return out
  })
}

export async function xykState(client: ClickHouseClient): Promise<XykPoolState[]> {
  const [snapshot, lpByAccount] = await Promise.all([poolSnapshot(client), xykLpAssetIds(client)])
  return [...snapshot.xyk.values()]
    .sort((a, b) => (a.poolAccount < b.poolAccount ? -1 : a.poolAccount > b.poolAccount ? 1 : 0))
    .map(p => {
      const lp = lpByAccount.get(p.poolAccount)
      return {
        poolAccountId: p.poolAccount,
        lpAssetId: lp == null ? null : String(lp),
        assetA: String(p.assetA),
        assetB: String(p.assetB),
        reserveA: p.reserveA.toString(),
        reserveB: p.reserveB.toString(),
        blockHeight: snapshot.blockHeight,
      }
    })
}

// ---------------------------------------------------------------------------
// Per-pool histories: pool-first keys, single-column block cursor.
// ---------------------------------------------------------------------------

// One (block-grid) row per block per pool: the replay identity is the block.
function dedupByBlock<T extends { block_height: number }>(rows: T[], limit: number): { page: T[]; hasMore: boolean } {
  return dedupPage(rows, row => String(row.block_height), limit)
}

function historyWhereSql(options: HistoryPageOptions, params: Record<string, unknown>): string {
  return `${windowSql(options, params)}${blockCursorSql(options.order, params, options.cursorBlock)}`
}

export interface HistoryPageOptions extends WindowFilters {
  limit: number
  order: Order
  cursorBlock: number | null
}

export interface OmnipoolHistoryRow {
  blockHeight: number
  timestamp: string
  reserve: string
  hubReserve: string
  shares: string
  protocolShares: string
  specVersion: number
}

export async function omnipoolHistory(client: ClickHouseClient, assetId: number, options: HistoryPageOptions): Promise<{ items: OmnipoolHistoryRow[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { assetId, bound: options.limit + 1 + DEDUP_SLACK }
  const dir = options.order === 'desc' ? 'DESC' : 'ASC'
  const res = await client.query({
    query: versionedPageSql(`-- data:pools:omnipool-history
        SELECT block_height, toString(block_timestamp) AS ts, reserve_raw, hub_reserve_raw, shares_raw, protocol_shares_raw, spec_version, ingested_at
        FROM price_data.omnipool_pool_state_history
        WHERE asset_id = {assetId:Int32}${historyWhereSql(options, params)}
        ORDER BY block_height ${dir}
        LIMIT {bound:UInt32}`, `block_height ${dir}`),
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupByBlock(await res.json<{ block_height: number; ts: string; reserve_raw: string; hub_reserve_raw: string; shares_raw: string; protocol_shares_raw: string; spec_version: number }>(), options.limit)
  return {
    items: page.map(row => ({
      blockHeight: Number(row.block_height),
      timestamp: iso(row.ts),
      reserve: row.reserve_raw,
      hubReserve: row.hub_reserve_raw,
      shares: row.shares_raw,
      protocolShares: row.protocol_shares_raw,
      specVersion: Number(row.spec_version),
    })),
    hasMore,
  }
}

export interface StableswapHistoryRow {
  blockHeight: number
  timestamp: string
  assetIds: string[]
  reserves: string[]
  amplification: number
  initialAmplification: number
  finalAmplification: number
  initialBlock: number
  finalBlock: number
  feePermill: number
  totalIssuance: string
  pegNum: string[]
  pegDen: string[]
  specVersion: number
}

export async function stableswapHistory(client: ClickHouseClient, poolId: number, options: HistoryPageOptions): Promise<{ items: StableswapHistoryRow[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { poolId, bound: options.limit + 1 + DEDUP_SLACK }
  const dir = options.order === 'desc' ? 'DESC' : 'ASC'
  const res = await client.query({
    query: versionedPageSql(`-- data:pools:stableswap-history
        SELECT block_height, toString(block_timestamp) AS ts, asset_ids, reserves_raw, amplification, initial_amplification, final_amplification, initial_block, final_block, fee_permill, total_issuance_raw, peg_num, peg_den, spec_version, ingested_at
        FROM price_data.stableswap_pool_state_history
        WHERE pool_id = {poolId:UInt32}${historyWhereSql(options, params)}
        ORDER BY block_height ${dir}
        LIMIT {bound:UInt32}`, `block_height ${dir}`),
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupByBlock(await res.json<{
    block_height: number; ts: string; asset_ids: number[]; reserves_raw: string[]; amplification: number
    initial_amplification: number; final_amplification: number; initial_block: number; final_block: number
    fee_permill: number; total_issuance_raw: string; peg_num: string[]; peg_den: string[]; spec_version: number
  }>(), options.limit)
  return {
    items: page.map(row => ({
      blockHeight: Number(row.block_height),
      timestamp: iso(row.ts),
      assetIds: (row.asset_ids ?? []).map(String),
      reserves: row.reserves_raw ?? [],
      amplification: Number(row.amplification),
      initialAmplification: Number(row.initial_amplification),
      finalAmplification: Number(row.final_amplification),
      initialBlock: Number(row.initial_block),
      finalBlock: Number(row.final_block),
      feePermill: Number(row.fee_permill),
      totalIssuance: row.total_issuance_raw,
      pegNum: row.peg_num ?? [],
      pegDen: row.peg_den ?? [],
      specVersion: Number(row.spec_version),
    })),
    hasMore,
  }
}

export interface XykHistoryRow {
  blockHeight: number
  timestamp: string
  assetA: string
  assetB: string
  reserveA: string
  reserveB: string
}

export async function xykHistory(client: ClickHouseClient, poolAccountId: string, options: HistoryPageOptions): Promise<{ items: XykHistoryRow[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { poolAccount: poolAccountId, bound: options.limit + 1 + DEDUP_SLACK }
  const dir = options.order === 'desc' ? 'DESC' : 'ASC'
  const res = await client.query({
    query: versionedPageSql(`-- data:pools:xyk-history
        SELECT block_height, toString(block_timestamp) AS ts, asset_a, asset_b, reserve_a_raw, reserve_b_raw, ingested_at
        FROM price_data.xyk_pool_reserve_history
        WHERE pool_account = {poolAccount:String}${historyWhereSql(options, params)}
        ORDER BY block_height ${dir}
        LIMIT {bound:UInt32}`, `block_height ${dir}`),
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupByBlock(await res.json<{ block_height: number; ts: string; asset_a: number; asset_b: number; reserve_a_raw: string; reserve_b_raw: string }>(), options.limit)
  return {
    items: page.map(row => ({
      blockHeight: Number(row.block_height),
      timestamp: iso(row.ts),
      assetA: String(row.asset_a),
      assetB: String(row.asset_b),
      reserveA: row.reserve_a_raw,
      reserveB: row.reserve_b_raw,
    })),
    hasMore,
  }
}

// ---------------------------------------------------------------------------
// Pool volumes from pool_swap_hourly. The table holds CLOSED hours only (the
// derivations job never writes the hour in progress), so this endpoint is up
// to ~1-2 hours behind the head by construction — a documented freshness
// bound, not a bug, and the price of never double-counting a replayed leg.
// ---------------------------------------------------------------------------

export interface VolumeBucket {
  bucket: string
  assetId: string
  side: 'in' | 'out'
  amount: string
  legCount: number
}

export async function poolVolumes(client: ClickHouseClient, venue: string, poolKey: string, bucket: 'hour' | 'day', fromTime: number, toTime: number): Promise<VolumeBucket[]> {
  const res = await client.query({
    query: `-- data:pools:volumes
        SELECT ${bucket === 'day' ? 'toStartOfDay(hour)' : 'hour'} AS bucket_start,
               asset_id, leg_kind,
               toString(sum(toUInt256OrZero(amount_sum))) AS amount,
               toUInt64(sum(leg_count)) AS legs
        FROM price_data.pool_swap_hourly
        WHERE venue = {venue:String} AND pool_key = {poolKey:String}
          AND leg_kind IN ('in', 'out')
          AND hour >= toDateTime({fromTime:UInt32}) AND hour <= toDateTime({toTime:UInt32})
        GROUP BY bucket_start, asset_id, leg_kind
        ORDER BY bucket_start ASC, asset_id ASC, leg_kind ASC`,
    query_params: { venue, poolKey, fromTime, toTime },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ bucket_start: string; asset_id: number; leg_kind: 'in' | 'out'; amount: string; legs: string }>()
  return rows.map(row => ({
    bucket: iso(row.bucket_start),
    assetId: String(row.asset_id),
    side: row.leg_kind,
    amount: row.amount,
    legCount: Number(row.legs),
  }))
}
