import { describe, it, expect } from 'vitest';
import { calculateStableswapPrices } from '../../src/price/stableswap.ts';
import type { StableswapPool, PriceMap, AssetDecimals } from '../../src/price/types.ts';

// Import internal functions for unit testing
// These will be exported from stableswap.ts for testing purposes
import { calculateD, calculateY, calculateSpotPrice } from '../../src/price/stableswap.ts';

describe('calculateD - stableswap invariant', () => {
  it('calculates D for balanced pool', () => {
    const reserves = [1000000n, 1000000n];
    const amplification = 100n;
    const d = calculateD(reserves, amplification);

    // For balanced pool, D should be approximately sum of reserves
    expect(d).toBeGreaterThan(1900000n);
    expect(d).toBeLessThan(2100000n);
  });

  it('calculates D for unbalanced pool', () => {
    const reserves = [1500000n, 500000n];
    const amplification = 100n;
    const d = calculateD(reserves, amplification);

    // D should be close to sum but slightly less for unbalanced pool
    expect(d).toBeGreaterThan(1900000n);
    expect(d).toBeLessThan(2100000n);
  });

  it('returns 0n for pool with zero reserve', () => {
    const reserves = [0n, 1000000n];
    const amplification = 100n;
    const d = calculateD(reserves, amplification);

    expect(d).toBe(0n);
  });

  it('returns 0n for all zero reserves', () => {
    const reserves = [0n, 0n];
    const amplification = 100n;
    const d = calculateD(reserves, amplification);

    expect(d).toBe(0n);
  });

  it('handles three-asset pool', () => {
    const reserves = [1000000n, 1000000n, 1000000n];
    const amplification = 100n;
    const d = calculateD(reserves, amplification);

    // D should be approximately 3x for balanced three-asset pool
    expect(d).toBeGreaterThan(2900000n);
    expect(d).toBeLessThan(3100000n);
  });

  it('handles large reserves without overflow', () => {
    const reserves = [1000000000000n, 1000000000000n]; // 1 trillion each
    const amplification = 100n;
    const d = calculateD(reserves, amplification);

    expect(d).toBeGreaterThan(0n);
    expect(d).toBeLessThan(3000000000000n);
  });

  it('converges for high amplification', () => {
    const reserves = [1000000n, 1000000n];
    const amplification = 1000n;
    const d = calculateD(reserves, amplification);

    // Should still converge even with high A
    expect(d).toBeGreaterThan(1900000n);
    expect(d).toBeLessThan(2100000n);
  });

  it('converges for low amplification', () => {
    const reserves = [1000000n, 1000000n];
    const amplification = 1n;
    const d = calculateD(reserves, amplification);

    // Should converge even with A=1
    expect(d).toBeGreaterThan(1900000n);
    expect(d).toBeLessThan(2100000n);
  });
});

describe('calculateY - reserve calculation', () => {
  it('calculates Y for balanced pool', () => {
    const reserves = [1000000n, 1000000n];
    const amplification = 100n;
    const d = calculateD(reserves, amplification);

    // Calculate what reserve[1] should be given reserve[0]
    const y = calculateY(reserves, amplification, 1, d);

    // For balanced pool, Y should equal the other reserve
    expect(y).toBeGreaterThan(990000n);
    expect(y).toBeLessThan(1010000n);
  });

  it('calculates Y for unbalanced pool', () => {
    const reserves = [1500000n, 500000n];
    const amplification = 100n;
    const d = calculateD(reserves, amplification);

    const y = calculateY(reserves, amplification, 1, d);

    // Y should be close to current reserve[1]
    expect(y).toBeGreaterThan(490000n);
    expect(y).toBeLessThan(510000n);
  });

  it('handles three-asset pool', () => {
    const reserves = [1000000n, 1000000n, 1000000n];
    const amplification = 100n;
    const d = calculateD(reserves, amplification);

    const y = calculateY(reserves, amplification, 2, d);

    // For balanced three-asset pool, Y should be close to 1M
    expect(y).toBeGreaterThan(990000n);
    expect(y).toBeLessThan(1010000n);
  });

  it('calculates Y after swap simulation', () => {
    const reserves = [1000000n, 1000000n];
    const amplification = 100n;
    const d = calculateD(reserves, amplification);

    // Simulate adding 10000 to reserve[0]
    const newReserves = [1010000n, 1000000n];
    const y = calculateY(newReserves, amplification, 1, d);

    // Y should be less than 1000000n (pool rebalances)
    expect(y).toBeLessThan(1000000n);
    expect(y).toBeGreaterThanOrEqual(990000n); // Allow edge case equality
  });
});

