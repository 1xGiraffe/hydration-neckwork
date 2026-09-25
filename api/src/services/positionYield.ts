import type { ClickHouseClient } from '../db/client.ts'
import { RAY, SECONDS_PER_YEAR as AAVE_SECONDS_PER_YEAR, rayMul } from './aaveMath.ts'
import { cachedSwr } from './cache.ts'
import { externalTokenApys } from './externalTokenApy.ts'
import {
  MM_MARKETS, assetDecimalsOrNull, assetDescriptor, assetIdFromMmAddress, currentPriceOf, isStableswapShareToken,
  type ExplorerAsset,
} from './explorerAssets.ts'
import { ensurePrices, loadXykCurrentState, scaledFromPriceInfo, type PriceInfo, type XykCurrentPool } from './explorerService.ts'
import {
  PERC_DECIMALS, buildFarmConfigSql, foldLiveXykFarms, omnipoolFarmAprs, splitAcrossYieldFarms, xykFarmAprPercScaled,
  type FarmAprEntry, type FarmConfigRow, type LiveXykFarm,
} from './farmApr.ts'
import { iso } from './isoTimestamp.ts'
import { xykShareLegs, type StableswapSharePool } from './lpMath.ts'
import { readReserveStateRows } from './moneyMarketCaps.ts'
import { WINDOW_DAYS, poolVolumes, readAnchor, scaledUsd, xykPoolMeta } from './poolVolumes.ts'
import { omnipoolYield, stableswapYield } from './poolYield.ts'
import { currentStableswapSharePools } from './stableswapSharePools.ts'
import { loadV3Registry, v3PoolStats } from './uniswapV3Service.ts'

// GET /explorer/yields — the current yield of every liquidity venue and money-market
// reserve, stated as a composition the explorer's Liquidity and Borrow tabs render
// (Omnipool fee, Stablepool fee, money-market supply APY of aToken legs, lending
// incentives, farm rewards per reward asset).
//
// ONE definition per rate, shared rather than restated:
//  * Omnipool / Stablepool fee APR: `poolYield.ts` over 30 days — the SAME code and
//    cache shape `/v1/pools/{omnipool,stableswap}/yield` serves, so the explorer's
//    number is the public API's digit for digit.
//  * Omnipool farm APR: `farmApr.ts`'s per-farm terms (`omnipoolFarmAprs`), the
//    terms the public per-asset `farmAprPerc` sums.
//  * XYK farm APR: the same pallet rule (`xykFarmAprPercScaled`, uncapped branch
//    halved — see there), on the XYK farmed principal valued at pool NAV and current
//    prices, exactly as the account page values an XYK Farm row (getXykPositions).
//  * XYK fee APR: 30-day LP fees (every XYK fee leg is paid to the pool account)
//    valued at event time, over the pool's CURRENT NAV at current prices, annualised
//    ×365/30. Current rather than mean TVL: a mean needs a per-sample valuation of
//    the reserve history, and the fee itself is the only window quantity here.
//    A pool that did not trade has a measured 0 %, not a missing one.
//  * Uniswap v3 fee APR: pool-level 7-day LP fees (uniswap_v3_legs, amount_in × fee
//    tier) over the pool's current balances at current prices, ×365/7, net of the
//    protocol's 1/n share when SetFeeProtocol turned one on (null when the two sides
//    differ, since the fee total is not split per side here).
//  * Money-market reserve APYs: the reserve's newest ReserveDataUpdated rates (RAY
//    APRs) compounded per second over Aave's 365-day year, (1 + r/Y)^Y − 1, in RAY
//    fixed point (`rayAprToApyPctScaled`) — the convention Aave's own UI applies.
//  * Lending incentive APRs: each RewardsController programme still running at the
//    anchor (distribution end in the future, non-zero emission) — emission per second
//    × Y × reward price over the token's total supply (the reserve's current supplied
//    amount for an aToken, its current debt for a variable-debt token) × the
//    underlying's price. The controller distributes over the SCALED total, and a
//    holder's share of it equals their share of the actual total, so the rate per
//    unit of balance is the same either way.
//
// Stableswap shares and aTokens carry what their holder economically earns through
// them: a share earns its pool's fee and, for every leg that is a money-market
// aToken, that reserve's supply APY and incentives weighted by the leg's CURRENT USD
// share of the pool; an aToken earns its reserve's supply APY and incentives, and —
// when its reserve is itself a stableswap share (GETH over 2-Pool-GETH) — what that
// share earns, since the share appreciates inside the reserve. Weights nest.
//
// Integer arithmetic throughout: percentages are integer counts of 10^-PCT_DECIMALS
// percent, USD is 10^-12, rates are RAY, and a percentage becomes a JS number once,
// at the wire. A missing input (unpriced leg, no rate, no TVL) is null — never zero —
// and a total with a null component is null.

