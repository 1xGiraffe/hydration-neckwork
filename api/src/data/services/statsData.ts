import type { ClickHouseClient } from '../../db/client.ts'
import { badRequest, iso } from '../schemas/common.ts'
import { assetDescriptor, priceAssetId } from '../../services/explorerAssets.ts'
import { renderUsd, scaledUsd } from '../../services/valuation.ts'
import { freshPriceMap } from './assetsData.ts'
import { poolSnapshot } from './poolSnapshot.ts'

// Aggregate reads for /v1/stats/*: volumes off the pool_swap_hourly
// pre-aggregate, revenue off revenue_events, activity counts off the daily
// identity bitmaps, and a cached current-TVL fold off the pool state
// histories × latest prices.

// A stats window: both ends resolved (defaults applied), span-checked. A
// default `to` is anchored down to `anchorS` so the window — and with it the
// cache key — is stable for that long instead of unique per second; the
// sources these windows read hold closed hours, so the anchored tail loses
// nothing.
export function resolveWindow(fromTime: number | undefined, toTime: number | undefined, defaultSpanS: number, maxSpanS: number, label: string, anchorS = 60): { from: number; to: number } {
  const now = Math.floor(Date.now() / 1000)
  const to = toTime ?? now - (now % anchorS)
  const from = fromTime ?? to - defaultSpanS
  if (from >= to) throw badRequest(`${label}: fromTime must be before toTime`)
  if (to - from > maxSpanS) {
    throw Object.assign(
      badRequest(`${label}: the window spans ${to - from} seconds; the maximum is ${maxSpanS} (${Math.floor(maxSpanS / 86_400)} days). Narrow fromTime/toTime.`),
      { context: { maxWindowSeconds: maxSpanS, maxWindowDays: Math.floor(maxSpanS / 86_400) } },
    )
  }
  return { from, to }
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

export type VolumeGroupBy = 'venue' | 'asset' | 'pool'
export type StatsBucket = 'hour' | 'day'

export interface VolumeRow {
  bucket: string
  group: string
  assetId: string
  side: 'in' | 'out'
  amount: string
  legCount: number
}

export interface VolumeOptions {
  groupBy: VolumeGroupBy
  bucket: StatsBucket
  from: number
  to: number
  venue?: string
  assetId?: number
}

export async function volumeStats(client: ClickHouseClient, options: VolumeOptions): Promise<VolumeRow[]> {
  const bucketExpr = options.bucket === 'day' ? 'toDateTime(toDate(hour))' : 'hour'
  const groupExpr = options.groupBy === 'venue' ? 'venue'
    : options.groupBy === 'asset' ? 'toString(asset_id)'
    : `concat(venue, ':', pool_key)`
  const params: Record<string, unknown> = { fromTime: options.from, toTime: options.to }
  const clauses = [
    `leg_kind IN ('in', 'out')`,
    'hour >= toDateTime({fromTime:UInt32})',
    'hour < toDateTime({toTime:UInt32})',
  ]
  if (options.venue) { clauses.push('venue = {venue:String}'); params.venue = options.venue }
  if (options.assetId != null) { clauses.push('asset_id = {assetId:UInt32}'); params.assetId = options.assetId }
  const res = await client.query({
    // No FINAL/dedup needed: pool_swap_hourly partitions are published whole
    // (staging twin + REPLACE PARTITION), so a partition never holds two
    // versions of a row (006_public.sql).
    query: `-- data:stats:volume
        SELECT toString(${bucketExpr}) AS bucket, ${groupExpr} AS grp, asset_id,
               toString(leg_kind) AS side, toString(sum(toUInt256OrZero(amount_sum))) AS amount,
               toUInt64(sum(leg_count)) AS legs
        FROM price_data.pool_swap_hourly
        WHERE ${clauses.join(' AND ')}
        GROUP BY bucket, grp, asset_id, side
        ORDER BY bucket, grp, asset_id, side`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ bucket: string; grp: string; asset_id: number | string; side: 'in' | 'out'; amount: string; legs: string }>()
  return rows.map(row => ({
    bucket: iso(row.bucket),
    group: row.grp,
    assetId: String(row.asset_id),
    side: row.side,
    amount: row.amount,
    legCount: Number(row.legs),
  }))
}

// ---------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------

// The `stream` filter's vocabulary: every stream the derivations write into
// revenue_events (api/src/services/revenueStreams.ts REVENUE_STREAMS — not
// importable here; keep the two in step, a stream missing here can be read
// under scope=all but not asked for by name).
export const REVENUE_STREAMS = [
  'omnipool_asset_fee', 'omnipool_protocol_fee', 'liquidation_penalty', 'pepl_liquidation_profit',
  'asset_reserve', 'hollar_borrow', 'hsm_revenue', 'ice_matched_fee', 'uniswap_v3_fee', 'network_fee',
] as const

// The canonical protocol-revenue predicate, restated from
// api/src/services/revenueStreams.ts (PROTOCOL_REVENUE_PREDICATE_SQL — not
// importable here, the data tree's allow-list is narrower): the omnipool fee
// legs the pool keeps for LPs are not protocol revenue, the routed-out /
// burned / protocol-owned-liquidity legs are, and every other stream counts in
// full. Keep the two literals in sync.
export const PROTOCOL_REVENUE_SQL = "((stream != 'omnipool_asset_fee' OR dest IN ('protocol', 'burned', 'pol')) AND dest != 'lp')"

export interface RevenueRow {
  bucket: string
  stream: string
  dest: string
  amountUsd: string
  events: number
}

export interface RevenueOptions {
  bucket: 'day' | 'month'
  scope: 'protocol' | 'all'
  from: number
  to: number
  stream?: string
}

export async function revenueStats(client: ClickHouseClient, options: RevenueOptions): Promise<RevenueRow[]> {
  const bucketExpr = options.bucket === 'month' ? 'toDateTime(toStartOfMonth(block_timestamp))' : 'toDateTime(toDate(block_timestamp))'
  const params: Record<string, unknown> = { fromTime: options.from, toTime: options.to }
  const clauses = [
    'block_timestamp >= toDateTime({fromTime:UInt32})',
    'block_timestamp < toDateTime({toTime:UInt32})',
  ]
  if (options.scope === 'protocol') clauses.push(PROTOCOL_REVENUE_SQL)
  if (options.stream) { clauses.push('stream = {stream:String}'); params.stream = options.stream }
  const res = await client.query({
    // revenue_events partitions are published whole (008_revenue.sql), so no
    // FINAL/dedup is needed here either.
    query: `-- data:stats:revenue
        SELECT toString(${bucketExpr}) AS bucket, stream, dest,
               toString(sum(amount_usd)) AS usd, toUInt64(count()) AS events
        FROM price_data.revenue_events
        WHERE ${clauses.join(' AND ')}
        GROUP BY bucket, stream, dest
        ORDER BY bucket, stream, dest`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ bucket: string; stream: string; dest: string; usd: string; events: string }>()
  return rows.map(row => ({
    bucket: iso(row.bucket),
    stream: row.stream,
    dest: row.dest,
    amountUsd: renderUsd(scaledUsd(row.usd)),
    events: Number(row.events),
  }))
}

// ---------------------------------------------------------------------------
// Daily activity counts
// ---------------------------------------------------------------------------

export interface ActivityCountRow { day: string; count: number }

export const ACTIVITY_KINDS = ['accounts', 'extrinsics', 'events'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export async function activityCounts(client: ClickHouseClient, kind: ActivityKind, from: number, to: number): Promise<ActivityCountRow[]> {
  if (kind === 'accounts') return activeAccounts(client, from, to)
  const res = await client.query({
    // The output alias must not be `day`: ClickHouse resolves a bare WHERE
    // column against SELECT aliases first (the farm_config_events_mv trap), so
    // aliasing toString(day) AS day turned the Date filter into a String
    // comparison and the whole route into a 500.
    query: `-- data:stats:active
        SELECT toString(day) AS d, toUInt64(groupBitmapMerge(identity_state)) AS c
        FROM price_data.daily_chain_identity_counts_v2
        WHERE kind = {kind:String} AND day >= toDate(toDateTime({fromTime:UInt32})) AND day <= toDate(toDateTime({toTime:UInt32}))
        GROUP BY day
        ORDER BY day`,
    query_params: { kind, fromTime: from, toTime: to },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ d: string; c: string }>()
  return rows.map(row => ({ day: row.d, count: Number(row.c) }))
}

// Distinct signing accounts per day. extrinsics_by_signer holds exactly one
// row per signed extrinsic (signer and effective_signer never coexist — pinned
// live: zero rows with both set in a week), so uniqExact(account) is the
// account count, not an identity double-count; the month partitions bound the
// scan (30 days ≈ 160k rows).
async function activeAccounts(client: ClickHouseClient, from: number, to: number): Promise<ActivityCountRow[]> {
  const res = await client.query({
    query: `-- data:stats:active-accounts
        SELECT toString(toDate(block_timestamp)) AS d, toUInt64(uniqExact(account)) AS c
        FROM price_data.extrinsics_by_signer
        WHERE block_timestamp >= toDateTime({fromTime:UInt32}) AND block_timestamp < toDateTime({toTime:UInt32})
        GROUP BY toDate(block_timestamp)
        ORDER BY d`,
    query_params: { fromTime: from, toTime: to },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ d: string; c: string }>()
  return rows.map(row => ({ day: row.d, count: Number(row.c) }))
}

// ---------------------------------------------------------------------------
// TVL: the live pool snapshot valued at fresh current prices.
// ---------------------------------------------------------------------------

export const TVL_VENUES = ['omnipool', 'stableswap', 'xyk', 'uniswapv3'] as const
export type TvlVenue = (typeof TVL_VENUES)[number]

export interface TvlResult {
  totalUsd: string
  venues: Array<{ venue: TvlVenue; tvlUsd: string }>
  asOfBlock: number
  /** Live pool assets that have no fresh price and therefore contribute 0. */
  unpricedAssets: string[]
}

interface UniswapV3Holding { pool: string; assetId: number; balance: bigint }

// A concentrated-liquidity pool's holdings, implied by its own logs: what was
// minted in and swapped in, less what collects (LP and protocol) paid out, plus
// flash-loan fees. The per-block pool snapshot the pallet venues are read from
// does not carry v3 pools — their state lives in the EVM — so this is the fold
// the explorer's pool page applies too (uniswapV3Service.v3PoolStats). Tokens
// resolve through assets.evm_address or the `0x…01 + id` precompile; a pool with
// a token neither names has no holding here.
async function uniswapV3Holdings(client: ClickHouseClient): Promise<UniswapV3Holding[]> {
  const hex = (expr: string) => `replaceRegexpOne(lower(${expr}), '^0x', '')`
  const precompile = (expr: string) => `if(length(${hex(expr)}) = 40 AND substring(${hex(expr)}, 1, 32) = '00000000000000000000000000000001', toInt64(reinterpretAsUInt32(reverse(unhex(substring(${hex(expr)}, 33, 8))))), toInt64(-1))`
  const res = await client.query({
    query: `-- data:stats:tvl:uniswapv3
WITH token_assets AS (
  SELECT lower(evm_address) AS addr, any(asset_id) AS asset_id FROM price_data.assets WHERE evm_address != '' GROUP BY addr
),
balances AS (
  SELECT contract_address,
         sumIf(amount0, event_name = 'Mint') + sumIf(amount0, event_name = 'Swap') - sumIf(amount0, event_name IN ('Collect', 'CollectProtocol')) + sumIf(toInt256(aux0) - amount0, event_name = 'Flash') AS bal0,
         sumIf(amount1, event_name = 'Mint') + sumIf(amount1, event_name = 'Swap') - sumIf(amount1, event_name IN ('Collect', 'CollectProtocol')) + sumIf(toInt256(aux1) - amount1, event_name = 'Flash') AS bal1
  FROM price_data.uniswap_v3_events FINAL
  WHERE kind = 'pool'
  GROUP BY contract_address
)
SELECT p.pool_address AS pool,
       if(t0.asset_id > 0, toInt64(t0.asset_id), ${precompile('p.token0')}) AS asset0,
       if(t1.asset_id > 0, toInt64(t1.asset_id), ${precompile('p.token1')}) AS asset1,
       toString(greatest(b.bal0, toInt256(0))) AS balance0, toString(greatest(b.bal1, toInt256(0))) AS balance1
FROM price_data.uniswap_v3_pools AS p FINAL
LEFT JOIN token_assets AS t0 ON t0.addr = lower(p.token0)
LEFT JOIN token_assets AS t1 ON t1.addr = lower(p.token1)
LEFT JOIN balances AS b ON b.contract_address = p.pool_address
ORDER BY p.pool_address`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ pool: string; asset0: number | string; asset1: number | string; balance0: string; balance1: string }>()
  const out: UniswapV3Holding[] = []
  for (const row of rows) {
    for (const [asset, balance] of [[row.asset0, row.balance0], [row.asset1, row.balance1]] as const) {
      const assetId = Number(asset)
      if (assetId < 0) continue
      out.push({ pool: row.pool, assetId, balance: /^\d+$/.test(String(balance)) ? BigInt(String(balance)) : 0n })
    }
  }
  return out
}

function usdOf(reserve: bigint, assetId: number, prices: Map<number, bigint>, unpriced: Set<string>): bigint {
  if (reserve === 0n) return 0n
  const price = prices.get(assetId) ?? prices.get(priceAssetId(assetId))
  if (price == null) {
    unpriced.add(String(assetId))
    return 0n
  }
  return (reserve * price) / 10n ** BigInt(assetDescriptor(assetId).decimals)
}

// The snapshot holds exactly the pools live at its block — a delisted asset or
// dead pool is simply absent — and the price map holds only feeds inside the
// freshness bound, so nothing here can value a stale row or a stale close.
export async function tvlStats(client: ClickHouseClient): Promise<TvlResult> {
  const [snapshot, prices, v3Holdings] = await Promise.all([poolSnapshot(client), freshPriceMap(client), uniswapV3Holdings(client)])
  const unpriced = new Set<string>()
  let omnipoolUsd = 0n
  for (const a of snapshot.omnipool.values()) omnipoolUsd += usdOf(a.reserve, a.assetId, prices, unpriced)
  let stableswapUsd = 0n
  for (const p of snapshot.stableswap.values()) {
    for (let i = 0; i < p.assetIds.length && i < p.reserves.length; i++) stableswapUsd += usdOf(p.reserves[i], p.assetIds[i], prices, unpriced)
  }
  let xykUsd = 0n
  for (const p of snapshot.xyk.values()) {
    xykUsd += usdOf(p.reserveA, p.assetA, prices, unpriced)
    xykUsd += usdOf(p.reserveB, p.assetB, prices, unpriced)
  }
  let uniswapV3Usd = 0n
  for (const h of v3Holdings) uniswapV3Usd += usdOf(h.balance, h.assetId, prices, unpriced)
  return {
    totalUsd: renderUsd(omnipoolUsd + stableswapUsd + xykUsd + uniswapV3Usd),
    venues: [
      { venue: 'omnipool', tvlUsd: renderUsd(omnipoolUsd) },
      { venue: 'stableswap', tvlUsd: renderUsd(stableswapUsd) },
      { venue: 'xyk', tvlUsd: renderUsd(xykUsd) },
      { venue: 'uniswapv3', tvlUsd: renderUsd(uniswapV3Usd) },
    ],
    asOfBlock: snapshot.blockHeight,
    unpricedAssets: [...unpriced].sort((a, b) => Number(a) - Number(b)),
  }
}
