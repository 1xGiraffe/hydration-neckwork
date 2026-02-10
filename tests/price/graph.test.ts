import { describe, it, expect } from 'vitest';
import { resolvePrices } from '../../src/price/graph.ts';
import type { OmnipoolAssetState, XYKPool, StableswapPool, AssetDecimals } from '../../src/price/types.ts';

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

    const prices = resolvePrices(omnipoolAssets, xykPools, stableswapPools, decimals);

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

    const prices = resolvePrices(omnipoolAssets, xykPools, [], decimals);

    // Should resolve DOT, GLMR, and KSM
    expect(prices.has(5)).toBe(true);   // DOT
    expect(prices.has(2)).toBe(true);   // GLMR
    expect(prices.has(4)).toBe(true);   // KSM

    // All should have valid prices
    expect(parseFloat(prices.get(5)!)).toBeGreaterThan(0);
    expect(parseFloat(prices.get(2)!)).toBeGreaterThan(0);
    expect(parseFloat(prices.get(4)!)).toBeGreaterThan(0);
  });

  it('returns only USDT price when USDT not in Omnipool', () => {
    const omnipoolAssets = new Map<number, OmnipoolAssetState>();
    const xykPools: XYKPool[] = [];
    const stableswapPools: StableswapPool[] = [];
    const decimals = new Map<number, number>([[10, 6]]);

    const prices = resolvePrices(omnipoolAssets, xykPools, stableswapPools, decimals);

    expect(prices.size).toBe(1);
    expect(prices.has(10)).toBe(true);
    expect(prices.get(10)).toBe('1.000000000000');
  });

  it('handles empty inputs gracefully', () => {
    const omnipoolAssets = new Map<number, OmnipoolAssetState>();
    const xykPools: XYKPool[] = [];
    const stableswapPools: StableswapPool[] = [];
    const decimals = new Map<number, number>([[10, 6]]);

    const prices = resolvePrices(omnipoolAssets, xykPools, stableswapPools, decimals);

    expect(prices.size).toBe(1);
    expect(prices.get(10)).toBe('1.000000000000');
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

    const prices = resolvePrices(
      omnipoolAssets,
      [],
      [],
      decimals,
      100,  // Custom USDT ID
      999   // Custom LRNA ID
    );

    expect(prices.has(100)).toBe(true);  // Custom USDT
    expect(prices.has(999)).toBe(true);  // Custom LRNA
    expect(prices.get(100)).toBe('1.000000000000');
  });

  it('stops iteration after max iterations', () => {
    // Create a scenario that would require many iterations
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

    // Create long chain
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

    const prices = resolvePrices(omnipoolAssets, xykPools, [], decimals);

    // Should stop after 10 iterations, so not all assets priced
    expect(prices.size).toBeLessThan(17);  // Won't have all 15 chain assets
    expect(prices.size).toBeGreaterThan(2); // But should have some
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

    const prices = resolvePrices(omnipoolAssets, xykPools, [], decimals);

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
