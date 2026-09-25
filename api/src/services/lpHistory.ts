import type { ClickHouseClient } from '../db/client.ts'
import type { Bucketing } from './bucketLadder.ts'
import { cached } from './cache.ts'
import { assetDescriptor, priceAssetId } from './explorerAssets.ts'
import { loadFarmRewardHistory, type FarmRewardHistory, type FarmRewardItem } from './lmRewardHistory.ts'
import { tagged } from './queryTag.ts'
import {
  HUB_ASSET_ID, OMNI_FIXED, omnipoolBucket, stableswapShareLegs, xykReserveAssets, xykShareLegs,
  type DecodedPosition, type HistoricalOwnedPosition, type OmnipoolAssetState, type OmnipoolBucketLeg,
} from './lpMath.ts'
import { loadV3AccountHistory, v3AccountPositions, v3AccountPositionsRawAt, type V3AccountHistoryRaw } from './uniswapV3Positions.ts'
import { PRICE_LOOKBACK_DAYS, scaledUsd } from './valuation.ts'

// Per-account liquidity-position history on a wall-clock bucket grid: for every
// position the accounts economically held at a bucket's END, the legs redeeming it
// would have returned at the pool state sampled at or before that end, valued at
// the candle that had fully closed by then. One definition shared by the explorer
// (value-history chart + /explorer/address/:a/liquidity-history) and the Data API
// (/v1/accounts/{address}/liquidity/history), so this module is an import leaf: it
// takes the ClickHouse client as an argument and imports only other leaves.
//
// Sources, all key-prefix reads (account-first, position-first, pool-first):
//  * Omnipool — ownership intervals (omnipool_position_owner_intervals, bare and
//    farmed, derivations reconstruction) × per-block position state events ×
//    omnipool_pool_state_history (the 600-block grid);
//  * XYK — direct LP-token balances (account_balance_history) and farm principal
//    intervals (xyk_farm_principal_intervals) × xyk_pool_reserve_history ×
//    the xyk_lp_total_shares_history step function;
//  * stableswap — share-token balances × stableswap_pool_state_history;
//  * Uniswap v3 / Gamma — the uniswapV3Positions fold stopped at each bucket end.
//
// Amounts are bigint end to end; USD is the valuation module's 1e-12 integer.
// Uncollected v3 fees and unclaimed farm rewards are not part of a position's
// principal and are not in these legs. Unclaimed farm rewards ride beside them as
// a separate figure (lmRewardHistory.ts): per farmed position point, and per
// account point as their own USD sum.

/**
 * How long after a bucket's end its sources can still restate it: the
 * derivations reconstructions the Omnipool-ownership and XYK-farm legs read run
 * about every ten minutes, and the candle closing at the end takes the price
 * pipeline's late rows for minutes after it. An hour covers both several times
 * over. Past it nothing restates the window short of a backfill, which is the
 * long-TTL case; inside it the window is short-TTL. One rule for every bucketed
 * history cache — the Data API's history routes and the explorer's windowed
 * value, LP and money-market histories.
 */
export const BUCKET_HISTORY_FINALITY_SEC = 3_600

/** Cache lifetimes: a window the head is BUCKET_HISTORY_FINALITY_SEC past, and one still settling. */
export const BUCKET_HISTORY_CLOSED_TTL_MS = 600_000
export const BUCKET_HISTORY_SETTLING_TTL_MS = 60_000

// A bucketed window ending at `toSec` is CLOSED — nothing can restate it short
// of a backfill — once the indexed head is `finalitySec` past that end: the
// longest its sources take to settle rows at or before the end (a derivations
// cycle, the closing candle's late rows). `headTimeSec` is the indexed head's
// block time, not the wall clock, so ingestion lag keeps a window settling rather
// than closing it early. A caller still has to keep a window that reaches the
// head (one that can gain rows) head-keyed; this answers only when a window that
// cannot has stopped moving.
export function bucketWindowIsClosed(toSec: number, headTimeSec: number, finalitySec: number): boolean {
  return Number.isFinite(headTimeSec) && headTimeSec >= toSec + finalitySec
}

export type { FarmRewardHistory, FarmRewardItem } from './lmRewardHistory.ts'
export { loadFarmRewardHistory } from './lmRewardHistory.ts'

export type LpVenue = 'omnipool' | 'stableswap' | 'xyk' | 'uniswapv3' | 'gamma'
export const LP_VENUES: readonly LpVenue[] = ['omnipool', 'stableswap', 'xyk', 'uniswapv3', 'gamma']

/** Both account-history surfaces cap the per-position list at this many, ranked by last-held value. */
export const LP_HISTORY_POSITION_CAP = 50

/** One stretch of economic ownership, block-exact. `toBlock` null: still held at the index head. */
export interface LpSpan {
  fromBlock: number
  fromTime: number | null
  toBlock: number | null
  toTime: number | null
  kind: 'direct' | 'farmed'
}

const substrateAccounts = (accounts: string[]): string[] =>
  [...new Set(accounts.map(a => a.toLowerCase()))].filter(a => /^0x[0-9a-f]{64}$/.test(a))

const big = (value: unknown): bigint => {
  const text = String(value ?? '0')
  return /^-?\d+$/.test(text) ? BigInt(text) : 0n
}

const optionalTime = (value: unknown): number | null => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function forwardFill<T>(n: number, perBucket: Map<number, T>): (T | undefined)[] {
  const series: (T | undefined)[] = new Array(n + 1).fill(undefined)
  let last = perBucket.get(-1)
  for (let b = 0; b <= n; b++) { if (perBucket.has(b)) last = perBucket.get(b); series[b] = last }
  return series
}

// ---------------------------------------------------------------------------
// Omnipool
// ---------------------------------------------------------------------------

