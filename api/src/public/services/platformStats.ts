import type { ClickHouseClient } from '../../db/client.ts'
import { cachedSwr } from '../../services/cache.ts'
import { ATOKEN_UNDERLYING_ID } from '../../services/explorerAssets.ts'
import { getPoolsIndex, initPoolService } from '../../services/poolService.ts'
import { decimalToScaled, formatUsd } from './accountBalances.ts'
import { type MmReserveState, type MoneyMarketSupply, moneyMarketSupply } from './moneyMarketReserves.ts'
import { omnipoolVolumes, poolVolumes, routedTradesUsd } from './poolVolumes.ts'

// GET /v1/stats/platform: the chain-wide TVL and 24-hour volume headline.
//
// The two halves come from different clocks and say so:
//  * TVL is CURRENT state, read from the shared pool service — the same model the
//    explorer's /liquidity page renders, so the public number and the page can
//    never disagree. Its Omnipool total excludes the LRNA hub leg (the hub is the
//    pool's internal accounting unit, not deposited value).
//  * Volume is the rolling 24 hours of `pool_swap_legs`, anchored to the newest
//    indexed block. `asOf`/`blockHeight` describe THAT anchor; the TVL snapshot is
//    the newest block state and may sit a few blocks apart.
//
// `totalUsd` remains the POOLED total — omnipool + stableswap + xyk. The
// money-market figure is reported beside it and deliberately NOT added in,
// because the pooled total and the money-market total OVERLAP IN BOTH
// DIRECTIONS (AGENTS.md, the folded-asset conservation rule):
//
//  * `moneyMarketFoldedUsd` — money market → pools. Stableswap SHARE tokens
//    (2-Pool-GDOT, 3-Pool, …) deposited as money-market collateral. A share token
//    IS a claim on a pool whose reserves are already in `stableswapUsd`.
//  * `pooledATokenUsd` — pools → money market. The pools themselves DEPOSIT into
//    the money market and hold the receipt: pool 690 holds aDOT, 4200 holds aETH,
//    the stablepools hold aUSDT/aUSDC/aEURC/aSOL, 10055 holds BIL, and the
//    Omnipool holds aDOT (asset 1001) directly. Every one of those aTokens is
//    also inside `moneyMarketSupplyUsd`, because the pool is one of the reserve's
//    suppliers. Measured 2026-08-13: $8.58 M across ten priced pools, of which
//    aDOT alone is $3.23 M — 74% of the core market's DOT reserve is deposited by
//    Hydration's own pools.
//
// Staking-backed stHDX ($10.9 M in the GIGAHDX market) is NOT an overlap: that HDX
// is locked in its holder's own wallet and no pool holds it.
//
// Both fold components are published so the two surfaces reconcile exactly:
//
//     totalUsd + moneyMarketSupplyUsd - moneyMarketFoldedUsd - pooledATokenUsd
//       == /hydration-web/v1/stats `tvl`
//
// to the cent, because that endpoint folds THESE strings rather than recomputing.
// The identity is per computation: the two routes are held for 600 s and 60 s, so
// two responses fetched minutes apart differ by whatever moved in between.
// A consumer that wants one platform headline should use /hydration-web/v1/stats.

/** The window the headline reports. */
const VOLUME_WINDOW = '24h' as const

export interface PlatformStats {
  asOf: string | null
  blockHeight: number | null
  tvl: {
    omnipoolUsd: string | null
    stableswapUsd: string | null
    xykUsd: string | null
    /**
     * Every money-market reserve's supplied side at current prices, across all
     * three isolated markets. Null — never 0 — when the reserve-state model has
     * no rows (no aToken anchor) or nothing in it could be priced. Not part of
     * `totalUsd`; see the header.
     */
    moneyMarketSupplyUsd: string | null
    /** The part of `moneyMarketSupplyUsd` that is pool-share collateral, already inside the pooled venues. */
    moneyMarketFoldedUsd: string | null
    /** The part of the pooled venues that is aTokens, already inside `moneyMarketSupplyUsd`. */
    pooledATokenUsd: string | null
    totalUsd: string | null
  }
  volume24h: {
    omnipoolUsd: string
    stableswapUsd: string
    xykUsd: string
    /**
     * Netted end-to-end: a multi-hop route counts once, so per-venue sums exceed
     * it. Trades that are only an aToken wrap are excluded — see `all_aave` in
     * poolVolumes.ts, which this shares with the DefiLlama facade.
     */
    totalRoutedUsd: string
  }
}

