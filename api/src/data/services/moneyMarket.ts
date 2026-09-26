import type { ClickHouseClient } from '../../db/client.ts'
import { MM_MARKETS, UNDERLYING_TO_ATOKEN_ID, assetDescriptor, assetIdFromMmAddress, currentPriceOf } from '../../services/explorerAssets.ts'
import {
  compareReserveExposure, loadCurrentCollateralFlags, loadCurrentEmode, loadMoneyMarketHistory, mmMarketCompare, mmMarketRole, mmMarketStakingBacked,
  reserveExposureUsd, reserveKey, type MmObservation,
} from '../../services/moneyMarketHistory.ts'
import { renderUsd } from '../../services/valuation.ts'
import { loadMmIncentives, type MmIncentiveSnapshotView } from '../../services/mmIncentiveSnapshot.ts'
import { iso } from '../schemas/common.ts'
import { settledAmount } from '../../services/aaveMath.ts'
import { accountScaledBalances, moneyMarketReserveState } from './accountsCore.ts'
import { freshPriceMap } from './assetsData.ts'
import { h160For, type ParsedAddress } from './address.ts'
import { moneyMarketPositions } from './accountsDefi.ts'
import { dataStatus } from './head.ts'
import { windowBucketing, type HistoryBucket, type BucketHistoryWindow } from './lpHistory.ts'
import type { BlockClock } from '../../services/blockClock.ts'

// GET /v1/accounts/{address}/money-market/positions and /money-market/history.
// Positions are the CURRENT twin of /liquidity/positions: the reserve rows /balances
// states (settled index, current prices) grouped per isolated market beside the
// market's newest getUserAccountData observation. History is the twin of
// /liquidity/history over services/moneyMarketHistory.ts, the definition the explorer
// serves too; this module only renders the wire.

export type MmHistoryGroupBy = 'reserve' | 'market' | 'account'

interface WireObservation {
  observedAtBlock: number
  timestamp: string | null
  totalCollateralBase: string
  totalDebtBase: string
  availableBorrowsBase: string
  liquidationThreshold: string
  ltv: string
  healthFactor: string
}

const wireObservation = (o: MmObservation, time: string | null): WireObservation => ({
  observedAtBlock: o.block, timestamp: time,
  totalCollateralBase: o.totalCollateralBase, totalDebtBase: o.totalDebtBase, availableBorrowsBase: o.availableBorrowsBase,
  liquidationThreshold: o.liquidationThreshold, ltv: o.ltv, healthFactor: o.healthFactor,
})

// A history point's observation also carries the bucket's LOWEST observed health
// factor: the bucket-end figure alone hides a dip inside the bucket — the one a
// LiquidationCall observed — so a liquidated account would never read below 1.
interface WireHistoryObservation extends WireObservation {
  lowestHealthFactor: string
  lowestAtBlock: number
}

const wireHistoryObservation = (o: MmObservation, time: string | null): WireHistoryObservation => ({
  ...wireObservation(o, time),
  lowestHealthFactor: o.lowestHealthFactor ?? o.healthFactor, lowestAtBlock: o.lowestAtBlock ?? o.block,
})

// ---------------------------------------------------------------------------
// Current positions
// ---------------------------------------------------------------------------

export interface WireMmRewardCurrent {
  assetId: string
  amount: string
  valueUsd: string | null
  reconciled: boolean
  belowExistentialDeposit: boolean
  legs: Array<{ aTokenAddress: string; aTokenAssetId: string | null; pending: string }>
}

export interface MmPositionsResponse {
  asOfBlock: number
  rewardsAsOfBlock: number | null
  markets: Array<{
    marketKey: string
    poolAddress: string
    stakingBacked: boolean
    role: 'primary' | 'supplemental'
    observation: WireObservation | null
    eModeCategoryId: number | null
    reserves: Array<{ assetId: string; reserveAddress: string; aTokenAssetId: string | null; supplied: string; borrowed: string; suppliedUsd: string | null; borrowedUsd: string | null; collateral: boolean }>
    unclaimedRewards: WireMmRewardCurrent[]
  }>
  totals: { suppliedUsd: string; borrowedUsd: string; unclaimedRewardsUsd: string }
}

