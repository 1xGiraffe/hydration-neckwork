import type { OmnipoolAssetState, XYKPool, StableswapPool, AssetDecimals, PriceMap, GraphEdge, EdgeKind, QueueEntry, ResolvedPrices } from './types.ts';
import { calculateLRNAPrice, calculateOmnipoolPrices } from './omnipool.ts';
import { calculateSpotPrice } from './stableswap.ts';

const PRICE_SCALE = 10n ** 12n;

interface SpotQuote {
  price: bigint
  liquidity: bigint
}

interface WeightedObservation {
  value: bigint
  weight: bigint
}

function priceStringTo12(price: string): bigint {
  const [intPart, decPart = ''] = price.split('.');
  return BigInt(intPart + decPart.padEnd(12, '0'));
}

function price12ToString(value: bigint): string {
  const s = value.toString().padStart(13, '0');
  return `${s.slice(0, -12) || '0'}.${s.slice(-12)}`;
}

function multiplyPriceStrings(left: string, right: string): string {
  const product = (priceStringTo12(left) * priceStringTo12(right)) / PRICE_SCALE;
  return price12ToString(product);
}

function normalizeReserve(reserve: bigint, assetId: number, decimals: AssetDecimals): bigint {
  const assetDecimals = decimals.get(assetId) ?? 12;
  if (assetDecimals === 18) return reserve;
  if (assetDecimals < 18) {
    return reserve * (10n ** BigInt(18 - assetDecimals));
  }
  return reserve / (10n ** BigInt(assetDecimals - 18));
}

// Find the best Omnipool bridge asset from the candidate list.
function findBestOmnipoolBridge(
  omnipoolAssets: Map<number, OmnipoolAssetState>,
  bridgeIds: number[]
): { assetId: number; state: OmnipoolAssetState } | null {
  let best: { assetId: number; state: OmnipoolAssetState } | null = null;

  for (const id of bridgeIds) {
    const state = omnipoolAssets.get(id);
    if (!state || state.hubReserve === 0n) continue;
    if (!best || state.hubReserve > best.state.hubReserve) {
      best = { assetId: id, state };
    }
  }

  return best;
}

function getBestStableQuote(
  assetInId: number,
  assetOutId: number,
  stableswapPools: StableswapPool[],
  decimals: AssetDecimals
): SpotQuote | null {
  let bestPool: StableswapPool | null = null;
  let bestLiquidity = 0n;

  for (const pool of stableswapPools) {
    const assetInIdx = pool.assets.indexOf(assetInId);
    const assetOutIdx = pool.assets.indexOf(assetOutId);
    if (assetInIdx === -1 || assetOutIdx === -1) continue;
    if (pool.reserves[assetInIdx] === 0n || pool.reserves[assetOutIdx] === 0n) continue;

    const liq = normalizeReserve(pool.reserves[assetOutIdx], assetOutId, decimals);
    if (liq > bestLiquidity) {
      bestLiquidity = liq;
      bestPool = pool;
    }
  }

  if (!bestPool) return null;

  const assetInIdx = bestPool.assets.indexOf(assetInId);
  const assetOutIdx = bestPool.assets.indexOf(assetOutId);

  const spotPrice = calculateSpotPrice(bestPool, assetInIdx, assetOutIdx, decimals);
  if (spotPrice === 0n) return null;

  return {
    price: spotPrice,
    liquidity: bestLiquidity,
  };
}

function findStableLpOmnipoolBridgeIds(
  stableswapPools: StableswapPool[],
  omnipoolAssets: Map<number, OmnipoolAssetState>,
  referenceAssetIds: number[],
): number[] {
  const referenceIdSet = new Set(referenceAssetIds);
  const bridgeIds: number[] = [];

  for (const pool of stableswapPools) {
    if (!omnipoolAssets.has(pool.poolId)) continue;
    if (!pool.assets.some(assetId => referenceIdSet.has(assetId))) continue;
    bridgeIds.push(pool.poolId);
  }

  return bridgeIds;
}

