import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { iso } from '../schemas/common.ts'
import { DEDUP_SLACK, blockCursorSql, dedupPage, orderSql, positionCursorSql, versionedPageSql, windowSql, type Order, type PositionCursor, type WindowFilters } from './feed.ts'
import { poolSnapshot } from './poolSnapshot.ts'
import { v3ActiveLiquidityByPool } from '../../services/uniswapV3Ranges.ts'

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

export interface UniswapV3PoolState {
  pool: string
  token0: string
  token1: string
  asset0: string | null
  asset1: string | null
  fee: number
  tickSpacing: number
  sqrtPriceX96: string | null
  tick: number | null
  liquidity: string | null
  createdBlock: number
  blockHeight: number
}

// Every concentrated-liquidity pool the factory announced, with the price and
// in-range liquidity its last Swap/Initialize log reported. Tokens resolve to
// asset ids through the registry's contract addresses (assets.evm_address) or the
// `0x…01 + id` asset precompile; a token the registry does not know stays null.
export async function uniswapV3State(client: ClickHouseClient): Promise<UniswapV3PoolState[]> {
  return cached('data:pools:uniswapv3', 30_000, async () => {
    // Active liquidity is the pool's OPEN RANGES at its current tick, not the field
    // the last Swap log carried: that one is only right at the instant of that swap
    // (the live aDOT/HOLLAR pool's last swap crossed out of its only range and
    // reported 0 while the range still stood). One read for every pool.
    const activeLiquidity = await v3ActiveLiquidityByPool(client)
    const hex = (expr: string) => `replaceRegexpOne(lower(${expr}), '^0x', '')`
    const precompile = (expr: string) => `if(length(${hex(expr)}) = 40 AND substring(${hex(expr)}, 1, 32) = '00000000000000000000000000000001', toInt64(reinterpretAsUInt32(reverse(unhex(substring(${hex(expr)}, 33, 8))))), toInt64(-1))`
    const res = await client.query({
      query: `-- data:pools:uniswapv3
WITH token_assets AS (
  SELECT lower(evm_address) AS addr, any(asset_id) AS asset_id FROM price_data.assets WHERE evm_address != '' GROUP BY addr
),
last_state AS (
  -- The price comes from the Swap/Initialize rows; last_block from every row that
  -- changed something, because the reported liquidity now moves with a Mint or Burn
  -- too (a burn(0) poke changes nothing and does not advance it).
  SELECT contract_address,
         argMaxIf(toString(sqrt_price_x96), (block_height, event_index), event_name IN ('Swap', 'Initialize')) AS sqrt_price,
         argMaxIf(tick, (block_height, event_index), event_name IN ('Swap', 'Initialize')) AS tick,
         countIf(event_name = 'Swap') AS swaps,
         countIf(event_name IN ('Swap', 'Initialize')) AS priced_rows,
         maxIf(block_height, NOT (event_name IN ('Burn', 'Collect') AND amount0 = 0 AND amount1 = 0 AND liquidity = 0)) AS last_block
  FROM price_data.uniswap_v3_events FINAL
  WHERE kind = 'pool'
  GROUP BY contract_address
)
SELECT p.pool_address AS pool, p.token0 AS token0, p.token1 AS token1,
       if(t0.asset_id > 0, toInt64(t0.asset_id), ${precompile('p.token0')}) AS asset0,
       if(t1.asset_id > 0, toInt64(t1.asset_id), ${precompile('p.token1')}) AS asset1,
       p.fee AS fee, p.tick_spacing AS tick_spacing, p.block_height AS created_block,
       s.sqrt_price AS sqrt_price, s.tick AS tick, s.swaps AS swaps, s.priced_rows AS priced_rows, s.last_block AS last_block
FROM price_data.uniswap_v3_pools AS p FINAL
LEFT JOIN token_assets t0 ON t0.addr = lower(p.token0)
LEFT JOIN token_assets t1 ON t1.addr = lower(p.token1)
LEFT JOIN last_state s ON s.contract_address = p.pool_address
ORDER BY p.block_height, p.pool_address`,
      format: 'JSONEachRow',
    })
    const rows = await res.json<{ pool: string; token0: string; token1: string; asset0: number | string; asset1: number | string; fee: number; tick_spacing: number; created_block: number; sqrt_price: string; tick: number; swaps: number | string; priced_rows: number | string; last_block: number }>()
    return rows.map(r => {
      const priced = r.sqrt_price != null && r.sqrt_price !== '' && r.sqrt_price !== '0'
      const asset = (v: number | string) => (Number(v) >= 0 ? String(Number(v)) : null)
      return {
        pool: r.pool, token0: r.token0, token1: r.token1, asset0: asset(r.asset0), asset1: asset(r.asset1),
        fee: Number(r.fee), tickSpacing: Number(r.tick_spacing),
        sqrtPriceX96: priced ? String(r.sqrt_price) : null, tick: priced ? Number(r.tick) : null,
        liquidity: priced ? (activeLiquidity.get(String(r.pool).toLowerCase()) ?? '0') : null,
        createdBlock: Number(r.created_block), blockHeight: Math.max(Number(r.created_block), Number(r.last_block ?? 0)),
      }
    })
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
// Concentrated-liquidity (Uniswap v3) pool history: one row per Swap (and the
// pool's Initialize), the price and in-range liquidity the pool reported after
// it. Unlike the three pallet venues there is no per-block state sample of a v3
// pool — its state IS the last swap's `sqrtPriceX96`/`liquidity`/`tick` — so the
// history is per event, keyed (block_height, event_index), and pages on the
// feeds' position cursor rather than the block-grid one.
// ---------------------------------------------------------------------------

export interface UniswapV3HistoryRow {
  blockHeight: number
  eventIndex: number
  timestamp: string
  eventName: 'Swap' | 'Initialize'
  sqrtPriceX96: string
  tick: number
  liquidity: string | null
  amount0: string | null
  amount1: string | null
}

export interface UniswapV3HistoryOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
}

export async function uniswapV3History(client: ClickHouseClient, pool: string, options: UniswapV3HistoryOptions): Promise<{ items: UniswapV3HistoryRow[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { pool: pool.toLowerCase(), bound: options.limit + 1 + DEDUP_SLACK }
  const order = orderSql(options.order, 'event_index')
  const res = await client.query({
    // The source is ReplacingMergeTree(ingested_at) on (block_height, event_index):
    // the version tie-break rides outside the bounded read (versionedPageSql) and
    // dedupPage keeps the newest.
    query: versionedPageSql(`-- data:pools:uniswapv3-history
        SELECT block_height, event_index, toString(block_timestamp) AS ts, event_name,
               toString(sqrt_price_x96) AS sqrt_price, tick, toString(liquidity) AS liq,
               toString(amount0) AS amount0_s, toString(amount1) AS amount1_s, ingested_at
        FROM price_data.uniswap_v3_events
        WHERE kind = 'pool' AND event_name IN ('Swap', 'Initialize') AND contract_address = {pool:String}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${order}
        LIMIT {bound:UInt32}`, order),
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<{ block_height: number; event_index: number; ts: string; event_name: 'Swap' | 'Initialize'; sqrt_price: string; tick: number; liq: string; amount0_s: string; amount1_s: string }>(),
    row => `${row.block_height}:${row.event_index}`,
    options.limit,
  )
  return {
    items: page.map(row => ({
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      timestamp: iso(row.ts),
      eventName: row.event_name,
      sqrtPriceX96: String(row.sqrt_price),
      tick: Number(row.tick),
      // An Initialize carries the starting price only: no liquidity yet, nothing traded.
      liquidity: row.event_name === 'Swap' ? String(row.liq) : null,
      amount0: row.event_name === 'Swap' ? String(row.amount0_s) : null,
      amount1: row.event_name === 'Swap' ? String(row.amount1_s) : null,
    })),
    hasMore,
  }
}

// ---------------------------------------------------------------------------
// Pool volumes: the pool_swap_hourly fold below its cut, raw legs above it.
//
// The fold holds CLOSED hours only and the derivations job republishes a live
// month only every POOL_SWAP_HOURLY_REFRESH_HOURS (24) — so on its own it runs
// up to a day behind the head. The reader therefore takes the aggregate at or
// below its cut (the newest folded hour, one table-wide value: the job folds
// oldest-first, so coverage is a contiguous prefix of the era) and the pool's
// deduplicated raw legs ABOVE it, which is a key-prefix read for one
// (venue, pool_key). A leg is never counted twice: the two arms split at one
// hour boundary. The one lag this does not cover is raw backfilled BELOW the cut
// into an already-folded month, which under-reports until the ingest-time
// watermark re-marks that partition (at most one derivations cycle).
// ---------------------------------------------------------------------------

export interface VolumeBucket {
  bucket: string
  assetId: string
  side: 'in' | 'out'
  amount: string
  legCount: number
}

export async function poolVolumes(client: ClickHouseClient, venue: string, poolKey: string, bucket: 'hour' | 'day', fromTime: number, toTime: number): Promise<VolumeBucket[]> {
  const bucketOf = (expr: string) => (bucket === 'day' ? `toStartOfDay(${expr})` : `toStartOfHour(${expr})`)
  const res = await client.query({
    // `cut` is the first hour the fold does not hold, evaluated once for both
    // arms. The raw arm groups on pool_swap_legs' own replacement key first, so a
    // replayed range contributes each leg exactly once before anything is summed.
    query: `-- data:pools:volumes
        WITH (SELECT max(hour) + INTERVAL 1 HOUR FROM price_data.pool_swap_hourly) AS cut
        SELECT bucket_start, asset_id, side, toString(sum(amount_u)) AS amount, toUInt64(sum(legs_n)) AS legs
        FROM (
          SELECT ${bucketOf('hour')} AS bucket_start, asset_id, toString(leg_kind) AS side,
                 sum(toUInt256OrZero(amount_sum)) AS amount_u, sum(leg_count) AS legs_n
          FROM price_data.pool_swap_hourly
          WHERE venue = {venue:String} AND pool_key = {poolKey:String}
            AND leg_kind IN ('in', 'out')
            AND hour >= toDateTime({fromTime:UInt32}) AND hour <= toDateTime({toTime:UInt32})
            AND hour < cut
          GROUP BY bucket_start, asset_id, side
          UNION ALL
          SELECT ${bucketOf('leg_time')} AS bucket_start, leg_asset AS asset_id, toString(leg_kind) AS side,
                 sum(toUInt256OrZero(leg_amount)) AS amount_u, count() AS legs_n
          FROM (
            SELECT block_height, event_index, leg_kind, leg_index,
                   argMax(asset_id, ingested_at) AS leg_asset, argMax(amount, ingested_at) AS leg_amount,
                   min(block_timestamp) AS leg_time
            FROM price_data.pool_swap_legs
            WHERE venue = {venue:String} AND pool_key = {poolKey:String}
              AND leg_kind IN ('in', 'out')
              AND block_timestamp >= cut
              AND block_timestamp >= toDateTime({fromTime:UInt32}) AND block_timestamp <= toDateTime({toTime:UInt32})
            GROUP BY block_height, event_index, leg_kind, leg_index
          )
          GROUP BY bucket_start, asset_id, side
        )
        GROUP BY bucket_start, asset_id, side
        ORDER BY bucket_start ASC, asset_id ASC, side ASC`,
    query_params: { venue, poolKey, fromTime, toTime },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ bucket_start: string; asset_id: number; side: 'in' | 'out'; amount: string; legs: string }>()
  return rows.map(row => ({
    bucket: iso(row.bucket_start),
    assetId: String(row.asset_id),
    side: row.side,
    amount: row.amount,
    legCount: Number(row.legs),
  }))
}
