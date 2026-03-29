import type { OmnipoolAssetState, XYKPool, StableswapPool, AssetDecimals, PriceMap, GraphEdge, EdgeKind, QueueEntry, ResolvedPrices } from './types.ts';
import { calculateLRNAPrice, calculateOmnipoolPrices } from './omnipool.ts';
import { calculateSpotPrice } from './stableswap.ts';

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

const MAX_HOPS = 3;
const BFS_PRECISION = 24;

// Multi-source BFS from Omnipool-seeded assets outward to resolve unpriced assets.
// Seeds: Map of assetId -> 24-decimal bigint price (from Omnipool LRNA pass).
// omnipoolPricedAssets: Guard set — BFS must not override these prices.
// graph: Bidirectional adjacency map from buildGraph().
// maxHops: Maximum real pool crossings (default 3). aToken edges are zero-cost.
export function bfsResolvePrices(
  seeds: Map<number, bigint>,
  omnipoolPricedAssets: Set<number>,
  graph: Map<number, GraphEdge[]>,
  maxHops: number = MAX_HOPS
): Map<number, { priceBigint: bigint; hopCount: number }> {
  const resolved = new Map<number, { priceBigint: bigint; hopCount: number }>();

  // Seed all Omnipool-priced assets at depth 0
  const queue: QueueEntry[] = [];
  for (const [assetId, price] of seeds) {
    resolved.set(assetId, { priceBigint: price, hopCount: 0 });
    queue.push({ assetId, priceBigint: price, hopCount: 0 });
  }

  let head = 0;
  while (head < queue.length) {
    const { assetId, priceBigint, hopCount } = queue[head++];

    const edges = graph.get(assetId) ?? [];
    // Edges are pre-sorted by liquidity desc + pool-type rank from buildGraph()

    for (const edge of edges) {
      // D-02: Never override Omnipool prices
      if (omnipoolPricedAssets.has(edge.toAsset)) continue;
      // First-arrival wins (edges sorted by liquidity, so best path wins)
      if (resolved.has(edge.toAsset)) continue;

      // D-04: aToken edges don't increment hop count
      const nextHopCount = edge.kind === 'atoken' ? hopCount : hopCount + 1;
      // D-05: Cap at maxHops real pool crossings
      if (nextHopCount > maxHops) continue;

      const nextPrice = edge.computePrice(priceBigint, BFS_PRECISION);
      if (nextPrice === 0n) continue;

      resolved.set(edge.toAsset, { priceBigint: nextPrice, hopCount: nextHopCount });
      queue.push({ assetId: edge.toAsset, priceBigint: nextPrice, hopCount: nextHopCount });
    }
  }

  return resolved;
}