function getUsdObservationsFromReferences(
  assetId: number,
  referenceUsdPrices: Map<number, string>,
  stableswapPools: StableswapPool[],
  decimals: AssetDecimals,
  atokenEquivalences: [number, number][] = [],
): SpotQuote[] {
  const directPrice = referenceUsdPrices.get(assetId);
  if (directPrice) {
    return [{
      price: priceStringTo12(directPrice),
      liquidity: 0n,
    }];
  }

  const assetAliases = new Map<number, Set<number>>();
  for (const [baseId, aTokenId] of atokenEquivalences) {
    if (!assetAliases.has(baseId)) assetAliases.set(baseId, new Set([baseId]));
    if (!assetAliases.has(aTokenId)) assetAliases.set(aTokenId, new Set([aTokenId]));
    assetAliases.get(baseId)!.add(aTokenId);
    assetAliases.get(aTokenId)!.add(baseId);
  }

  const observations: SpotQuote[] = [];
  for (const [referenceId, referenceUsdPrice] of referenceUsdPrices.entries()) {
    const referenceCandidates = [...(assetAliases.get(referenceId) ?? new Set([referenceId]))];
    for (const referenceCandidateId of referenceCandidates) {
      const quote = getBestStableQuote(assetId, referenceCandidateId, stableswapPools, decimals);
      if (!quote) continue;

      observations.push({
        price: (quote.price * priceStringTo12(referenceUsdPrice)) / PRICE_SCALE,
        liquidity: quote.liquidity,
      });
    }
  }

  return observations;
}

function buildUsdReferencePrices(
  referenceIds: number[],
  stableswapPools: StableswapPool[],
  decimals: AssetDecimals,
): Map<number, string> {
  const uniqueIds = [...new Set(referenceIds)];
  const prices = new Map<number, string>();

  for (const id of uniqueIds) {
    prices.set(id, '1.000000000000');
  }

  if (uniqueIds.length < 2) {
    return prices;
  }

  const [primaryId, secondaryId] = uniqueIds;
  const quote = getBestStableQuote(primaryId, secondaryId, stableswapPools, decimals);
  if (!quote) {
    return prices;
  }

  const denominator = PRICE_SCALE + quote.price;
  if (denominator === 0n) {
    return prices;
  }

  const primaryPrice = (2n * quote.price * PRICE_SCALE) / denominator;
  const secondaryPrice = (2n * PRICE_SCALE * PRICE_SCALE) / denominator;

  prices.set(primaryId, price12ToString(primaryPrice));
  prices.set(secondaryId, price12ToString(secondaryPrice));

  return prices;
}

function getUsdPriceFromReferences(
  assetId: number,
  referenceUsdPrices: Map<number, string>,
  stableswapPools: StableswapPool[],
  decimals: AssetDecimals,
  atokenEquivalences: [number, number][] = [],
): string | null {
  const observations = getUsdObservationsFromReferences(
    assetId,
    referenceUsdPrices,
    stableswapPools,
    decimals,
    atokenEquivalences,
  );
  if (observations.length === 0) {
    return null;
  }

  if (observations.length === 1) {
    return price12ToString(observations[0].price);
  }

  let weightedSum = 0n;
  let totalLiquidity = 0n;
  for (const observation of observations) {
    weightedSum += observation.price * observation.liquidity;
    totalLiquidity += observation.liquidity;
  }

  if (totalLiquidity === 0n) {
    return price12ToString(observations[0].price);
  }

  return price12ToString(weightedSum / totalLiquidity);
}

function getStableLpUsdQuote(
  assetId: number,
  referenceUsdPrices: Map<number, string>,
  stableswapPools: StableswapPool[],
  decimals: AssetDecimals,
  atokenEquivalences: [number, number][] = [],
): SpotQuote | null {
  const pool = stableswapPools.find(candidate => candidate.poolId === assetId);
  if (!pool) return null;

  const lpDecimals = decimals.get(assetId) ?? 18;
  const normalizedTotalSupply = normalizeReserve(pool.totalIssuance ?? 0n, assetId, new Map([[assetId, lpDecimals]]));
  if (normalizedTotalSupply === 0n) return null;

  let totalValue = 0n;
  for (let index = 0; index < pool.assets.length; index++) {
    const underlyingAssetId = pool.assets[index];
    const underlyingPrice = getUsdPriceFromReferences(
      underlyingAssetId,
      referenceUsdPrices,
      stableswapPools,
      decimals,
      atokenEquivalences,
    );
    if (!underlyingPrice) {
      return null;
    }

    totalValue += normalizeReserve(pool.reserves[index], underlyingAssetId, decimals) * priceStringTo12(underlyingPrice);
  }

  if (totalValue === 0n) return null;

  return {
    price: totalValue / normalizedTotalSupply,
    liquidity: totalValue / PRICE_SCALE,
  };
}