// 'token-yield': what a yield-bearing token accrues by itself (vDOT's staking, a
// vault share's appreciation) — the growth of its stableswap peg multiplier, which
// is the token's redemption rate (tokenAccrualAprs).
export type YieldComponentKind = 'omnipool-fee' | 'stablepool-fee' | 'xyk-fee' | 'v3-fee' | 'mm-supply' | 'mm-incentive' | 'token-yield' | 'farm'
/** Where a token-yield rate comes from: the Hydration UI's external sources, else the on-chain peg growth. */
export type TokenYieldSource = 'defillama' | 'kamino' | 'on-chain'
export interface YieldComponent { kind: YieldComponentKind; aprPct: number | null; asset?: ExplorerAsset; weightPct?: number; source?: TokenYieldSource }
export interface FarmYield { globalFarmId: number; yieldFarmId: number; rewardAsset: ExplorerAsset; aprPct: number | null }
export interface PoolYield { totalAprPct: number | null; components: YieldComponent[]; farms: FarmYield[] }
export interface ReserveYield {
  supplyApyPct: number | null
  borrowApyPct: number | null
  supplyIncentives: { rewardAsset: ExplorerAsset; aprPct: number | null }[]
  borrowIncentives: { rewardAsset: ExplorerAsset; aprPct: number | null }[]
  /**
   * Everything supplying this reserve earns, composed like a pool's yield: the
   * reserve's supply APY and incentives, plus what the underlying accrues by itself
   * (a stableswap share's fee and legs, a yield-bearing token's own rate). What the
   * Hydration UI calls the reserve's total supply APY.
   */
  supply: PoolYield
}
export interface ExplorerYields {
  asOf: string
  feeWindow: '30d'
  omnipool: Record<string, PoolYield>
  stableswap: Record<string, PoolYield>
  xyk: Record<string, PoolYield>
  uniswapV3: Record<string, PoolYield>
  /** marketKey → reserve yield, keyed by the underlying asset id and, for a reserve with a registered aToken, also by that aToken id. */
  moneyMarket: Record<string, Record<string, ReserveYield>>
}

let client: ClickHouseClient | null = null
export function initPositionYield(c: ClickHouseClient): void { client = c }

// ── integer percent arithmetic ──

/** Decimals an internal percentage carries (1 = 10^-6 %). */
export const PCT_DECIMALS = 6
const PCT_UNIT = 10n ** BigInt(PCT_DECIMALS)
/** A leg weight's fixed point: 10^12 = the whole pool. */
export const WEIGHT_UNIT = 10n ** 12n

function divHalfUp(n: bigint, d: bigint): bigint {
  const negative = (n < 0n) !== (d < 0n)
  const an = n < 0n ? -n : n, ad = d < 0n ? -d : d
  const q = (an * 2n + ad) / (ad * 2n)
  return negative ? -q : q
}

/** An internal percentage as the wire's JS number, converted once from its decimal string. */
export function pctNumber(scaled: bigint | null): number | null {
  if (scaled == null) return null
  const negative = scaled < 0n
  const digits = (negative ? -scaled : scaled).toString().padStart(PCT_DECIMALS + 1, '0')
  return Number(`${negative ? '-' : ''}${digits.slice(0, -PCT_DECIMALS)}.${digits.slice(-PCT_DECIMALS)}`)
}

/** A 4-decimal percentage string (the public yield wire) as an internal percentage. */
export function pctFromPerc(perc: string | null | undefined): bigint | null {
  if (perc == null) return null
  const negative = perc.startsWith('-')
  const [whole, frac = ''] = (negative ? perc.slice(1) : perc).split('.')
  const v = BigInt(whole || '0') * PCT_UNIT + BigInt((frac + '0'.repeat(PCT_DECIMALS)).slice(0, PCT_DECIMALS) || '0')
  return negative ? -v : v
}

/** farmApr.ts's 10^-PERC_DECIMALS percent as an internal percentage (exact: 4 < 6). */
export function pctFromFarmScaled(v: bigint | null): bigint | null {
  return v == null ? null : v * 10n ** BigInt(PCT_DECIMALS - PERC_DECIMALS)
}

/** WadRayMath-style x^n in RAY by squaring, each product rounded half-up (rayMul). */
export function rayPow(x: bigint, n: bigint): bigint {
  let z = n % 2n !== 0n ? x : RAY
  for (let e = n / 2n; e > 0n; e /= 2n) {
    x = rayMul(x, x)
    if (e % 2n !== 0n) z = rayMul(z, x)
  }
  return z
}

/**
 * A RAY-scaled annual rate (liquidityRate / variableBorrowRate) as an APY in
 * internal percent: (1 + r/Y)^Y − 1 with Y = 31 536 000, the per-second
 * compounding the reserve's index realises.
 */
export function rayAprToApyPctScaled(rate: bigint): bigint {
  if (rate <= 0n) return 0n
  const perSecond = RAY + rate / AAVE_SECONDS_PER_YEAR
  return divHalfUp((rayPow(perSecond, AAVE_SECONDS_PER_YEAR) - RAY) * 100n * PCT_UNIT, RAY)
}

/**
 * A RewardsController programme's APR in internal percent:
 * emission/s · Y · rewardPrice / 10^rewardDec  ÷  total / 10^tokenDec · tokenPrice.
 * Null without a price, or with nothing supplied/borrowed to spread it over.
 */