/**
 * TVL as a 2-decimal string, the surface's USD wire shape (spec § Wire
 * conventions) — the same one the volume half arrives in from renderUsd, so both
 * halves of this response and the accounts endpoints all publish cents.
 *
 * Pool TVL is computed in floating point inside poolService (current holdings ×
 * current prices), so `toFixed` is the whole rounding here: the extra digits a
 * Decimal-string convention implies would be noise — cents is already past what
 * that model resolves.
 */
export function tvlUsdString(value: number | null): string | null {
  return value == null || !Number.isFinite(value) ? null : value.toFixed(2)
}

/**
 * A venue's TVL from the pool index.
 *
 * A pool whose legs are not all priced has no TVL at all (poolService's rule) and
 * contributes nothing, rather than making its whole venue unknown — 276 of the
 * chain's 289 XYK pools are unpriced dust. But a venue that HAS pools and not one
 * priced among them is unknown, not empty: reporting 0 there would publish a
 * broken price feed as a collapsed venue.
 */
export function venueTvlUsd(pools: Array<{ kind: string; tvlUsd: number | null }>, kind: 'stableswap' | 'xyk'): number | null {
  const venue = pools.filter(p => p.kind === kind)
  const priced = venue.filter(p => p.tvlUsd != null)
  if (venue.length > 0 && priced.length === 0) return null
  return priced.reduce((sum, p) => sum + (p.tvlUsd ?? 0), 0)
}

/**
 * The platform total: a sum of knowns, or nothing at all. Silently dropping an
 * unknown venue would understate the platform by that venue's whole value, which
 * reads as a crash in TVL rather than as missing data.
 */
export function sumKnownTvl(parts: Array<number | null>): number | null {
  return parts.some(p => p == null) ? null : parts.reduce((sum: number, p) => sum + (p ?? 0), 0)
}

/** The pool-index shape both folds read. */
export interface FoldablePool {
  kind: string
  poolId: number | null
  tvlUsd: number | null
  composition?: Array<{ asset: { assetId: number }; usd: number | null }>
}

/**
 * The share tokens of every pool THAT CONTRIBUTED TO THE POOLED TOTAL: a
 * Stableswap pool's `poolId` IS its share asset, an XYK pool's is its LP asset
 * (poolService's own keying).
 *
 * Holding one of these IS holding a claim on a pool whose reserves are already in
 * `stableswapUsd`/`xykUsd`, so a surface that folds another value source into the
 * pooled total must subtract the part denominated in them or it counts the same
 * liquidity twice.
 *
 * The `tvlUsd != null` guard is the enforced invariant, and it is the POOL's, not
 * the reserve's: poolService gives a pool no TVL at all unless EVERY leg is
 * priced, so an unpriced pool added nothing and its share token must not be
 * subtracted. Guarding on the money-market reserve's own price instead would be a
 * different, weaker condition — a share token can be priced through its underlying
 * while the pool behind it is not. Pool 10055 (BIL/HOLLAR) is the live near-miss:
 * it is priced today and one delisting away from the mismatch.
 */
export function poolShareAssetIds(pools: FoldablePool[]): Set<number> {
  const ids = new Set<number>()
  for (const pool of pools) {
    if (pool.tvlUsd == null) continue
    if (pool.poolId != null && (pool.kind === 'stableswap' || pool.kind === 'xyk')) ids.add(pool.poolId)
  }
  return ids
}

