import { createHash } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'
import { cached, cachedSwr } from './cache.ts'
import { assetDescriptor } from './explorerAssets.ts'
import { loadHourlyFlowPricer, type HourlyFlowPricer } from './eventTimeCloses.ts'
import type { AssetRef } from './explorerService.ts'
import { tagged } from './queryTag.ts'
import { renderUsd } from './valuation.ts'

// Claimed liquidity-mining rewards over an account set's whole history (Omnipool and
// XYK farms): every RewardClaimed in price_data.lm_reward_claims_by_account (account-
// first, chained off lm_deposit_farm_events), totalled per (pallet, pool asset, reward
// asset). Each claim is valued at the hourly candle fully CLOSED by its block time
// (eventTimeCloses.ts — ≤ PRICE_LOOKBACK_DAYS carry), integer 1e-12 USD rendered once.
// A claim with no such candle is left out of the USD and counted (`unpricedClaims`);
// a row whose claims are ALL unpriced has a null value, never zero.
//
// The pool asset of a claim is its yield farm's: the Omnipool asset named by the
// farm's YieldFarmCreated, or — for an XYK farm — the share token of the pair it
// names (xyk_pool_registry). Yield-farm ids are unique per pallet.

let client: ClickHouseClient
export function initLpRewardClaims(c: ClickHouseClient): void { client = c }

export type LpRewardPallet = 'omnipool' | 'xyk'

export interface LiquidityRewardsClaimedRow {
  pallet: LpRewardPallet
  /** Omnipool asset of the yield farm, or the XYK share asset; null when the farm's creation is not indexed. */
  poolAsset: AssetRef | null
  /** XYK rows: the pair behind the share token (A, B) — a share token has no symbol of its own. */
  poolPair?: [AssetRef, AssetRef]
  rewardAsset: AssetRef
  amount: string
  valueUsd: number | null
  unpricedClaims: number
  claims: number
  firstAt: string
  lastAt: string
}
export interface LiquidityRewardsClaimed {
  rows: LiquidityRewardsClaimedRow[]
  totalClaimedUsd: number
  unpricedClaims: number
}

/** One (yield farm, reward asset, hour) group of claims as the read returns it. */
export interface LpClaimHourGroup {
  pallet: LpRewardPallet
  yieldFarmId: number
  rewardAssetId: number
  /** Unix seconds of the hour's start; 0 when the claim block's time is not indexed. */
  hourSec: number
  claims: number
  amount: bigint
  firstAt: string
  lastAt: string
}

/** One (pallet, pool asset, reward asset) total, integer. */
export interface LpClaimTotal { pallet: LpRewardPallet; poolAssetId: number | null; rewardAssetId: number; amount: bigint; valueUsd: bigint | null; claims: number; unpricedClaims: number; firstAt: string; lastAt: string }

/**
 * Hour groups → per (pallet, pool asset, reward asset) totals. Pure. Rows are ordered
 * by value (unvalued last), then pallet, pool asset id and reward asset id.
 */
export function aggregateLpRewardClaims(
  groups: readonly LpClaimHourGroup[],
  poolAssetOf: (pallet: LpRewardPallet, yieldFarmId: number) => number | null,
  pricer: Pick<HourlyFlowPricer, 'usd'>,
): { rows: LpClaimTotal[]; totalUsd: bigint; unpricedClaims: number } {
  type Acc = LpClaimTotal
  const out = new Map<string, Acc>()
  let totalUsd = 0n
  let unpriced = 0
  for (const g of groups) {
    if (g.claims <= 0) continue
    const poolAssetId = poolAssetOf(g.pallet, g.yieldFarmId)
    const key = `${g.pallet}|${poolAssetId ?? `farm:${g.yieldFarmId}`}|${g.rewardAssetId}`
    const acc = out.get(key) ?? out.set(key, { pallet: g.pallet, poolAssetId, rewardAssetId: g.rewardAssetId, amount: 0n, valueUsd: null, claims: 0, unpricedClaims: 0, firstAt: '', lastAt: '' }).get(key)!
    acc.amount += g.amount
    acc.claims += g.claims
    const usd = g.hourSec > 0 ? pricer.usd(g.rewardAssetId, g.amount, g.hourSec) : null
    if (usd == null) { acc.unpricedClaims += g.claims; unpriced += g.claims }
    else { acc.valueUsd = (acc.valueUsd ?? 0n) + usd; totalUsd += usd }
    if (g.firstAt && (!acc.firstAt || g.firstAt < acc.firstAt)) acc.firstAt = g.firstAt
    if (g.lastAt && g.lastAt > acc.lastAt) acc.lastAt = g.lastAt
  }
  const rows = [...out.values()].sort((a, b) => {
    if (a.valueUsd !== b.valueUsd) {
      if (a.valueUsd == null) return 1
      if (b.valueUsd == null) return -1
      return a.valueUsd > b.valueUsd ? -1 : 1
    }
    if (a.pallet !== b.pallet) return a.pallet < b.pallet ? -1 : 1
    if (a.poolAssetId !== b.poolAssetId) return (a.poolAssetId ?? Infinity) - (b.poolAssetId ?? Infinity)
    return a.rewardAssetId - b.rewardAssetId
  })
  return { rows, totalUsd, unpricedClaims: unpriced }
}