export function incentiveAprPctScaled(
  emissionPerSecond: bigint, rewardDecimals: number, rewardPriceUsd: bigint | null,
  totalSupply: bigint | null, tokenDecimals: number, tokenPriceUsd: bigint | null,
): bigint | null {
  if (rewardPriceUsd == null || tokenPriceUsd == null || totalSupply == null || totalSupply <= 0n) return null
  return divHalfUp(
    emissionPerSecond * AAVE_SECONDS_PER_YEAR * rewardPriceUsd * 10n ** BigInt(tokenDecimals) * 100n * PCT_UNIT,
    10n ** BigInt(rewardDecimals) * totalSupply * tokenPriceUsd,
  )
}

/** A period fee over a TVL, annualised: 100 · fee/tvl · 365/days, internal percent. Null without a TVL. */
export function feeAprPctScaled(feeUsd: bigint, tvlUsd: bigint | null, days: number): bigint | null {
  if (tvlUsd == null || tvlUsd <= 0n) return null
  return divHalfUp(feeUsd * 365n * 100n * PCT_UNIT, BigInt(days) * tvlUsd)
}

/** Each leg's USD share of the pool (WEIGHT_UNIT = all of it); null when any leg is unpriced or the pool is empty. */
export function legWeights(legUsd: ReadonlyArray<bigint | null>): bigint[] | null {
  if (legUsd.some(v => v == null)) return null
  const total = (legUsd as bigint[]).reduce((a, b) => a + b, 0n)
  if (total <= 0n) return null
  return (legUsd as bigint[]).map(v => v * WEIGHT_UNIT / total)
}

function weighted(v: bigint | null, w: bigint | null): bigint | null {
  return v == null || w == null ? null : divHalfUp(v * w, WEIGHT_UNIT)
}

// ── composition ──

interface Part { kind: YieldComponentKind; apr: bigint | null; assetId?: number; weight?: bigint | null; source?: TokenYieldSource }

const KIND_ORDER: Record<YieldComponentKind, number> = {
  'omnipool-fee': 0, 'stablepool-fee': 0, 'xyk-fee': 0, 'v3-fee': 0, 'mm-supply': 1, 'token-yield': 1, 'mm-incentive': 2, farm: 3,
}

/** Farm terms folded per reward asset: a sum with an unknown term is unknown. */
export function farmPartsByReward(entries: ReadonlyArray<{ rewardAssetId: number; apr: bigint | null }>): Part[] {
  const by = new Map<number, bigint | null>()
  for (const e of entries) {
    const prev = by.has(e.rewardAssetId) ? by.get(e.rewardAssetId)! : 0n
    by.set(e.rewardAssetId, prev == null || e.apr == null ? null : prev + e.apr)
  }
  return [...by].map(([assetId, apr]) => ({ kind: 'farm' as const, apr, assetId }))
}

/** Parts → the wire's PoolYield: fees first, then mm-supply, mm-incentive, farms; total null if any part is. */
export function assemblePoolYield(parts: Part[], farms: FarmYield[] = []): PoolYield {
  const ordered = parts.map((p, i) => ({ p, i })).sort((a, b) => KIND_ORDER[a.p.kind] - KIND_ORDER[b.p.kind] || a.i - b.i).map(x => x.p)
  let total: bigint | null = 0n
  for (const p of ordered) total = total == null || p.apr == null ? null : total + p.apr
  const components = ordered.map(p => {
    const c: YieldComponent = { kind: p.kind, aprPct: pctNumber(p.apr) }
    if (p.assetId != null) c.asset = assetDescriptor(p.assetId)
    if (p.source) c.source = p.source
    if ((p.kind === 'mm-supply' || p.kind === 'token-yield') && p.weight != null) c.weightPct = pctNumber(divHalfUp(p.weight * 100n * PCT_UNIT, WEIGHT_UNIT)) as number
    return c
  })
  return { totalAprPct: parts.length ? pctNumber(total) : null, components, farms }
}

interface MmReserve {
  market: string
  underlyingId: number | null
  aToken: string
  vDebt: string
  aTokenAssetId: number | null
  supplied: bigint | null
  debt: bigint | null
  supplyApy: bigint | null
  borrowApy: bigint | null
  supplyIncentives: Array<{ rewardAssetId: number; apr: bigint | null }>
  borrowIncentives: Array<{ rewardAssetId: number; apr: bigint | null }>
}

export interface YieldContext {
  /** aToken registry id → its reserve. */
  aTokenReserve: Map<number, MmReserve>
  /** Stableswap pool id → current pool state. */
  pools: Map<number, StableswapSharePool>
  /** Stableswap pool id → 30d fee APR, internal percent (null = no denominator). */
  poolFee: Map<number, bigint | null>
  price: (assetId: number) => bigint | null
  decimals: (assetId: number) => number | null
  /** Yield-bearing token → its own rate, internal percent: the external APY where fresh, else tokenAccrualAprs. */
  accrual: Map<number, bigint>
  /** Where each `accrual` rate comes from; absent = on-chain. */
  accrualSource?: Map<number, TokenYieldSource>
}

