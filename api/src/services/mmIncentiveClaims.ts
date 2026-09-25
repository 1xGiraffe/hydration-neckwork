import type { ClickHouseClient } from '../db/client.ts'
import { priceAssetId, assetIdFromMmAddress } from './explorerAssets.ts'
import { bucketPricerFrom, type CandleClose } from './lpHistory.ts'
import { loadMmIncentiveProgrammeRows } from './mmIncentiveHistory.ts'
import { mmPrimaryMarket } from './mmIncentiveSnapshot.ts'
import { tagged } from './queryTag.ts'
import { PRICE_LOOKBACK_DAYS, scaledUsd } from './valuation.ts'

// Claimed money-market (lending) incentives: every RewardsClaimed of the holders over
// all indexed history (price_data.mm_incentive_claims, user-first), totalled per market
// and reward asset, each claim valued at the hourly candle fully CLOSED by the claim's
// block timestamp (≤ PRICE_LOOKBACK_DAYS carry) — event-time valuation, integer 1e-12 USD.
//
// A claim names no aToken (RewardsClaimed(user, reward, to, claimer, amount)), so, like
// the stored accrual in mmIncentiveHistory.ts, it is filed under the reward's primary
// market (mmPrimaryMarket over the markets whose aTokens the reward incentivizes). Every
// programme today lies within one market, which makes the split exact.
//
// The holder set is the caller's (`moneyMarketIdentities(...).h160s`, the set every
// incentive surface uses); user_address is stored as the lower-case H160.

export interface MmIncentiveClaimRow {
  reward: string
  /** Unix seconds of the claim's block. */
  ts: number
  amount: bigint
}

export interface MmClaimedIncentive {
  marketKey: string
  rewardAssetId: number
  /** Raw units of rewardAssetId, Σ RewardsClaimed.amount. */
  amount: bigint
  /** Σ of the priced claims at their event-time closes; null when no claim could be priced. */
  valueUsd: bigint | null
  claims: number
  /** Claims left out of valueUsd (no closed candle within the lookback). */
  unpricedClaims: number
}

/**
 * Claims → per (market, reward asset) totals, ordered by market then reward asset id.
 * Pure. `priceOf(rewardAssetId, amount, i)` values claim `i` at its event time; a reward
 * address the registry cannot name is left out (it has no asset to be listed as).
 */
export function aggregateMmIncentiveClaims(
  rows: readonly MmIncentiveClaimRow[],
  marketOfReward: (reward: string) => string,
  priceOf: (rewardAssetId: number, amount: bigint, i: number) => bigint | null,
): MmClaimedIncentive[] {
  const out = new Map<string, MmClaimedIncentive>()
  rows.forEach((row, i) => {
    const rewardAssetId = assetIdFromMmAddress(row.reward)
    if (rewardAssetId == null || row.amount <= 0n) return
    const marketKey = marketOfReward(row.reward)
    const key = `${marketKey}|${rewardAssetId}`
    const acc = out.get(key) ?? out.set(key, { marketKey, rewardAssetId, amount: 0n, valueUsd: null, claims: 0, unpricedClaims: 0 }).get(key)!
    acc.amount += row.amount
    acc.claims++
    const usd = priceOf(rewardAssetId, row.amount, i)
    if (usd == null) acc.unpricedClaims++
    else acc.valueUsd = (acc.valueUsd ?? 0n) + usd
  })
  return [...out.values()].sort((a, b) => (a.marketKey < b.marketKey ? -1 : a.marketKey > b.marketKey ? 1 : a.rewardAssetId - b.rewardAssetId))
}

const PRICE_LOOKBACK_SEC = PRICE_LOOKBACK_DAYS * 86_400

/**
 * The holders' claimed incentives (see the header). Two reads: the claims, key-prefixed
 * on user_address (FINAL bounded by that prefix, the replacement collapse), then the
 * reward assets' hourly closes over the claims' span plus the lookback — asset-first.
 * `reserves` is the money-market reserve map (aToken → market) that names each
 * programme's market.
 */
export async function loadMmIncentiveClaims(
  client: ClickHouseClient,
  h160s: readonly string[],
  reserves: ReadonlyArray<{ atoken: string; marketKey: string }>,
): Promise<MmClaimedIncentive[]> {
  const hs = [...new Set(h160s.map(h => h.toLowerCase()))].filter(h => /^0x[0-9a-f]{40}$/.test(h))
  if (!hs.length) return []
  const res = await client.query(tagged({
    query: `-- mm:incentive-claims-total
            SELECT reward_address AS reward, toUInt32(toUnixTimestamp(block_timestamp)) AS ts, toString(amount) AS amount
            FROM price_data.mm_incentive_claims FINAL
            WHERE user_address IN {hs:Array(String)}
            ORDER BY ts`,
    query_params: { hs },
    format: 'JSONEachRow',
  }))
  const rows: MmIncentiveClaimRow[] = (await res.json<{ reward: string; ts: number; amount: string }>())
    .map(r => ({ reward: r.reward.toLowerCase(), ts: Number(r.ts), amount: BigInt(r.amount) }))
  if (!rows.length) return []

  const marketsOf = new Map<string, Set<string>>()
  const atokenMarket = new Map(reserves.map(r => [r.atoken.toLowerCase(), r.marketKey]))
  for (const p of await loadMmIncentiveProgrammeRows(client)) {
    const market = atokenMarket.get(p.asset.toLowerCase())
    if (!market) continue
    const reward = p.reward.toLowerCase()
    ;(marketsOf.get(reward) ?? marketsOf.set(reward, new Set()).get(reward)!).add(market)
  }
  const marketOfReward = (reward: string) => mmPrimaryMarket([...(marketsOf.get(reward) ?? [])])

  const aliasIds = [...new Set(rows.map(r => assetIdFromMmAddress(r.reward)).filter((id): id is number => id != null).map(id => priceAssetId(id)))]
  const closes = new Map<number, CandleClose[]>()
  if (aliasIds.length) {
    const candles = await client.query(tagged({
      query: `-- mm:incentive-claim-closes
              SELECT asset_id, toUInt32(toUnixTimestamp(interval_start)) + 3600 AS closed_at, toString(argMaxMerge(close_state)) AS px
              FROM price_data.ohlc_1h
              WHERE asset_id IN {ids:Array(UInt32)}
                AND interval_start >= toDateTime({minT:UInt32})
                AND interval_start <= toDateTime({maxT:UInt32})
              GROUP BY asset_id, interval_start
              ORDER BY asset_id, interval_start`,
      query_params: { ids: aliasIds, minT: Math.max(0, rows[0].ts - PRICE_LOOKBACK_SEC - 3_600), maxT: Math.max(0, rows[rows.length - 1].ts - 3_600) },
      format: 'JSONEachRow',
    }))
    for (const r of await candles.json<{ asset_id: number; closed_at: number; px: string }>()) {
      const id = Number(r.asset_id)
      const list = closes.get(id) ?? closes.set(id, []).get(id)!
      list.push({ closedAt: Number(r.closed_at), close: scaledUsd(r.px) })
    }
  }
  // The bucket pricer with one "bucket" per claim ending at the claim's timestamp:
  // the newest candle closed at or before it, within the lookback, never a later one.
  const pricer = bucketPricerFrom(closes, { endSec: i => rows[i].ts })
  return aggregateMmIncentiveClaims(rows, marketOfReward, (id, amount, i) => pricer.usd(id, amount, i))
}