function weightedMedian(observations: WeightedObservation[]): bigint | null {
  if (observations.length === 0) {
    return null;
  }

  const sorted = [...observations].sort((left, right) => {
    if (left.value < right.value) return -1;
    if (left.value > right.value) return 1;
    return 0;
  });

  let totalWeight = 0n;
  for (const observation of sorted) {
    totalWeight += observation.weight > 0n ? observation.weight : 1n;
  }

  const threshold = (totalWeight + 1n) / 2n;
  let runningWeight = 0n;
  for (const observation of sorted) {
    runningWeight += observation.weight > 0n ? observation.weight : 1n;
    if (runningWeight >= threshold) {
      return observation.value;
    }
  }

  return sorted[sorted.length - 1].value;
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
  let maxPoolLiquidity = 0n;

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
    if (liquidity > maxPoolLiquidity) {
      maxPoolLiquidity = liquidity;
    }

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
    if (liquiditySum > maxPoolLiquidity) {
      maxPoolLiquidity = liquiditySum;
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
  // These are exact wrapper relations, so they must outrank any market route.
  const atokenLiquidity = maxPoolLiquidity + 1n;
  for (const [base, aToken] of atokenEquivalences) {
    addEdge(base, {
      toAsset: aToken,
      poolId: null,
      kind: 'atoken',
      liquidity: atokenLiquidity,
      computePrice: (knownPrice: bigint, _precision: number): bigint => knownPrice,
    });

    addEdge(aToken, {
      toAsset: base,
      poolId: null,
      kind: 'atoken',
      liquidity: atokenLiquidity,
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
// 1. Prefer a direct Omnipool USD reference (10/22 basket)
// 2. Fallback: externally priced Omnipool bridge assets, including stable LP bridges priced by NAV
// 3. Compute all Omnipool prices via LRNA
// 4. Iteratively resolve XYK + Stableswap + aToken equivalences
export function resolvePrices(
  omnipoolAssets: Map<number, OmnipoolAssetState>,
  xykPools: XYKPool[],
  stableswapPools: StableswapPool[],
  decimals: AssetDecimals,
  _legacyUsdReferenceAssetId: number = 10,
  lrnaAssetId: number = 1,
  omnipoolBridgeIds: number[] = [10],
  atokenEquivalences: [number, number][] = [],
  totalIssuances: Map<number, bigint> = new Map(),
  usdReferenceIds: number[] = [_legacyUsdReferenceAssetId],
): ResolvedPrices {
  const prices = new Map<number, string>();
  const hopCounts = new Map<number, number>();

  const canonicalizeExactWrapperPairs = (): void => {
    for (const [baseId, aTokenId] of atokenEquivalences) {
      const basePrice = prices.get(baseId);
      const aTokenPrice = prices.get(aTokenId);
      const canonicalPrice = basePrice ?? aTokenPrice;
      if (!canonicalPrice) continue;

      const baseHop = hopCounts.get(baseId);
      const aTokenHop = hopCounts.get(aTokenId);
      const canonicalHop =
        baseHop != null && aTokenHop != null ? Math.min(baseHop, aTokenHop)
          : baseHop ?? aTokenHop;

      prices.set(baseId, canonicalPrice);
      prices.set(aTokenId, canonicalPrice);
      if (canonicalHop != null) {
        hopCounts.set(baseId, canonicalHop);
        hopCounts.set(aTokenId, canonicalHop);
      }
    }
  };

  let lrnaPrice: string | null = null;
  const referenceUsdPrices = buildUsdReferencePrices(usdReferenceIds, stableswapPools, decimals);

  const seedReferencePrices = () => {
    for (const [assetId, price] of referenceUsdPrices.entries()) {
      prices.set(assetId, price);
    }
  };

  // Keep the stable USD basket available even when Omnipool has no safe USD anchor yet.
  seedReferencePrices();

  const directReferenceBridge = findBestOmnipoolBridge(omnipoolAssets, usdReferenceIds);
  if (directReferenceBridge) {
    try {
      const bridgeDecimals = decimals.get(directReferenceBridge.assetId) || 6;
      const bridgeUsdPrice = referenceUsdPrices.get(directReferenceBridge.assetId) ?? '1.000000000000';
      lrnaPrice = calculateLRNAPrice(directReferenceBridge.state, bridgeDecimals);
      lrnaPrice = multiplyPriceStrings(lrnaPrice, bridgeUsdPrice);
    } catch {
    }
  }

  if (!lrnaPrice) {
    const bridgeCandidates: WeightedObservation[] = [];
    const selectedBridgePrices = new Map<number, string>();
    const nonReferenceBridgeIds = omnipoolBridgeIds.filter(id => !usdReferenceIds.includes(id));
    const stableLpBridgeIds = findStableLpOmnipoolBridgeIds(stableswapPools, omnipoolAssets, usdReferenceIds);
    const candidateBridgeIds = [
      ...(nonReferenceBridgeIds.length > 0 ? nonReferenceBridgeIds : omnipoolBridgeIds),
      ...stableLpBridgeIds,
    ].filter((assetId, index, ids) => ids.indexOf(assetId) === index);

    for (const assetId of candidateBridgeIds) {
      const state = omnipoolAssets.get(assetId);
      if (!state || state.hubReserve === 0n || state.reserve === 0n) continue;

      try {
        const usdObservations = getUsdObservationsFromReferences(
          assetId,
          referenceUsdPrices,
          stableswapPools,
          decimals,
          atokenEquivalences,
        );
        const stableLpQuote = usdObservations.length === 0
          ? getStableLpUsdQuote(
            assetId,
            referenceUsdPrices,
            stableswapPools,
            decimals,
            atokenEquivalences,
          )
          : null;
        const candidateUsdObservations = stableLpQuote ? [stableLpQuote] : usdObservations;
        if (candidateUsdObservations.length === 0) continue;

        let weightedUsdSum = 0n;
        let totalExternalLiquidity = 0n;
        let totalExternalLiquidityUsd = 0n;
        for (const observation of candidateUsdObservations) {
          weightedUsdSum += observation.price * observation.liquidity;
          totalExternalLiquidity += observation.liquidity;
          totalExternalLiquidityUsd += (observation.liquidity * observation.price) / PRICE_SCALE;
        }

        const assetUsdPrice = totalExternalLiquidity > 0n
          ? weightedUsdSum / totalExternalLiquidity
          : candidateUsdObservations[0].price;
        const assetReserveUsd =
          (normalizeReserve(state.reserve, assetId, decimals) * assetUsdPrice) / PRICE_SCALE;
        const anchorWeight = totalExternalLiquidityUsd > 0n
          ? (assetReserveUsd < totalExternalLiquidityUsd ? assetReserveUsd : totalExternalLiquidityUsd)
          : assetReserveUsd;
        if (anchorWeight === 0n) continue;

        const bridgeDecimals = decimals.get(assetId)
          ?? (stableswapPools.some(pool => pool.poolId === assetId) ? 18 : 6);
        const bridgeLrnaPrice = priceStringTo12(calculateLRNAPrice(state, bridgeDecimals));
        bridgeCandidates.push({
          value: (bridgeLrnaPrice * assetUsdPrice) / PRICE_SCALE,
          weight: anchorWeight,
        });
        selectedBridgePrices.set(assetId, price12ToString(assetUsdPrice));
      } catch {
      }
    }

    const medianLrnaPrice = weightedMedian(bridgeCandidates);
    if (medianLrnaPrice !== null) {
      lrnaPrice = price12ToString(medianLrnaPrice);
      for (const [assetId, price] of selectedBridgePrices.entries()) {
        prices.set(assetId, price);
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

  // Exact wrapper pairs must stay identical even if only one side is directly
  // seeded (for example, because only one wrapper is present in Omnipool).
  canonicalizeExactWrapperPairs();

  // Set hop count 0 for all Omnipool-priced assets
  for (const assetId of prices.keys()) {
    hopCounts.set(assetId, 0);
  }

  canonicalizeExactWrapperPairs();

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

  canonicalizeExactWrapperPairs();

    // LP NAV pricing: price stableswap share tokens via TVL / totalSupply,
  // then seed a second BFS pass with newly priced LP tokens (D-01, D-03)
  computeLpNavPrices(prices, stableswapPools, totalIssuances, decimals, graph, omnipoolPricedAssets, hopCounts);

  // Collect unpriced assets that have pool connections in the graph
  const unpricedConnected = collectUnpricedConnectedAssets(graph, prices);

  return { prices, hopCounts, unpricedConnected };
}