const MAX_NEST = 4

/**
 * What holding `assetId` earns through the asset itself, weighted by `weight` —
 * money-market supply/incentives when it is an aToken, the pool fee and the aToken
 * legs when it is a stableswap share (recursively, weights multiplying).
 */
export function underlyingParts(assetId: number, weight: bigint | null, ctx: YieldContext, depth = 0): Part[] {
  if (depth >= MAX_NEST) return []
  const out: Part[] = []
  const own = ctx.accrual.get(assetId)
  if (own != null) out.push({ kind: 'token-yield', apr: weighted(own, weight), assetId, weight, source: ctx.accrualSource?.get(assetId) ?? 'on-chain' })
  const reserve = ctx.aTokenReserve.get(assetId)
  if (reserve) {
    out.push({ kind: 'mm-supply', apr: weighted(reserve.supplyApy, weight), assetId: reserve.underlyingId ?? undefined, weight })
    for (const inc of reserve.supplyIncentives) out.push({ kind: 'mm-incentive', apr: weighted(inc.apr, weight), assetId: inc.rewardAssetId })
    if (reserve.underlyingId != null && reserve.underlyingId !== assetId) out.push(...underlyingParts(reserve.underlyingId, weight, ctx, depth + 1))
    return out
  }
  const pool = ctx.pools.get(assetId)
  if (!pool && !isStableswapShareToken(assetId)) return out
  out.push({ kind: 'stablepool-fee', apr: weighted(ctx.poolFee.has(assetId) ? ctx.poolFee.get(assetId)! : null, weight) })
  // A share with no current pool state (the snapshot missing or older than its
  // bound) cannot state its legs: its yield is unknown, never the fee alone.
  if (!pool) { out.push({ kind: 'mm-supply', apr: null, weight }); return out }
  const legUsd = pool.assetIds.map((id, i) => {
    const price = ctx.price(id)
    const decimals = ctx.decimals(id)
    return price == null || decimals == null ? null : pool.reserves[i] * price / 10n ** BigInt(decimals)
  })
  const weights = legWeights(legUsd)
  pool.assetIds.forEach((id, i) => {
    const w = weights == null || weight == null ? null : weights[i] * weight / WEIGHT_UNIT
    if (ctx.aTokenReserve.has(id) || ctx.pools.has(id) || ctx.accrual.has(id)) out.push(...underlyingParts(id, w, ctx, depth + 1))
  })
  return out
}

// ── token accrual ──

const SECONDS_PER_YEAR_BIG = 365n * 86_400n

/**
 * A yield-bearing token's own APR from its peg multiplier: a stableswap pool pegs
 * such a token to its partner by the token's redemption rate (vDOT against DOT, a
 * vault share against its asset), so the rate's growth over the window (up to
 * TOKEN_YIELD_WINDOW_DAYS, see PEG_WINDOW_SQL), annualised
 * (simple, not compounded), is what holding the token earns by itself. Pure; the
 * rows are one pool's peg vectors at the window's two ends. A leg whose peg did not
 * move (a fixed conversion, an unpegged leg) accrues nothing and is left out; a
 * token pegged in several pools takes the first stated one (they track one rate).
 */
export function tokenAccrualAprs(rows: ReadonlyArray<{ asset_ids: Array<number | string>; n0: string[]; d0: string[]; n1: string[]; d1: string[]; t0: number | string; t1: number | string }>): Map<number, bigint> {
  const out = new Map<number, bigint>()
  for (const r of rows) {
    const dt = BigInt(Number(r.t1) - Number(r.t0))
    if (dt <= 0n) continue
    r.asset_ids.forEach((idRaw, i) => {
      const id = Number(idRaw)
      if (out.has(id)) return
      const [n0, d0, n1, d1] = [r.n0[i], r.d0[i], r.n1[i], r.d1[i]].map(v => (v && /^\d+$/.test(v) ? BigInt(v) : 0n))
      if (n0 <= 0n || d0 <= 0n || n1 <= 0n || d1 <= 0n) return
      // growth = (n1/d1) / (n0/d0) − 1, as a fraction n1·d0 / (d1·n0) − 1.
      const num = n1 * d0 - d1 * n0, den = d1 * n0
      if (num === 0n) return
      out.set(id, divHalfUp(num * 100n * PCT_UNIT * SECONDS_PER_YEAR_BIG, den * dt))
    })
  }
  return out
}

