import type { OmnipoolAssetState, XYKPool, StableswapPool, AssetDecimals, PriceMap } from './types.ts';
import { calculateLRNAPrice, calculateOmnipoolPrices } from './omnipool.ts';
import { calculateXYKPrices } from './xyk.ts';
import { calculateStableswapPrices } from './stableswap.ts';

// Find the most liquid stableswap LP token in Omnipool that contains the anchor.
function findMostLiquidStableLPToken(
  stableswapPools: StableswapPool[],
  omnipoolAssets: Map<number, OmnipoolAssetState>,
  anchorAssetId: number
): number | null {
  let bestPoolId: number | null = null;
  let bestHubReserve: bigint = 0n;

  for (const pool of stableswapPools) {
    if (!pool.assets.includes(anchorAssetId)) continue;
    const omnipoolState = omnipoolAssets.get(pool.poolId);
    if (!omnipoolState) continue;
    if (omnipoolState.hubReserve > bestHubReserve) {
      bestHubReserve = omnipoolState.hubReserve;
      bestPoolId = pool.poolId;
    }
  }

  return bestPoolId;
}

// Find the best LRNA anchor from the candidate list.
function findBestLRNAAnchor(
  omnipoolAssets: Map<number, OmnipoolAssetState>,
  anchorIds: number[]
): { assetId: number; state: OmnipoolAssetState } | null {
  let best: { assetId: number; state: OmnipoolAssetState } | null = null;

  for (const id of anchorIds) {
    const state = omnipoolAssets.get(id);
    if (!state || state.hubReserve === 0n) continue;
    if (!best || state.hubReserve > best.state.hubReserve) {
      best = { assetId: id, state };
    }
  }

  return best;
}

// Propagate prices between aToken equivalences (1:1 pairs).
// If one side has a price and the other doesn't, copy it over.
function propagateAtokenPrices(prices: PriceMap, equivalences: [number, number][]): boolean {
  let changed = false;
  for (const [base, aToken] of equivalences) {
    const basePrice = prices.get(base);
    const aTokenPrice = prices.get(aToken);
    if (aTokenPrice && !basePrice) {
      prices.set(base, aTokenPrice);
      changed = true;
    } else if (basePrice && !aTokenPrice) {
      prices.set(aToken, basePrice);
      changed = true;
    }
  }
  return changed;
}

// Normalize all prices so that USDT = $1.
function normalizeToUsdt(prices: PriceMap, usdtAssetId: number): void {
  const usdtPrice = prices.get(usdtAssetId);
  if (!usdtPrice) return;

  const usdtFloat = parseFloat(usdtPrice);
  if (usdtFloat === 0 || usdtFloat === 1) return;

  for (const [assetId, price] of prices.entries()) {
    const normalized = parseFloat(price) / usdtFloat;
    prices.set(assetId, normalized.toFixed(12));
  }
  prices.set(usdtAssetId, '1.000000000000');
}