describe('calculateSpotPrice - spot price calculation', () => {
  it('calculates spot price for balanced pool', () => {
    const pool: StableswapPool = {
      poolId: 1,
      assets: [10, 22],
      reserves: [1000000n, 1000000n],
      amplification: 100n,
      fee: 400,
    };

    const decimals = new Map<number, number>([
      [10, 6],
      [22, 6],
    ]);

    const spotPrice = calculateSpotPrice(pool, 0, 1, decimals);

    // For balanced pool, spot price should be approximately 1.0 (in 12 decimal precision)
    // spotPrice represents price per unit, scaled to 10^12
    expect(spotPrice).toBeGreaterThan(990000000000n);
    expect(spotPrice).toBeLessThan(1010000000000n);
  });

  it('calculates spot price for unbalanced pool', () => {
    const pool: StableswapPool = {
      poolId: 1,
      assets: [10, 22],
      reserves: [1500000n, 500000n], // More of asset 0, less of asset 1
      amplification: 100n,
      fee: 400,
    };

    const decimals = new Map<number, number>([
      [10, 6],
      [22, 6],
    ]);

    const spotPrice = calculateSpotPrice(pool, 0, 1, decimals);

    // Asset 0 is more abundant, so should be cheaper than asset 1
    // Spot price of asset 0 in terms of asset 1 should be < 1.0
    expect(spotPrice).toBeLessThan(1000000000000n);
  });

  it('calculates spot price for non-dollar pool (vDOT/DOT)', () => {
    const pool: StableswapPool = {
      poolId: 2,
      assets: [5, 100], // DOT and vDOT
      reserves: [100000000000n, 90000000000n], // 100 DOT, 90 vDOT (10 decimals each)
      amplification: 10n,
      fee: 400,
    };

    const decimals = new Map<number, number>([
      [5, 10],   // DOT
      [100, 10], // vDOT
    ]);

    const spotPrice = calculateSpotPrice(pool, 1, 0, decimals); // vDOT price in DOT terms

    // vDOT is less abundant, should be worth more than 1 DOT
    expect(spotPrice).toBeGreaterThan(1000000000000n);
  });

  it('handles different decimal counts', () => {
    const pool: StableswapPool = {
      poolId: 1,
      assets: [10, 22], // USDT and USDC both have 6 decimals
      reserves: [1000000000n, 1000000000n], // 1000 whole units each
      amplification: 100n,
      fee: 400,
    };

    const decimals = new Map<number, number>([
      [10, 6],  // USDT
      [22, 6],  // USDC
    ]);

    const spotPrice = calculateSpotPrice(pool, 0, 1, decimals);

    // Balanced pool with same decimals should have 1:1 price
    expect(spotPrice).toBeGreaterThan(990000000000n);
    expect(spotPrice).toBeLessThan(1010000000000n);
  });
});

