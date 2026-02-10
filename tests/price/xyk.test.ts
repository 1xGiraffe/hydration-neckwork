import { describe, it, expect } from 'vitest';
import { calculateXYKPrices } from '../../src/price/xyk.ts';
import type { XYKPool, PriceMap, AssetDecimals } from '../../src/price/types.ts';

describe('calculateXYKPrices', () => {
  it('derives price for assetB when assetA is known', () => {
    const pools: XYKPool[] = [
      {
        assetA: 5,  // DOT (known, 10 decimals)
        assetB: 0,  // HDX (unknown, 12 decimals)
        reserveA: 100000000000n,         // 10 DOT (10 * 10^10)
        reserveB: 50000000000000000n,    // 50,000 HDX (50000 * 10^12)
      },
    ];

    const knownPrices = new Map<number, string>([
      [5, '7.500000000000'],  // DOT = $7.50
    ]);

    const decimals = new Map<number, number>([
      [0, 12],  // HDX
      [5, 10],  // DOT
      [10, 6],  // USDT
    ]);

    const newPrices = calculateXYKPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(1);
    expect(newPrices.has(0)).toBe(true);

    // HDX price with decimal normalization:
    // (10 DOT / 50,000 HDX) * $7.50 = 0.0002 * 7.5 = $0.0015 per HDX
    // Formula: (reserveA * 10^12 / reserveB * 10^10) * 7.5
    const hdxPrice = newPrices.get(0);
    expect(hdxPrice).toBeDefined();
    expect(parseFloat(hdxPrice!)).toBeCloseTo(0.0015, 8);
  });

  it('derives price for assetA when assetB is known', () => {
    const pools: XYKPool[] = [
      {
        assetA: 0,  // HDX (unknown, 12 decimals)
        assetB: 5,  // DOT (known, 10 decimals)
        reserveA: 50000000000000000n,  // 50,000 HDX (50000 * 10^12)
        reserveB: 100000000000n,        // 10 DOT (10 * 10^10)
      },
    ];

    const knownPrices = new Map<number, string>([
      [5, '7.500000000000'],  // DOT
    ]);

    const decimals = new Map<number, number>([
      [0, 12],
      [5, 10],
      [10, 6],
    ]);

    const newPrices = calculateXYKPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(1);
    expect(newPrices.has(0)).toBe(true);

    // Same result as previous test, just reversed order: $0.0015 per HDX
    const hdxPrice = newPrices.get(0);
    expect(parseFloat(hdxPrice!)).toBeCloseTo(0.0015, 8);
  });

  it('returns empty when neither asset is priced', () => {
    const pools: XYKPool[] = [
      {
        assetA: 0,
        assetB: 2,
        reserveA: 1000n,
        reserveB: 2000n,
      },
    ];

    const knownPrices = new Map<number, string>();
    const decimals = new Map<number, number>([[0, 12], [2, 12], [10, 6]]);

    const newPrices = calculateXYKPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(0);
  });

  it('returns empty when both assets are already priced', () => {
    const pools: XYKPool[] = [
      {
        assetA: 5,
        assetB: 10,
        reserveA: 1000n,
        reserveB: 2000n,
      },
    ];

    const knownPrices = new Map<number, string>([
      [5, '7.500000000000'],
      [10, '1.000000000000'],
    ]);

    const decimals = new Map<number, number>([[5, 10], [10, 6]]);

    const newPrices = calculateXYKPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(0);
  });

  it('skips pools with zero reserves', () => {
    const pools: XYKPool[] = [
      {
        assetA: 5,
        assetB: 0,
        reserveA: 0n,  // Zero reserve
        reserveB: 1000n,
      },
      {
        assetA: 5,
        assetB: 2,
        reserveA: 1000n,
        reserveB: 0n,  // Zero reserve
      },
    ];

    const knownPrices = new Map<number, string>([[5, '7.500000000000']]);
    const decimals = new Map<number, number>([[0, 12], [2, 12], [5, 10], [10, 6]]);

    const newPrices = calculateXYKPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(0);
  });

  it('processes multiple pools in single pass', () => {
    const pools: XYKPool[] = [
      {
        assetA: 5,  // DOT (known, 10 decimals)
        assetB: 0,  // HDX (unknown, 12 decimals)
        reserveA: 100000000000n,         // 10 DOT
        reserveB: 50000000000000000n,    // 50,000 HDX
      },
      {
        assetA: 5,  // DOT (known, 10 decimals)
        assetB: 2,  // GLMR (unknown, 12 decimals)
        reserveA: 200000000000n,         // 20 DOT
        reserveB: 10000000000000000n,    // 10,000 GLMR
      },
    ];

    const knownPrices = new Map<number, string>([
      [5, '7.500000000000'],
    ]);

    const decimals = new Map<number, number>([
      [0, 12],
      [2, 12],
      [5, 10],
      [10, 6],
    ]);

    const newPrices = calculateXYKPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(2);
    expect(newPrices.has(0)).toBe(true);  // HDX
    expect(newPrices.has(2)).toBe(true);  // GLMR

    // HDX: (10 DOT / 50,000 HDX) * $7.50 = $0.0015
    const hdxPrice = newPrices.get(0);
    expect(parseFloat(hdxPrice!)).toBeCloseTo(0.0015, 8);

    // GLMR: (20 DOT / 10,000 GLMR) * $7.50 = $0.015
    const glmrPrice = newPrices.get(2);
    expect(parseFloat(glmrPrice!)).toBeCloseTo(0.015, 8);
  });

  it('correctly normalizes cross-decimal pairs (DOT 10 dec + WBTC 8 dec)', () => {
    const pools: XYKPool[] = [
      {
        assetA: 5,  // DOT (known, 10 decimals)
        assetB: 21, // WBTC (unknown, 8 decimals)
        reserveA: 1000000000000n,  // 100 DOT (100 * 10^10)
        reserveB: 100000000n,       // 1 WBTC (1 * 10^8)
      },
    ];

    const knownPrices = new Map<number, string>([
      [5, '50.000000000000'],  // DOT = $50
    ]);

    const decimals = new Map<number, number>([
      [5, 10],   // DOT
      [21, 8],   // WBTC
      [10, 6],   // USDT
    ]);

    const newPrices = calculateXYKPrices(pools, knownPrices, decimals);

    expect(newPrices.size).toBe(1);
    expect(newPrices.has(21)).toBe(true);

    // WBTC price with decimal normalization:
    // (100 DOT / 1 WBTC) * $50 = 100 * 50 = $5000 per WBTC
    // Formula: (reserveA * 10^8 / reserveB * 10^10) * 50
    const wbtcPrice = newPrices.get(21);
    expect(wbtcPrice).toBeDefined();
    expect(parseFloat(wbtcPrice!)).toBeCloseTo(5000.0, 2);
  });
});
