import type { OmnipoolAssetState, XYKPool, StableswapPool, AssetDecimals, PriceMap } from './types.ts';
import { calculateLRNAPrice, calculateOmnipoolPrices } from './omnipool.ts';
import { calculateXYKPrices } from './xyk.ts';
import { calculateStableswapPrices } from './stableswap.ts';

// Find the most liquid stablecoin-backed LP token in Omnipool.
// Criteria: Stableswap pool contains USDT, LP token is in Omnipool, select highest hubReserve.
function findMostLiquidStableLPToken(
  stableswapPools: StableswapPool[],
  omnipoolAssets: Map<number, OmnipoolAssetState>,
  usdtAssetId: number
): number | null {
  let bestPoolId: number | null = null;
  let bestHubReserve: bigint = 0n;

  for (const pool of stableswapPools) {
    // Must contain USDT
    if (!pool.assets.includes(usdtAssetId)) {
      continue;
    }

    // Must be in Omnipool
    const omnipoolState = omnipoolAssets.get(pool.poolId);
    if (!omnipoolState) {
      continue;
    }

    // Track highest liquidity
    if (omnipoolState.hubReserve > bestHubReserve) {
      bestHubReserve = omnipoolState.hubReserve;
      bestPoolId = pool.poolId;
    }
  }

  return bestPoolId;
}

// Resolve all asset prices across all pool types.
// Order: USDT = $1, calculate LRNA price from USDT, calculate Omnipool prices via LRNA,
// iteratively resolve XYK + Stableswap until no new prices (max 10 iterations).
export function resolvePrices(
  omnipoolAssets: Map<number, OmnipoolAssetState>,
  xykPools: XYKPool[],
  stableswapPools: StableswapPool[],
  decimals: AssetDecimals,
  usdtAssetId: number = 10,
  lrnaAssetId: number = 1
): PriceMap {
  const prices = new Map<number, string>();
  const maxIterations = 10;

  prices.set(usdtAssetId, '1.000000000000');

  let lrnaPrice: string | null = null;
  let stablePoolLPId: number | null = null;

  const usdtState = omnipoolAssets.get(usdtAssetId);
  if (usdtState) {
    try {
      const usdtDecimals = decimals.get(usdtAssetId) || 6;
      lrnaPrice = calculateLRNAPrice(usdtState, usdtDecimals);
    } catch {
    }
  }

  // Fallback: LP tokens from pools containing USDT are approximately $1 (stablecoin-backed)
  if (!lrnaPrice) {
    stablePoolLPId = findMostLiquidStableLPToken(stableswapPools, omnipoolAssets, usdtAssetId);
    if (stablePoolLPId !== null) {
      const stablePoolState = omnipoolAssets.get(stablePoolLPId);
      if (stablePoolState) {
        try {
          // Approximate: LP token = $1 (backed by stablecoins)
          const lpDecimals = decimals.get(stablePoolLPId) || 18;
          lrnaPrice = calculateLRNAPrice(stablePoolState, lpDecimals);
          prices.set(stablePoolLPId, '1.000000000000');
        } catch {
        }
      }
    }
  }

  if (lrnaPrice) {
    prices.set(lrnaAssetId, lrnaPrice);

    const omnipoolPrices = calculateOmnipoolPrices(omnipoolAssets, lrnaPrice, decimals);
    for (const [assetId, price] of omnipoolPrices.entries()) {
      // Don't overwrite USDT or LP token prices (they're anchors)
      if (assetId !== usdtAssetId && assetId !== stablePoolLPId) {
        prices.set(assetId, price);
      }
    }
  }

  const omnipoolPricedAssets = new Set<number>();
  for (const [assetId, price] of prices.entries()) {
    if (assetId !== usdtAssetId) {
      omnipoolPricedAssets.add(assetId);
    }
  }

  // Only add prices for assets NOT already priced via Omnipool (routing preference)
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const pricesBefore = prices.size;

    const xykPrices = calculateXYKPrices(xykPools, prices, decimals);
    for (const [assetId, price] of xykPrices.entries()) {
      if (!omnipoolPricedAssets.has(assetId)) {
        prices.set(assetId, price);
      }
    }

    const stableswapPrices = calculateStableswapPrices(stableswapPools, prices, decimals);
    for (const [assetId, price] of stableswapPrices.entries()) {
      if (!omnipoolPricedAssets.has(assetId)) {
        prices.set(assetId, price);
      }
    }

    if (prices.size === pricesBefore) {
      break;
    }
  }

  return prices;
}
