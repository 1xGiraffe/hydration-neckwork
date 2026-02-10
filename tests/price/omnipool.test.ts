import { describe, it, expect } from 'vitest';
import { calculateLRNAPrice, calculateOmnipoolPrices } from '../../src/price/omnipool.ts';
import type { OmnipoolAssetState, AssetDecimals, PriceMap } from '../../src/price/types.ts';

describe('calculateLRNAPrice', () => {
  it('calculates LRNA price from symmetric USDT reserves', () => {
    const usdtState: OmnipoolAssetState = {
      hubReserve: 1000000000000n,  // 1 LRNA (12 decimals: 1 * 10^12)
      reserve: 1000000n,            // 1 USDT (6 decimals: 1 * 10^6)
      shares: 0n,
      protocolShares: 0n,
      cap: 0n,
      tradable: 0,
    };

    const lrnaPrice = calculateLRNAPrice(usdtState, 6);

    // With 1 USDT per 1 LRNA, LRNA price = 1.0 USDT
    // Formula: (reserve * 10^12) / (hubReserve * 10^6)
    //        = (1000000 * 10^12) / (1000000000000 * 10^6)
    //        = 10^18 / 10^18 = 1.0
    expect(lrnaPrice).toBe('1.000000000000');
  });

  it('calculates LRNA price from asymmetric reserves', () => {
    const usdtState: OmnipoolAssetState = {
      hubReserve: 1000000000000n,  // 1 LRNA (12 decimals)
      reserve: 2000000n,            // 2 USDT (6 decimals: 2 * 10^6)
      shares: 0n,
      protocolShares: 0n,
      cap: 0n,
      tradable: 0,
    };

    const lrnaPrice = calculateLRNAPrice(usdtState, 6);

    // With 2 USDT per 1 LRNA, LRNA price = 2.0 USDT
    // Formula: (2000000 * 10^12) / (1000000000000 * 10^6) = 2.0
    expect(lrnaPrice).toBe('2.000000000000');
  });

  it('handles zero hub reserve', () => {
    const usdtState: OmnipoolAssetState = {
      hubReserve: 0n,
      reserve: 1000000000000n,
      shares: 0n,
      protocolShares: 0n,
      cap: 0n,
      tradable: 0,
    };

    expect(() => calculateLRNAPrice(usdtState, 6)).toThrow();
  });
});

describe('calculateOmnipoolPrices', () => {
  it('calculates prices for assets with valid reserves', () => {
    const assets = new Map<number, OmnipoolAssetState>([
      [0, { // HDX (12 decimals)
        hubReserve: 50000000000000n,    // 50 LRNA (50 * 10^12)
        reserve: 100000000000000000n,   // 100,000 HDX (100000 * 10^12)
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
      [5, { // DOT (10 decimals)
        hubReserve: 5000000000000000n,  // 5000 LRNA (5000 * 10^12)
        reserve: 1000000000000n,        // 100 DOT (100 * 10^10)
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
    ]);

    const decimals = new Map<number, number>([
      [0, 12],  // HDX
      [5, 10],  // DOT
      [10, 6],  // USDT
    ]);

    const lrnaPrice = '1.000000000000';
    const prices = calculateOmnipoolPrices(assets, lrnaPrice, decimals);

    expect(prices.size).toBe(2);
    expect(prices.has(0)).toBe(true);  // HDX
    expect(prices.has(5)).toBe(true);  // DOT

    // HDX (12 decimals): hubReserve=50 LRNA, reserve=100,000 HDX
    // With decimal normalization: (50 * 10^12 / 100,000 * 10^12) * 1.0 = 0.0005 USDT
    const hdxPrice = prices.get(0);
    expect(hdxPrice).toBeDefined();
    expect(parseFloat(hdxPrice!)).toBeCloseTo(0.0005, 6);

    // DOT (10 decimals): hubReserve=5000 LRNA, reserve=100 DOT
    // With decimal normalization: (5000 * 10^10 / 100 * 10^12) * 1.0 = 50.0 USDT
    const dotPrice = prices.get(5);
    expect(dotPrice).toBeDefined();
    expect(parseFloat(dotPrice!)).toBeCloseTo(50.0, 2);
  });

  it('skips assets with zero reserve', () => {
    const assets = new Map<number, OmnipoolAssetState>([
      [0, {
        hubReserve: 500n,
        reserve: 0n,  // Zero reserve
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
    ]);

    const decimals = new Map<number, number>([[0, 12], [10, 6]]);
    const prices = calculateOmnipoolPrices(assets, '1.0', decimals);

    expect(prices.size).toBe(0);
  });

  it('skips assets with zero hub reserve', () => {
    const assets = new Map<number, OmnipoolAssetState>([
      [0, {
        hubReserve: 0n,  // Zero hub reserve
        reserve: 1000n,
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
    ]);

    const decimals = new Map<number, number>([[0, 12], [10, 6]]);
    const prices = calculateOmnipoolPrices(assets, '1.0', decimals);

    expect(prices.size).toBe(0);
  });

  it('returns empty map for empty input', () => {
    const assets = new Map<number, OmnipoolAssetState>();
    const decimals = new Map<number, number>([[10, 6]]);
    const prices = calculateOmnipoolPrices(assets, '1.0', decimals);

    expect(prices.size).toBe(0);
  });

  it('correctly normalizes asset with 8 decimals (WBTC)', () => {
    const assets = new Map<number, OmnipoolAssetState>([
      [21, { // WBTC (8 decimals)
        hubReserve: 100000000000000n,   // 100 LRNA (100 * 10^12)
        reserve: 200000000n,            // 2 WBTC (2 * 10^8)
        shares: 0n,
        protocolShares: 0n,
        cap: 0n,
        tradable: 0,
      }],
    ]);

    const decimals = new Map<number, number>([
      [21, 8],  // WBTC
      [10, 6],  // USDT
    ]);

    const lrnaPrice = '1.000000000000';
    const prices = calculateOmnipoolPrices(assets, lrnaPrice, decimals);

    expect(prices.size).toBe(1);
    expect(prices.has(21)).toBe(true);

    // WBTC (8 decimals): hubReserve=100 LRNA, reserve=2 WBTC
    // With decimal normalization: (100 * 10^8 / 2 * 10^12) * 1.0 = 50.0 USDT
    const wbtcPrice = prices.get(21);
    expect(wbtcPrice).toBeDefined();
    expect(parseFloat(wbtcPrice!)).toBeCloseTo(50.0, 2);
  });
});
