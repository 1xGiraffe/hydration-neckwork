import { describe, it, expect } from 'vitest';
import { resolvePrices, priceTo24, price24ToString, buildGraph, bfsResolvePrices, computeLpNavPrices, collectUnpricedConnectedAssets } from '../../src/price/graph.ts';
import type { OmnipoolAssetState, XYKPool, StableswapPool, AssetDecimals, PriceMap } from '../../src/price/types.ts';

describe('priceTo24', () => {
  it('converts "1.000000000000" to 10^24', () => {
    expect(priceTo24('1.000000000000')).toBe(1000000000000000000000000n);
  });

  it('converts "50.000000000000" to 50 * 10^24', () => {
    expect(priceTo24('50.000000000000')).toBe(50000000000000000000000000n);
  });

  it('converts "0.500000000000" to 0.5 * 10^24', () => {
    expect(priceTo24('0.500000000000')).toBe(500000000000000000000000n);
  });

  it('converts "0.020000000000" correctly', () => {
    expect(priceTo24('0.020000000000')).toBe(20000000000000000000000n);
  });
});

describe('price24ToString', () => {
  it('converts 10^24 to "1.000000000000"', () => {
    expect(price24ToString(1000000000000000000000000n)).toBe('1.000000000000');
  });

  it('converts 50 * 10^24 to "50.000000000000"', () => {
    expect(price24ToString(50000000000000000000000000n)).toBe('50.000000000000');
  });

  it('converts 0n to "0.000000000000"', () => {
    expect(price24ToString(0n)).toBe('0.000000000000');
  });

  it('roundtrips "1.000000000000"', () => {
    expect(price24ToString(priceTo24('1.000000000000'))).toBe('1.000000000000');
  });

  it('roundtrips "50.000000000000"', () => {
    expect(price24ToString(priceTo24('50.000000000000'))).toBe('50.000000000000');
  });

  it('roundtrips "0.020000000000"', () => {
    expect(price24ToString(priceTo24('0.020000000000'))).toBe('0.020000000000');
  });
});

