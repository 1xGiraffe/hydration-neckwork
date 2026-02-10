import type { StableswapPool, PriceMap, AssetDecimals } from './types.ts';

const MAX_D_ITERATIONS = 64;
const MAX_Y_ITERATIONS = 128;
const PRECISION = 1n;

// Calculate the stableswap invariant D using Newton's method.
// The invariant D represents the total value in the pool at equal price.
export function calculateD(reserves: bigint[], amplification: bigint): bigint {
  const n = BigInt(reserves.length);

  // Edge case: if any reserve is 0, D = 0
  for (const reserve of reserves) {
    if (reserve === 0n) {
      return 0n;
    }
  }

  // Calculate sum of reserves
  let sum = 0n;
  for (const reserve of reserves) {
    sum += reserve;
  }

  // Initial guess: D = sum of reserves
  let d = sum;
  let d_prev = 0n;

  // Calculate Ann = A * n^n
  let n_pow = 1n;
  for (let i = 0; i < Number(n); i++) {
    n_pow *= n;
  }
  const ann = amplification * n_pow;

  // Newton's method iteration
  for (let iteration = 0; iteration < MAX_D_ITERATIONS; iteration++) {
    // Calculate d_prod = D^(n+1) / (n^n * prod(reserves))
    // We compute this as: D * D * D * ... / (n^n * r1 * r2 * ...)
    let d_prod = d;
    for (const reserve of reserves) {
      d_prod = d_prod * d / (reserve * n);
    }

    d_prev = d;

    // d_next = (Ann * sum + d_prod * n) * d / ((Ann - 1) * d + (n + 1) * d_prod)
    const numerator = (ann * sum + d_prod * n) * d;
    const denominator = (ann - 1n) * d + (n + 1n) * d_prod;

    d = numerator / denominator;

    // Check convergence
    const diff = d > d_prev ? d - d_prev : d_prev - d;
    if (diff <= PRECISION) {
      return d;
    }
  }

  // If didn't converge, return best approximation
  return d;
}

/**
 * Calculate the required reserve Y for a given invariant D
 *
 * Given all reserves except targetIndex, compute what reserve[targetIndex]
 * should be to maintain invariant D.
 *
 * Uses Newton's method to solve for y in the stableswap equation.
 *
 * @param reserves - Current reserves (value at targetIndex is ignored)
 * @param amplification - Amplification parameter A
 * @param targetIndex - Index of the reserve to calculate
 * @param d - Target invariant D
 * @returns The required reserve amount for targetIndex
 */
export function calculateY(
  reserves: bigint[],
  amplification: bigint,
  targetIndex: number,
  d: bigint
): bigint {
  const n = BigInt(reserves.length);

  // Calculate Ann = A * n^n
  let n_pow = 1n;
  for (let i = 0; i < Number(n); i++) {
    n_pow *= n;
  }
  const ann = amplification * n_pow;

  // Calculate sum and product of all reserves except target
  let sum = 0n;
  let c = d;
  for (let i = 0; i < reserves.length; i++) {
    if (i !== targetIndex) {
      sum += reserves[i];
      c = c * d / (reserves[i] * n);
    }
  }

  // c = D^(n+1) / (n^n * prod(other reserves) * Ann)
  c = c * d / (ann * n);

  // b = sum + D / Ann
  const b = sum + d / ann;

  // Initial guess: y = D
  let y = d;
  let y_prev = 0n;

  // Newton's method iteration for y
  for (let iteration = 0; iteration < MAX_Y_ITERATIONS; iteration++) {
    y_prev = y;

    // y_next = (y^2 + c) / (2y + b - D)
    const numerator = y * y + c;
    const denominator = 2n * y + b - d;

    y = numerator / denominator;

    // Check convergence
    const diff = y > y_prev ? y - y_prev : y_prev - y;
    if (diff <= PRECISION) {
      return y;
    }
  }

  // If didn't converge, return best approximation
  return y;
}

/**
 * Calculate spot price of assetIn in terms of assetOut
 *
 * Simulates swapping a small amount of assetIn and calculates the marginal
 * price based on how much assetOut would be received.
 *
 * Uses 0.01% of the pool's assetIn reserve as the swap amount to minimize
 * slippage and approximate the true spot price.
 *
 * @param pool - Stableswap pool
 * @param assetInIndex - Index of input asset in pool.assets
 * @param assetOutIndex - Index of output asset in pool.assets
 * @param decimals - Decimal counts for all assets
 * @returns Spot price scaled to 10^12 precision (price per whole unit)
 */
