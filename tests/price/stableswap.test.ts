import { describe, it, expect } from 'vitest'
import type { StableswapPool } from '../../src/price/types.ts'
import { calculateSpotPrice } from '../../src/price/stableswap.ts'

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

describe('calculateSpotPrice - peg-aware pools', () => {
  it('applies peg multiplier to vDOT/aDOT pool (GDOT-like)', () => {
    // Pool with vDOT (peg 1.6) and aDOT (peg 1.0), balanced reserves
    // Without peg: spot price ≈ 1.0 (reserves are equal)
    // With peg: spot price ≈ 1.6 (1 vDOT = 1.6 aDOT in the curve)
    const pool: StableswapPool = {
      poolId: 690,
      assets: [15, 1001], // vDOT, aDOT
      reserves: [100000_0000000000n, 100000_000000000000000000n], // 100k each (10 dec, 18 dec)
      amplification: 22n,
      fee: 600,
      pegMultipliers: [
        [16n, 10n], // vDOT peg = 1.6
        [1n, 1n],   // aDOT peg = 1.0
      ],
    };
    const decimals = new Map([[15, 10], [1001, 18]]);

    // Spot price of vDOT in aDOT terms: how much aDOT per 1 vDOT
    const spotPrice = calculateSpotPrice(pool, 0, 1, decimals);

    // With peg 1.6, the curve treats 1 vDOT as 1.6 units.
    // Spot price should be ≈ 1.6 (scaled to 10^12)
    expect(spotPrice).toBeGreaterThan(1_500_000_000_000n); // > 1.5
    expect(spotPrice).toBeLessThan(1_700_000_000_000n);    // < 1.7
  });

  it('spot price without peg treats assets as 1:1', () => {
    // Same pool but no peg — spot price should be ≈ 1.0
    const pool: StableswapPool = {
      poolId: 690,
      assets: [15, 1001],
      reserves: [100000_0000000000n, 100000_000000000000000000n],
      amplification: 22n,
      fee: 600,
      // no pegMultipliers
    };
    const decimals = new Map([[15, 10], [1001, 18]]);

    const spotPrice = calculateSpotPrice(pool, 0, 1, decimals);

    // Without peg, balanced reserves → spot price ≈ 1.0
    expect(spotPrice).toBeGreaterThan(990_000_000_000n);
    expect(spotPrice).toBeLessThan(1_010_000_000_000n);
  });

  it('peg-adjusted spot price is symmetric (A→B * B→A ≈ 1)', () => {
    const pool: StableswapPool = {
      poolId: 4200,
      assets: [1000809, 1007], // wstETH, aETH
      reserves: [50000_000000000000000000n, 50000_000000000000000000n], // 50k each, 18 dec
      amplification: 50n,
      fee: 400,
      pegMultipliers: [
        [1n, 1n],   // wstETH peg = 1.0
        [12n, 10n], // aETH peg = 1.2
      ],
    };
    const decimals = new Map([[1000809, 18], [1007, 18]]);

    const priceAB = calculateSpotPrice(pool, 0, 1, decimals); // wstETH → aETH
    const priceBA = calculateSpotPrice(pool, 1, 0, decimals); // aETH → wstETH

    // priceAB * priceBA should be ≈ 10^24 (1.0 * 10^12 * 1.0 * 10^12)
    const product = (priceAB * priceBA) / (10n ** 12n);
    expect(product).toBeGreaterThan(990_000_000_000n);
    expect(product).toBeLessThan(1_010_000_000_000n);
  });
});