// Resolve all asset prices denominated in USDT.
//
// Strategy:
// 1. If USDT is in the Omnipool, use it directly as $1 anchor (historical path)
// 2. Fallback: stableswap LP token containing USDT
// 3. Fallback: most liquid stablecoin from anchor list → compute all prices →
//    resolve USDT through stableswap/XYK + aToken equivalences → normalize to USDT
// 4. Compute all Omnipool prices via LRNA
// 5. Iteratively resolve XYK + Stableswap + aToken equivalences
// 6. Normalize so USDT = $1
export function resolvePrices(
  omnipoolAssets: Map<number, OmnipoolAssetState>,
  xykPools: XYKPool[],
  stableswapPools: StableswapPool[],
  decimals: AssetDecimals,
  usdtAssetId: number = 10,
  lrnaAssetId: number = 1,
  stablecoinAnchorIds: number[] = [10],
  atokenEquivalences: [number, number][] = []
): PriceMap {
  const prices = new Map<number, string>();
  const maxIterations = 10;

  let lrnaPrice: string | null = null;
  let needsNormalization = false;

  // Primary: USDT directly in Omnipool
  const usdtState = omnipoolAssets.get(usdtAssetId);
  if (usdtState) {
    try {
      const usdtDecimals = decimals.get(usdtAssetId) || 6;
      lrnaPrice = calculateLRNAPrice(usdtState, usdtDecimals);
      prices.set(usdtAssetId, '1.000000000000');
    } catch {
    }
  }

  // Fallback 1: stableswap LP token containing USDT
  if (!lrnaPrice) {
    const stablePoolLPId = findMostLiquidStableLPToken(stableswapPools, omnipoolAssets, usdtAssetId);
    if (stablePoolLPId !== null) {
      const stablePoolState = omnipoolAssets.get(stablePoolLPId);
      if (stablePoolState) {
        try {
          const lpDecimals = decimals.get(stablePoolLPId) || 18;
          lrnaPrice = calculateLRNAPrice(stablePoolState, lpDecimals);
          prices.set(stablePoolLPId, '1.000000000000');
          prices.set(usdtAssetId, '1.000000000000');
        } catch {
        }
      }
    }
  }

  // Fallback 2: most liquid stablecoin from anchor list.
  // Prices will be in anchor terms — normalized to USDT after iteration.
  if (!lrnaPrice) {
    const bestAnchor = findBestLRNAAnchor(omnipoolAssets, stablecoinAnchorIds);
    if (bestAnchor) {
      try {
        const anchorDecimals = decimals.get(bestAnchor.assetId) || 6;
        lrnaPrice = calculateLRNAPrice(bestAnchor.state, anchorDecimals);
        prices.set(bestAnchor.assetId, '1.000000000000');
        needsNormalization = true;
      } catch {
      }
    }
  }

  // Compute all Omnipool prices
  if (lrnaPrice) {
    prices.set(lrnaAssetId, lrnaPrice);

    const omnipoolPrices = calculateOmnipoolPrices(omnipoolAssets, lrnaPrice, decimals);
    for (const [assetId, price] of omnipoolPrices.entries()) {
      if (!prices.has(assetId)) {
        prices.set(assetId, price);
      }
    }
  }

  // Track Omnipool-priced assets for routing preference
  const omnipoolPricedAssets = new Set(prices.keys());

  // Iteratively resolve: aToken equivalences → XYK → Stableswap
  // aToken propagation runs each iteration so stableswap-priced aTokens
  // (e.g. aUSDT from HOLLAR/aUSDT pool) propagate to their base tokens
  // (e.g. USDT), enabling further price discovery.
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const pricesBefore = prices.size;

    propagateAtokenPrices(prices, atokenEquivalences);

    // Stableswap runs BEFORE XYK — stableswap pools have amplification-based
    // pricing that's more accurate for pegged assets (stablecoins, aTokens).
    // XYK's constant-product pricing would give worse prices for these pairs.
    const stableswapPrices = calculateStableswapPrices(stableswapPools, prices, decimals);
    for (const [assetId, price] of stableswapPrices.entries()) {
      if (!omnipoolPricedAssets.has(assetId)) {
        prices.set(assetId, price);
      }
    }

    // aToken propagation after stableswap so stableswap-priced aTokens
    // (e.g. aUSDT from HOLLAR/aUSDT pool) propagate to base tokens (e.g. USDT)
    propagateAtokenPrices(prices, atokenEquivalences);

    const xykPrices = calculateXYKPrices(xykPools, prices, decimals);
    for (const [assetId, price] of xykPrices.entries()) {
      if (!omnipoolPricedAssets.has(assetId) && !prices.has(assetId)) {
        prices.set(assetId, price);
      }
    }

    if (prices.size === pricesBefore) {
      break;
    }
  }

  // Normalize to USDT if we used a non-USDT anchor
  if (needsNormalization) {
    normalizeToUsdt(prices, usdtAssetId);
  }

  return prices;
}