export function calculateSpotPrice(
  pool: StableswapPool,
  assetInIndex: number,
  assetOutIndex: number,
  decimals: AssetDecimals
): bigint {
  const assetInId = pool.assets[assetInIndex];
  const assetOutId = pool.assets[assetOutIndex];

  const assetInDecimals = decimals.get(assetInId) || 12;
  const assetOutDecimals = decimals.get(assetOutId) || 12;

  // Calculate current invariant D
  const d = calculateD(pool.reserves, pool.amplification);
  if (d === 0n) {
    return 0n; // Pool has zero reserves
  }

  // Use a small swap amount: 0.01% of the assetIn reserve
  // This minimizes slippage and approximates the spot price
  const swapAmount = pool.reserves[assetInIndex] / 10000n;
  if (swapAmount === 0n) {
    // Pool too small, fall back to 1 unit minimum
    return 0n;
  }

  // Simulate adding swap amount to assetIn reserve
  const newReserves = [...pool.reserves];
  newReserves[assetInIndex] = pool.reserves[assetInIndex] + swapAmount;

  // Calculate new assetOut reserve after the swap
  const newAssetOutReserve = calculateY(newReserves, pool.amplification, assetOutIndex, d);

  // Amount of assetOut received
  const assetOutReceived = pool.reserves[assetOutIndex] - newAssetOutReserve;

  // Calculate spot price: how much assetOut per whole unit of assetIn
  // assetOutReceived and swapAmount are both in their respective native units
  // We need to normalize to: (assetOut in whole units) / (assetIn in whole units)

  // Convert to whole units:
  // assetOutReceived (native) / 10^assetOutDecimals = assetOut in whole units
  // swapAmount (native) / 10^assetInDecimals = assetIn in whole units

  // Price = (assetOutReceived / 10^outDec) / (swapAmount / 10^inDec)
  //       = assetOutReceived * 10^inDec / (swapAmount * 10^outDec)

  // Scale to 10^12 for storage:
  const scaleFactor = 10n ** 12n;
  const inDecFactor = 10n ** BigInt(assetInDecimals);
  const outDecFactor = 10n ** BigInt(assetOutDecimals);

  // price = (assetOutReceived * inDecFactor * scaleFactor) / (swapAmount * outDecFactor)
  const price = (assetOutReceived * inDecFactor * scaleFactor) / (swapAmount * outDecFactor);

  return price;
}

/**
 * Calculate prices for assets in stableswap pools using curve math
 *
 * For each pool with at least one known-priced asset:
 * - Calculate spot prices for unknown assets using Newton's method
 * - Convert spot prices to USDT prices using the known asset's price
 *
 * This replaces the simple 1:1 propagation with real curve math that
 * accounts for reserve imbalances and amplification parameters.
 */
export function calculateStableswapPrices(
  pools: StableswapPool[],
  knownPrices: PriceMap,
  decimals: AssetDecimals
): PriceMap {
  const newPrices = new Map<number, string>();

  for (const pool of pools) {
    // Check for zero reserves - skip pools with any zero reserve
    let hasZeroReserve = false;
    for (const reserve of pool.reserves) {
      if (reserve === 0n) {
        hasZeroReserve = true;
        break;
      }
    }
    if (hasZeroReserve) {
      continue;
    }

    // Find assets with known and unknown prices
    const knownAssets: Array<{ assetId: number; price: string; decimals: number; index: number }> = [];
    const unknownAssets: Array<{ assetId: number; decimals: number; index: number }> = [];

    for (let i = 0; i < pool.assets.length; i++) {
      const assetId = pool.assets[i];
      const price = knownPrices.get(assetId);
      const assetDecimals = decimals.get(assetId);

      if (assetDecimals === undefined) {
        continue; // Skip assets without decimal info
      }

      if (price !== undefined) {
        knownAssets.push({ assetId, price, decimals: assetDecimals, index: i });
      } else {
        unknownAssets.push({ assetId, decimals: assetDecimals, index: i });
      }
    }

    // If no known prices or no unknown prices, skip this pool
    if (knownAssets.length === 0 || unknownAssets.length === 0) {
      continue;
    }

    // Use the first known asset as reference
    const referenceAsset = knownAssets[0];

    // Calculate prices for each unknown asset
    for (const unknownAsset of unknownAssets) {
      // Calculate spot price: how much reference asset per 1 unit of unknown asset
      // This gives us the price of unknown in terms of reference
      const spotPrice = calculateSpotPrice(
        pool,
        unknownAsset.index,    // Swap IN the unknown asset
        referenceAsset.index,  // Receive OUT the reference asset
        decimals
      );

      if (spotPrice === 0n) {
        continue; // Skip if calculation failed
      }

      // Convert spot price to USDT price
      // spotPrice is scaled to 10^12 (how much reference you get per 1 unknown)
      // This IS the price ratio: unknownPrice / referencePrice = spotPrice / 10^12
      // unknownUSDTPrice = referenceUSDTPrice * spotPrice / 10^12

      // Parse reference price (already scaled to 10^12)
      const [intPart, decPart = ''] = referenceAsset.price.split('.');
      const priceDigits = intPart + decPart.padEnd(12, '0');
      const referencePriceBigint = BigInt(priceDigits);

      // Calculate: (referencePrice * spotPrice) / 10^12
      const unknownPriceBigint = (referencePriceBigint * spotPrice) / (10n ** 12n);

      // Convert back to decimal string
      const resultStr = unknownPriceBigint.toString().padStart(13, '0');
      const resultInt = resultStr.slice(0, -12) || '0';
      const resultDec = resultStr.slice(-12);

      newPrices.set(unknownAsset.assetId, `${resultInt}.${resultDec}`);
    }
  }

  return newPrices;
}