// Each stableswap pool's peg vectors at the newest 600-block sample and at the
// earliest sample of the TOKEN_YIELD_WINDOW_DAYS before it. Longer than the fee
// window on purpose: some redemption rates move in irregular bursts weeks apart
// (PRIME's paused from 2026-05-19 to 2026-07-31), so a 30-day window can fall
// between two bursts and read a real yield as zero. A pool with less history uses
// what it has, from TOKEN_YIELD_MIN_DAYS on. Bounded to the window's own samples.
const TOKEN_YIELD_WINDOW_DAYS = 180
const TOKEN_YIELD_MIN_DAYS = 30
const PEG_WINDOW_SQL = `-- explorer:yields:peg-window
SELECT pool_id, asset_ids,
       argMax(peg_num, block_height) AS n1, argMax(peg_den, block_height) AS d1, toUInt32(max(block_timestamp)) AS t1,
       argMin(peg_num, block_height) AS n0, argMin(peg_den, block_height) AS d0, toUInt32(min(block_timestamp)) AS t0
FROM price_data.stableswap_pool_state_history FINAL
WHERE block_timestamp >= toDateTime({anchor:UInt32}) - INTERVAL ${TOKEN_YIELD_WINDOW_DAYS} DAY AND block_timestamp <= toDateTime({anchor:UInt32})
  AND notEmpty(peg_num)
GROUP BY pool_id, asset_ids
HAVING t1 - t0 >= ${TOKEN_YIELD_MIN_DAYS} * 86400`

/**
 * The token rates a composition uses: each token's current APY from the Hydration
 * UI's sources where the refresher holds a fresh one (externalTokenApy.ts), else its
 * on-chain peg growth — the same figure the app shows, with the source named. Pure.
 */
export function tokenRates(onChain: ReadonlyMap<number, bigint>, external: ReadonlyMap<number, { apyPct: bigint; source: 'defillama' | 'kamino' }>): { accrual: Map<number, bigint>; accrualSource: Map<number, TokenYieldSource> } {
  const accrual = new Map(onChain)
  const accrualSource = new Map<number, TokenYieldSource>([...onChain.keys()].map(id => [id, 'on-chain' as const]))
  for (const [id, e] of external) { accrual.set(id, e.apyPct); accrualSource.set(id, e.source) }
  return { accrual, accrualSource }
}

// ── reads ──

const MM_RESERVE_SQL = `-- explorer:yields:mm-reserves
SELECT m.market_key AS market_key, m.pool_address AS pool_address, m.reserve_address AS reserve_address,
       m.atoken AS atoken, m.vdebt AS vdebt,
       toInt64(if(a.ev = '', -1, toInt64(a.asset_id))) AS atoken_asset_id
FROM (
  SELECT DISTINCT market_key, lower(pool_proxy) AS pool_address, lower(asset_address) AS reserve_address,
                  lower(atoken) AS atoken, lower(vdebt) AS vdebt
  FROM price_data.atoken_reserve_map FINAL
) AS m
LEFT JOIN (
  SELECT lower(evm_address) AS ev, any(asset_id) AS asset_id
  FROM price_data.assets FINAL WHERE evm_address != '' GROUP BY ev
) AS a ON a.ev = m.atoken`

// The newest rates per reserve: argMax over the table's replacement key plus its
// version, so a replayed duplicate resolves to the same winner without FINAL.
const MM_RATES_SQL = `-- explorer:yields:mm-rates
SELECT pool_address, reserve_address,
       toString(argMax(liquidity_rate, tuple(block_height, event_index, ingested_at))) AS liquidity_rate,
       toString(argMax(variable_borrow_rate, tuple(block_height, event_index, ingested_at))) AS variable_borrow_rate
FROM price_data.money_market_reserve_rates
GROUP BY pool_address, reserve_address`

const MM_PROGRAMMES_SQL = `-- explorer:yields:mm-programmes
SELECT asset_address, reward_address,
       toString(argMax(new_emission, tuple(block_height, event_index, ingested_at))) AS emission,
       toString(argMax(new_distribution_end, tuple(block_height, event_index, ingested_at))) AS distribution_end
FROM price_data.mm_incentive_programmes
GROUP BY asset_address, reward_address`

const XYK_FARMED_SQL = `-- explorer:yields:xyk-farmed
SELECT lp_asset_id, toString(sum(toInt256(principal_shares_raw))) AS shares
FROM price_data.xyk_farm_principal_intervals FINAL
WHERE valid_to_block = 0
GROUP BY lp_asset_id`

async function rows<T>(c: ClickHouseClient, query: string): Promise<T[]> {
  const res = await c.query({ query, format: 'JSONEachRow' })
  return res.json<T>()
}

function priceLookup(prices: Map<number, PriceInfo>): (assetId: number) => bigint | null {
  return id => scaledFromPriceInfo(currentPriceOf(prices, id))
}

function usdOf(raw: bigint, assetId: number, price: (id: number) => bigint | null): bigint | null {
  const p = price(assetId)
  const decimals = assetDecimalsOrNull(assetId)
  return p == null || decimals == null ? null : raw * p / 10n ** BigInt(decimals)
}