// For every position the accounts economically owned at each bucket (bare or
// farmed), the raw withdraw legs from its TRUE per-block state — not current
// shares, never request-time snapshot JSON. Account-bounded: ownership intervals
// by account, position state by referenced positions, pool state by referenced
// assets. Callers apply the bucket's price to the raw legs.
export type OmnipoolHistoryLeg = OmnipoolBucketLeg
export interface OmnipoolPrincipalHistory {
  legsByBucket: OmnipoolHistoryLeg[][]
  assetIds: number[]
  fromBucket: number | null
  /** Ownership spans per position id overlapping the range, in order. */
  spans: Map<string, LpSpan[]>
  /**
   * Per bucket: positions owned at its end whose legs cannot be stated — no
   * position state indexed yet, or no pool state for its asset. Absent: none.
   */
  unvaluedByBucket?: number[]
}
export async function loadOmnipoolPrincipalHistory(client: ClickHouseClient, accounts: string[], bk: Bucketing): Promise<OmnipoolPrincipalHistory> {
  const n = bk.N
  const minb = bk.floorHeight
  const empty: OmnipoolPrincipalHistory = { legsByBucket: Array.from({ length: n + 1 }, () => []), assetIds: [], fromBucket: null, spans: new Map(), unvaluedByBucket: new Array(n + 1).fill(0) }
  const accs = substrateAccounts(accounts)
  if (!accs.length) return empty
  const maxb = bk.endHeight(n)
  const bucketEndBlock = (b: number) => bk.endHeight(b)

  // 1) Ownership intervals overlapping the range (account-bounded).
  const ivRes = await client.query(tagged({
    query: `-- lp:omnipool-owner-intervals
            SELECT position_id, ownership_kind, deposit_id, valid_from_block, toUnixTimestamp(valid_from_ts) AS from_ts, valid_to_block
            FROM price_data.omnipool_position_owner_intervals FINAL
            WHERE account_id IN {accs:Array(String)}
              AND valid_from_block <= ${maxb}
              AND (valid_to_block = 0 OR valid_to_block >= ${minb})
            ORDER BY position_id, valid_from_block, valid_from_event`,
    query_params: { accs }, format: 'JSONEachRow',
  }))
  const intervals = (await ivRes.json<{ position_id: string; ownership_kind?: string; deposit_id?: string; valid_from_block: number; from_ts?: number; valid_to_block: number }>())
    .map(i => ({ ...i, position_id: String(i.position_id), valid_from_block: Number(i.valid_from_block), valid_to_block: Number(i.valid_to_block) }))
  if (!intervals.length) return empty
  const positionIds = [...new Set(intervals.map(i => i.position_id))]
  const spans = new Map<string, LpSpan[]>()
  for (const iv of intervals) {
    const list = spans.get(iv.position_id) ?? []
    list.push({
      fromBlock: iv.valid_from_block, fromTime: optionalTime(iv.from_ts),
      toBlock: iv.valid_to_block === 0 ? null : iv.valid_to_block, toTime: null,
      kind: iv.ownership_kind === 'farmed' ? 'farmed' : 'direct',
    })
    spans.set(iv.position_id, list)
  }

  // 2) Position state events for those positions (position-bounded); forward-fill the
  //    latest active state to each bucket end. `null` once destroyed (the position no
  //    longer exists, so it is not held); `undefined` before any state event is
  //    indexed (owned, but with nothing to redeem it by — counted, never valued).
  const stRes = await client.query(tagged({
    query: `-- lp:omnipool-position-states
            SELECT position_id, block_height, event_kind, asset_id, amount_raw, shares_raw, price_raw, active
            FROM price_data.omnipool_position_state_events FINAL
            WHERE position_id IN {pids:Array(String)}
            ORDER BY position_id, block_height, event_index`,
    query_params: { pids: positionIds }, format: 'JSONEachRow',
  }))
  const stRows = await stRes.json<{ position_id: string; block_height: number; event_kind: string; asset_id: number; amount_raw: string; shares_raw: string; price_raw: string; active: number }>()
  const eventsByPosition = new Map<string, typeof stRows>()
  for (const r of stRows) { const pid = String(r.position_id); if (!eventsByPosition.has(pid)) eventsByPosition.set(pid, []); eventsByPosition.get(pid)!.push(r) }
  const stateByPosition = new Map<string, (DecodedPosition | null | undefined)[]>()
  const assetByPosition = new Map<string, number>()
  for (const pid of positionIds) {
    const evs = eventsByPosition.get(pid) ?? []
    const series: (DecodedPosition | null | undefined)[] = new Array(n + 1).fill(undefined)
    let cursor = 0
    let last: DecodedPosition | null | undefined = undefined
    for (let b = 0; b <= n; b++) {
      const be = bucketEndBlock(b)
      while (cursor < evs.length && Number(evs[cursor].block_height) <= be) {
        const e = evs[cursor]
        if (e.event_kind === 'destroyed' || Number(e.active) === 0) last = null
        else {
          const assetId = Number(e.asset_id)
          last = { assetId, amount: BigInt(e.amount_raw || '0'), shares: BigInt(e.shares_raw || '0'), priceNum: BigInt(e.price_raw || '0'), priceDen: OMNI_FIXED }
          assetByPosition.set(pid, assetId)
        }
        cursor++
      }
      series[b] = last
    }
    stateByPosition.set(pid, series)
  }

  // 3) Pool state per (asset, bucket): the latest snapshot at/before each bucket end,
  //    forward-filled (b = -1 carries the pre-range state). Asset-bounded.
  const assetIds = [...new Set([...assetByPosition.values()])]
  const poolByAssetBucket = new Map<number, (OmnipoolAssetState | undefined)[]>()
  if (assetIds.length) {
    const poolRes = await client.query(tagged({
      query: `-- lp:omnipool-pool-states
              SELECT asset_id,
                ${bk.ofTsCarry('block_timestamp')} AS b,
                argMax(reserve_raw, block_height) AS reserve,
                argMax(hub_reserve_raw, block_height) AS hub_reserve,
                argMax(shares_raw, block_height) AS shares
              FROM price_data.omnipool_pool_state_history
              WHERE asset_id IN {aids:Array(Int32)} AND block_height <= ${maxb}
              GROUP BY asset_id, b ORDER BY asset_id, b`,
      query_params: { aids: assetIds }, format: 'JSONEachRow',
    }))
    const byAsset = new Map<number, Map<number, OmnipoolAssetState>>()
    for (const r of await poolRes.json<{ asset_id: number; b: number; reserve: string; hub_reserve: string; shares: string }>()) {
      const aid = Number(r.asset_id)
      if (!byAsset.has(aid)) byAsset.set(aid, new Map())
      byAsset.get(aid)!.set(Number(r.b), { reserve: BigInt(r.reserve || '0'), hub: BigInt(r.hub_reserve || '0'), shares: BigInt(r.shares || '0') })
    }
    for (const aid of assetIds) poolByAssetBucket.set(aid, forwardFill(n, byAsset.get(aid) ?? new Map()))
  }

  // 4) Per bucket: positions owned at the bucket end (dedup by positionId), raw legs.
  //    Intervals are [from, to): a transfer at block X leaves the old owner at X.
  const legsByBucket: OmnipoolHistoryLeg[][] = Array.from({ length: n + 1 }, () => [])
  const unvaluedByBucket: number[] = new Array(n + 1).fill(0)
  let fromBucket: number | null = null
  for (let b = 0; b <= n; b++) {
    const be = bucketEndBlock(b)
    const owned: HistoricalOwnedPosition[] = []
    const stateless = new Set<string>()
    for (const iv of intervals) {
      if (iv.valid_from_block <= be && (iv.valid_to_block === 0 || iv.valid_to_block > be)) {
        const state = stateByPosition.get(iv.position_id)?.[b]
        if (state === null) continue
        if (state === undefined) { stateless.add(iv.position_id); continue }
        owned.push({
          positionId: iv.position_id, assetId: state.assetId, state, pool: poolByAssetBucket.get(state.assetId)?.[b],
          farmed: iv.ownership_kind === 'farmed', depositId: iv.deposit_id ? String(iv.deposit_id) : null,
        })
      }
    }
    const { legs, unvalued } = omnipoolBucket(owned)
    if (legs.length && fromBucket === null) fromBucket = b
    legsByBucket[b] = legs
    unvaluedByBucket[b] = unvalued + stateless.size
  }
  return { legsByBucket, assetIds, fromBucket, spans, unvaluedByBucket }
}

// ---------------------------------------------------------------------------
// XYK
// ---------------------------------------------------------------------------