/**
 * The inverse fold: the money-market aTokens the POOLS hold.
 *
 * Hydration's pools are themselves money-market suppliers — pool 690 holds aDOT,
 * the stablepools hold aUSDT/aUSDC, the Omnipool holds asset 1001 (aDOT) — and each
 * of those receipts is inside `moneyMarketSupplyUsd` too, because the pool is one of
 * the reserve's suppliers. Summed here from the composition the index already
 * carries, over the same priced-pool set the pooled total was built from, so every
 * leg read here is one that WAS added (measured live: zero unpriced legs inside
 * priced pools, which is poolService's rule restated as data).
 *
 * `ATOKEN_UNDERLYING_ID` is the registry's own aToken list, so a newly listed
 * aToken folds without a deploy — the same property `poolShareAssetIds` has.
 */
export function pooledATokenUsd(pools: FoldablePool[]): number {
  let total = 0
  for (const pool of pools) {
    if (pool.tvlUsd == null) continue
    for (const leg of pool.composition ?? []) {
      if (ATOKEN_UNDERLYING_ID[leg.asset.assetId] != null) total += leg.usd ?? 0
    }
  }
  return total
}

/** The part of the money market's supplied side that is pool-share collateral. */
export function moneyMarketFoldedUsd(reserves: Array<Pick<MmReserveState, 'assetId' | 'suppliedUsd'>>, shareAssetIds: Set<number>): bigint {
  return reserves.reduce(
    (sum, r) => (r.assetId != null && shareAssetIds.has(r.assetId) ? sum + (r.suppliedUsd ?? 0n) : sum),
    0n,
  )
}

/**
 * A venue whose TVL came back unknown is a null in the response — the honest value
 * — but nothing about a 200 says the price feed died. `refreshPrices` swallows its
 * own failures, so a total outage would publish an all-null TVL indefinitely and
 * quietly. This is the operator-visible half of that contract.
 */
function warnOnUnknownTvl(byVenue: Record<string, number | null>): void {
  const unknown = Object.entries(byVenue).filter(([, value]) => value == null).map(([venue]) => venue)
  if (unknown.length === 0) return
  console.warn(`[public-api] platform TVL unknown for ${unknown.join(', ')} — every pool of `
    + `${unknown.length > 1 ? 'those venues' : 'that venue'} is unpriced (check the price feed, not the pool model)`)
}

/**
 * poolService keeps its ClickHouse handle in module state, set once at boot by
 * whichever process uses it. The public API is a separate process, so it is wired
 * here on first use rather than duplicating the pool composition model.
 */
let wiredClient: ClickHouseClient | null = null
export function ensurePoolService(client: ClickHouseClient): void {
  if (wiredClient === client) return
  initPoolService(client)
  wiredClient = client
}

/** The TVL half of /v1/stats/platform, exactly as it is published. */
export interface TvlComponents {
  omnipoolUsd: string | null
  stableswapUsd: string | null
  xykUsd: string | null
  moneyMarketSupplyUsd: string | null
  moneyMarketFoldedUsd: string | null
  pooledATokenUsd: string | null
  totalUsd: string | null
}

/**
 * The TVL composition both TVL surfaces read.
 *
 * /v1/stats/platform publishes it as-is; /hydration-web/v1/stats folds these exact
 * STRINGS into one headline rather than recomputing from the underlying floats, so
 * the conservation equation in the header holds to the published cent instead of to
 * within a rounding step.
 */