async function loadMmReserves(c: ClickHouseClient, anchorSec: bigint, price: (id: number) => bigint | null): Promise<MmReserve[]> {
  const [mapRows, stateRows, rateRows, programmeRows] = await Promise.all([
    rows<{ market_key: string; pool_address: string; reserve_address: string; atoken: string; vdebt: string; atoken_asset_id: string | number }>(c, MM_RESERVE_SQL),
    readReserveStateRows(c),
    rows<{ pool_address: string; reserve_address: string; liquidity_rate: string; variable_borrow_rate: string }>(c, MM_RATES_SQL),
    rows<{ asset_address: string; reward_address: string; emission: string; distribution_end: string }>(c, MM_PROGRAMMES_SQL),
  ])
  const markets = new Set(MM_MARKETS.map(m => m.key))
  const key = (pool: string, reserve: string) => `${pool.toLowerCase()}|${reserve.toLowerCase()}`
  // Listed reserves only: the map keeps a delisted reserve's last row forever, and
  // its refresh generation is the tell (moneyMarketCaps.ts's `listed`).
  const state = new Map(stateRows.filter(r => Number(r.listed) === 1).map(r => [key(r.pool_address, r.reserve_address), r]))
  const rates = new Map(rateRows.map(r => [key(r.pool_address, r.reserve_address), r]))
  const programmes = new Map<string, Array<{ rewardAssetId: number; emission: bigint }>>()
  for (const p of programmeRows) {
    const emission = BigInt(p.emission || '0')
    if (emission <= 0n || BigInt(p.distribution_end || '0') <= anchorSec) continue
    const rewardAssetId = assetIdFromMmAddress(p.reward_address)
    if (rewardAssetId == null) {
      console.warn(`[explorer-yields] incentive reward ${p.reward_address} resolves to no registry asset; programme skipped`)
      continue
    }
    const list = programmes.get(p.asset_address.toLowerCase()) ?? []
    list.push({ rewardAssetId, emission })
    programmes.set(p.asset_address.toLowerCase(), list)
  }

  const out: MmReserve[] = []
  for (const m of mapRows) {
    if (!markets.has(m.market_key)) continue
    const s = state.get(key(m.pool_address, m.reserve_address))
    if (!s) continue
    const r = rates.get(key(m.pool_address, m.reserve_address))
    const underlyingId = assetIdFromMmAddress(m.reserve_address)
    const supplied = BigInt(String(s.supplied || '0'))
    const debt = BigInt(String(s.debt || '0'))
    const tokenPrice = underlyingId == null ? null : price(underlyingId)
    const tokenDecimals = underlyingId == null ? null : assetDecimalsOrNull(underlyingId)
    const incentives = (token: string, total: bigint) => (programmes.get(token) ?? []).map(p => ({
      rewardAssetId: p.rewardAssetId,
      apr: tokenDecimals == null ? null : incentiveAprPctScaled(
        p.emission, assetDescriptor(p.rewardAssetId).decimals, price(p.rewardAssetId), total, tokenDecimals, tokenPrice),
    }))
    const aTokenAssetId = Number(m.atoken_asset_id)
    out.push({
      market: m.market_key,
      underlyingId,
      aToken: m.atoken,
      vDebt: m.vdebt,
      aTokenAssetId: aTokenAssetId >= 0 ? aTokenAssetId : null,
      supplied,
      debt,
      supplyApy: r ? rayAprToApyPctScaled(BigInt(r.liquidity_rate || '0')) : null,
      borrowApy: r ? rayAprToApyPctScaled(BigInt(r.variable_borrow_rate || '0')) : null,
      supplyIncentives: incentives(m.atoken, supplied),
      borrowIncentives: incentives(m.vdebt, debt),
    })
  }
  return out
}

function xykTvlUsd(st: XykCurrentPool, price: (id: number) => bigint | null): bigint | null {
  const a = usdOf(st.reserveA, st.assetA, price)
  const b = usdOf(st.reserveB, st.assetB, price)
  return a == null || b == null ? null : a + b
}

function xykPositionUsd(shares: bigint, st: XykCurrentPool, price: (id: number) => bigint | null): bigint | null {
  const { amountA, amountB } = xykShareLegs(shares, st.reserveA, st.reserveB, st.totalShares)
  const a = usdOf(amountA, st.assetA, price)
  const b = usdOf(amountB, st.assetB, price)
  return a == null || b == null ? null : a + b
}

/**
 * The LP fee share of a v3 pool's swap fee: all of it while the protocol fee is off,
 * (n−1)/n with one denominator n on both sides; null when the sides differ.
 */
export function v3LpFee(feeUsd: bigint, feeProtocol0: number, feeProtocol1: number): bigint | null {
  if (feeProtocol0 === 0 && feeProtocol1 === 0) return feeUsd
  if (feeProtocol0 !== feeProtocol1) return null
  const n = BigInt(feeProtocol0)
  return feeUsd * (n - 1n) / n
}