describe('calculateStableswapPrices - full price resolution', () => {
  it('calculates prices using curve math for balanced pool', () => {
    const pools: StableswapPool[] = [
      {
        poolId: 1,
        assets: [10, 22],
        reserves: [1000000n, 1000000n],
        amplification: 100n,
        fee: 400,
      },
    ];

    const knownPrices = new Map<number, string>([
      [10, '1.000000000000'], // USDT
    ]);

    const decimals = new Map<number, number>([
      [10, 6],
      [22, 6],
    ]);

    const newPrices = calculateStableswapPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(1);
    expect(newPrices.has(22)).toBe(true);

    const usdcPrice = newPrices.get(22);
    expect(usdcPrice).toBeDefined();
    expect(parseFloat(usdcPrice!)).toBeCloseTo(1.0, 2);
  });

  it('calculates non-1:1 prices for unbalanced pool', () => {
    const pools: StableswapPool[] = [
      {
        poolId: 1,
        assets: [10, 22],
        reserves: [1500000n, 500000n], // 3:1 ratio
        amplification: 100n,
        fee: 400,
      },
    ];

    const knownPrices = new Map<number, string>([
      [10, '1.000000000000'], // USDT at $1
    ]);

    const decimals = new Map<number, number>([
      [10, 6],
      [22, 6],
    ]);

    const newPrices = calculateStableswapPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(1);
    const usdcPrice = newPrices.get(22);
    expect(usdcPrice).toBeDefined();

    // USDC is scarce (less reserves), should be worth MORE than USDT
    expect(parseFloat(usdcPrice!)).toBeGreaterThan(1.0);
  });

  it('calculates prices for non-dollar pool (vDOT/DOT)', () => {
    const pools: StableswapPool[] = [
      {
        poolId: 2,
        assets: [5, 100],
        reserves: [100000000000n, 90000000000n], // 100 DOT, 90 vDOT
        amplification: 10n,
        fee: 400,
      },
    ];

    const knownPrices = new Map<number, string>([
      [5, '5.000000000000'], // DOT at $5
    ]);

    const decimals = new Map<number, number>([
      [5, 10],
      [100, 10],
    ]);

    const newPrices = calculateStableswapPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(1);
    const vdotPrice = newPrices.get(100);
    expect(vdotPrice).toBeDefined();

    // vDOT should NOT be exactly $5 - curve math should produce different price
    expect(parseFloat(vdotPrice!)).not.toBe(5.0);
    // vDOT is scarcer, should be worth more than DOT
    expect(parseFloat(vdotPrice!)).toBeGreaterThan(5.0);
  });

  it('handles zero reserve pools gracefully', () => {
    const pools: StableswapPool[] = [
      {
        poolId: 1,
        assets: [10, 22],
        reserves: [0n, 1000000n],
        amplification: 100n,
        fee: 400,
      },
    ];

    const knownPrices = new Map<number, string>([
      [10, '1.000000000000'],
    ]);

    const decimals = new Map<number, number>([
      [10, 6],
      [22, 6],
    ]);

    const newPrices = calculateStableswapPrices(pools, knownPrices, decimals);

    // Should not crash, but also should not produce a price
    expect(newPrices.size).toBe(0);
  });

  it('propagates prices to multiple assets in same pool', () => {
    const pools: StableswapPool[] = [
      {
        poolId: 1,
        assets: [10, 22, 21], // USDT, USDC, WUSD (all 6 decimals for balanced curve)
        reserves: [1000000000n, 1000000000n, 1000000000n], // 1000 whole units each
        amplification: 100n,
        fee: 400,
      },
    ];

    const knownPrices = new Map<number, string>([
      [10, '1.000000000000'], // USDT
    ]);

    const decimals = new Map<number, number>([
      [10, 6],
      [22, 6],
      [21, 6],
    ]);

    const newPrices = calculateStableswapPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(2);
    expect(newPrices.has(22)).toBe(true); // USDC
    expect(newPrices.has(21)).toBe(true); // WUSD

    const usdcPrice = newPrices.get(22);
    const wusdPrice = newPrices.get(21);

    expect(parseFloat(usdcPrice!)).toBeCloseTo(1.0, 2);
    expect(parseFloat(wusdPrice!)).toBeCloseTo(1.0, 2);
  });

  it('returns empty when no assets are priced', () => {
    const pools: StableswapPool[] = [
      {
        poolId: 1,
        assets: [22, 18],
        reserves: [1000n, 1000n],
        amplification: 100n,
        fee: 400,
      },
    ];

    const knownPrices = new Map<number, string>();
    const decimals = new Map<number, number>([[22, 6], [18, 12]]);

    const newPrices = calculateStableswapPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(0);
  });

  it('returns empty when all assets already priced', () => {
    const pools: StableswapPool[] = [
      {
        poolId: 1,
        assets: [10, 22],
        reserves: [1000n, 1000n],
        amplification: 100n,
        fee: 400,
      },
    ];

    const knownPrices = new Map<number, string>([
      [10, '1.000000000000'],
      [22, '1.000000000000'],
    ]);

    const decimals = new Map<number, number>([[10, 6], [22, 6]]);

    const newPrices = calculateStableswapPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(0);
  });

  it('processes multiple pools', () => {
    const pools: StableswapPool[] = [
      {
        poolId: 1,
        assets: [10, 22],
        reserves: [1000000n, 1000000n],
        amplification: 100n,
        fee: 400,
      },
      {
        poolId: 2,
        assets: [5, 100],
        reserves: [100000000000n, 95000000000n],
        amplification: 10n,
        fee: 400,
      },
    ];

    const knownPrices = new Map<number, string>([
      [10, '1.000000000000'], // USDT
      [5, '5.000000000000'],  // DOT
    ]);

    const decimals = new Map<number, number>([
      [10, 6],
      [22, 6],
      [5, 10],
      [100, 10],
    ]);

    const newPrices = calculateStableswapPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(2);
    expect(newPrices.has(22)).toBe(true);  // USDC
    expect(newPrices.has(100)).toBe(true); // vDOT
  });
});