describe('resolvePrices', () => {
  it('resolves full price graph with all pool types', () => {
    // USDT in Omnipool
    const omnipoolAssets = new Map<number, OmnipoolAssetState>([
      [10, { // USDT (6 decimals)
        hubReserve: 1000000000000n,   // 1 LRNA
        reserve: 1000000n,             // 1 USDT
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
      [0, { // HDX (12 decimals)
        hubReserve: 50000000000000n,     // 50 LRNA
        reserve: 100000000000000000n,    // 100,000 HDX
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
      [5, { // DOT (10 decimals)
        hubReserve: 5000000000000000n,   // 5000 LRNA
        reserve: 1000000000000n,         // 100 DOT
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
    ]);

    // XYK pool: DOT/GLMR
    const xykPools: XYKPool[] = [
      {
        assetA: 5,  // DOT (10 decimals)
        assetB: 2,  // GLMR (12 decimals)
        reserveA: 100000000000n,         // 10 DOT
        reserveB: 50000000000000000n,    // 50,000 GLMR
      },
    ];

    // Stableswap: USDT/USDC (both 6 decimals)
    const stableswapPools: StableswapPool[] = [
      {
        poolId: 1,
        assets: [10, 22],
        reserves: [1000000n, 1000000n],  // 1 USDT, 1 USDC (both 6 decimals)
        amplification: 100n,
        fee: 400,
      },
    ];

    const decimals = new Map<number, number>([
      [0, 12],   // HDX
      [2, 12],   // GLMR
      [5, 10],   // DOT
      [10, 6],   // USDT
      [22, 6],   // USDC
    ]);

    const { prices } = resolvePrices(omnipoolAssets, xykPools, stableswapPools, decimals);

    // Should have prices for: USDT, LRNA, HDX, DOT, GLMR, USDC
    expect(prices.size).toBeGreaterThanOrEqual(5);
    expect(prices.has(10)).toBe(true);  // USDT
    expect(prices.has(1)).toBe(true);   // LRNA
    expect(prices.has(0)).toBe(true);   // HDX
    expect(prices.has(5)).toBe(true);   // DOT
    expect(prices.has(2)).toBe(true);   // GLMR
    expect(prices.has(22)).toBe(true);  // USDC

    // USDT should be exactly 1.0
    expect(prices.get(10)).toBe('1.000000000000');

    // All prices should be valid numbers
    for (const [assetId, price] of prices.entries()) {
      expect(parseFloat(price)).toBeGreaterThan(0);
      expect(parseFloat(price)).toBeLessThan(1000000);
    }
  });

  it('handles iterative resolution across multiple XYK hops', () => {
    const omnipoolAssets = new Map<number, OmnipoolAssetState>([
      [10, { // USDT (6 decimals)
        hubReserve: 1000000000000n,      // 1 LRNA
        reserve: 1000000n,                // 1 USDT
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
      [5, { // DOT (10 decimals)
        hubReserve: 5000000000000000n,   // 5000 LRNA
        reserve: 1000000000000n,         // 100 DOT
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
    ]);

    // Chain: DOT -> GLMR -> KSM (requires 2 iterations)
    const xykPools: XYKPool[] = [
      {
        assetA: 5,  // DOT (10 decimals, priced via Omnipool)
        assetB: 2,  // GLMR (12 decimals, unknown)
        reserveA: 100000000000n,         // 10 DOT
        reserveB: 50000000000000000n,    // 50,000 GLMR
      },
      {
        assetA: 2,  // GLMR (12 decimals, priced in iteration 1)
        assetB: 4,  // KSM (12 decimals, unknown)
        reserveA: 50000000000000000n,    // 50,000 GLMR
        reserveB: 200000000000n,         // 0.2 KSM
      },
    ];

    const decimals = new Map<number, number>([
      [2, 12],
      [4, 12],
      [5, 10],
      [10, 6],
    ]);

    const { prices } = resolvePrices(omnipoolAssets, xykPools, [], decimals);

    // Should resolve DOT, GLMR, and KSM
    expect(prices.has(5)).toBe(true);   // DOT
    expect(prices.has(2)).toBe(true);   // GLMR
    expect(prices.has(4)).toBe(true);   // KSM

    // All should have valid prices
    expect(parseFloat(prices.get(5)!)).toBeGreaterThan(0);
    expect(parseFloat(prices.get(2)!)).toBeGreaterThan(0);
    expect(parseFloat(prices.get(4)!)).toBeGreaterThan(0);
  });

  it('returns empty prices when USDT not in Omnipool and no fallback', () => {
    const omnipoolAssets = new Map<number, OmnipoolAssetState>();
    const xykPools: XYKPool[] = [];
    const stableswapPools: StableswapPool[] = [];
    const decimals = new Map<number, number>([[10, 6]]);

    const { prices } = resolvePrices(omnipoolAssets, xykPools, stableswapPools, decimals);

    expect(prices.size).toBe(0);
  });

  it('handles empty inputs gracefully', () => {
    const omnipoolAssets = new Map<number, OmnipoolAssetState>();
    const xykPools: XYKPool[] = [];
    const stableswapPools: StableswapPool[] = [];
    const decimals = new Map<number, number>([[10, 6]]);

    const { prices } = resolvePrices(omnipoolAssets, xykPools, stableswapPools, decimals);

    expect(prices.size).toBe(0);
  });

  it('uses custom USDT and LRNA asset IDs', () => {
    const omnipoolAssets = new Map<number, OmnipoolAssetState>([
      [100, { // Custom USDT ID (6 decimals)
        hubReserve: 1000000000000n,      // 1 LRNA
        reserve: 1000000n,                // 1 USDT
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
    ]);

    const decimals = new Map<number, number>([[100, 6]]);

    const { prices } = resolvePrices(
      omnipoolAssets,
      [],
      [],
      decimals,
      100,  // Custom USDT ID
      999,  // Custom LRNA ID
      [100] // Custom anchor
    );

    expect(prices.has(100)).toBe(true);  // Custom USDT
    expect(prices.has(999)).toBe(true);  // Custom LRNA
    expect(prices.get(100)).toBe('1.000000000000');
  });

  it('caps resolution at 3 hops depth (BFS hop limit)', () => {
    // Create a 15-link chain starting from HDX (depth 0)
    // BFS should price assets at depth 1, 2, 3 but NOT depth 4+
    const omnipoolAssets = new Map<number, OmnipoolAssetState>([
      [10, { // USDT (6 decimals)
        hubReserve: 1000000000000n,      // 1 LRNA
        reserve: 1000000n,                // 1 USDT
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
      [0, { // HDX (12 decimals)
        hubReserve: 50000000000000n,     // 50 LRNA
        reserve: 100000000000000000n,    // 100,000 HDX
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
    ]);

    // Create long chain: HDX(0) -> 100 -> 101 -> 102 -> 103 -> ... -> 114
    const xykPools: XYKPool[] = [];
    for (let i = 0; i < 15; i++) {
      xykPools.push({
        assetA: i === 0 ? 0 : 100 + i - 1,
        assetB: 100 + i,
        reserveA: 1000000000000n,
        reserveB: 1000000000000n,
      });
    }

    const decimals = new Map<number, number>([
      [0, 12],
      [10, 6],
      ...Array.from({ length: 15 }, (_, i) => [100 + i, 12] as [number, number]),
    ]);

    const { prices } = resolvePrices(omnipoolAssets, xykPools, [], decimals);

    // BFS caps at 3 hops: USDT(10) + LRNA(1) + HDX(0) + assets 100, 101, 102 = 6 total
    expect(prices.size).toBe(6);

    // Depth 1, 2, 3 should be priced
    expect(prices.has(100)).toBe(true);  // depth 1
    expect(prices.has(101)).toBe(true);  // depth 2
    expect(prices.has(102)).toBe(true);  // depth 3

    // Depth 4+ should NOT be priced (capped)
    expect(prices.has(103)).toBe(false); // depth 4 — capped
    expect(prices.has(114)).toBe(false); // depth 15 — far beyond cap
  });

  it('prefers Omnipool prices over XYK when asset appears in both', () => {
    // DOT appears in both Omnipool and XYK with different price ratios
    // Omnipool should win (most liquid route)
    const omnipoolAssets = new Map<number, OmnipoolAssetState>([
      [10, { // USDT (6 decimals)
        hubReserve: 1000000000000n,   // 1 LRNA
        reserve: 1000000n,             // 1 USDT
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
      [5, { // DOT (10 decimals) - priced at $50 via Omnipool
        hubReserve: 5000000000000000n,   // 5000 LRNA
        reserve: 1000000000000n,         // 100 DOT
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
    ]);

    // XYK pool: DOT/GLMR with different DOT price (would be different if calculated via GLMR)
    const xykPools: XYKPool[] = [
      {
        assetA: 5,  // DOT (10 decimals)
        assetB: 2,  // GLMR (12 decimals, unknown)
        reserveA: 200000000000n,         // 20 DOT
        reserveB: 50000000000000000n,    // 50,000 GLMR
      },
    ];

    const decimals = new Map<number, number>([
      [2, 12],
      [5, 10],
      [10, 6],
    ]);

    const { prices } = resolvePrices(omnipoolAssets, xykPools, [], decimals);

    // DOT should be priced via Omnipool
    expect(prices.has(5)).toBe(true);

    // Calculate expected Omnipool price for DOT with decimal normalization:
    // LRNA price from USDT: (1 USDT / 1 LRNA) = 1.0
    // DOT price: (5000 LRNA / 100 DOT) * 1.0 = 50.0
    const dotPrice = parseFloat(prices.get(5)!);
    expect(dotPrice).toBeCloseTo(50.0, 1); // Should be ~50.0

    // GLMR should be priced via XYK using DOT's Omnipool price
    // (20 DOT / 50,000 GLMR) * $50 = $0.02
    expect(prices.has(2)).toBe(true);
    const glmrPrice = parseFloat(prices.get(2)!);
    expect(glmrPrice).toBeGreaterThan(0);
  });
});

describe('buildGraph', () => {
  it('XYK pool produces bidirectional edges with correct toAsset values', () => {
    const xykPools: XYKPool[] = [
      { assetA: 5, assetB: 2, reserveA: 100000000000n, reserveB: 50000000000000000n },
    ];
    const decimals: AssetDecimals = new Map([[5, 10], [2, 12]]);

    const graph = buildGraph(xykPools, [], [], decimals);

    expect(graph.size).toBe(2);
    expect(graph.has(5)).toBe(true);
    expect(graph.has(2)).toBe(true);
    expect(graph.get(5)!.length).toBe(1);
    expect(graph.get(5)![0].toAsset).toBe(2);
    expect(graph.get(2)![0].toAsset).toBe(5);
    expect(graph.get(5)![0].kind).toBe('xyk');
  });

  it('XYK pool with zero reserve is skipped (graph empty)', () => {
    const xykPools: XYKPool[] = [
      { assetA: 5, assetB: 2, reserveA: 0n, reserveB: 50000000000000000n },
    ];
    const decimals: AssetDecimals = new Map([[5, 10], [2, 12]]);

    const graph = buildGraph(xykPools, [], [], decimals);

    expect(graph.size).toBe(0);
  });

  it('Stableswap 3-asset pool produces 6 edges (3 assets x 2 directions each)', () => {
    const stableswapPools: StableswapPool[] = [
      {
        poolId: 1,
        assets: [10, 22, 33],
        reserves: [1000000n, 1000000n, 1000000n],
        amplification: 100n,
        fee: 400,
      },
    ];
    const decimals: AssetDecimals = new Map([[10, 6], [22, 6], [33, 6]]);

    const graph = buildGraph([], stableswapPools, [], decimals);

    expect(graph.size).toBe(3);
    expect(graph.get(10)!.length).toBe(2);
    expect(graph.get(22)!.length).toBe(2);
    expect(graph.get(33)!.length).toBe(2);
    // Total edges = 6
    const totalEdges = [...graph.values()].reduce((sum, edges) => sum + edges.length, 0);
    expect(totalEdges).toBe(6);
  });

  it('aToken equivalence produces bidirectional edges with kind "atoken"', () => {
    const atokenEquivalences: [number, number][] = [[5, 105]];
    const decimals: AssetDecimals = new Map([[5, 10], [105, 10]]);

    const graph = buildGraph([], [], atokenEquivalences, decimals);

    expect(graph.size).toBe(2);
    expect(graph.has(5)).toBe(true);
    expect(graph.has(105)).toBe(true);
    expect(graph.get(5)![0].kind).toBe('atoken');
    expect(graph.get(105)![0].kind).toBe('atoken');
    expect(graph.get(5)![0].toAsset).toBe(105);
    expect(graph.get(105)![0].toAsset).toBe(5);
  });

  it('aToken edges have max safe bigint liquidity', () => {
    const atokenEquivalences: [number, number][] = [[5, 105]];
    const decimals: AssetDecimals = new Map([[5, 10], [105, 10]]);

    const graph = buildGraph([], [], atokenEquivalences, decimals);

    expect(graph.get(5)![0].liquidity).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('edge sorting: higher-liquidity edge appears first in adjacency list', () => {
    // Two XYK pools for asset 5: one with large reserves, one small
    const xykPools: XYKPool[] = [
      { assetA: 5, assetB: 2, reserveA: 1000000000000n, reserveB: 1000000000000n },     // small
      { assetA: 5, assetB: 3, reserveA: 100000000000000000n, reserveB: 100000000000000000n }, // large
    ];
    const decimals: AssetDecimals = new Map([[5, 12], [2, 12], [3, 12]]);

    const graph = buildGraph(xykPools, [], [], decimals);

    const edges5 = graph.get(5)!;
    expect(edges5.length).toBe(2);
    // Higher liquidity edge (to asset 3) should come first
    expect(edges5[0].toAsset).toBe(3);
    expect(edges5[1].toAsset).toBe(2);
  });

  it('XYK computePrice produces correct 24-decimal result: DOT at $50, pool 10 DOT / 50000 GLMR => GLMR ~$0.01', () => {
    // DOT: 10 decimals, GLMR: 12 decimals
    // Pool: 10 DOT / 50000 GLMR => ratio = 10/50000 = 0.0002 DOT per GLMR
    // If DOT = $50, GLMR = $50 * 0.0002 = $0.01
    const xykPools: XYKPool[] = [
      {
        assetA: 5,   // DOT (10 decimals)
        assetB: 2,   // GLMR (12 decimals)
        reserveA: 100000000000n,         // 10 DOT (10 decimals = 10 * 10^10)
        reserveB: 50000000000000000n,    // 50,000 GLMR (12 decimals = 50000 * 10^12)
      },
    ];
    const decimals: AssetDecimals = new Map([[5, 10], [2, 12]]);

    const graph = buildGraph(xykPools, [], [], decimals);

    // Edge from DOT to GLMR: knowing DOT price, compute GLMR price
    const dotToGlmrEdge = graph.get(5)!.find(e => e.toAsset === 2)!;
    expect(dotToGlmrEdge).toBeDefined();

    const dotPrice24 = priceTo24('50.000000000000'); // $50 in 24-decimal
    const glmrPrice24 = dotToGlmrEdge.computePrice(dotPrice24, 24);

    // Expected: ~$0.01 => 0.01 * 10^24 = 10000000000000000000000n
    // Allow ~1% tolerance due to integer division
    const expected = priceTo24('0.010000000000');
    const tolerance = expected / 100n; // 1%
    const diff = glmrPrice24 > expected ? glmrPrice24 - expected : expected - glmrPrice24;
    expect(diff).toBeLessThanOrEqual(tolerance);
  });

  it('priceTo24 and price24ToString roundtrip for various inputs', () => {
    const inputs = ['1.000000000000', '50.000000000000', '0.020000000000'];
    for (const input of inputs) {
      expect(price24ToString(priceTo24(input))).toBe(input);
    }
  });
});

describe('bfsResolvePrices', () => {
  it('seeds Omnipool-priced assets at depth 0 and expands outward', () => {
    // XYK pool: assetA(0) / assetB(1)
    const xykPools: XYKPool[] = [
      { assetA: 0, assetB: 1, reserveA: 1000000000000n, reserveB: 1000000000000n },
    ];
    const decimals: AssetDecimals = new Map([[0, 12], [1, 12]]);
    const graph = buildGraph(xykPools, [], [], decimals);

    // Seed asset 0 at $1.0
    const seeds = new Map([[0, priceTo24('1.000000000000')]]);
    const omnipoolPricedAssets = new Set([0]);

    const result = bfsResolvePrices(seeds, omnipoolPricedAssets, graph);

    // Asset 0 is in result at depth 0, asset 1 is resolved at depth 1
    expect(result.has(0)).toBe(true);
    expect(result.has(1)).toBe(true);
    expect(result.get(0)!.hopCount).toBe(0);
    expect(result.get(1)!.hopCount).toBe(1);
  });

  it('aToken equivalences do not increment hop count (D-04)', () => {
    // Setup: Omnipool prices HDX(0). XYK: HDX(0) -> AssetA(50).
    // aToken: [50, 150] (AssetA and its aToken).
    // XYK: AssetA-aToken(150) -> AssetB(60).
    // Path: HDX(0) ->XYK-> AssetA(50) ->aToken-> aToken(150) ->XYK-> AssetB(60)
    // Real hops: HDX->AssetA = 1, aToken->AssetB = 2. aToken crossing = 0.
    // So AssetB should be at depth 2, not depth 3.
    const omnipoolAssets = new Map<number, OmnipoolAssetState>([
      [10, { hubReserve: 1000000000000n, reserve: 1000000n, shares: 0n, protocolShares: 0n, cap: 0n, tradable: 0 }],
      [0,  { hubReserve: 50000000000000n, reserve: 100000000000000000n, shares: 0n, protocolShares: 0n, cap: 0n, tradable: 0 }],
    ]);

    const xykPools: XYKPool[] = [
      { assetA: 0,   assetB: 50,  reserveA: 1000000000000n, reserveB: 1000000000000n },
      { assetA: 150, assetB: 60,  reserveA: 1000000000000n, reserveB: 1000000000000n },
    ];

    const atokenEquivalences: [number, number][] = [[50, 150]];

    const decimals = new Map<number, number>([
      [0, 12], [10, 6], [50, 12], [60, 12], [150, 12],
    ]);

    const { prices } = resolvePrices(omnipoolAssets, xykPools, [], decimals, 10, 1, [10], atokenEquivalences);

    // All 4 custom assets should be priced
    expect(prices.has(50)).toBe(true);   // AssetA (depth 1)
    expect(prices.has(150)).toBe(true);  // aToken (depth 1, zero-cost)
    expect(prices.has(60)).toBe(true);   // AssetB (depth 2, not depth 3)

    // To confirm depth 2: let's use bfsResolvePrices directly to check hop count
    const graph = buildGraph(xykPools, [], atokenEquivalences, decimals);
    const seeds = new Map<number, bigint>();
    // Seed with HDX price from Omnipool
    const hdxPrice = prices.get(0)!;
    seeds.set(0, priceTo24(hdxPrice));
    const omnipoolPricedSet = new Set([0, 1, 10]); // LRNA + USDT + HDX

    const bfsResult = bfsResolvePrices(seeds, omnipoolPricedSet, graph);
    // AssetA at depth 1
    expect(bfsResult.get(50)?.hopCount).toBe(1);
    // aToken at depth 1 (zero-cost crossing from AssetA)
    expect(bfsResult.get(150)?.hopCount).toBe(1);
    // AssetB at depth 2 (1 real hop AssetA->... wait, 150->60 is 1 XYK hop from aToken at depth 1)
    expect(bfsResult.get(60)?.hopCount).toBe(2);
  });

  it('liquidity tiebreaker picks higher-liquidity path (D-06)', () => {
    // Two XYK pools both connecting HDX(0) to AssetX(99):
    // Pool 1 (low liq): 1000 HDX / 500 AssetX => price ratio 2:1
    // Pool 2 (high liq): 10000 HDX / 2000 AssetX => price ratio 5:1
    // BFS picks Pool 2 (higher liquidity) so AssetX = HDX_price * 5
    const omnipoolAssets = new Map<number, OmnipoolAssetState>([
      [10, { hubReserve: 1000000000000n, reserve: 1000000n, shares: 0n, protocolShares: 0n, cap: 0n, tradable: 0 }],
      [0,  { // HDX: LRNA=50, reserve=100,000 HDX => price ≈ $0.0005 per HDX
             hubReserve: 50000000000000n, reserve: 100000000000000000n, shares: 0n, protocolShares: 0n, cap: 0n, tradable: 0 }],
    ]);

    const xykPools: XYKPool[] = [
      // Pool 1 (low liq): 1000 HDX / 500 AssetX — price ratio: 1 AssetX = 2 HDX
      { assetA: 0, assetB: 99, reserveA: 1000000000000n, reserveB: 500000000000n },
      // Pool 2 (high liq): 10000 HDX / 2000 AssetX — price ratio: 1 AssetX = 5 HDX
      { assetA: 0, assetB: 99, reserveA: 10000000000000n, reserveB: 2000000000000n },
    ];

    const decimals = new Map<number, number>([[0, 12], [10, 6], [99, 12]]);

    const { prices } = resolvePrices(omnipoolAssets, xykPools, [], decimals);

    expect(prices.has(99)).toBe(true);

    // Expected: AssetX price from Pool 2 (higher liquidity, 5:1 ratio)
    const hdxPrice = parseFloat(prices.get(0)!);
    const assetXPrice = parseFloat(prices.get(99)!);
    const pool1DerivedPrice = hdxPrice * 2; // Pool 1: AssetX = 2 HDX
    const pool2DerivedPrice = hdxPrice * 5; // Pool 2: AssetX = 5 HDX

    // Should match Pool 2 (higher liquidity), not Pool 1
    expect(assetXPrice).toBeCloseTo(pool2DerivedPrice, 5);
    expect(Math.abs(assetXPrice - pool1DerivedPrice)).toBeGreaterThan(Math.abs(assetXPrice - pool2DerivedPrice));
  });

  it('24-decimal precision preserves accuracy in multi-hop chains (HOP-04)', () => {
    // Chain: USDT -> A -> B via two XYK pools
    // Use very small price ratios to test that 24-decimal intermediates avoid precision loss
    const omnipoolAssets = new Map<number, OmnipoolAssetState>([
      [10, { // USDT (6 decimals) at $1
        hubReserve: 1000000000000n, reserve: 1000000n, shares: 0n, protocolShares: 0n, cap: 0n, tradable: 0,
      }],
    ]);

    // Pool 1: USDT(10, 6dec) <-> AssetA(50, 18dec)
    // 1 USDT = 1,000,000 AssetA => AssetA price = $0.000001
    const xykPools: XYKPool[] = [
      {
        assetA: 10,  // USDT (6 decimals)
        assetB: 50,  // AssetA (18 decimals)
        reserveA: 1000000n,                        // 1 USDT (6dec)
        reserveB: 1000000000000000000000000n,       // 1,000,000 AssetA (18dec)
      },
      {
        assetA: 50,  // AssetA (18 decimals)
        assetB: 60,  // AssetB (18 decimals)
        reserveA: 1000000000000000000000000n,       // 1,000,000 AssetA
        reserveB: 500000000000000000000000n,        // 500,000 AssetB
      },
    ];

    const decimals = new Map<number, number>([
      [10, 6],
      [50, 18],
      [60, 18],
    ]);

    const { prices } = resolvePrices(omnipoolAssets, xykPools, [], decimals);

    // AssetA should be priced (depth 1 from USDT)
    expect(prices.has(50)).toBe(true);
    const assetAPrice = parseFloat(prices.get(50)!);
    expect(assetAPrice).toBeGreaterThan(0);

    // AssetB should be priced (depth 2 from USDT via AssetA)
    expect(prices.has(60)).toBe(true);
    const assetBPrice = parseFloat(prices.get(60)!);
    expect(assetBPrice).toBeGreaterThan(0);

    // AssetB = AssetA * (reserveA / reserveB) = AssetA * 2
    // So AssetB price should be approximately 2x AssetA price
    expect(assetBPrice).toBeCloseTo(assetAPrice * 2, 5);
  });

  it('Omnipool prices are not overridden by BFS (D-02)', () => {
    // DOT (5) is priced in Omnipool at $50.
    // There's also an XYK pool that would imply a different DOT price.
    // BFS must NOT override the Omnipool price for DOT.
    const omnipoolAssets = new Map<number, OmnipoolAssetState>([
      [10, { hubReserve: 1000000000000n, reserve: 1000000n, shares: 0n, protocolShares: 0n, cap: 0n, tradable: 0 }],
      [5,  { // DOT: priced at $50 via Omnipool (5000 LRNA / 100 DOT)
             hubReserve: 5000000000000000n, reserve: 1000000000000n, shares: 0n, protocolShares: 0n, cap: 0n, tradable: 0 }],
    ]);

    // XYK pool: DOT/GLMR — if BFS tried to compute DOT from GLMR, it would get a different value
    // DOT reserves: 50 DOT, GLMR reserves: 500 GLMR => 1 DOT = 10 GLMR
    const xykPools: XYKPool[] = [
      { assetA: 5, assetB: 2, reserveA: 500000000000n, reserveB: 5000000000000000n },
      // Second pool: GLMR/AssetZ to create chain back
      { assetA: 2, assetB: 99, reserveA: 5000000000000000n, reserveB: 1000000000000n },
    ];

    const decimals = new Map<number, number>([
      [5, 10], [10, 6], [2, 12], [99, 12],
    ]);

    const { prices } = resolvePrices(omnipoolAssets, xykPools, [], decimals);

    // DOT should be priced
    expect(prices.has(5)).toBe(true);

    // DOT price must be the Omnipool price (~$50), NOT any BFS-derived price
    const dotPrice = parseFloat(prices.get(5)!);
    expect(dotPrice).toBeCloseTo(50.0, 1);

    // GLMR and AssetZ should be priced via BFS (from DOT's Omnipool price)
    expect(prices.has(2)).toBe(true);
    expect(prices.has(99)).toBe(true);
  });
});

describe('computeLpNavPrices', () => {
  it('computes NAV price for stableswap LP token (basic case)', () => {
    // TVL = (1000 units * $1) + (1000 units * $1) = $2000
    // NAV = $2000 / 2000 LP tokens = $1.00
    const prices = new Map<number, string>([
      [10, '1.000000000000'], [22, '1.000000000000'],
    ]);
    const pools: StableswapPool[] = [{
      poolId: 100, assets: [10, 22],
      reserves: [1000_000000n, 1000_000000n], // 1000 units each, 6 decimals
      amplification: 100n, fee: 400,
    }];
    const totalIssuances = new Map([[100, 2000_000000000000000000n]]); // 2000 LP at 18 dec
    const decimals = new Map([[10, 6], [22, 6], [100, 18]]);
    const graph = new Map<number, any[]>();
    const omnipoolPriced = new Set<number>();
    computeLpNavPrices(prices, pools, totalIssuances, decimals, graph, omnipoolPriced);
    expect(prices.has(100)).toBe(true);
    const lpPrice = parseFloat(prices.get(100)!);
    expect(lpPrice).toBeCloseTo(1.0, 2);
  });

  it('skips LP token when any underlying is unpriced (all-or-nothing guard)', () => {
    // Asset 22 is NOT in prices — pool must be skipped entirely
    const prices = new Map<number, string>([[10, '1.000000000000']]); // asset 22 NOT priced
    const pools: StableswapPool[] = [{
      poolId: 100, assets: [10, 22],
      reserves: [1000_000000n, 1000_000000n],
      amplification: 100n, fee: 400,
    }];
    const totalIssuances = new Map([[100, 2000_000000000000000000n]]);
    const decimals = new Map([[10, 6], [22, 6], [100, 18]]);
    computeLpNavPrices(prices, pools, totalIssuances, decimals, new Map(), new Set());
    expect(prices.has(100)).toBe(false);
  });

  it('skips LP token with zero totalSupply (avoids division by zero)', () => {
    const prices = new Map<number, string>([[10, '1.000000000000'], [22, '1.000000000000']]);
    const pools: StableswapPool[] = [{
      poolId: 100, assets: [10, 22],
      reserves: [1000_000000n, 1000_000000n],
      amplification: 100n, fee: 400,
    }];
    const totalIssuances = new Map([[100, 0n]]); // zero supply
    const decimals = new Map([[10, 6], [22, 6], [100, 18]]);
    computeLpNavPrices(prices, pools, totalIssuances, decimals, new Map(), new Set());
    expect(prices.has(100)).toBe(false);
  });

  it('newly priced LP tokens seed second BFS pass to price downstream assets', () => {
    // LP token 100 is priced via NAV. An XYK pool connects LP token 100 to asset 200.
    // After computeLpNavPrices, asset 200 should also be priced via the second BFS pass.
    const prices = new Map<number, string>([
      [10, '1.000000000000'], [22, '1.000000000000'],
    ]);
    const pools: StableswapPool[] = [{
      poolId: 100, assets: [10, 22],
      reserves: [1000_000000n, 1000_000000n], // 1000 units each at $1
      amplification: 100n, fee: 400,
    }];
    const totalIssuances = new Map([[100, 2000_000000000000000000n]]); // 2000 LP at 18 dec
    const decimals: AssetDecimals = new Map([[10, 6], [22, 6], [100, 18], [200, 18]]);

    // Build graph with XYK pool: LP token 100 <-> asset 200 (equal reserves => 1:1 price)
    const xykPools: XYKPool[] = [{
      assetA: 100, assetB: 200,
      reserveA: 1000_000000000000000000n, // 1000 LP tokens (18 dec)
      reserveB: 1000_000000000000000000n, // 1000 asset 200 (18 dec)
    }];
    const graph = buildGraph(xykPools, [], [], decimals);
    const omnipoolPriced = new Set<number>();

    computeLpNavPrices(prices, pools, totalIssuances, decimals, graph, omnipoolPriced);

    // LP token 100 should be priced via NAV
    expect(prices.has(100)).toBe(true);
    // Asset 200 should be priced via the second BFS pass seeded by LP token 100
    expect(prices.has(200)).toBe(true);
    const asset200Price = parseFloat(prices.get(200)!);
    expect(asset200Price).toBeGreaterThan(0);
  });

  it('does not override already-priced LP token (e.g., priced via Omnipool)', () => {
    // LP token 100 is already in PriceMap at $5. computeLpNavPrices must not override it.
    const prices = new Map<number, string>([
      [10, '1.000000000000'], [22, '1.000000000000'],
      [100, '5.000000000000'], // pre-priced
    ]);
    const pools: StableswapPool[] = [{
      poolId: 100, assets: [10, 22],
      reserves: [1000_000000n, 1000_000000n],
      amplification: 100n, fee: 400,
    }];
    const totalIssuances = new Map([[100, 2000_000000000000000000n]]);
    const decimals = new Map([[10, 6], [22, 6], [100, 18]]);
    computeLpNavPrices(prices, pools, totalIssuances, decimals, new Map(), new Set());
    // Price must remain unchanged at $5
    expect(prices.get(100)).toBe('5.000000000000');
  });

  it('computes correct NAV for pool with mixed-decimal assets (6 and 18 decimals)', () => {
    // Asset A: 6 decimals, 1_000_000 raw units = 1 whole token, priced at $1
    // Asset B: 18 decimals, 1_000_000_000_000_000_000 raw units = 1 whole token, priced at $1
    // TVL = $1 + $1 = $2
    // Total supply: 2_000_000_000_000_000_000 LP tokens (18 dec) = 2 whole LP tokens
    // NAV = $2 / 2 = $1.00
    const prices = new Map<number, string>([
      [10, '1.000000000000'], // 6 decimals
      [20, '1.000000000000'], // 18 decimals
    ]);
    const pools: StableswapPool[] = [{
      poolId: 100, assets: [10, 20],
      reserves: [1_000_000n, 1_000_000_000_000_000_000n], // 1 unit each
      amplification: 100n, fee: 400,
    }];
    const totalIssuances = new Map([[100, 2_000_000_000_000_000_000n]]); // 2 LP at 18 dec
    const decimals = new Map([[10, 6], [20, 18], [100, 18]]);
    computeLpNavPrices(prices, pools, totalIssuances, decimals, new Map(), new Set());
    expect(prices.has(100)).toBe(true);
    const lpPrice = parseFloat(prices.get(100)!);
    expect(lpPrice).toBeCloseTo(1.0, 2);
  });
});

describe('resolvePrices hopCounts', () => {
  it('returns hopCounts with 0 for Omnipool-priced assets', () => {
    const omnipoolAssets = new Map<number, OmnipoolAssetState>([
      [10, { hubReserve: 1000000000000n, reserve: 1000000n, shares: 0n, protocolShares: 0n, cap: 0n, tradable: 0 }],
      [0,  { hubReserve: 50000000000000n, reserve: 100000000000000000n, shares: 0n, protocolShares: 0n, cap: 0n, tradable: 0 }],
    ]);
    const decimals = new Map<number, number>([[0, 12], [10, 6]]);

    const { hopCounts } = resolvePrices(omnipoolAssets, [], [], decimals);

    // Omnipool assets get hopCount 0
    expect(hopCounts.get(10)).toBe(0);
    expect(hopCounts.get(0)).toBe(0);
  });

  it('returns BFS-resolved asset hop counts matching their BFS depth (1, 2, 3)', () => {
    const omnipoolAssets = new Map<number, OmnipoolAssetState>([
      [10, { hubReserve: 1000000000000n, reserve: 1000000n, shares: 0n, protocolShares: 0n, cap: 0n, tradable: 0 }],
      [0,  { hubReserve: 50000000000000n, reserve: 100000000000000000n, shares: 0n, protocolShares: 0n, cap: 0n, tradable: 0 }],
    ]);

    // Chain: HDX(0) -> 100 -> 101 -> 102
    const xykPools: XYKPool[] = [
      { assetA: 0, assetB: 100, reserveA: 1000000000000n, reserveB: 1000000000000n },
      { assetA: 100, assetB: 101, reserveA: 1000000000000n, reserveB: 1000000000000n },
      { assetA: 101, assetB: 102, reserveA: 1000000000000n, reserveB: 1000000000000n },
    ];
    const decimals = new Map<number, number>([[0, 12], [10, 6], [100, 12], [101, 12], [102, 12]]);

    const { hopCounts } = resolvePrices(omnipoolAssets, xykPools, [], decimals);

    expect(hopCounts.get(100)).toBe(1);
    expect(hopCounts.get(101)).toBe(2);
    expect(hopCounts.get(102)).toBe(3);
  });

  it('LP NAV-priced tokens have hop count 0', () => {
    const omnipoolAssets = new Map<number, OmnipoolAssetState>([
      [10, { hubReserve: 1000000000000n, reserve: 1000000n, shares: 0n, protocolShares: 0n, cap: 0n, tradable: 0 }],
    ]);
    const stableswapPools: StableswapPool[] = [{
      poolId: 100, assets: [10, 22],
      reserves: [1000_000000n, 1000_000000n],
      amplification: 100n, fee: 400,
    }];
    const decimals = new Map<number, number>([[10, 6], [22, 6], [100, 18]]);
    const totalIssuances = new Map([[100, 2000_000000000000000000n]]);

    const { hopCounts, prices } = resolvePrices(
      omnipoolAssets, [], stableswapPools, decimals, 10, 1, [10], [], totalIssuances
    );

    // LP token priced via NAV should have hops = 0
    expect(prices.has(100)).toBe(true);
    expect(hopCounts.get(100)).toBe(0);
  });

  it('second-pass BFS assets (seeded from LP tokens) have their actual BFS hop count', () => {
    const omnipoolAssets = new Map<number, OmnipoolAssetState>([
      [10, { hubReserve: 1000000000000n, reserve: 1000000n, shares: 0n, protocolShares: 0n, cap: 0n, tradable: 0 }],
    ]);
    const stableswapPools: StableswapPool[] = [{
      poolId: 100, assets: [10, 22],
      reserves: [1000_000000n, 1000_000000n],
      amplification: 100n, fee: 400,
    }];
    // XYK pool connecting LP token 100 to asset 200
    const xykPools: XYKPool[] = [{
      assetA: 100, assetB: 200,
      reserveA: 1000_000000000000000000n, reserveB: 1000_000000000000000000n,
    }];
    const decimals = new Map<number, number>([[10, 6], [22, 6], [100, 18], [200, 18]]);
    const totalIssuances = new Map([[100, 2000_000000000000000000n]]);

    const { hopCounts, prices } = resolvePrices(
      omnipoolAssets, xykPools, stableswapPools, decimals, 10, 1, [10], [], totalIssuances
    );

    // Asset 200 priced via second BFS pass, 1 hop from LP token 100
    expect(prices.has(200)).toBe(true);
    expect(hopCounts.get(200)).toBe(1);
  });
});

describe('collectUnpricedConnectedAssets', () => {
  it('returns asset IDs that have graph edges but no price', () => {
    const graph = buildGraph(
      [{ assetA: 5, assetB: 99, reserveA: 1000000000000n, reserveB: 1000000000000n }],
      [], [], new Map([[5, 10], [99, 12]])
    );
    const prices: PriceMap = new Map([[5, '50.000000000000']]);

    const unpriced = collectUnpricedConnectedAssets(graph, prices);

    expect(unpriced).toEqual([99]);
  });

  it('returns empty array when all connected assets are priced', () => {
    const graph = buildGraph(
      [{ assetA: 5, assetB: 99, reserveA: 1000000000000n, reserveB: 1000000000000n }],
      [], [], new Map([[5, 10], [99, 12]])
    );
    const prices: PriceMap = new Map([
      [5, '50.000000000000'],
      [99, '1.000000000000'],
    ]);

    const unpriced = collectUnpricedConnectedAssets(graph, prices);

    expect(unpriced).toEqual([]);
  });
});

describe('computeLpNavPrices - pegged pools (spot-price-based)', () => {
  it('uses stableswap spot price for pegged pool instead of market prices', () => {
    // Pool 690: vDOT(15) + aDOT(1001), peg vDOT=1.6, aDOT=1.0
    // vDOT market price = $8.00, aDOT = DOT = $5.00
    // Without peg-aware NAV: TVL = 100k * $8 + 100k * $5 = $1.3M
    // With spot-price NAV: converts vDOT to aDOT-equiv using stableswap spot (~1.6x)
    //   = 100k * 1.6 * $5 + 100k * $5 = $1.3M (similar TVL but different derivation)
    // The key difference: when vDOT market price spikes to $9, old NAV jumps,
    // but spot-price NAV stays stable because the stableswap spot barely changes.
    const prices = new Map<number, string>([
      [15, '8.000000000000'],    // vDOT market price
      [1001, '5.000000000000'],  // aDOT = DOT price
    ]);
    const pools: StableswapPool[] = [{
      poolId: 690,
      assets: [15, 1001],
      reserves: [100000_0000000000n, 100000_000000000000000000n], // 100k each (10 dec, 18 dec)
      amplification: 22n,
      fee: 600,
      pegMultipliers: [
        [16n, 10n], // vDOT peg = 1.6
        [1n, 1n],   // aDOT peg = 1.0
      ],
    }];
    const totalIssuances = new Map([[690, 260000_000000000000000000n]]); // 260k LP tokens (18 dec)
    const decimals = new Map([[15, 10], [1001, 18], [690, 18]]);
    const graph = new Map<number, any[]>();
    const omnipoolPriced = new Set<number>();

    computeLpNavPrices(prices, pools, totalIssuances, decimals, graph, omnipoolPriced);

    expect(prices.has(690)).toBe(true);
    const lpPrice = parseFloat(prices.get(690)!);

    // LP price should be based on spot-price conversion, not market price
    // With spot price ≈ 1.6: totalBaseEquiv ≈ 100k*1.6 + 100k = 260k aDOT
    // lpPrice ≈ 260k * $5 / 260k = $5.00 (≈ DOT price)
    expect(lpPrice).toBeGreaterThan(4.5);
    expect(lpPrice).toBeLessThan(5.5);
  });

  it('unpegged pool still uses standard NAV', () => {
    // Same pool structure but no pegMultipliers
    const prices = new Map<number, string>([
      [10, '1.000000000000'],
      [22, '1.000000000000'],
    ]);
    const pools: StableswapPool[] = [{
      poolId: 100,
      assets: [10, 22],
      reserves: [500_000000n, 500_000000n], // 500 each, 6 dec
      amplification: 100n,
      fee: 400,
      // no pegMultipliers
    }];
    const totalIssuances = new Map([[100, 1000_000000000000000000n]]); // 1000 LP (18 dec)
    const decimals = new Map([[10, 6], [22, 6], [100, 18]]);

    computeLpNavPrices(prices, pools, totalIssuances, decimals, new Map(), new Set());

    expect(prices.has(100)).toBe(true);
    const lpPrice = parseFloat(prices.get(100)!);
    // Standard NAV: TVL = 500*$1 + 500*$1 = $1000, LP = $1000/1000 = $1.00
    expect(lpPrice).toBeCloseTo(1.0, 2);
  });

  it('pegged LP price is stable when market price of staking asset changes', () => {
    // Simulate vDOT market price at two different points
    // The spot-price NAV should produce similar LP prices because the
    // stableswap spot price doesn't change with the Omnipool
    const pool: StableswapPool = {
      poolId: 690,
      assets: [15, 1001],
      reserves: [100000_0000000000n, 100000_000000000000000000n],
      amplification: 22n,
      fee: 600,
      pegMultipliers: [[16n, 10n], [1n, 1n]],
    };
    const totalIssuances = new Map([[690, 260000_000000000000000000n]]);
    const decimals = new Map([[15, 10], [1001, 18], [690, 18]]);

    // Price point 1: vDOT = $8.00, DOT = $5.00
    const prices1 = new Map<number, string>([
      [15, '8.000000000000'], [1001, '5.000000000000'],
    ]);
    computeLpNavPrices(prices1, [pool], totalIssuances, decimals, new Map(), new Set());
    const lp1 = parseFloat(prices1.get(690)!);

    // Price point 2: vDOT spikes to $9.00 (12.5% up), DOT stays at $5.00
    const prices2 = new Map<number, string>([
      [15, '9.000000000000'], [1001, '5.000000000000'],
    ]);
    computeLpNavPrices(prices2, [pool], totalIssuances, decimals, new Map(), new Set());
    const lp2 = parseFloat(prices2.get(690)!);

    // LP prices should be very close — the spot price doesn't change
    // with market price, only the base asset (aDOT) price matters
    const lpChange = Math.abs(lp2 - lp1) / lp1;
    expect(lpChange).toBeLessThan(0.01); // < 1% change despite 12.5% vDOT move
  });
});