// Price stableswap LP share tokens via NAV (TVL / totalSupply).
// LP tokens with any unpriced underlying are skipped (all-or-nothing, D-02).
// Newly priced LP tokens seed a second BFS pass to expand pricing further (D-03).
export function computeLpNavPrices(
  prices: PriceMap,
  stableswapPools: StableswapPool[],
  totalIssuances: Map<number, bigint>,
  decimals: AssetDecimals,
  graph: Map<number, GraphEdge[]>,
  omnipoolPricedAssets: Set<number>,
  hopCounts: Map<number, number> = new Map(),
): void {
  const newLpSeeds = new Map<number, bigint>();

  for (const pool of stableswapPools) {
    const lpAssetId = pool.poolId; // LP token assetId == poolId in Hydration runtime

    // Skip if LP token already priced (e.g., via Omnipool)
    if (prices.has(lpAssetId)) continue;

    // D-02: all-or-nothing — skip if any underlying is unpriced
    if (!pool.assets.every(id => prices.has(id))) continue;

    const totalSupply = totalIssuances.get(lpAssetId);
    if (!totalSupply || totalSupply === 0n) continue;

    // LP decimals default to 18 for stableswap LP tokens
    const lpDec = decimals.get(lpAssetId) ?? 18;
    const lpDecScale = 10n ** BigInt(lpDec);

    let lpPrice24: bigint;

    if (pool.pegMultipliers && pool.pegMultipliers.length > 0) {
      // Pegged pool (GDOT, GETH, GSOL etc.): use spot-price-based NAV.
      // Convert all reserves to the base asset using the pool's own spot price
      // (which is stable due to the stableswap curve + peg), rather than using
      // volatile Omnipool market prices.

      // Find base asset: lowest peg ratio (typically 1.0 = aDOT, aETH, aSOL)
      let baseIndex = 0;
      let minPegRatio = Number.MAX_VALUE;
      for (let i = 0; i < pool.assets.length; i++) {
        const [num, den] = pool.pegMultipliers![i] ?? [1n, 1n];
        const ratio = Number(num) / Number(den);
        if (ratio < minPegRatio) {
          minPegRatio = ratio;
          baseIndex = i;
        }
      }

      const basePrice24 = priceTo24(prices.get(pool.assets[baseIndex])!);
      const baseDec = decimals.get(pool.assets[baseIndex]) ?? 12;
      const baseDecScale = 10n ** BigInt(baseDec);

      // Convert each reserve to base-equivalent using the pool's spot price
      let totalBaseEquiv = 0n; // in base asset's native decimals
      for (let i = 0; i < pool.assets.length; i++) {
        if (i === baseIndex) {
          // Base asset: 1:1
          totalBaseEquiv += pool.reserves[i] * baseDecScale / (10n ** BigInt(decimals.get(pool.assets[i]) ?? 12));
        } else {
          // Use stableswap spot price: how much base do I get for 1 unit of asset[i]?
          // spotPrice(i → baseIndex) gives the exchange rate within the pool
          const spotPrice = calculateSpotPrice(pool, i, baseIndex, decimals);
          if (spotPrice === 0n) continue;
          const assetDec = decimals.get(pool.assets[i]) ?? 12;
          // reserve in base-equivalent = reserve * spotPrice / 10^12 * baseDecScale / assetDecScale
          totalBaseEquiv += (pool.reserves[i] * spotPrice * baseDecScale) / ((10n ** BigInt(assetDec)) * (10n ** 12n));
        }
      }

      // lpPrice = totalBaseEquiv * basePrice / totalSupply
      lpPrice24 = (totalBaseEquiv * basePrice24 * lpDecScale) / (totalSupply * baseDecScale);
    } else {
      // Unpegged pool: standard NAV = TVL / totalSupply
      let tvl24 = 0n;
      for (let i = 0; i < pool.assets.length; i++) {
        const assetId = pool.assets[i];
        const price24 = priceTo24(prices.get(assetId)!);
        const dec = decimals.get(assetId) ?? 12;
        const assetDec = 10n ** BigInt(dec);
        tvl24 += (pool.reserves[i] * price24) / assetDec;
      }
      lpPrice24 = (tvl24 * lpDecScale) / totalSupply;
    }

    if (lpPrice24 === 0n) continue;

    prices.set(lpAssetId, price24ToString(lpPrice24));
    hopCounts.set(lpAssetId, 0);
    newLpSeeds.set(lpAssetId, lpPrice24);
  }

  // D-03: second BFS pass seeded with newly priced LP tokens
  if (newLpSeeds.size > 0) {
    const bfsResults = bfsResolvePrices(newLpSeeds, omnipoolPricedAssets, graph);
    for (const [assetId, { priceBigint, hopCount }] of bfsResults) {
      if (!omnipoolPricedAssets.has(assetId) && !prices.has(assetId)) {
        prices.set(assetId, price24ToString(priceBigint));
        hopCounts.set(assetId, hopCount);
      }
    }
  }
}

export function collectUnpricedConnectedAssets(
  graph: Map<number, GraphEdge[]>,
  prices: PriceMap
): number[] {
  const unpriced: number[] = [];
  for (const assetId of graph.keys()) {
    if (!prices.has(assetId)) {
      unpriced.push(assetId);
    }
  }
  return unpriced.sort((a, b) => a - b);
}