export async function moneyMarketCurrentPositions(client: ClickHouseClient, parsed: ParsedAddress): Promise<MmPositionsResponse> {
  const h160 = h160For(parsed)
  const [state, prices, status, observations, flags, emode, incentives] = await Promise.all([
    moneyMarketReserveState(client),
    freshPriceMap(client),
    dataStatus(client),
    moneyMarketPositions(client, parsed),
    loadCurrentCollateralFlags(client, [h160]),
    loadCurrentEmode(client, [h160]),
    // A failed snapshot read leaves the rewards unstated (rewardsAsOfBlock null), never the route failing.
    loadMmIncentives(client, [h160]).catch((): MmIncentiveSnapshotView => ({ asOfBlock: null, rewards: [] })),
  ])
  const scaled = state.anchorBlock ? await accountScaledBalances(client, h160, state.anchorBlock) : new Map<string, bigint>()
  const flagOf = flags.get(h160) ?? new Map<string, boolean>()

  type Market = MmPositionsResponse['markets'][number]
  const markets = new Map<string, Market>()
  const marketFor = (marketKey: string, pool: string): Market => {
    let m = markets.get(pool)
    if (!m) {
      m = { marketKey, poolAddress: pool, stakingBacked: mmMarketStakingBacked(marketKey), role: mmMarketRole(marketKey), observation: null, eModeCategoryId: emode.get(pool) ?? null, reserves: [], unclaimedRewards: [] }
      markets.set(pool, m)
    }
    return m
  }

  let suppliedTotal = 0n
  let borrowedTotal = 0n
  const usdOf = (assetId: number, amount: bigint): bigint | null => {
    const price = currentPriceOf(prices, assetId)
    return price != null && price > 0n ? (amount * price) / 10n ** BigInt(assetDescriptor(assetId).decimals) : null
  }
  const exposureByReserve = new Map<object, bigint | null>()
  for (const reserve of state.reserves) {
    const index = state.indices.get(`${reserve.poolProxy}:${reserve.assetAddress}`)
    if (!index) continue
    const assetId = assetIdFromMmAddress(reserve.assetAddress)
    if (assetId == null) continue
    const supplied = settledAmount(scaled.get(reserve.atoken) ?? 0n, index.liq)
    const borrowed = settledAmount(scaled.get(reserve.vdebt) ?? 0n, index.vbi)
    if (supplied <= 0n && borrowed <= 0n) continue
    const suppliedUsd = supplied > 0n ? usdOf(assetId, supplied) : 0n
    const borrowedUsd = borrowed > 0n ? usdOf(assetId, borrowed) : 0n
    if (suppliedUsd != null) suppliedTotal += suppliedUsd
    if (borrowedUsd != null) borrowedTotal += borrowedUsd
    const row = {
      assetId: String(assetId), reserveAddress: reserve.assetAddress,
      aTokenAssetId: UNDERLYING_TO_ATOKEN_ID[assetId] != null ? String(UNDERLYING_TO_ATOKEN_ID[assetId]) : null,
      supplied: supplied.toString(), borrowed: borrowed.toString(),
      suppliedUsd: suppliedUsd == null ? null : renderUsd(suppliedUsd),
      borrowedUsd: borrowedUsd == null ? null : renderUsd(borrowedUsd),
      collateral: supplied > 0n && (flagOf.get(reserveKey(reserve.poolProxy, reserve.assetAddress)) ?? false),
    }
    exposureByReserve.set(row, reserveExposureUsd({ supplied, borrowed, suppliedUsd, borrowedUsd }))
    marketFor(reserve.marketKey, reserve.poolProxy).reserves.push(row)
  }
  for (const o of observations) {
    const marketKey = o.marketKey ?? MM_MARKETS.find(m => m.poolProxy === o.poolAddress.toLowerCase())?.key
    if (!marketKey) continue
    marketFor(marketKey, o.poolAddress.toLowerCase()).observation = wireObservation({
      block: o.blockHeight, totalCollateralBase: o.totalCollateralBase, totalDebtBase: o.totalDebtBase,
      availableBorrowsBase: o.availableBorrowsBase, liquidationThreshold: o.liquidationThreshold, ltv: o.ltv, healthFactor: o.healthFactor,
    }, o.timestamp)
  }
  // Claimable incentives, listed under the market the snapshot files each one in —
  // its aTokens' market; a reward spanning markets once per market, with that
  // market's own amount — at that market's pool: the reserve map's, else the
  // declared MM_MARKETS entry's. A market neither names, or an amount a claim
  // since the snapshot consumed, is left out.
  let rewardsTotal = 0n
  const poolOfMarket = (key: string): string | undefined =>
    state.reserves.find(r => r.marketKey === key)?.poolProxy ?? MM_MARKETS.find(m => m.key === key)?.poolProxy
  const atokenAssetOf = (atoken: string): string | null => {
    const reserve = state.reserves.find(r => r.atoken === atoken)
    const underlying = reserve ? assetIdFromMmAddress(reserve.assetAddress) : null
    const id = underlying != null ? UNDERLYING_TO_ATOKEN_ID[underlying] : undefined
    return id != null ? String(id) : null
  }
  for (const r of incentives.rewards) {
    if (r.claimable <= 0n) continue
    const pool = poolOfMarket(r.marketKey)
    if (!pool) continue
    const valueUsd = usdOf(r.rewardAssetId, r.claimable)
    if (valueUsd != null) rewardsTotal += valueUsd
    marketFor(r.marketKey, pool).unclaimedRewards.push({
      assetId: String(r.rewardAssetId), amount: r.claimable.toString(), valueUsd: valueUsd == null ? null : renderUsd(valueUsd),
      reconciled: r.reconciled, belowExistentialDeposit: r.belowExistentialDeposit,
      legs: r.legs.map(l => ({ aTokenAddress: l.assetAddress, aTokenAssetId: atokenAssetOf(l.assetAddress), pending: l.pending.toString() })),
    })
  }
  const list = [...markets.values()]
  for (const m of list) {
    m.reserves.sort((a, b) => compareReserveExposure(
      { exposureUsd: exposureByReserve.get(a) ?? null, assetId: Number(a.assetId) },
      { exposureUsd: exposureByReserve.get(b) ?? null, assetId: Number(b.assetId) }))
  }
  list.sort((a, b) => mmMarketCompare(a.marketKey, b.marketKey))
  return {
    asOfBlock: status.indexedHead,
    rewardsAsOfBlock: incentives.asOfBlock,
    markets: list,
    totals: { suppliedUsd: renderUsd(suppliedTotal), borrowedUsd: renderUsd(borrowedTotal), unclaimedRewardsUsd: renderUsd(rewardsTotal) },
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface MmHistoryResponse {
  bucket: HistoryBucket
  from: string
  to: string
  reserveHistoryFrom: { blockHeight: number; time: string | null } | null
  points: Array<{ bucket: string; blockHeight: number; suppliedUsd: string | null; borrowedUsd: string | null; unpriced: number; unclaimedRewardsUsd: string | null; rewardsIncomplete: number }>
  markets?: Array<{
    marketKey: string
    poolAddress: string
    stakingBacked: boolean
    points: Array<{
      bucket: string
      blockHeight: number
      suppliedUsd: string | null
      borrowedUsd: string | null
      netUsd: string | null
      unpriced: number
      observation: WireHistoryObservation | null
      eModeCategoryId: number | null
      unclaimedRewards: Array<{ assetId: string; amount: string; valueUsd: string | null; settledAtBlock: number | null }>
    }>
    reserves?: Array<{
      assetId: string
      reserveAddress: string
      aTokenAssetId: string | null
      points: Array<{ bucket: string; blockHeight: number; supplied: string; borrowed: string; suppliedUsd: string | null; borrowedUsd: string | null; collateral: boolean | null }>
    }>
  }>
}

export async function moneyMarketHistory(
  client: ClickHouseClient,
  parsed: ParsedAddress,
  opts: { bucket: HistoryBucket; window: BucketHistoryWindow; clock: BlockClock; markets?: ReadonlySet<string>; groupBy: MmHistoryGroupBy },
): Promise<MmHistoryResponse> {
  const { window, bucket, clock } = opts
  const bk = windowBucketing(window, clock)
  const history = await loadMoneyMarketHistory(client, { h160s: [h160For(parsed)] }, bk, { grain: bucket === 'hour' ? '1h' : '1d', markets: opts.markets })
  const startIso = (b: number) => iso((bk.endSec(b) - bk.step) * 1000)
  const usd = (v: bigint | null) => (v == null ? null : renderUsd(v))
  const time = (h: number) => { const t = history.blockTimes.get(h); return t == null ? null : iso(t * 1000) }
  const response: MmHistoryResponse = {
    bucket,
    from: iso(window.from * 1000),
    to: iso(window.to * 1000),
    reserveHistoryFrom: history.reserveHistoryFrom ? { blockHeight: history.reserveHistoryFrom.blockHeight, time: time(history.reserveHistoryFrom.blockHeight) } : null,
    points: history.points.map(p => ({
      bucket: startIso(p.b), blockHeight: bk.endHeight(p.b), suppliedUsd: usd(p.suppliedUsd), borrowedUsd: usd(p.borrowedUsd), unpriced: p.unpriced,
      unclaimedRewardsUsd: usd(p.unclaimedRewardsUsd), rewardsIncomplete: p.rewardsIncomplete,
    })),
  }
  if (opts.groupBy === 'account') return response
  response.markets = history.markets.map(m => ({
    marketKey: m.marketKey, poolAddress: m.poolAddress, stakingBacked: m.stakingBacked,
    points: m.points.map(p => ({
      bucket: startIso(p.b), blockHeight: bk.endHeight(p.b),
      suppliedUsd: usd(p.suppliedUsd), borrowedUsd: usd(p.borrowedUsd), netUsd: usd(p.netUsd), unpriced: p.unpriced,
      observation: p.observation ? wireHistoryObservation(p.observation, time(p.observation.block)) : null,
      eModeCategoryId: p.eModeCategoryId,
      unclaimedRewards: p.unclaimedRewards.map(r => ({ assetId: String(r.rewardAssetId), amount: r.amount.toString(), valueUsd: usd(r.valueUsd), settledAtBlock: r.settledAtBlock })),
    })),
    ...(opts.groupBy === 'reserve'
      ? {
          reserves: m.reserves.map(r => ({
            assetId: String(r.assetId), reserveAddress: r.reserveAddress, aTokenAssetId: r.aTokenAssetId == null ? null : String(r.aTokenAssetId),
            points: r.points.map(p => ({
              bucket: startIso(p.b), blockHeight: bk.endHeight(p.b), supplied: p.supplied.toString(), borrowed: p.borrowed.toString(),
              suppliedUsd: usd(p.suppliedUsd), borrowedUsd: usd(p.borrowedUsd), collateral: p.collateral,
            })),
          })),
        }
      : {}),
  }))
  return response
}

/** The market keys a `market=` filter may name: every market the reserve map lists (per market, not a closed list). */
export async function knownMarketKeys(client: ClickHouseClient): Promise<string[]> {
  const state = await moneyMarketReserveState(client)
  return [...new Set(state.reserves.map(r => r.marketKey))].sort(mmMarketCompare)
}