/**
 * yield farm → pool asset, from every YieldFarmCreated (farm_config_events, a few
 * dozen rows) and, for XYK farms, the pair's share token (xyk_pool_registry).
 * Farms are created rarely; ten minutes keeps a new one's claims unmapped (null
 * pool, still listed and valued) for at most that long. `xykPairs`: each XYK share
 * token's pair (asset A, asset B), to name a share token by its pair.
 */
function yieldFarmPools(): Promise<{ byFarm: Map<string, number>; xykPairs: Map<number, [number, number]> }> {
  return cached('explorer:lm-yield-farm-pools', 10 * 60_000, async () => {
    const [farmRes, xykRes] = await Promise.all([
      client.query(tagged({
        query: `-- lm:yield-farm-pool-assets
                SELECT pallet, yield_farm_id, args_json FROM price_data.farm_config_events FINAL
                WHERE event_name = 'YieldFarmCreated' AND yield_farm_id IS NOT NULL`,
        format: 'JSONEachRow',
      })),
      client.query(tagged({
        query: `-- lm:xyk-pool-registry
                SELECT lp_asset_id, asset_a, asset_b FROM price_data.xyk_pool_registry FINAL`,
        format: 'JSONEachRow',
      })),
    ])
    const xykByPair = new Map<string, number>()
    const xykPairs = new Map<number, [number, number]>()
    for (const r of await xykRes.json<{ lp_asset_id: number; asset_a: number; asset_b: number }>()) {
      const [lo, hi] = [Number(r.asset_a), Number(r.asset_b)].sort((x, y) => x - y)
      xykByPair.set(`${lo}:${hi}`, Number(r.lp_asset_id))
      xykPairs.set(Number(r.lp_asset_id), [Number(r.asset_a), Number(r.asset_b)])
    }
    return { byFarm: yieldFarmPoolAssetMap(await farmRes.json<{ pallet: string; yield_farm_id: number; args_json: string }>(), xykByPair), xykPairs }
  })
}

/** Pure half of yieldFarmPools: keys are `${pallet}:${yieldFarmId}`. */
export function yieldFarmPoolAssetMap(rows: ReadonlyArray<{ pallet: string; yield_farm_id: number; args_json: string }>, xykByPair: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    let args: Record<string, unknown>
    try { args = JSON.parse(r.args_json) } catch { continue }
    if (r.pallet === 'xyk_lm') {
      const pair = args.assetPair as { assetIn?: unknown; assetOut?: unknown } | undefined
      const a = Number(pair?.assetIn), b = Number(pair?.assetOut)
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) continue
      const lp = xykByPair.get(`${Math.min(a, b)}:${Math.max(a, b)}`)
      if (lp != null) out.set(`xyk:${r.yield_farm_id}`, lp)
    } else {
      const asset = Number(args.assetId)
      if (Number.isSafeInteger(asset) && asset >= 0) out.set(`omnipool:${r.yield_farm_id}`, asset)
    }
  }
  return out
}

const ACCOUNT_RE = /^0x[0-9a-f]{64}$/