// Normalize all prices so that USDT = $1.
function normalizeToUsdt(prices: PriceMap, usdtAssetId: number): void {
  const usdPrice = prices.get(usdtAssetId);
  if (!usdPrice) return;

  const usdFloat = parseFloat(usdPrice);
  if (usdFloat === 0 || usdFloat === 1) return;

  for (const [assetId, price] of prices.entries()) {
    const normalized = parseFloat(price) / usdFloat;
    prices.set(assetId, normalized.toFixed(12));
  }
  prices.set(usdtAssetId, '1.000000000000');
}

// Convert 12-decimal price string to 24-decimal bigint for BFS intermediate math
export function priceTo24(priceStr: string): bigint {
  const [intPart, decPart = ''] = priceStr.split('.');
  const digits = intPart + decPart.padEnd(12, '0');
  return BigInt(digits) * (10n ** 12n);
}

// Convert 24-decimal bigint to 12-decimal price string for PriceMap storage
export function price24ToString(p: bigint): string {
  const truncated = p / (10n ** 12n);
  const s = truncated.toString().padStart(13, '0');
  return `${s.slice(0, -12) || '0'}.${s.slice(-12)}`;
}

export function buildGraph(
  xykPools: XYKPool[],
  stableswapPools: StableswapPool[],
  atokenEquivalences: [number, number][],
  decimals: AssetDecimals,
  totalIssuances: Map<number, bigint> = new Map(),
): Map<number, GraphEdge[]> {
  const graph = new Map<number, GraphEdge[]>();

  const addEdge = (from: number, edge: GraphEdge) => {
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from)!.push(edge);
  };

  // XYK pool edges (bidirectional)
  for (const pool of xykPools) {
    if (pool.reserveA === 0n || pool.reserveB === 0n) continue;

    const decimalsA = decimals.get(pool.assetA);
    const decimalsB = decimals.get(pool.assetB);
    if (decimalsA === undefined || decimalsB === undefined) continue;

    // Normalize reserves to 18 decimals for liquidity comparison
    const normA = pool.reserveA * (10n ** BigInt(18 - decimalsA));
    const normB = pool.reserveB * (10n ** BigInt(18 - decimalsB));
    const liquidity = normA + normB;

    // Edge: assetA -> assetB (knowing A's price, compute B's)
    addEdge(pool.assetA, {
      toAsset: pool.assetB,
      poolId: null,
      kind: 'xyk',
      liquidity,
      computePrice: (knownPrice: bigint, _precision: number): bigint => {
        if (pool.reserveA === 0n || pool.reserveB === 0n) return 0n;
        const knownScale = 10n ** BigInt(decimalsA);
        const unknownScale = 10n ** BigInt(decimalsB);
        return (pool.reserveA * unknownScale * knownPrice) / (pool.reserveB * knownScale);
      },
    });

    // Edge: assetB -> assetA (knowing B's price, compute A's)
    addEdge(pool.assetB, {
      toAsset: pool.assetA,
      poolId: null,
      kind: 'xyk',
      liquidity,
      computePrice: (knownPrice: bigint, _precision: number): bigint => {
        if (pool.reserveA === 0n || pool.reserveB === 0n) return 0n;
        const knownScale = 10n ** BigInt(decimalsB);
        const unknownScale = 10n ** BigInt(decimalsA);
        return (pool.reserveB * unknownScale * knownPrice) / (pool.reserveA * knownScale);
      },
    });
  }

  // Stableswap pool edges: every (assetI, assetJ) pair gets bidirectional edges
  for (const pool of stableswapPools) {
    let hasZeroReserve = false;
    for (const reserve of pool.reserves) {
      if (reserve === 0n) { hasZeroReserve = true; break; }
    }
    if (hasZeroReserve) continue;

    // Normalize reserves to 18 decimals for liquidity metric
    let liquiditySum = 0n;
    for (let i = 0; i < pool.assets.length; i++) {
      const d = decimals.get(pool.assets[i]) || 12;
      liquiditySum += pool.reserves[i] * (10n ** BigInt(18 - d));
    }

    for (let i = 0; i < pool.assets.length; i++) {
      for (let j = 0; j < pool.assets.length; j++) {
        if (i === j) continue;
        const fromAsset = pool.assets[i];
        const toAsset = pool.assets[j];
        const fromIndex = i;
        const toIndex = j;

        // Edge: fromAsset -> toAsset
        // "Knowing fromAsset price, compute toAsset price"
        // spotPrice(toIndex, fromIndex) = "how much fromAsset per 1 toAsset"
        // toAssetPrice = fromAssetPrice * spotPrice(toIndex, fromIndex) / 10^12
        addEdge(fromAsset, {
          toAsset,
          poolId: pool.poolId,
          kind: 'stableswap',
          liquidity: liquiditySum,
          computePrice: (knownPrice: bigint, _precision: number): bigint => {
            const spotPrice = calculateSpotPrice(pool, toIndex, fromIndex, decimals);
            if (spotPrice === 0n) return 0n;
            // knownPrice is 24-decimal, spotPrice is 12-decimal
            // result = knownPrice * spotPrice / 10^12 = 24-decimal
            return (knownPrice * spotPrice) / (10n ** 12n);
          },
        });
      }
    }
  }

  // LP token → underlying asset edges (inverse NAV: derive underlying from LP price)
  for (const pool of stableswapPools) {
    const lpAssetId = pool.poolId;
    const totalSupply = totalIssuances.get(lpAssetId);
    if (!totalSupply || totalSupply === 0n) continue;

    let hasZeroReserve = false;
    for (const reserve of pool.reserves) {
      if (reserve === 0n) { hasZeroReserve = true; break; }
    }
    if (hasZeroReserve) continue;

    const lpDec = decimals.get(lpAssetId) ?? 18;
    const lpDecScale = 10n ** BigInt(lpDec);
    const numAssets = BigInt(pool.assets.length);

    // Normalize reserves to 18 decimals for liquidity metric
    let liquiditySum = 0n;
    for (let i = 0; i < pool.assets.length; i++) {
      const d = decimals.get(pool.assets[i]) || 12;
      liquiditySum += pool.reserves[i] * (10n ** BigInt(18 - d));
    }

    for (let i = 0; i < pool.assets.length; i++) {
      const underlyingAsset = pool.assets[i];
      const reserve = pool.reserves[i];
      const underlyingDec = BigInt(decimals.get(underlyingAsset) ?? 12);
      const underlyingDecScale = 10n ** underlyingDec;

      // Edge: LP token → underlying asset
      // Inverse NAV assuming equal value split (valid for stableswap):
      // underlyingPrice = lpPrice * totalSupply / (numAssets * reserve_i)
      // adjusted for decimal differences
      addEdge(lpAssetId, {
        toAsset: underlyingAsset,
        poolId: pool.poolId,
        kind: 'stableswap',
        liquidity: liquiditySum,
        computePrice: (knownPrice: bigint, _precision: number): bigint => {
          // knownPrice = LP price in 24-decimal (per 1 whole LP token)
          // result = knownPrice * totalSupply * underlyingDecScale / (numAssets * reserve * lpDecScale)
          return (knownPrice * totalSupply * underlyingDecScale) / (numAssets * reserve * lpDecScale);
        },
      });
    }
  }

  // aToken equivalence edges (zero-cost, bidirectional, 1:1 price copy)
  for (const [base, aToken] of atokenEquivalences) {
    const maxLiquidity = BigInt(Number.MAX_SAFE_INTEGER);

    addEdge(base, {
      toAsset: aToken,
      poolId: null,
      kind: 'atoken',
      liquidity: maxLiquidity,
      computePrice: (knownPrice: bigint, _precision: number): bigint => knownPrice,
    });

    addEdge(aToken, {
      toAsset: base,
      poolId: null,
      kind: 'atoken',
      liquidity: maxLiquidity,
      computePrice: (knownPrice: bigint, _precision: number): bigint => knownPrice,
    });
  }

  // Sort each adjacency list: primary = liquidity desc, secondary = pool-type rank
  const kindRank: Record<EdgeKind, number> = { atoken: 0, stableswap: 1, xyk: 2 };
  for (const edges of graph.values()) {
    edges.sort((a, b) => {
      if (b.liquidity !== a.liquidity) return b.liquidity > a.liquidity ? 1 : -1;
      return kindRank[a.kind] - kindRank[b.kind];
    });
  }

  return graph;
}