// For the accounts' XYK LP holdings — direct wallet share-token balances AND
// collection-5389 farm-deposit principal — the per-bucket pool state needed to
// redeem each (reserves × shares / total supply). Total supply is the reconstructed
// step function; reserves are the sampled snapshot. Account/pool/asset-bounded.
// xykLegsByBucket turns it into legs.
export interface XykBucketState { assetA: number; assetB: number; reserveA: bigint; reserveB: bigint; totalShares: bigint }
export interface XykPrincipalHistory {
  lpAssetIds: Set<number>
  underlyingAssetIds: number[]
  stateByLp: Map<number, (XykBucketState | undefined)[]>
  farmSharesByLp: Map<number, bigint[]>
  /** LP asset → pool account (the venue's pool key). */
  poolByLp: Map<number, string>
  /** LP asset → the farm-deposit spans overlapping the range. */
  farmSpansByLp: Map<number, LpSpan[]>
}
export async function loadXykPrincipalHistory(client: ClickHouseClient, accounts: string[], candidateAssetIds: number[], bk: Bucketing): Promise<XykPrincipalHistory> {
  const n = bk.N
  const minb = bk.floorHeight
  const empty: XykPrincipalHistory = { lpAssetIds: new Set(), underlyingAssetIds: [], stateByLp: new Map(), farmSharesByLp: new Map(), poolByLp: new Map(), farmSpansByLp: new Map() }
  const accs = substrateAccounts(accounts)
  const maxb = bk.endHeight(n)
  const bucketEndBlock = (b: number) => bk.endHeight(b)

  // 1) Farm principal intervals → per (lp, bucket) summed active principal.
  const farmSharesByLp = new Map<number, bigint[]>()
  const farmSpansByLp = new Map<number, LpSpan[]>()
  const farmedLps = new Set<number>()
  if (accs.length) {
    const fRes = await client.query(tagged({
      query: `-- lp:xyk-farm-intervals
              SELECT lp_asset_id, deposit_id, principal_shares_raw, valid_from_block, toUnixTimestamp(valid_from_ts) AS from_ts, valid_to_block
              FROM price_data.xyk_farm_principal_intervals FINAL
              WHERE account_id IN {accs:Array(String)} AND valid_from_block <= ${maxb} AND (valid_to_block = 0 OR valid_to_block >= ${minb})
              ORDER BY lp_asset_id, valid_from_block`,
      query_params: { accs }, format: 'JSONEachRow',
    }))
    for (const r of await fRes.json<{ lp_asset_id: number; principal_shares_raw: string; valid_from_block: number; from_ts?: number; valid_to_block: number }>()) {
      const lp = Number(r.lp_asset_id)
      const from = Number(r.valid_from_block), to = Number(r.valid_to_block)
      farmedLps.add(lp)
      if (!farmSharesByLp.has(lp)) farmSharesByLp.set(lp, new Array(n + 1).fill(0n))
      const arr = farmSharesByLp.get(lp)!
      const principal = BigInt(r.principal_shares_raw || '0')
      for (let b = 0; b <= n; b++) { const be = bucketEndBlock(b); if (from <= be && (to === 0 || to > be)) arr[b] += principal }
      const spans = farmSpansByLp.get(lp) ?? []
      spans.push({ fromBlock: from, fromTime: optionalTime(r.from_ts), toBlock: to === 0 ? null : to, toTime: null, kind: 'farmed' })
      farmSpansByLp.set(lp, spans)
    }
  }

  // 2) Which candidate assets (+ farmed lps) are XYK LP tokens? → registry mapping.
  //    Farm principal whose LP the registry does not list is still held: it keeps
  //    its shares and spans (no state, so it is counted as unvalued, never dropped).
  const lpCandidates = [...new Set([...candidateAssetIds, ...farmedLps])]
  if (!lpCandidates.length) return empty
  const unregistered: XykPrincipalHistory = { ...empty, farmSharesByLp, farmSpansByLp }
  const rRes = await client.query(tagged({
    query: `-- lp:xyk-registry
            SELECT lp_asset_id, pool_account, asset_a, asset_b FROM price_data.xyk_pool_registry FINAL WHERE lp_asset_id IN {lps:Array(Int32)}`,
    query_params: { lps: lpCandidates }, format: 'JSONEachRow',
  }))
  const regRows = (await rRes.json<{ lp_asset_id: number; pool_account: string; asset_a: number; asset_b: number }>())
    .map(r => ({ ...r, lp_asset_id: Number(r.lp_asset_id), asset_a: Number(r.asset_a), asset_b: Number(r.asset_b) }))
  if (!regRows.length) return unregistered
  const lpAssetIds = new Set(regRows.map(r => r.lp_asset_id))
  const regByLp = new Map(regRows.map(r => [r.lp_asset_id, r]))
  const pools = [...new Set(regRows.map(r => r.pool_account))]

  // 3) Reserves per (pool, bucket) — sampled, forward-filled (b=-1 carry-in). Carry the
  // snapshot's own asset order (aa/ab), taken from the SAME latest row as the reserves
  // (all argMax by block_height): it can differ from — and even flips across blocks
  // within — the registry's PoolCreated order, so reserves must be paired by it (step 5).
  type Reserve = { aa: number; ab: number; ra: bigint; rb: bigint }
  const reserveByPoolBucket = new Map<string, (Reserve | undefined)[]>()
  {
    const resvRes = await client.query(tagged({
      query: `-- lp:xyk-reserves
              SELECT pool_account,
                ${bk.ofTsCarry('block_timestamp')} AS b,
                argMax(asset_a, block_height) AS aa, argMax(asset_b, block_height) AS ab,
                argMax(reserve_a_raw, block_height) AS ra, argMax(reserve_b_raw, block_height) AS rb
              FROM price_data.xyk_pool_reserve_history WHERE pool_account IN {pools:Array(String)} AND block_height <= ${maxb}
              GROUP BY pool_account, b ORDER BY pool_account, b`,
      query_params: { pools }, format: 'JSONEachRow',
    }))
    const byPool = new Map<string, Map<number, Reserve>>()
    for (const r of await resvRes.json<{ pool_account: string; b: number; aa?: number; ab?: number; ra: string; rb: string }>()) {
      if (!byPool.has(r.pool_account)) byPool.set(r.pool_account, new Map())
      byPool.get(r.pool_account)!.set(Number(r.b), { aa: Number(r.aa ?? 0) || 0, ab: Number(r.ab ?? 0) || 0, ra: BigInt(r.ra || '0'), rb: BigInt(r.rb || '0') })
    }
    for (const pool of pools) reserveByPoolBucket.set(pool, forwardFill(n, byPool.get(pool) ?? new Map()))
  }

  // 4) Total shares per (lp, bucket) — reconstructed step function, forward-filled.
  const totalByLpBucket = new Map<number, (bigint | undefined)[]>()
  {
    const tRes = await client.query(tagged({
      query: `-- lp:xyk-total-shares
              SELECT lp_asset_id,
                ${bk.ofHeightCarry('block_height')} AS b,
                argMax(total_shares_raw, block_height) AS total
              FROM price_data.xyk_lp_total_shares_history WHERE lp_asset_id IN {lps:Array(Int32)} AND block_height <= ${maxb}
              GROUP BY lp_asset_id, b ORDER BY lp_asset_id, b`,
      query_params: { lps: [...lpAssetIds] }, format: 'JSONEachRow',
    }))
    const byLp = new Map<number, Map<number, bigint>>()
    for (const r of await tRes.json<{ lp_asset_id: number; b: number; total: string }>()) {
      const lp = Number(r.lp_asset_id)
      if (!byLp.has(lp)) byLp.set(lp, new Map())
      byLp.get(lp)!.set(Number(r.b), BigInt(r.total || '0'))
    }
    for (const lp of lpAssetIds) totalByLpBucket.set(lp, forwardFill(n, byLp.get(lp) ?? new Map()))
  }

  // 5) Assemble per-lp per-bucket state (only where reserves + positive total supply exist).
  const stateByLp = new Map<number, (XykBucketState | undefined)[]>()
  const poolByLp = new Map<number, string>()
  for (const lp of lpAssetIds) {
    const reg = regByLp.get(lp)!
    poolByLp.set(lp, reg.pool_account)
    const reserves = reserveByPoolBucket.get(reg.pool_account)
    const totals = totalByLpBucket.get(lp)
    const arr: (XykBucketState | undefined)[] = new Array(n + 1).fill(undefined)
    for (let b = 0; b <= n; b++) {
      const rv = reserves?.[b]; const ts = totals?.[b]
      if (rv && ts && ts > 0n) {
        // Pair each reserve with the asset it belongs to via the snapshot's own
        // (asset_a↔reserve_a) order; fall back to the registry order only for legacy
        // rows that predate the snapshot asset columns. The sampled table stores an
        // absent id as 0, and HDX IS 0, so only a (0, 0) pair reads as absent.
        const [assetA, assetB] = xykReserveAssets(rv.aa !== 0 || rv.ab !== 0, rv.aa, rv.ab, reg.asset_a, reg.asset_b)
        arr[b] = { assetA, assetB, reserveA: rv.ra, reserveB: rv.rb, totalShares: ts }
      }
    }
    stateByLp.set(lp, arr)
  }
  const underlyingAssetIds = [...new Set(regRows.flatMap(r => [r.asset_a, r.asset_b]))]
  return { lpAssetIds, underlyingAssetIds, stateByLp, farmSharesByLp, poolByLp, farmSpansByLp }
}