export function tvlComponents(pools: FoldablePool[], moneyMarket: MoneyMarketSupply): TvlComponents {
  const omnipoolUsd = pools.find(p => p.kind === 'omnipool')?.tvlUsd ?? null
  const stableswapUsd = venueTvlUsd(pools, 'stableswap')
  const xykUsd = venueTvlUsd(pools, 'xyk')
  const totalUsd = sumKnownTvl([omnipoolUsd, stableswapUsd, xykUsd])
  warnOnUnknownTvl({ omnipool: omnipoolUsd, stableswap: stableswapUsd, xyk: xykUsd })

  const shareIds = poolShareAssetIds(pools)
  const folded = moneyMarket.suppliedUsd == null ? null : moneyMarketFoldedUsd(moneyMarket.reserves, shareIds)
  return {
    omnipoolUsd: tvlUsdString(omnipoolUsd),
    stableswapUsd: tvlUsdString(stableswapUsd),
    xykUsd: tvlUsdString(xykUsd),
    moneyMarketSupplyUsd: moneyMarket.suppliedUsd == null ? null : formatUsd(moneyMarket.suppliedUsd),
    moneyMarketFoldedUsd: folded == null ? null : formatUsd(folded),
    // Always known when the pooled total is: it is summed over the priced pools
    // the total itself was built from.
    pooledATokenUsd: totalUsd == null ? null : tvlUsdString(pooledATokenUsd(pools)),
    totalUsd: tvlUsdString(totalUsd),
  }
}

/**
 * The single de-duplicated platform headline, at the 1e-12 integer scale.
 *
 * THE CONSERVATION EQUATION (AGENTS.md's folded-asset rule). Writing D for direct
 * holdings and C for custody:
 *
 *   pooled(D + C)  +  moneyMarket(D + C)
 *     = headline(D)                                  the value held once
 *     + moneyMarketFoldedUsd(C)                      pool shares held BY the market
 *     + pooledATokenUsd(C)                           aTokens held BY the pools
 *
 * with no unattributed remainder: both custody terms are attributed, and each is
 * SUBTRACTED from the total rather than the beneficial side being scaled to fit.
 * The two custody legs cannot overlap — one is denominated in pool-share tokens,
 * which are never aTokens, and the other in aTokens, which are never pool shares —
 * so a value cannot be removed twice. Pool 690 is the worked case: its liquidity is
 * counted once in `stableswapUsd`, again as the market's 2-Pool-GDOT collateral, and
 * a third time as the aDOT the pool itself supplies; the two folds remove exactly
 * the second and the third.
 *
 * Null in, null out: a headline missing a whole venue or the whole money market is
 * unknown, not a smaller platform.
 */
export function foldedPlatformTvl(components: TvlComponents): bigint | null {
  const { totalUsd, moneyMarketSupplyUsd, moneyMarketFoldedUsd: folded, pooledATokenUsd: pooled } = components
  if (totalUsd == null || moneyMarketSupplyUsd == null || folded == null || pooled == null) return null
  const cents = (value: string): bigint => decimalToScaled(value, 12)
  return cents(totalUsd) + cents(moneyMarketSupplyUsd) - cents(folded) - cents(pooled)
}

export async function platformStats(client: ClickHouseClient): Promise<PlatformStats> {
  return cachedSwr('pub:stats:platform', 60_000, 300_000, async () => {
    ensurePoolService(client)
    const [index, omniVolume, stableVolume, xykVolume, routed, moneyMarket] = await Promise.all([
      getPoolsIndex(),
      omnipoolVolumes(client, VOLUME_WINDOW),
      poolVolumes(client, 'stableswap', VOLUME_WINDOW),
      poolVolumes(client, 'xyk', VOLUME_WINDOW),
      routedTradesUsd(client, VOLUME_WINDOW),
      moneyMarketSupply(client),
    ])

    // The pool index already carries the Omnipool's TVL, computed by the same
    // buildComposition rule (reserves at current prices, hub leg excluded) that
    // getOmnipoolDetail applies. Reading it here instead of calling that model
    // avoids a whole-table state-history GROUP BY, a per-asset daily-candle series
    // and an accountRef() lookup into tag/identity caches this process never
    // initializes — for a number that is already in hand.
    return {
      asOf: omniVolume.asOf,
      blockHeight: omniVolume.blockHeight,
      tvl: tvlComponents(index.pools, moneyMarket),
      volume24h: {
        omnipoolUsd: omniVolume.totalVolumeUsd,
        stableswapUsd: stableVolume.totalVolumeUsd,
        xykUsd: xykVolume.totalVolumeUsd,
        totalRoutedUsd: routed.totalUsd,
      },
    }
  })
}