// Resolve all asset prices denominated in USD.
//
// Strategy:
// 1. If USDT is in the Omnipool, use it directly as $1 anchor (historical path)
// 2. Fallback: stableswap LP token containing USDT
// 3. Fallback: most liquid stablecoin from anchor list → compute all prices →
//    resolve USDT through stableswap/XYK + aToken equivalences → normalize to USDT
// 4. Compute all Omnipool prices via LRNA
// 5. Iteratively resolve XYK + Stableswap + aToken equivalences
// 6. Normalize so USDT = $1 (USD anchor)
export function resolvePrices(
  omnipoolAssets: Map<number, OmnipoolAssetState>,
  xykPools: XYKPool[],
  stableswapPools: StableswapPool[],
  decimals: AssetDecimals,
  usdtAssetId: number = 10,
  lrnaAssetId: number = 1,
  stablecoinAnchorIds: number[] = [10],
  atokenEquivalences: [number, number][] = [],
  totalIssuances: Map<number, bigint> = new Map(),
): ResolvedPrices {
  const prices = new Map<number, string>();
  const hopCounts = new Map<number, number>();

  let lrnaPrice: string | null = null;
  let needsNormalization = false;

  // Primary: USDT directly in Omnipool
  const usdState = omnipoolAssets.get(usdtAssetId);
  if (usdState) {
    try {
      const usdDecimals = decimals.get(usdtAssetId) || 6;
      lrnaPrice = calculateLRNAPrice(usdState, usdDecimals);
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

  // Set hop count 0 for all Omnipool-priced assets
  for (const assetId of prices.keys()) {
    hopCounts.set(assetId, 0);
  }

  // Track Omnipool-priced assets for routing preference
  const omnipoolPricedAssets = new Set(prices.keys());

  // Build adjacency graph from all non-Omnipool pools + aToken equivalences
  const graph = buildGraph(xykPools, stableswapPools, atokenEquivalences, decimals, totalIssuances);

  // Convert Omnipool seed prices from 12-decimal strings to 24-decimal bigints
  const seeds = new Map<number, bigint>();
  for (const [assetId, priceStr] of prices) {
    seeds.set(assetId, priceTo24(priceStr));
  }

  // Multi-source BFS from all priced assets outward
  const bfsResults = bfsResolvePrices(seeds, omnipoolPricedAssets, graph);

  // Write BFS-resolved prices to PriceMap (12-decimal strings)
  for (const [assetId, { priceBigint, hopCount }] of bfsResults) {
    if (!omnipoolPricedAssets.has(assetId) && !prices.has(assetId)) {
      prices.set(assetId, price24ToString(priceBigint));
      hopCounts.set(assetId, hopCount);
    }
  }

    // LP NAV pricing: price stableswap share tokens via TVL / totalSupply,
  // then seed a second BFS pass with newly priced LP tokens (D-01, D-03)
  computeLpNavPrices(prices, stableswapPools, totalIssuances, decimals, graph, omnipoolPricedAssets, hopCounts);

  // Normalize to USDT if we used a non-USDT anchor
  if (needsNormalization) {
    normalizeToUsdt(prices, usdtAssetId);
  }

  // Collect unpriced assets that have pool connections in the graph
  const unpricedConnected = collectUnpricedConnectedAssets(graph, prices);

  return { prices, hopCounts, unpricedConnected };
}