export interface XykBucketLeg {
  lp: number
  /** `combined` sums direct + farmed shares before redeeming (the chart's form). */
  kind: 'direct' | 'farmed' | 'combined'
  shares: bigint
  assetA: number
  assetB: number
  amountA: bigint
  amountB: bigint
}

/**
 * The XYK legs per bucket, pure. `directSharesByLp` is the accounts' wallet
 * LP-token balance per bucket (forward-filled per account, summed). `split`
 * redeems direct and farmed shares as two positions (the LP-history surfaces);
 * without it they are summed first and redeemed once (the value-history chart,
 * whose floor then matches its historical output exactly).
 */
export function xykLegsByBucket(hist: XykPrincipalHistory, directSharesByLp: Map<number, bigint[]>, N: number, opts: { split?: boolean } = {}): XykBucketLeg[][] {
  const out: XykBucketLeg[][] = Array.from({ length: N + 1 }, () => [])
  for (const lp of hist.lpAssetIds) {
    const state = hist.stateByLp.get(lp)
    if (!state) continue
    const farm = hist.farmSharesByLp.get(lp)
    const direct = directSharesByLp.get(lp)
    for (let b = 0; b <= N; b++) {
      const st = state[b]
      if (!st) continue
      const d = direct?.[b] ?? 0n
      const f = farm?.[b] ?? 0n
      const parts: Array<[bigint, XykBucketLeg['kind']]> = opts.split ? [[d, 'direct'], [f, 'farmed']] : [[d + f, 'combined']]
      for (const [shares, kind] of parts) {
        if (shares <= 0n) continue
        const { amountA, amountB } = xykShareLegs(shares, st.reserveA, st.reserveB, st.totalShares)
        out[b].push({ lp, kind, shares, assetA: st.assetA, assetB: st.assetB, amountA, amountB })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Fungible share balances, stableswap
// ---------------------------------------------------------------------------

/**
 * The accounts' raw balance of each asset per bucket end: each account's newest
 * observation at or before the bucket end, forward-filled per account and only
 * then summed (a single argMax across accounts would pick one member's balance).
 * Pre-range observations fold into bucket 0 as the carry-in. Account-first prefix
 * read on account_balance_history; assets never held are absent from the map.
 */
export async function loadShareBalanceHistory(client: ClickHouseClient, accounts: string[], assetIds: number[], bk: Bucketing): Promise<Map<number, bigint[]>> {
  const out = new Map<number, bigint[]>()
  const accs = substrateAccounts(accounts)
  if (!accs.length || !assetIds.length) return out
  const res = await client.query(tagged({
    query: `-- lp:share-balance-history
            SELECT account_id, asset_id, ${bk.ofTs('block_timestamp')} AS b,
              toString(argMax(toUInt256OrZero(total), tuple(block_height, observation_id, ingested_at))) AS bal
            FROM price_data.account_balance_history
            WHERE account_id IN {accs:Array(String)} AND asset_id IN {ids:Array(String)}
              AND block_timestamp <= toDateTime({end:UInt32})
            GROUP BY account_id, asset_id, b ORDER BY account_id, asset_id, b`,
    query_params: { accs, ids: [...new Set(assetIds)].map(String), end: bk.endSec(bk.N) }, format: 'JSONEachRow',
  }))
  const perAccount = new Map<string, Map<number, bigint>>()
  for (const r of await res.json<{ account_id: string; asset_id: string; b: number; bal: string }>()) {
    const key = `${r.account_id}\u0000${r.asset_id}`
    if (!perAccount.has(key)) perAccount.set(key, new Map())
    perAccount.get(key)!.set(Number(r.b), big(r.bal))
  }
  for (const [key, byBucket] of perAccount) {
    const assetId = Number(key.slice(key.indexOf('\u0000') + 1))
    const series = out.get(assetId) ?? new Array<bigint>(bk.N + 1).fill(0n)
    let last = 0n
    for (let b = 0; b <= bk.N; b++) { const v = byBucket.get(b); if (v !== undefined) last = v; series[b] += last }
    out.set(assetId, series)
  }
  for (const [assetId, series] of out) if (!series.some(v => v > 0n)) out.delete(assetId)
  return out
}

export interface StableswapBucketState { assetIds: number[]; reserves: bigint[]; totalIssuance: bigint }

/**
 * Pool state per (stableswap pool, bucket): the newest 600-block sample at or
 * before the bucket end, carried in. A sample whose asset list and reserves do
 * not pair one to one (or are empty) is no state — `undefined` from that bucket
 * on, not the previous sample carried past it, and never a zero-filled leg.
 */
export async function loadStableswapPrincipalHistory(client: ClickHouseClient, poolIds: number[], bk: Bucketing): Promise<Map<number, (StableswapBucketState | undefined)[]>> {
  const out = new Map<number, (StableswapBucketState | undefined)[]>()
  if (!poolIds.length) return out
  const res = await client.query(tagged({
    query: `-- lp:stableswap-states
            SELECT pool_id,
              ${bk.ofTsCarry('block_timestamp')} AS b,
              argMax(asset_ids, block_height) AS aids,
              argMax(reserves_raw, block_height) AS reserves,
              argMax(total_issuance_raw, block_height) AS issuance
            FROM price_data.stableswap_pool_state_history
            WHERE pool_id IN {pools:Array(UInt32)} AND block_height <= ${bk.endHeight(bk.N)}
            GROUP BY pool_id, b ORDER BY pool_id, b`,
    query_params: { pools: poolIds }, format: 'JSONEachRow',
  }))
  const byPool = new Map<number, Map<number, StableswapBucketState | undefined>>()
  for (const r of await res.json<{ pool_id: number; b: number; aids: number[]; reserves: string[]; issuance: string }>()) {
    const pool = Number(r.pool_id)
    if (!byPool.has(pool)) byPool.set(pool, new Map())
    const assetIds = (r.aids ?? []).map(Number)
    const reserves = (r.reserves ?? []).map(big)
    byPool.get(pool)!.set(Number(r.b), assetIds.length && assetIds.length === reserves.length
      ? { assetIds, reserves, totalIssuance: big(r.issuance) }
      : undefined)
  }
  for (const pool of poolIds) out.set(pool, forwardFill(bk.N, byPool.get(pool) ?? new Map()))
  return out
}

// ---------------------------------------------------------------------------
// Uniswap v3 / Gamma
// ---------------------------------------------------------------------------

export interface V3HistoryLeg {
  kind: 'position' | 'vault'
  /** `manager:tokenId` for a position NFT, the vault contract for a vault holding. */
  key: string
  tokenId: string | null
  manager: string | null
  pool: string | null
  vault: string | null
  shares: bigint
  asset0: number
  asset1: number
  amount0: bigint
  amount1: bigint
}
export interface V3PrincipalHistory {
  legsByBucket: V3HistoryLeg[][]
  assetIds: number[]
  /** Position-NFT ownership spans by `manager:tokenId` (vault shares are fungible: none). */
  spans: Map<string, LpSpan[]>
  /** Per bucket: holdings whose token the registry cannot resolve to an asset (held, unpriceable). Absent: none. */
  unvaluedByBucket?: Array<{ uniswapv3: number; gamma: number }>
}

// The NFT's holder changes only on its Transfers; a stretch opens on a transfer to
// one of the accounts and closes on the first transfer away. Pure.
export function v3PositionSpans(history: V3AccountHistoryRaw): Map<string, LpSpan[]> {
  const accounts = new Set(history.accounts)
  const out = new Map<string, LpSpan[]>()
  for (const e of history.managerEvents) {
    if (e.event !== 'Transfer') continue
    const key = `${e.manager}:${e.tokenId}`
    const list = out.get(key) ?? []
    const open = list.length ? list[list.length - 1] : null
    const toAccount = accounts.has(e.holder)
    if (toAccount && !(open && open.toBlock == null)) list.push({ fromBlock: e.block, fromTime: null, toBlock: null, toTime: null, kind: 'direct' })
    else if (!toAccount && open && open.toBlock == null) open.toBlock = e.block
    if (list.length) out.set(key, list)
  }
  return out
}

// The account page's own fold (v3AccountPositionsRawAt) stopped at each bucket's end
// block — manager-NFT principal and Gamma vault shares redeemed against the vault's
// totals at that block — so the history's last bucket and the page's current value
// are one definition. Uncollected fees are in neither. Raw legs; callers apply the
// bucket's price. `resolveToken` is the explorer's registry overlay; without it the
// fold's own precompile/registry resolution applies.
export async function loadV3PrincipalHistory(client: ClickHouseClient, h160s: string[], bk: Bucketing, resolveToken?: (addr: string) => number | null): Promise<V3PrincipalHistory> {
  const empty: V3PrincipalHistory = { legsByBucket: Array.from({ length: bk.N + 1 }, () => [] as V3HistoryLeg[]), assetIds: [], spans: new Map() }
  const accounts = [...new Set(h160s.map(h => h.toLowerCase()))]
  if (!accounts.length) return empty
  const history = await loadV3AccountHistory(client, accounts)
  if (!history.managerEvents.length && !history.shareEvents.length) return empty
  const assetIds = new Set<number>()
  const legsByBucket = empty.legsByBucket
  const unvaluedByBucket = Array.from({ length: bk.N + 1 }, () => ({ uniswapv3: 0, gamma: 0 }))
  for (let b = 0; b <= bk.N; b++) {
    for (const p of v3AccountPositions(v3AccountPositionsRawAt(history, bk.endHeight(b)), resolveToken)) {
      // An unresolvable token cannot be priced: no legs (the current-value twin
      // drops it too), but it is held, so it is counted rather than vanishing.
      if (p.asset0 == null || p.asset1 == null) { unvaluedByBucket[b][p.kind === 'position' ? 'uniswapv3' : 'gamma']++; continue }
      legsByBucket[b].push({
        kind: p.kind,
        key: p.kind === 'position' ? `${p.manager}:${p.tokenId}` : String(p.vault),
        tokenId: p.tokenId ?? null, manager: p.manager ?? null, pool: p.pool, vault: p.vault ?? null,
        shares: p.shares, asset0: p.asset0, asset1: p.asset1, amount0: p.amount0, amount1: p.amount1,
      })
      assetIds.add(p.asset0).add(p.asset1)
    }
  }
  return { legsByBucket, assetIds: [...assetIds], spans: v3PositionSpans(history), unvaluedByBucket }
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export type PriceGrain = '1h' | '1d'
const GRAIN_SEC: Record<PriceGrain, number> = { '1h': 3_600, '1d': 86_400 }
const PRICE_LOOKBACK_SEC = PRICE_LOOKBACK_DAYS * 86_400

export interface BucketPricer {
  /** The close (1e-12 USD per whole unit) of `assetId`'s price feed valid at bucket `b`'s end, or null. */
  close(assetId: number, b: number): bigint | null
  /** USD (1e-12 integer) of `amount` raw units at bucket `b`, or null when unpriced. */
  usd(assetId: number, amount: bigint, b: number): bigint | null
}

export interface CandleClose { closedAt: number; close: bigint }

/**
 * The pricer over already-fetched closes (per price-feed id, ascending by
 * closedAt). Pure. A bucket takes the newest candle that had fully CLOSED by its
 * end — `closedAt ≤ endSec(b)`, so a candle closing exactly at the end is in and
 * the one still open is not — carried forward at most PRICE_LOOKBACK_DAYS. It is
 * never back-filled from a later candle, and a non-positive close is no price.
 */
export function bucketPricerFrom(closes: Map<number, CandleClose[]>, bk: Pick<Bucketing, 'endSec'>): BucketPricer {
  const memo = new Map<string, bigint | null>()
  const closeOf = (aliasId: number, b: number): bigint | null => {
    const key = `${aliasId}:${b}`
    if (memo.has(key)) return memo.get(key)!
    const list = closes.get(aliasId)
    const end = bk.endSec(b)
    let result: bigint | null = null
    if (list?.length) {
      let lo = 0, hi = list.length - 1, best = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (list[mid].closedAt <= end) { best = mid; lo = mid + 1 } else hi = mid - 1
      }
      if (best >= 0 && end - list[best].closedAt <= PRICE_LOOKBACK_SEC && list[best].close > 0n) result = list[best].close
    }
    memo.set(key, result)
    return result
  }
  return {
    close: (assetId, b) => closeOf(priceAssetId(assetId), b),
    usd(assetId, amount, b) {
      const close = closeOf(priceAssetId(assetId), b)
      if (close == null) return null
      return (amount * close) / 10n ** BigInt(assetDescriptor(assetId).decimals)
    },
  }
}

/**
 * Closed-candle prices on the bucket grid, integer. `1h` reads ohlc_1h (bucket
 * steps under a day), `1d` ohlc_1d. One asset-first read covering the grid plus the
 * staleness lookback: ≤ ~1.2k rows per asset at the 400-bucket cap.
 */
export async function bucketClosePrices(client: ClickHouseClient, assetIds: Iterable<number>, bk: Bucketing, grain: PriceGrain): Promise<BucketPricer> {
  const aliasIds = [...new Set([...assetIds].map(id => priceAssetId(id)))]
  const closes = new Map<number, CandleClose[]>()
  if (aliasIds.length) {
    const candle = GRAIN_SEC[grain]
    const table = grain === '1h' ? 'price_data.ohlc_1h' : 'price_data.ohlc_1d'
    const res = await client.query(tagged({
      query: `-- lp:bucket-closes
              SELECT asset_id, toUInt32(toUnixTimestamp(interval_start)) + ${candle} AS closed_at, toString(argMaxMerge(close_state)) AS px
              FROM ${table}
              WHERE asset_id IN {ids:Array(UInt32)}
                AND interval_start >= toDateTime({minT:UInt32})
                AND interval_start <= toDateTime({maxT:UInt32})
              GROUP BY asset_id, interval_start
              ORDER BY asset_id, interval_start`,
      query_params: { ids: aliasIds, minT: Math.max(0, bk.endSec(0) - PRICE_LOOKBACK_SEC - candle), maxT: Math.max(0, bk.endSec(bk.N) - candle) },
      format: 'JSONEachRow',
    }))
    for (const r of await res.json<{ asset_id: number; closed_at: number; px: string }>()) {
      const id = Number(r.asset_id)
      const list = closes.get(id) ?? []
      list.push({ closedAt: Number(r.closed_at), close: scaledUsd(r.px) })
      closes.set(id, list)
    }
  }
  return bucketPricerFrom(closes, bk)
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface LpHistoryParts {
  omnipool?: OmnipoolPrincipalHistory | null
  xyk?: { hist: XykPrincipalHistory; directSharesByLp: Map<number, bigint[]> } | null
  stableswap?: { states: Map<number, (StableswapBucketState | undefined)[]>; sharesByPool: Map<number, bigint[]> } | null
  v3?: V3PrincipalHistory | null
  /** Unclaimed farm rewards per bucket (Omnipool and XYK farm entries). */
  rewards?: FarmRewardHistory | null
  /** Keep only these venues (the v3 fold yields both uniswapv3 and gamma). */
  venues?: ReadonlySet<LpVenue>
}

export interface LpHistoryLeg { assetId: number; amount: bigint; usd: bigint | null }
/** One farm entry's claimable reward at a bucket end. */
export interface LpHistoryReward { depositId: string; globalFarmId: number; yieldFarmId: number; assetId: number; amount: bigint; usd: bigint | null }
export interface LpHistoryPoint {
  b: number
  shares: bigint
  legs: LpHistoryLeg[]
  usd: bigint | null
  /** Farm entries behind a farmed position ([] otherwise). Never in `legs` or `usd`. */
  rewards: LpHistoryReward[]
}
export interface LpHistoryPosition {
  venue: LpVenue
  /** How the position was held at its last held bucket (spans carry every flip). */
  farmed: boolean
  positionId: string | null
  poolKey: string
  shareAssetId: string | null
  spans: LpSpan[]
  /** Only the buckets at whose end it was held, ascending. */
  points: LpHistoryPoint[]
}
export interface LpHistory {
  /**
   * Per bucket: the sum of every PRICED position, and how many positions held at
   * its end are not in that sum — a leg without a price, or legs that cannot be
   * stated at all (no pool state at or before the end, an unresolvable v3 token;
   * those have no point in `positions` at that bucket).
   */
  points: Array<{
    b: number
    usd: bigint
    unpriced: number
    /** Sum of every priced farm-entry reward held at the bucket end (not in `usd`). */
    rewardsUsd: bigint
    /** Farm entries held at the end whose reward is not in rewardsUsd: not stated, or unpriced. */
    rewardsIncomplete: number
  }>
  /** Every position held at ≥ 1 bucket end, largest last-held value first, unpriced last. */
  positions: LpHistoryPosition[]
}

interface RawPoint { b: number; shares: bigint; farmed: boolean; legs: Array<{ assetId: number; amount: bigint }> }
interface RawSeries { venue: LpVenue; positionId: string | null; poolKey: string; shareAssetId: string | null; spans: LpSpan[]; points: RawPoint[] }

/**
 * The per-position series and the account line, priced — pure and integer. A
 * position is valued at a bucket only when every leg is priced; otherwise its
 * value is null there and it counts in that bucket's `unpriced`, never as zero.
 * A position held at a bucket end whose legs cannot be stated (no pool state then,
 * an unresolvable token) has no point there and is counted in `unpriced` too —
 * held value is never silently absent from the line.
 * Omnipool positions carry their asset leg plus an H2O (asset 1) leg when the hub
 * leg is non-zero. The Omnipool arm is already de-duplicated by position id, so a
 * position moving between bare and farmed is one series whose spans flip.
 */
export function assembleLpHistory(parts: LpHistoryParts, pricer: BucketPricer, bk: Pick<Bucketing, 'N'>): LpHistory {
  const N = bk.N
  const want = (v: LpVenue) => !parts.venues || parts.venues.has(v)
  const unvalued: number[] = new Array(N + 1).fill(0)
  const series = new Map<string, RawSeries>()
  const seriesFor = (key: string, init: () => RawSeries) => {
    let s = series.get(key)
    if (!s) { s = init(); series.set(key, s) }
    return s
  }

  if (parts.omnipool && want('omnipool')) {
    const omni = parts.omnipool
    for (let b = 0; b <= N; b++) {
      for (const leg of omni.legsByBucket[b] ?? []) {
        const s = seriesFor(`omnipool:${leg.positionId}`, () => ({ venue: 'omnipool', positionId: leg.positionId, poolKey: 'omnipool', shareAssetId: null, spans: omni.spans?.get(leg.positionId) ?? [], points: [] }))
        const legs = [{ assetId: leg.assetId, amount: leg.liquidity }]
        if (leg.hub > 0n) legs.push({ assetId: HUB_ASSET_ID, amount: leg.hub })
        s.points.push({ b, shares: leg.shares, farmed: leg.farmed, legs })
      }
      unvalued[b] += omni.unvaluedByBucket?.[b] ?? 0
    }
  }

  if (parts.xyk && want('xyk')) {
    const { hist, directSharesByLp } = parts.xyk
    const byBucket = xykLegsByBucket(hist, directSharesByLp, N, { split: true })
    for (let b = 0; b <= N; b++) {
      for (const leg of byBucket[b]) {
        const farmed = leg.kind === 'farmed'
        const s = seriesFor(`xyk:${leg.lp}:${farmed ? 'farmed' : 'direct'}`, () => ({
          venue: 'xyk', positionId: null, poolKey: hist.poolByLp?.get(leg.lp) ?? '', shareAssetId: String(leg.lp),
          spans: farmed ? hist.farmSpansByLp?.get(leg.lp) ?? [] : [], points: [],
        }))
        s.points.push({ b, shares: leg.shares, farmed, legs: [{ assetId: leg.assetA, amount: leg.amountA }, { assetId: leg.assetB, amount: leg.amountB }] })
      }
    }
    // Held shares (direct or farmed, each its own position) with no pool state at
    // the bucket — no reserves sampled yet, no positive total supply, or an LP the
    // registry does not list — have no legs above; count them.
    const lps = new Set([...hist.lpAssetIds, ...directSharesByLp.keys(), ...(hist.farmSharesByLp?.keys() ?? [])])
    for (const lp of lps) {
      const state = hist.stateByLp.get(lp)
      const direct = directSharesByLp.get(lp)
      const farm = hist.farmSharesByLp?.get(lp)
      for (let b = 0; b <= N; b++) {
        if (state?.[b]) continue
        if ((direct?.[b] ?? 0n) > 0n) unvalued[b]++
        if ((farm?.[b] ?? 0n) > 0n) unvalued[b]++
      }
    }
  }

  if (parts.stableswap && want('stableswap')) {
    for (const [pool, shares] of parts.stableswap.sharesByPool) {
      const states = parts.stableswap.states.get(pool)
      for (let b = 0; b <= N; b++) {
        const held = shares[b] ?? 0n
        if (held <= 0n) continue
        const st = states?.[b]
        // No state, or one whose assets and reserves do not pair: held, not stated.
        if (!st || st.totalIssuance <= 0n || !st.assetIds.length || st.assetIds.length !== st.reserves.length) { unvalued[b]++; continue }
        const amounts = stableswapShareLegs(held, st.reserves, st.totalIssuance)
        const s = seriesFor(`stableswap:${pool}`, () => ({ venue: 'stableswap', positionId: null, poolKey: String(pool), shareAssetId: String(pool), spans: [], points: [] }))
        s.points.push({ b, shares: held, farmed: false, legs: st.assetIds.map((assetId, i) => ({ assetId, amount: amounts[i] })) })
      }
    }
  }

  if (parts.v3) {
    const v3 = parts.v3
    for (let b = 0; b <= N; b++) {
      for (const leg of v3.legsByBucket[b] ?? []) {
        const venue: LpVenue = leg.kind === 'position' ? 'uniswapv3' : 'gamma'
        if (!want(venue)) continue
        const s = seriesFor(`${venue}:${leg.key}`, () => venue === 'uniswapv3'
          ? { venue, positionId: leg.tokenId, poolKey: leg.pool ?? leg.manager ?? '', shareAssetId: null, spans: v3.spans?.get(leg.key) ?? [], points: [] }
          : { venue, positionId: null, poolKey: leg.vault ?? leg.key, shareAssetId: null, spans: [], points: [] })
        s.points.push({ b, shares: leg.shares, farmed: false, legs: [{ assetId: leg.asset0, amount: leg.amount0 }, { assetId: leg.asset1, amount: leg.amount1 }] })
      }
      const skipped = v3.unvaluedByBucket?.[b]
      if (skipped) unvalued[b] += (want('uniswapv3') ? skipped.uniswapv3 : 0) + (want('gamma') ? skipped.gamma : 0)
    }
  }

  const totals = Array.from({ length: N + 1 }, (_, b) => ({ b, usd: 0n, unpriced: unvalued[b], rewardsUsd: 0n, rewardsIncomplete: 0 }))

  // Rewards: every entry counts in its bucket's account total (a position this
  // history cannot state still has its reward); farmed series carry their own.
  const rewardsByPosition = new Map<string, LpHistoryReward[]>()
  if (parts.rewards) {
    const r = parts.rewards
    for (let b = 0; b <= N; b++) {
      const omniOn = want('omnipool'), xykOn = want('xyk')
      const missing = r.incompleteByBucket[b]
      if (missing) totals[b].rewardsIncomplete += (omniOn ? missing.omnipool : 0) + (xykOn ? missing.xyk : 0)
      for (const item of r.itemsByBucket[b] ?? []) {
        if (item.pallet === 'omnipool' ? !omniOn : !xykOn) continue
        const usd = pricer.usd(item.rewardAssetId, item.amount, b)
        if (usd == null) totals[b].rewardsIncomplete += 1
        else totals[b].rewardsUsd += usd
        const key = rewardSeriesKey(item, b)
        const list = rewardsByPosition.get(key) ?? []
        list.push({ depositId: item.depositId, globalFarmId: item.globalFarmId, yieldFarmId: item.yieldFarmId, assetId: item.rewardAssetId, amount: item.amount, usd })
        rewardsByPosition.set(key, list)
      }
    }
  }

  const positions: LpHistoryPosition[] = []
  for (const [seriesKey, s] of series) {
    const points: LpHistoryPoint[] = s.points.map(p => {
      let usd: bigint | null = 0n
      const legs = p.legs.map(l => {
        const value = pricer.usd(l.assetId, l.amount, p.b)
        usd = usd == null || value == null ? null : usd + value
        return { assetId: l.assetId, amount: l.amount, usd: value }
      })
      if (usd == null) totals[p.b].unpriced += 1
      else totals[p.b].usd += usd
      const rewards = p.farmed ? rewardsByPosition.get(`${seriesKey}@${p.b}`) ?? [] : []
      return { b: p.b, shares: p.shares, legs, usd, rewards }
    })
    const last = s.points[s.points.length - 1]
    positions.push({ venue: s.venue, farmed: last?.farmed ?? false, positionId: s.positionId, poolKey: s.poolKey, shareAssetId: s.shareAssetId, spans: s.spans, points })
  }
  positions.sort(compareByLastHeldValue)
  return { points: totals, positions }
}

// The series a reward item belongs to at bucket b (see seriesFor keys above):
// an Omnipool deposit's position NFT, an XYK pool's farmed principal.
function rewardSeriesKey(item: FarmRewardItem, b: number): string {
  return item.pallet === 'omnipool' ? `omnipool:${item.positionId}@${b}` : `xyk:${item.lpAssetId}:farmed@${b}`
}

function compareByLastHeldValue(x: LpHistoryPosition, y: LpHistoryPosition): number {
  const vx = x.points[x.points.length - 1]?.usd ?? null
  const vy = y.points[y.points.length - 1]?.usd ?? null
  if (vx != null && vy != null && vx !== vy) return vy > vx ? 1 : -1
  if ((vx == null) !== (vy == null)) return vx == null ? 1 : -1
  const kx = `${x.venue}:${x.poolKey}:${x.positionId ?? ''}:${x.farmed ? 1 : 0}`
  const ky = `${y.venue}:${y.poolKey}:${y.positionId ?? ''}:${y.farmed ? 1 : 0}`
  return kx < ky ? -1 : kx > ky ? 1 : 0
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface LpHistoryOptions {
  grain: PriceGrain
  venues?: ReadonlySet<LpVenue>
  resolveToken?: (addr: string) => number | null
  /**
   * Publish only these bucket indices (ascending): the explorer's un-windowed
   * view keeps one bucket per day like its value chart. Selected before the
   * positions are ranked and capped, so the cap is over what is published.
   */
  buckets?: readonly number[]
  /** Resolve span block times (default true); a caller not rendering positions skips the read. */
  spanTimes?: boolean
}

/** The published history: at most LP_HISTORY_POSITION_CAP positions, the rest counted. */
export interface LpHistoryPage extends LpHistory {
  /** Positions beyond the cap; their value is still in `points`. */
  positionsOmitted: number
}

/**
 * Keep only the buckets `keep` names (ascending bucket indices; `b` keeps its
 * original value): the account line at those buckets, each position's points at
 * them, and only positions still held at one of them, re-ranked by their last
 * kept point. Pure.
 */
export function selectLpHistoryBuckets(history: LpHistory, keep: readonly number[]): LpHistory {
  const kept = new Set(keep)
  const positions = history.positions
    .map(p => ({ ...p, points: p.points.filter(pt => kept.has(pt.b)) }))
    .filter(p => p.points.length > 0)
  positions.sort(compareByLastHeldValue)
  return { points: history.points.filter(p => kept.has(p.b)), positions }
}

// Registry-derived id lists, the same for every account: cached rather than
// re-read per request (the stableswap one is a DISTINCT over the whole state
// history). Ten minutes is safely inside BUCKET_HISTORY_FINALITY_SEC (the Data API's
// closed-window margin, an hour): a pool listed after a window closed was created
// after its end, so it holds nothing inside that window — a closed window can
// never be cached against a list that is missing a pool it needed.
const LP_ID_LIST_TTL_MS = 10 * 60_000

function xykLpAssetIdList(client: ClickHouseClient): Promise<number[]> {
  return cached('lp:xyk-lp-ids', LP_ID_LIST_TTL_MS, async () => {
    const res = await client.query(tagged({ query: '-- lp:xyk-lp-ids\nSELECT DISTINCT lp_asset_id FROM price_data.xyk_pool_registry FINAL', format: 'JSONEachRow' }))
    return (await res.json<{ lp_asset_id: number }>()).map(r => Number(r.lp_asset_id))
  })
}

function stableswapPoolIdList(client: ClickHouseClient): Promise<number[]> {
  return cached('lp:stableswap-pool-ids', LP_ID_LIST_TTL_MS, async () => {
    const res = await client.query(tagged({ query: '-- lp:stableswap-pool-ids\nSELECT DISTINCT pool_id FROM price_data.stableswap_pool_state_history', format: 'JSONEachRow' }))
    return (await res.json<{ pool_id: number }>()).map(r => Number(r.pool_id))
  })
}

/**
 * Block timestamps for span ends the interval sources do not carry, in place.
 * PK point reads over price_data.blocks; run on the published positions only.
 */
export async function fillSpanTimes(client: ClickHouseClient, positions: LpHistoryPosition[]): Promise<void> {
  const heights = new Set<number>()
  for (const p of positions) for (const s of p.spans) {
    if (s.fromTime == null) heights.add(s.fromBlock)
    if (s.toBlock != null && s.toTime == null) heights.add(s.toBlock)
  }
  if (!heights.size) return
  const res = await client.query(tagged({
    query: `-- lp:span-times
            SELECT block_height, toUnixTimestamp(block_timestamp) AS t FROM price_data.blocks WHERE block_height IN {hs:Array(UInt32)}`,
    query_params: { hs: [...heights] }, format: 'JSONEachRow',
  }))
  const timeOf = new Map<number, number>()
  for (const r of await res.json<{ block_height: number; t: number }>()) timeOf.set(Number(r.block_height), Number(r.t))
  for (const p of positions) {
    p.spans = p.spans.map(s => ({
      ...s,
      fromTime: s.fromTime ?? timeOf.get(s.fromBlock) ?? null,
      toTime: s.toBlock == null ? null : s.toTime ?? timeOf.get(s.toBlock) ?? null,
    }))
  }
}

/**
 * The LP history both surfaces serve: every venue's loader for the accounts
 * (substrate AccountId32s) and the H160s they act through on the EVM side, priced
 * on `grain` closes, assembled, narrowed to `buckets`, capped at
 * LP_HISTORY_POSITION_CAP positions (span times resolved for those only). Venues
 * outside `venues` are not read at all.
 */
export async function loadLpHistory(
  client: ClickHouseClient,
  scope: { accounts: string[]; h160s: string[] },
  bk: Bucketing,
  opts: LpHistoryOptions,
): Promise<LpHistoryPage> {
  const want = (v: LpVenue) => !opts.venues || opts.venues.has(v)
  const [omnipool, xykIds, poolIds, v3, rewards] = await Promise.all([
    want('omnipool') ? loadOmnipoolPrincipalHistory(client, scope.accounts, bk) : Promise.resolve(null),
    want('xyk') ? xykLpAssetIdList(client) : Promise.resolve([] as number[]),
    want('stableswap') ? stableswapPoolIdList(client) : Promise.resolve([] as number[]),
    want('uniswapv3') || want('gamma') ? loadV3PrincipalHistory(client, scope.h160s, bk, opts.resolveToken) : Promise.resolve(null),
    want('omnipool') || want('xyk') ? loadFarmRewardHistory(client, scope.accounts, bk) : Promise.resolve(null),
  ])
  // One account-first read for every fungible share token the venues know.
  const shareBalances = await loadShareBalanceHistory(client, scope.accounts, [...xykIds, ...poolIds], bk)
  const xykSet = new Set(xykIds)
  const poolSet = new Set(poolIds)
  const directSharesByLp = new Map([...shareBalances].filter(([id]) => xykSet.has(id)))
  const sharesByPool = new Map([...shareBalances].filter(([id]) => poolSet.has(id) && !xykSet.has(id)))
  const [xykHist, stableStates] = await Promise.all([
    want('xyk') ? loadXykPrincipalHistory(client, scope.accounts, [...directSharesByLp.keys()], bk) : Promise.resolve(null),
    want('stableswap') ? loadStableswapPrincipalHistory(client, [...sharesByPool.keys()], bk) : Promise.resolve(null),
  ])

  const priceIds = new Set<number>()
  if (omnipool) { for (const id of omnipool.assetIds) priceIds.add(id); if (omnipool.assetIds.length) priceIds.add(HUB_ASSET_ID) }
  if (xykHist) for (const id of xykHist.underlyingAssetIds) priceIds.add(id)
  if (stableStates) for (const states of stableStates.values()) for (const st of states) for (const id of st?.assetIds ?? []) priceIds.add(id)
  if (v3) for (const id of v3.assetIds) priceIds.add(id)
  if (rewards) for (const id of rewards.rewardAssetIds) priceIds.add(id)
  const pricer = await bucketClosePrices(client, priceIds, bk, opts.grain)

  const assembled = assembleLpHistory({
    omnipool,
    xyk: xykHist ? { hist: xykHist, directSharesByLp } : null,
    stableswap: stableStates ? { states: stableStates, sharesByPool } : null,
    v3,
    rewards,
    venues: opts.venues,
  }, pricer, bk)
  const history = opts.buckets ? selectLpHistoryBuckets(assembled, opts.buckets) : assembled
  const positions = history.positions.slice(0, LP_HISTORY_POSITION_CAP)
  if (opts.spanTimes !== false) await fillSpanTimes(client, positions)
  return { points: history.points, positions, positionsOmitted: history.positions.length - positions.length }
}