async function loadClaimHourGroups(accounts: string[]): Promise<LpClaimHourGroup[]> {
  // The claims (FINAL bounded by the `who` prefix — the replacement collapse), their
  // blocks' times by primary key (`blocks` is a plain MergeTree, so a re-inserted
  // height is collapsed before the join), summed per (farm, reward, hour).
  const res = await client.query(tagged({
    query: `-- lm:reward-claims-by-hour
            SELECT c.pallet AS pallet, c.yield_farm_id AS yf, c.reward_currency AS reward,
                   if(b.ts = toDateTime(0), toUInt32(0), toUInt32(toUnixTimestamp(toStartOfHour(b.ts)))) AS h,
                   count() AS n, toString(sum(c.amount)) AS amt,
                   toString(min(b.ts)) AS first_at, toString(max(b.ts)) AS last_at
            FROM (
              SELECT pallet, yield_farm_id, reward_currency, block_height, amount
              FROM price_data.lm_reward_claims_by_account FINAL
              WHERE who IN {accs:Array(String)}
            ) AS c
            LEFT JOIN (
              SELECT block_height, min(block_timestamp) AS ts FROM price_data.blocks
              WHERE block_height IN (SELECT block_height FROM price_data.lm_reward_claims_by_account WHERE who IN {accs:Array(String)})
              GROUP BY block_height
            ) AS b ON b.block_height = c.block_height
            GROUP BY pallet, yf, reward, h`,
    query_params: { accs: accounts },
    format: 'JSONEachRow',
  }))
  return (await res.json<{ pallet: string; yf: number; reward: number; h: number; n: string | number; amt: string; first_at: string; last_at: string }>())
    .map(r => {
      const dated = Number(r.h) > 0
      return {
        pallet: r.pallet === 'xyk' ? 'xyk' as const : 'omnipool' as const,
        yieldFarmId: Number(r.yf), rewardAssetId: Number(r.reward), hourSec: Number(r.h),
        claims: Number(r.n), amount: BigInt(r.amt),
        firstAt: dated ? r.first_at : '', lastAt: dated ? r.last_at : '',
      }
    })
}

export async function buildLiquidityRewardsClaimed(accountsIn: readonly string[]): Promise<LiquidityRewardsClaimed> {
  const accounts = [...new Set(accountsIn.map(a => a.toLowerCase()))].filter(a => ACCOUNT_RE.test(a)).sort()
  if (!accounts.length) return { rows: [], totalClaimedUsd: 0, unpricedClaims: 0 }
  const [groups, { byFarm: pools, xykPairs }] = await Promise.all([loadClaimHourGroups(accounts), yieldFarmPools()])
  if (!groups.length) return { rows: [], totalClaimedUsd: 0, unpricedClaims: 0 }
  const pricer = await loadHourlyFlowPricer(client, groups.filter(g => g.hourSec > 0).map(g => ({ assetId: g.rewardAssetId, hourSec: g.hourSec })))
  const agg = aggregateLpRewardClaims(groups, (pallet, yf) => pools.get(`${pallet}:${yf}`) ?? null, pricer)
  return {
    rows: agg.rows.map(r => ({
      pallet: r.pallet,
      poolAsset: r.poolAssetId == null ? null : assetDescriptor(r.poolAssetId),
      ...(() => {
        const pair = r.pallet === 'xyk' && r.poolAssetId != null ? xykPairs.get(r.poolAssetId) : undefined
        return pair ? { poolPair: [assetDescriptor(pair[0]), assetDescriptor(pair[1])] as [AssetRef, AssetRef] } : {}
      })(),
      rewardAsset: assetDescriptor(r.rewardAssetId),
      amount: r.amount.toString(),
      valueUsd: r.valueUsd == null ? null : Number(renderUsd(r.valueUsd)),
      unpricedClaims: r.unpricedClaims,
      claims: r.claims,
      firstAt: r.firstAt,
      lastAt: r.lastAt,
    })),
    totalClaimedUsd: Number(renderUsd(agg.totalUsd)),
    unpricedClaims: agg.unpricedClaims,
  }
}

/**
 * Cached per account set: fresh for a minute, then served stale (up to 30 min) while
 * one rebuild replaces it — the LP history's rule, since a new claim is the only thing
 * that moves it and the Liquidity tab reads the two side by side.
 */
export function cachedLiquidityRewardsClaimed(scope: string, accounts: readonly string[]): Promise<LiquidityRewardsClaimed> {
  const key = `explorer:lp-rewards-claimed:${scope}:${accountSetKey(accounts)}`
  return cachedSwr(key, 60_000, 30 * 60_000, () => buildLiquidityRewardsClaimed(accounts))
}

/** A short, order-independent fingerprint of an account set, for cache keys. */
export function accountSetKey(accounts: readonly string[]): string {
  return createHash('sha1').update([...new Set(accounts.map(a => a.toLowerCase()))].sort().join(',')).digest('hex').slice(0, 16)
}