async function buildExplorerYields(c: ClickHouseClient): Promise<ExplorerYields> {
  const anchor = await readAnchor(c)
  const empty: ExplorerYields = { asOf: iso(Date.now()), feeWindow: '30d', omnipool: {}, stableswap: {}, xyk: {}, uniswapV3: {}, moneyMarket: {} }
  if (!anchor) return empty
  const anchorSec = BigInt(Math.floor(new Date(iso(anchor.anchor)).getTime() / 1000))

  const [prices, omni, stable, omniFarms, sharePools, xykMeta, xykFees, v3Fees, xykFarmRows, xykFarmedRows, v3Registry, pegRows] = await Promise.all([
    ensurePrices(),
    omnipoolYield(c, '30d'),
    stableswapYield(c, '30d'),
    omnipoolFarmAprs(c, anchor.anchor),
    currentStableswapSharePools(c),
    xykPoolMeta(c),
    poolVolumes(c, 'xyk', '30d'),
    poolVolumes(c, 'uniswapv3', '7d'),
    rows<FarmConfigRow>(c, buildFarmConfigSql('xyk_lm')),
    rows<{ lp_asset_id: number | string; shares: string }>(c, XYK_FARMED_SQL),
    loadV3Registry(assetIdFromMmAddress),
    c.query({ query: PEG_WINDOW_SQL, query_params: { anchor: Number(anchorSec) }, format: 'JSONEachRow' })
      .then(r => r.json<{ asset_ids: number[]; n0: string[]; d0: string[]; n1: string[]; d1: string[]; t0: number; t1: number }>()),
  ])
  const price = priceLookup(prices)
  const reserves = await loadMmReserves(c, anchorSec, price)

  const ctx: YieldContext = {
    aTokenReserve: new Map(reserves.filter(r => r.aTokenAssetId != null).map(r => [r.aTokenAssetId as number, r])),
    pools: new Map((sharePools ?? []).map(p => [p.poolId, p])),
    poolFee: new Map(stable.items.map(i => [Number(i.poolId), pctFromPerc(i.feeAprPerc)])),
    price,
    decimals: assetDecimalsOrNull,
    ...tokenRates(tokenAccrualAprs(pegRows), externalTokenApys()),
  }

  // ── money market ──
  const moneyMarket: ExplorerYields['moneyMarket'] = {}
  for (const r of reserves) {
    if (r.underlyingId == null) continue
    const incentives = (list: MmReserve['supplyIncentives']) => list.map(i => ({ rewardAsset: assetDescriptor(i.rewardAssetId), aprPct: pctNumber(i.apr) }))
    const entry = {
      supplyApyPct: pctNumber(r.supplyApy),
      borrowApyPct: pctNumber(r.borrowApy),
      supplyIncentives: incentives(r.supplyIncentives),
      borrowIncentives: incentives(r.borrowIncentives),
      // Supplying earns what the aToken earns: underlyingParts over the aToken is the
      // reserve's rate and incentives plus the underlying's own accrual; a reserve
      // with no registered aToken is composed from its parts directly.
      supply: assemblePoolYield(r.aTokenAssetId != null
        ? underlyingParts(r.aTokenAssetId, WEIGHT_UNIT, ctx)
        : [
          { kind: 'mm-supply', apr: r.supplyApy, assetId: r.underlyingId, weight: WEIGHT_UNIT },
          ...r.supplyIncentives.map(inc => ({ kind: 'mm-incentive' as const, apr: inc.apr, assetId: inc.rewardAssetId })),
          ...underlyingParts(r.underlyingId, WEIGHT_UNIT, ctx),
        ]),
    }
    const market = (moneyMarket[r.market] ??= {})
    market[String(r.underlyingId)] = entry
    // Also under the aToken's own registry id: an account's supplied row is
    // displayed as the aToken it holds (aUSDT, a2-Pool-PRIME), so a reader keyed
    // by what the row shows finds the reserve either way. An aToken id never
    // collides with an underlying id — they are different registry assets.
    if (r.aTokenAssetId != null && market[String(r.aTokenAssetId)] == null) market[String(r.aTokenAssetId)] = entry
  }


  // ── Omnipool ──
  const farmsByAsset = new Map<number, FarmAprEntry[]>()
  for (const e of omniFarms) farmsByAsset.set(e.farm.assetId, [...farmsByAsset.get(e.farm.assetId) ?? [], e])
  const omnipool: ExplorerYields['omnipool'] = {}
  const omniIds = new Set<number>([...omni.items.map(i => Number(i.assetId)), ...farmsByAsset.keys()])
  const omniFee = new Map(omni.items.map(i => [Number(i.assetId), i.feeAprPerc]))
  for (const id of [...omniIds].sort((a, b) => a - b)) {
    const farms = (farmsByAsset.get(id) ?? []).map(e => ({ rewardAssetId: e.farm.rewardAssetId, apr: pctFromFarmScaled(e.aprScaled), g: e.farm.globalFarmId, y: e.farm.yieldFarmId }))
    omnipool[String(id)] = assemblePoolYield(
      [{ kind: 'omnipool-fee', apr: pctFromPerc(omniFee.get(id)) }, ...underlyingParts(id, WEIGHT_UNIT, ctx), ...farmPartsByReward(farms)],
      farms.map(f => ({ globalFarmId: f.g, yieldFarmId: f.y, rewardAsset: assetDescriptor(f.rewardAssetId), aprPct: pctNumber(f.apr) })),
    )
  }

  // ── Stableswap (wallet-held shares) ──
  const stableswap: ExplorerYields['stableswap'] = {}
  for (const item of stable.items) stableswap[item.poolId] = assemblePoolYield(underlyingParts(Number(item.poolId), WEIGHT_UNIT, ctx))

  // ── XYK ──
  const shareOfAccount = new Map<string, number>()
  const shareOfPair = new Map<string, number>()
  for (const [account, meta] of xykMeta) {
    if (meta.shareTokenId == null) continue
    shareOfAccount.set(account, Number(meta.shareTokenId))
    if (meta.assetA != null && meta.assetB != null) {
      shareOfPair.set(`${meta.assetA}:${meta.assetB}`, Number(meta.shareTokenId))
      shareOfPair.set(`${meta.assetB}:${meta.assetA}`, Number(meta.shareTokenId))
    }
  }
  const xykState = await loadXykCurrentState([...new Set(shareOfAccount.values())])
  const xykFarms = foldLiveXykFarms(xykFarmRows)
  const farmed = new Map(xykFarmedRows.map(r => [Number(r.lp_asset_id), BigInt(r.shares || '0')]))
  const split = splitAcrossYieldFarms(xykFarms)
  const at = new Date(iso(anchor.anchor))
  const xykFarmsByLp = new Map<number, Array<{ farm: LiveXykFarm; apr: bigint | null }>>()
  for (const farm of xykFarms) {
    const lp = shareOfPair.get(`${farm.assetPair[0]}:${farm.assetPair[1]}`)
    if (lp == null) continue
    const st = xykState.get(lp)
    // Same unknowns as the Omnipool farms: past the planned schedule, a split global
    // farm, no current pool state or an unpriced leg/reward is null.
    const stake = st ? xykPositionUsd(farmed.get(lp) ?? 0n, st, price) : null
    const apr = farm.endsAt > at && !split.has(farm.globalFarmId)
      ? pctFromFarmScaled(xykFarmAprPercScaled(farm, stake, price(farm.rewardAssetId)))
      : null
    xykFarmsByLp.set(lp, [...xykFarmsByLp.get(lp) ?? [], { farm, apr }])
  }
  const feeByLp = new Map<number, bigint>()
  for (const item of xykFees.items) {
    const lp = shareOfAccount.get(item.poolKey)
    if (lp != null) feeByLp.set(lp, (feeByLp.get(lp) ?? 0n) + scaledUsd(item.feeUsd))
  }
  const xyk: ExplorerYields['xyk'] = {}
  for (const [lp, st] of [...xykState].sort((a, b) => a[0] - b[0])) {
    if (st.totalShares <= 0n) continue
    const farms = xykFarmsByLp.get(lp) ?? []
    xyk[String(lp)] = assemblePoolYield(
      [
        { kind: 'xyk-fee', apr: feeAprPctScaled(feeByLp.get(lp) ?? 0n, xykTvlUsd(st, price), WINDOW_DAYS['30d']) },
        ...farmPartsByReward(farms.map(f => ({ rewardAssetId: f.farm.rewardAssetId, apr: f.apr }))),
      ],
      farms.map(f => ({ globalFarmId: f.farm.globalFarmId, yieldFarmId: f.farm.yieldFarmId, rewardAsset: assetDescriptor(f.farm.rewardAssetId), aprPct: pctNumber(f.apr) })),
    )
  }

  // ── Uniswap v3 (pool-level; Gamma vaults read their pool's entry) ──
  const v3FeeByPool = new Map(v3Fees.items.map(i => [i.poolKey.toLowerCase(), scaledUsd(i.feeUsd)]))
  const uniswapV3: ExplorerYields['uniswapV3'] = {}
  await Promise.all([...v3Registry.pools.values()].map(async pool => {
    const stats = await v3PoolStats(pool.address)
    let tvl: bigint | null = null
    if (stats && pool.asset0 != null && pool.asset1 != null) {
      const a = usdOf(BigInt(stats.balance0), pool.asset0, price)
      const b = usdOf(BigInt(stats.balance1), pool.asset1, price)
      tvl = a == null || b == null ? null : a + b
    }
    const lpFee = stats ? v3LpFee(v3FeeByPool.get(pool.address.toLowerCase()) ?? 0n, stats.feeProtocol0, stats.feeProtocol1) : null
    uniswapV3[pool.address.toLowerCase()] = assemblePoolYield([{ kind: 'v3-fee', apr: lpFee == null ? null : feeAprPctScaled(lpFee, tvl, WINDOW_DAYS['7d']) }])
  }))

  return { asOf: omni.asOf ?? iso(anchor.anchor), feeWindow: '30d', omnipool, stableswap, xyk, uniswapV3, moneyMarket }
}

/** GET /explorer/yields: global and current; ten minutes fresh, served stale for half an hour while one rebuild runs. */
export function getExplorerYields(): Promise<ExplorerYields> {
  const c = client
  if (!c) throw new Error('positionYield: initPositionYield was not called')
  return cachedSwr('explorer:yields', 600_000, 1_800_000, () => buildExplorerYields(c))
}
