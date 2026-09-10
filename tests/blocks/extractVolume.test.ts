import { describe, it, expect, vi } from 'vitest';
import { TypeKind } from '@subsquid/substrate-runtime/lib/metadata';
import {
  calculateUsdVolume,
  extractTradeVolumeFromSwaps,
  extractVolumeFromSwaps,
  swapToVolumeRows,
  mergePriceAndVolumeRows,
  type DecodedSwap
} from '../../src/blocks/extractVolume.ts';
import type { PriceMap, AssetDecimals } from '../../src/price/types.ts';
import type { PriceRow } from '../../src/db/schema.ts';
import { isSwapEvent } from '../../src/registry/swapEvents.ts';
import { sts, type RuntimeCtx } from '../../src/types/support.ts';
import { broadcast } from '../../src/types/events.ts';
import { readFile } from 'node:fs/promises'
import { OTC_FILL_EVENT_NAMES } from '../../src/blocks/otcCounterparty.js'
import { ICE_SETTLEMENT_TRANSFER_EVENTS } from '../../src/blocks/icePotSettlement.js'

function createMockEvent(name: string, args: unknown) {
  const runtime = {
    events: {
      checkType: (eventName: string) => eventName === name,
    },
    decodeJsonEventRecordArguments: (event: { args: unknown }) => event.args,
  };

  return {
    name,
    args,
    block: { _runtime: runtime },
  };
}

describe('calculateUsdVolume', () => {
  it('calculates USD volume from native amount with price', () => {
    const prices: PriceMap = new Map([[5, '2.000000000000']]);
    const decimals: AssetDecimals = new Map([[5, 12]]);

    // 1 token (12 decimals) * price 2.0 = 2.0 USDT
    const result = calculateUsdVolume(1000000000000n, 5, prices, decimals);
    expect(result).toBe('2.000000000000');
  });

  it('handles different decimals (USDT with 6 decimals)', () => {
    const prices: PriceMap = new Map([[10, '1.000000000000']]);
    const decimals: AssetDecimals = new Map([[10, 6]]);

    // 1 USDT (6 decimals) * price 1.0 = 1.0 USDT
    const result = calculateUsdVolume(1000000n, 10, prices, decimals);
    expect(result).toBe('1.000000000000');
  });

  it('returns zero when no price available', () => {
    const prices: PriceMap = new Map();
    const decimals: AssetDecimals = new Map([[5, 12]]);

    const result = calculateUsdVolume(1000000000000n, 5, prices, decimals);
    expect(result).toBe('0.000000000000');
  });

  it('returns zero for zero native amount', () => {
    const prices: PriceMap = new Map([[5, '2.000000000000']]);
    const decimals: AssetDecimals = new Map([[5, 12]]);

    const result = calculateUsdVolume(0n, 5, prices, decimals);
    expect(result).toBe('0.000000000000');
  });

  it('handles large amounts correctly', () => {
    const prices: PriceMap = new Map([[5, '50.000000000000']]);
    const decimals: AssetDecimals = new Map([[5, 12]]);

    // 1,000,000 tokens (12 decimals) * price 50.0 = 50,000,000 USDT
    const result = calculateUsdVolume(1000000000000000000n, 5, prices, decimals);
    expect(result).toBe('50000000.000000000000');
  });

  it('handles fractional results correctly', () => {
    const prices: PriceMap = new Map([[5, '3.000000000000']]);
    const decimals: AssetDecimals = new Map([[5, 12]]);

    // 0.5 tokens (12 decimals) * price 3.0 = 1.5 USDT
    const result = calculateUsdVolume(500000000000n, 5, prices, decimals);
    expect(result).toBe('1.500000000000');
  });

  it('normalizes compact price strings to 12 decimal places', () => {
    const prices: PriceMap = new Map([[5, '1.5']]);
    const decimals: AssetDecimals = new Map([[5, 12]]);

    expect(calculateUsdVolume(1_000_000_000_000n, 5, prices, decimals))
      .toBe('1.500000000000');
  });

  it('rejects malformed prices instead of silently mis-scaling volume', () => {
    const prices: PriceMap = new Map([[5, '1.2.3']]);
    const decimals: AssetDecimals = new Map([[5, 12]]);

    expect(() => calculateUsdVolume(1_000_000_000_000n, 5, prices, decimals))
      .toThrow('Invalid non-negative USD price');
  });

  it('returns zero when asset decimals are unknown', () => {
    const prices: PriceMap = new Map([[5, '1.000000000000']]);
    const decimals: AssetDecimals = new Map(); // Asset 5 not in map

    const result = calculateUsdVolume(1000000000000n, 5, prices, decimals);
    expect(result).toBe('0.000000000000');
  });
});

describe('swapToVolumeRows', () => {
  it('generates exactly 2 PriceRow entries for a swap', () => {
    const swap: DecodedSwap = {
      assetIn: 5,
      assetOut: 10,
      amountIn: 1000n,
      amountOut: 2000n,
    };
    const prices: PriceMap = new Map([[5, '2.000000000000'], [10, '1.500000000000']]);
    const decimals: AssetDecimals = new Map([[5, 12], [10, 12]]);

    const rows = swapToVolumeRows(swap, 100, prices, decimals);

    expect(rows).toHaveLength(2);
  });

  it('creates sell volume row for assetIn', () => {
    const swap: DecodedSwap = {
      assetIn: 5,
      assetOut: 10,
      amountIn: 1000000000000n, // 1 token (12 decimals)
      amountOut: 2000000000000n,
    };
    const prices: PriceMap = new Map([[5, '2.000000000000'], [10, '1.500000000000']]);
    const decimals: AssetDecimals = new Map([[5, 12], [10, 12]]);

    const rows = swapToVolumeRows(swap, 100, prices, decimals);
    const sellRow = rows[0];

    expect(sellRow.asset_id).toBe(5);
    expect(sellRow.block_height).toBe(100);
    expect(sellRow.usd_price).toBe('0');
    expect(sellRow.native_volume_sell).toBe('1000000000000');
    expect(sellRow.usd_volume_sell).toBe('2.000000000000'); // 1 * 2.0
    expect(sellRow.native_volume_buy).toBe('0');
    expect(sellRow.usd_volume_buy).toBe('0.000000000000');
  });

  it('creates buy volume row for assetOut', () => {
    const swap: DecodedSwap = {
      assetIn: 5,
      assetOut: 10,
      amountIn: 1000000000000n,
      amountOut: 2000000000000n, // 2 tokens (12 decimals)
    };
    const prices: PriceMap = new Map([[5, '2.000000000000'], [10, '1.500000000000']]);
    const decimals: AssetDecimals = new Map([[5, 12], [10, 12]]);

    const rows = swapToVolumeRows(swap, 100, prices, decimals);
    const buyRow = rows[1];

    expect(buyRow.asset_id).toBe(10);
    expect(buyRow.block_height).toBe(100);
    expect(buyRow.usd_price).toBe('0');
    expect(buyRow.native_volume_buy).toBe('2000000000000');
    expect(buyRow.usd_volume_buy).toBe('3.000000000000'); // 2 * 1.5
    expect(buyRow.native_volume_sell).toBe('0');
    expect(buyRow.usd_volume_sell).toBe('0.000000000000');
  });

  it('handles missing prices gracefully', () => {
    const swap: DecodedSwap = {
      assetIn: 5,
      assetOut: 10,
      amountIn: 1000n,
      amountOut: 2000n,
    };
    const prices: PriceMap = new Map(); // No prices available
    const decimals: AssetDecimals = new Map([[5, 12], [10, 12]]);

    const rows = swapToVolumeRows(swap, 100, prices, decimals);

    expect(rows[0].usd_volume_sell).toBe('0.000000000000');
    expect(rows[1].usd_volume_buy).toBe('0.000000000000');
  });
});

describe('mergePriceAndVolumeRows', () => {
  it('returns price rows unchanged when no volume rows', () => {
    const priceRows: PriceRow[] = [
      { asset_id: 5, block_height: 100, usd_price: '2.000000000000' },
      { asset_id: 10, block_height: 100, usd_price: '1.500000000000' },
    ];
    const volumeRows: PriceRow[] = [];

    const result = mergePriceAndVolumeRows(priceRows, volumeRows);

    expect(result).toEqual(priceRows);
  });

  it('returns volume rows unchanged when no price rows', () => {
    const priceRows: PriceRow[] = [];
    const volumeRows: PriceRow[] = [
      {
        asset_id: 5,
        block_height: 100,
        usd_price: '0',
        native_volume_sell: '1000',
        usd_volume_sell: '2.000000000000',
        native_volume_buy: '0',
        usd_volume_buy: '0.000000000000',
      },
    ];

    const result = mergePriceAndVolumeRows(priceRows, volumeRows);

    expect(result).toEqual(volumeRows);
  });

  it('merges volume into matching price row', () => {
    const priceRows: PriceRow[] = [
      { asset_id: 5, block_height: 100, usd_price: '2.000000000000' },
    ];
    const volumeRows: PriceRow[] = [
      {
        asset_id: 5,
        block_height: 100,
        usd_price: '0',
        native_volume_sell: '1000',
        usd_volume_sell: '2.500000000000',
        native_volume_buy: '0',
        usd_volume_buy: '0.000000000000',
      },
    ];

    const result = mergePriceAndVolumeRows(priceRows, volumeRows);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      asset_id: 5,
      block_height: 100,
      usd_price: '2.000000000000', // Price preserved from price row
      native_volume_sell: '1000',
      usd_volume_sell: '2.500000000000',
      native_volume_buy: '0',
      usd_volume_buy: '0.000000000000',
    });
  });

  it('creates standalone row for non-matching volume', () => {
    const priceRows: PriceRow[] = [
      { asset_id: 5, block_height: 100, usd_price: '2.000000000000' },
    ];
    const volumeRows: PriceRow[] = [
      {
        asset_id: 10,
        block_height: 100,
        usd_price: '0',
        native_volume_buy: '500',
        usd_volume_buy: '1.000000000000',
        native_volume_sell: '0',
        usd_volume_sell: '0.000000000000',
      },
    ];

    const result = mergePriceAndVolumeRows(priceRows, volumeRows);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(priceRows[0]); // Original price row unchanged
    expect(result[1]).toEqual(volumeRows[0]); // Volume row added
  });

  it('sums volumes from multiple swaps for same asset', () => {
    const priceRows: PriceRow[] = [];
    const volumeRows: PriceRow[] = [
      {
        asset_id: 5,
        block_height: 100,
        usd_price: '0',
        native_volume_sell: '100',
        usd_volume_sell: '1.000000000000',
        native_volume_buy: '0',
        usd_volume_buy: '0.000000000000',
      },
      {
        asset_id: 5,
        block_height: 100,
        usd_price: '0',
        native_volume_sell: '200',
        usd_volume_sell: '2.000000000000',
        native_volume_buy: '50',
        usd_volume_buy: '0.500000000000',
      },
    ];

    const result = mergePriceAndVolumeRows(priceRows, volumeRows);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      asset_id: 5,
      block_height: 100,
      usd_price: '0',
      native_volume_sell: '300', // 100 + 200
      usd_volume_sell: '3.000000000000', // 1.0 + 2.0
      native_volume_buy: '50',
      usd_volume_buy: '0.500000000000',
    });
  });

  it('handles mixed scenario: some assets have price+volume, some only price, some only volume', () => {
    const priceRows: PriceRow[] = [
      { asset_id: 5, block_height: 100, usd_price: '2.000000000000' },
      { asset_id: 10, block_height: 100, usd_price: '1.500000000000' },
    ];
    const volumeRows: PriceRow[] = [
      {
        asset_id: 5, // Has matching price row
        block_height: 100,
        usd_price: '0',
        native_volume_sell: '1000',
        usd_volume_sell: '3.000000000000',
        native_volume_buy: '0',
        usd_volume_buy: '0.000000000000',
      },
      {
        asset_id: 15, // No matching price row
        block_height: 100,
        usd_price: '0',
        native_volume_buy: '500',
        usd_volume_buy: '1.000000000000',
        native_volume_sell: '0',
        usd_volume_sell: '0.000000000000',
      },
    ];

    const result = mergePriceAndVolumeRows(priceRows, volumeRows);

    expect(result).toHaveLength(3);

    // Asset 5: price + volume merged
    const asset5 = result.find(r => r.asset_id === 5);
    expect(asset5).toEqual({
      asset_id: 5,
      block_height: 100,
      usd_price: '2.000000000000',
      native_volume_sell: '1000',
      usd_volume_sell: '3.000000000000',
      native_volume_buy: '0',
      usd_volume_buy: '0.000000000000',
    });

    // Asset 10: price only (no volume)
    const asset10 = result.find(r => r.asset_id === 10);
    expect(asset10).toEqual({
      asset_id: 10,
      block_height: 100,
      usd_price: '1.500000000000',
    });

    // Asset 15: volume only (no price)
    const asset15 = result.find(r => r.asset_id === 15);
    expect(asset15).toEqual({
      asset_id: 15,
      block_height: 100,
      usd_price: '0',
      native_volume_buy: '500',
      usd_volume_buy: '1.000000000000',
      native_volume_sell: '0',
      usd_volume_sell: '0.000000000000',
    });
  });

  it('sums volumes correctly when multiple swaps and price row both exist', () => {
    const priceRows: PriceRow[] = [
      { asset_id: 5, block_height: 100, usd_price: '2.000000000000' },
    ];
    const volumeRows: PriceRow[] = [
      {
        asset_id: 5,
        block_height: 100,
        usd_price: '0',
        native_volume_sell: '100',
        usd_volume_sell: '1.500000000000',
        native_volume_buy: '50',
        usd_volume_buy: '0.250000000000',
      },
      {
        asset_id: 5,
        block_height: 100,
        usd_price: '0',
        native_volume_sell: '200',
        usd_volume_sell: '2.500000000000',
        native_volume_buy: '75',
        usd_volume_buy: '0.750000000000',
      },
    ];

    const result = mergePriceAndVolumeRows(priceRows, volumeRows);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      asset_id: 5,
      block_height: 100,
      usd_price: '2.000000000000',
      native_volume_sell: '300', // 100 + 200
      usd_volume_sell: '4.000000000000', // 1.5 + 2.5
      native_volume_buy: '125', // 50 + 75
      usd_volume_buy: '1.000000000000', // 0.25 + 0.75
    });
  });
});

describe('isSwapEvent', () => {
  it('uses legacy swap events before unified runtime support', () => {
    expect(isSwapEvent('Omnipool.SellExecuted', 201)).toBe(true);
    expect(isSwapEvent('Broadcast.Swapped3', 201)).toBe(false);
  });

  it('switches to unified broadcast events from spec 282 onward', () => {
    expect(isSwapEvent('Omnipool.SellExecuted', 282)).toBe(false);
    expect(isSwapEvent('Broadcast.Swapped3', 323)).toBe(true);
  });
});

describe('extractVolumeFromSwaps', () => {
  const prices: PriceMap = new Map([
    [5, '2.000000000000'],
    [10, '1.500000000000'],
  ]);
  const decimals: AssetDecimals = new Map([
    [5, 12],
    [10, 12],
  ]);

  it('extracts legacy swap events before the unified swap cutoff', () => {
    const event = createMockEvent('Omnipool.SellExecuted', {
      assetIn: 5,
      assetOut: 10,
      amountIn: 1000000000000n,
      amountOut: 2000000000000n,
    });

    const rows = extractVolumeFromSwaps([event], 100, 201, prices, decimals);

    expect(rows).toHaveLength(2);
    expect(rows[0].asset_id).toBe(5);
    expect(rows[0].native_volume_sell).toBe('1000000000000');
    expect(rows[1].asset_id).toBe(10);
    expect(rows[1].native_volume_buy).toBe('2000000000000');
  });

  it('ignores legacy swap events after the unified swap cutoff', () => {
    const event = createMockEvent('Omnipool.SellExecuted', {
      assetIn: 5,
      assetOut: 10,
      amountIn: 1000000000000n,
      amountOut: 2000000000000n,
    });

    const rows = extractVolumeFromSwaps([event], 100, 282, prices, decimals);

    expect(rows).toEqual([]);
  });

  it('extracts unified broadcast swap events after the cutoff', () => {
    const event = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Omnipool' },
      operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 5, amount: 1000000000000n }],
      outputs: [{ asset: 10, amount: 2000000000000n }],
      fees: [],
      swapper: 'alice',
      filler: 'pool',
      operationStack: [],
    });

    const rows = extractVolumeFromSwaps([event], 100, 323, prices, decimals);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      asset_id: 5,
      native_volume_sell: '1000000000000',
      usd_volume_sell: '2.000000000000',
    });
    expect(rows[1]).toMatchObject({
      asset_id: 10,
      native_volume_buy: '2000000000000',
      usd_volume_buy: '3.000000000000',
    });
  });

  // A routed Omnipool trade is two broadcast hops through the hub asset. The
  // pallet event beside them names the user's two assets; the hub leg is the
  // pool's plumbing and must not read as H2O volume.
  it('books a two-hop Omnipool trade to its two user assets and nothing to the hub asset', () => {
    const pallet = createMockEvent('Omnipool.SellExecuted', {
      who: 'router', assetIn: 5, assetOut: 10, amountIn: 1000000000000n, amountOut: 2000000000000n,
      hubAmountIn: 700000000000n, hubAmountOut: 697000000000n, assetFeeAmount: 0n, protocolFeeAmount: 0n,
    });
    const hopOut = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Omnipool' }, operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 5, amount: 1000000000000n }], outputs: [{ asset: 1, amount: 700000000000n }],
      fees: [], swapper: 'alice', filler: 'pool', operationStack: [],
    });
    const hopIn = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Omnipool' }, operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 1, amount: 697000000000n }], outputs: [{ asset: 10, amount: 2000000000000n }],
      fees: [], swapper: 'alice', filler: 'pool', operationStack: [],
    });
    const hubPrices: PriceMap = new Map([...prices, [1, '5.000000000000']]);
    const hubDecimals: AssetDecimals = new Map([...decimals, [1, 12]]);

    const rows = extractVolumeFromSwaps([pallet, hopOut, hopIn], 100, 323, hubPrices, hubDecimals);

    expect(rows.map(r => r.asset_id)).toEqual([5, 10]);
    expect(rows[0]).toMatchObject({ asset_id: 5, native_volume_sell: '1000000000000', usd_volume_sell: '2.000000000000' });
    expect(rows[1]).toMatchObject({ asset_id: 10, native_volume_buy: '2000000000000', usd_volume_buy: '3.000000000000' });
  });

  it('still books a lone hop that sells or buys the hub asset itself', () => {
    const sellHub = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Omnipool' }, operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 1, amount: 1040000000000n }], outputs: [{ asset: 5, amount: 2000000000000n }],
      fees: [], swapper: 'router', filler: 'pool', operationStack: [],
    });
    const hubPrices: PriceMap = new Map([...prices, [1, '5.000000000000']]);
    const hubDecimals: AssetDecimals = new Map([...decimals, [1, 12]]);

    const rows = extractVolumeFromSwaps([sellHub], 100, 323, hubPrices, hubDecimals);

    expect(rows.map(r => r.asset_id)).toEqual([1, 5]);
    expect(rows[0]).toMatchObject({ asset_id: 1, native_volume_sell: '1040000000000', usd_volume_sell: '5.200000000000' });
  });

  it('applies the v282 Broadcast.Swapped exact-out XYK amount correction', () => {
    const event = createMockEvent('Broadcast.Swapped', {
      fillerType: { __kind: 'XYK', value: 123 },
      operation: { __kind: 'ExactOut' },
      inputs: [{ asset: 5, amount: 1000000000000n }],
      outputs: [{ asset: 10, amount: 2000000000000n }],
      fees: [],
      swapper: 'alice',
      filler: 'pool',
      operationStack: [],
    });

    const rows = extractVolumeFromSwaps([event], 100, 282, prices, decimals);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      asset_id: 5,
      native_volume_sell: '2000000000000',
      usd_volume_sell: '4.000000000000',
    });
    expect(rows[1]).toMatchObject({
      asset_id: 10,
      native_volume_buy: '1000000000000',
      usd_volume_buy: '1.500000000000',
    });
  });

  it('canonicalizes wrapper assets before aggregation and skips wrapper self-conversions', () => {
    const routeWrap = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'AAVE' },
      operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 5, amount: 1000000000000n }],
      outputs: [{ asset: 1001, amount: 1000000000000n }],
      fees: [],
      swapper: 'alice',
      filler: 'aave',
      operationStack: [],
    });
    const routeSwap = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Omnipool' },
      operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 1001, amount: 1000000000000n }],
      outputs: [{ asset: 10, amount: 2000000000000n }],
      fees: [],
      swapper: 'alice',
      filler: 'pool',
      operationStack: [],
    });
    const wrapperPrices: PriceMap = new Map([
      [5, '2.000000000000'],
      [1001, '2.000000000000'],
      [10, '1.500000000000'],
    ]);
    const wrapperDecimals: AssetDecimals = new Map([
      [5, 12],
      [1001, 12],
      [10, 12],
    ]);
    const canonicalize = (assetId: number) => assetId === 1001 ? 5 : assetId;

    const rows = extractVolumeFromSwaps([routeWrap, routeSwap], 100, 323, wrapperPrices, wrapperDecimals, canonicalize);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      asset_id: 5,
      native_volume_sell: '1000000000000',
      usd_volume_sell: '2.000000000000',
      native_volume_buy: '0',
      usd_volume_buy: '0.000000000000',
    });
    expect(rows[1]).toMatchObject({
      asset_id: 10,
      native_volume_buy: '2000000000000',
      usd_volume_buy: '3.000000000000',
    });
  });

  it('uses the canonical asset price when a wrapper leg has no direct price', () => {
    const event = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Stableswap', value: 690 },
      operation: { __kind: 'LiquidityRemove' },
      inputs: [{ asset: 690, amount: 2000000000000000000n }],
      outputs: [{ asset: 10, amount: 2500000n }],
      fees: [],
      swapper: 'alice',
      filler: 'pool',
      operationStack: [],
    });
    const wrapperPrices: PriceMap = new Map([
      [69, '1.250000000000'],
      [10, '1.000000000000'],
    ]);
    const wrapperDecimals: AssetDecimals = new Map([
      [69, 18],
      [690, 18],
      [10, 6],
    ]);
    const canonicalize = (assetId: number) => assetId === 690 ? 69 : assetId;

    const rows = extractVolumeFromSwaps([event], 100, 323, wrapperPrices, wrapperDecimals, canonicalize);

    expect(rows[0]).toMatchObject({
      asset_id: 69,
      native_volume_sell: '2000000000000000000',
      usd_volume_sell: '2.500000000000',
    });
  });
});

// Broadcast.Swapped3's argument types as a block's metadata lays them out, with the
// Filler enum parameterised: `.is()` matches a typegen arm structurally against this,
// so an event built over the spec-443 table selects an arm the way a real block does.
const FILLER_323 = ['AAVE', 'HSM', 'LBP', 'OTC', 'Omnipool', 'Stableswap', 'XYK'];
const FILLER_443 = [...FILLER_323, 'UniswapV3'];
const SWAPPED3_ARGS_TI = 15;

function swapped3Metadata(fillerVariants: string[]): sts.ScaleType[] {
  const U32 = 0, U128 = 1, ACCOUNT = 2, FILLER = 3, OPERATION = 4, ASSET = 5, ASSETS = 6,
    DESTINATION = 7, FEE = 8, FEES = 9, U32_PAIR = 10, BYTES = 11, XCM_KEY = 12, EXECUTION = 13, STACK = 14;
  const variants = (names: string[], payload: Record<string, number> = {}) => ({
    kind: TypeKind.Variant as const,
    variants: names.map((name, index) => ({ index, name, fields: name in payload ? [{ type: payload[name] }] : [] })),
  });
  const composite = (fields: Record<string, number>) => ({
    kind: TypeKind.Composite as const,
    fields: Object.entries(fields).map(([name, type]) => ({ name, type })),
  });
  return [
    { kind: TypeKind.Primitive, primitive: 'U32' },
    { kind: TypeKind.Primitive, primitive: 'U128' },
    { kind: TypeKind.HexBytesArray, len: 32 },
    variants(fillerVariants, { OTC: U32, Stableswap: U32, XYK: U32 }),
    variants(['ExactIn', 'ExactOut', 'Limit', 'LiquidityAdd', 'LiquidityRemove']),
    composite({ asset: U32, amount: U128 }),
    { kind: TypeKind.Sequence, type: ASSET },
    variants(['Account', 'Burned'], { Account: ACCOUNT }),
    composite({ asset: U32, amount: U128, destination: DESTINATION }),
    { kind: TypeKind.Sequence, type: FEE },
    { kind: TypeKind.Tuple, tuple: [U32, U32] },
    { kind: TypeKind.HexBytes },
    { kind: TypeKind.Tuple, tuple: [BYTES, U32] },
    variants(['Batch', 'DCA', 'Omnipool', 'Router', 'Xcm', 'XcmExchange'],
      { Batch: U32, DCA: U32_PAIR, Omnipool: U32, Router: U32, Xcm: XCM_KEY, XcmExchange: U32 }),
    { kind: TypeKind.Sequence, type: EXECUTION },
    composite({
      swapper: ACCOUNT, filler: ACCOUNT, fillerType: FILLER, operation: OPERATION,
      inputs: ASSETS, outputs: ASSETS, fees: FEES, operationStack: STACK,
    }),
  ];
}

// A runtime stub that does what EACRegistry.checkType does: match the arm's sts type
// against the event's metadata type. Unlike createMockEvent it can decline an arm.
function metadataEvent(name: string, args: unknown, types: sts.ScaleType[]) {
  const runtime = {
    specVersion: 443,
    events: {
      checkType: (eventName: string, type: sts.Type) =>
        eventName === name && type.match(sts.getTypeChecker(types), types[SWAPPED3_ARGS_TI]),
    },
    decodeJsonEventRecordArguments: (event: { args: unknown }) => event.args,
  };
  return { name, args, block: { _runtime: runtime as unknown as RuntimeCtx['_runtime'] } };
}

// Runtime 443 added the UniswapV3 filler. These cases pin arm selection over the
// spec-443 metadata, the flow of a UniswapV3 fill into volume rows, and the
// metadata-driven fallback for an event no arm recognises.
describe('decodeTradeEvent under runtime 443', () => {
  const uniswapArgs = {
    swapper: '0x169858b96fc71cedfcaff0542dfbfd9e4fa824f9afad4c3e304f9ab529bf7d5f',
    filler: '0x4554480069003a65189f6ed993d3bd3e2b74f1db39f405ce0000000000000000',
    fillerType: { __kind: 'UniswapV3' },
    operation: { __kind: 'ExactIn' },
    inputs: [{ asset: 10, amount: 1000000n }],
    outputs: [{ asset: 5, amount: 250000000000n }],
    fees: [],
    operationStack: [{ __kind: 'Router', value: 11029407 }],
  };

  it('decodes a UniswapV3 fill through the v443 arm', () => {
    const event = metadataEvent('Broadcast.Swapped3', uniswapArgs, swapped3Metadata(FILLER_443));
    expect(broadcast.swapped3.v443.is(event)).toBe(true);
    expect(broadcast.swapped3.v323.is(event)).toBe(false);
    expect(broadcast.swapped3.v313.is(event)).toBe(false);

    const prices: PriceMap = new Map([[10, '1.000000000000'], [5, '4.000000000000']]);
    const decimals: AssetDecimals = new Map([[10, 6], [5, 12]]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rows = extractVolumeFromSwaps([event], 14362843, 443, prices, decimals, id => id);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.find(r => r.asset_id === 10)?.usd_volume_sell).toBe('1.000000000000');
      // the arm decoded it: the metadata fallback would produce the same rows, but warns
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('still selects the v323 arm, and not v443, over the spec-323 metadata', () => {
    const event = metadataEvent('Broadcast.Swapped3', uniswapArgs, swapped3Metadata(FILLER_323));
    expect(broadcast.swapped3.v323.is(event)).toBe(true);
    expect(broadcast.swapped3.v443.is(event)).toBe(false);
  });

  it('falls back to the block metadata decode when no typegen arm matches', () => {
    const runtime = {
      events: { checkType: () => false },
      decodeJsonEventRecordArguments: (e: { args: unknown }) => e.args,
    };
    const event = { name: 'Broadcast.Swapped3', args: uniswapArgs, block: { _runtime: runtime } };
    const prices: PriceMap = new Map([[10, '1.000000000000'], [5, '4.000000000000']]);
    const decimals: AssetDecimals = new Map([[10, 6], [5, 12]]);
    const rows = extractVolumeFromSwaps([event], 14362843, 999, prices, decimals, id => id);
    expect(rows.find(r => r.asset_id === 10)?.usd_volume_sell).toBe('1.000000000000');
  });

  it('does not fall back for a payload missing the swap fields', () => {
    const runtime = {
      events: { checkType: () => false },
      decodeJsonEventRecordArguments: () => ({ something: 'else' }),
    };
    const event = { name: 'Broadcast.Swapped3', args: {}, block: { _runtime: runtime } };
    const rows = extractVolumeFromSwaps([event], 14362843, 999, new Map(), new Map(), id => id);
    expect(rows).toEqual([]);
  });
});

describe('extractTradeVolumeFromSwaps', () => {
  const prices: PriceMap = new Map([
    [5, '2.000000000000'],
    [10, '1.500000000000'],
  ]);
  const decimals: AssetDecimals = new Map([
    [5, 12],
    [10, 12],
  ]);

  it('preserves legacy trader accounts in per-account volume rows', () => {
    const event = createMockEvent('Omnipool.SellExecuted', {
      who: 'alice',
      assetIn: 5,
      assetOut: 10,
      amountIn: 1000000000000n,
      amountOut: 2000000000000n,
    });

    const rows = extractTradeVolumeFromSwaps([event], 100, 201, prices, decimals);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      asset_id: 5,
      account: 'alice',
      native_volume_sell: '1000000000000',
      usd_volume_sell: '2.000000000000',
      trade_count: 1,
    });
    expect(rows[1]).toMatchObject({
      asset_id: 10,
      account: 'alice',
      native_volume_buy: '2000000000000',
      usd_volume_buy: '3.000000000000',
      trade_count: 1,
    });
  });

  it('counts a two-hop Omnipool trade once per user asset, with no hub-asset row for the account', () => {
    const hopOut = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Omnipool' }, operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 5, amount: 1000000000000n }], outputs: [{ asset: 1, amount: 700000000000n }],
      fees: [], swapper: 'alice', filler: 'pool', operationStack: [],
    });
    const hopIn = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Omnipool' }, operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 1, amount: 697000000000n }], outputs: [{ asset: 10, amount: 2000000000000n }],
      fees: [], swapper: 'alice', filler: 'pool', operationStack: [],
    });
    const hubPrices: PriceMap = new Map([...prices, [1, '5.000000000000']]);
    const hubDecimals: AssetDecimals = new Map([...decimals, [1, 12]]);

    const rows = extractTradeVolumeFromSwaps([hopOut, hopIn], 100, 323, hubPrices, hubDecimals);

    expect(rows.map(r => [r.asset_id, r.account, r.trade_count])).toEqual([[5, 'alice', 1], [10, 'alice', 1]]);
  });

  it('aggregates repeated broadcast trades by asset, block, and account', () => {
    const first = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Omnipool' },
      operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 5, amount: 1000000000000n }],
      outputs: [{ asset: 10, amount: 2000000000000n }],
      fees: [],
      swapper: 'bob',
      filler: 'pool',
      operationStack: [],
    });
    const second = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Omnipool' },
      operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 5, amount: 500000000000n }],
      outputs: [{ asset: 10, amount: 1000000000000n }],
      fees: [],
      swapper: 'bob',
      filler: 'pool',
      operationStack: [],
    });

    const rows = extractTradeVolumeFromSwaps([first, second], 100, 323, prices, decimals);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      asset_id: 5,
      account: 'bob',
      native_volume_sell: '1500000000000',
      usd_volume_sell: '3.000000000000',
      trade_count: 2,
    });
    expect(rows[1]).toMatchObject({
      asset_id: 10,
      account: 'bob',
      native_volume_buy: '3000000000000',
      usd_volume_buy: '4.500000000000',
      trade_count: 2,
    });
  });

  it('counts a trade once per account and asset when duplicate legs are present', () => {
    const event = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Omnipool' },
      operation: { __kind: 'ExactIn' },
      inputs: [
        { asset: 5, amount: 1000000000000n },
        { asset: 5, amount: 500000000000n },
      ],
      outputs: [{ asset: 5, amount: 250000000000n }],
      fees: [],
      swapper: 'carol',
      filler: 'pool',
      operationStack: [],
    });

    const rows = extractTradeVolumeFromSwaps([event], 100, 323, prices, decimals);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      asset_id: 5,
      account: 'carol',
      native_volume_sell: '1500000000000',
      usd_volume_sell: '3.000000000000',
      native_volume_buy: '250000000000',
      usd_volume_buy: '0.500000000000',
      trade_count: 1,
    });
  });

  it('does not create same-account buy and sell rows for wrapper conversions', () => {
    const routeWrap = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'AAVE' },
      operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 5, amount: 1000000000000n }],
      outputs: [{ asset: 1001, amount: 1000000000000n }],
      fees: [],
      swapper: 'dave',
      filler: 'aave',
      operationStack: [],
    });
    const routeSwap = createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Omnipool' },
      operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 1001, amount: 1000000000000n }],
      outputs: [{ asset: 10, amount: 2000000000000n }],
      fees: [],
      swapper: 'dave',
      filler: 'pool',
      operationStack: [],
    });
    const wrapperPrices: PriceMap = new Map([
      [5, '2.000000000000'],
      [1001, '2.000000000000'],
      [10, '1.500000000000'],
    ]);
    const wrapperDecimals: AssetDecimals = new Map([
      [5, 12],
      [1001, 12],
      [10, 12],
    ]);
    const canonicalize = (assetId: number) => assetId === 1001 ? 5 : assetId;

    const rows = extractTradeVolumeFromSwaps([routeWrap, routeSwap], 100, 323, wrapperPrices, wrapperDecimals, canonicalize);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      asset_id: 5,
      account: 'dave',
      native_volume_sell: '1000000000000',
      usd_volume_sell: '2.000000000000',
      native_volume_buy: '0',
      usd_volume_buy: '0.000000000000',
      trade_count: 1,
    });
    expect(rows[1]).toMatchObject({
      asset_id: 10,
      account: 'dave',
      native_volume_buy: '2000000000000',
      usd_volume_buy: '3.000000000000',
      trade_count: 1,
    });
  });
});

describe('Uniswap v3 pool swaps in EVM.Log', () => {
  // The aDOT/HOLLAR pool's first swap (block 14395782, extrinsic 4) exactly as
  // the block stream carries it: HOLLAR in, aDOT out, to recipient 0x6e8967….
  const POOL = '0x5c6208a3c316a801f8996750aa7b6f45fc988548';
  const swapLog = {
    log: {
      address: POOL,
      topics: [
        '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
        '0x0000000000000000000000005a79de848626994c4099640ef5c48fd65dae4159',
        '0x0000000000000000000000006e896769ddecd994f63e5772218a820918e0ff6f',
      ],
      data: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffe6dbabd300000000000000000000000000000000000000000000000000a411a5b06516450000000000000000000000000000000000002a5f9ddcd191e225a5b8b880afcb0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002d5f3',
    },
  };
  const pools = new Map([[POOL, { token0AssetId: 1001, token1AssetId: 222 }]]);
  const prices: PriceMap = new Map([[5, '1.180000000000'], [1001, '1.180000000000'], [222, '1.000000000000']]);
  const decimals: AssetDecimals = new Map([[5, 10], [1001, 10], [222, 18]]);
  const evmLog = (extrinsicIndex: number) => ({ ...createMockEvent('EVM.Log', swapLog), extrinsicIndex });
  const routedFill = (extrinsicIndex: number) => ({
    ...createMockEvent('Broadcast.Swapped3', {
      swapper: '0x455448006e896769ddecd994f63e5772218a820918e0ff6f0000000000000000',
      filler: '0x4554480069003a65189f6ed993d3bd3e2b74f1db39f405ce0000000000000000',
      fillerType: { __kind: 'UniswapV3' },
      operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 222, amount: 46181299507238469n }],
      outputs: [{ asset: 1001, amount: 421811245n }],
      fees: [],
      operationStack: [],
    }),
    extrinsicIndex,
  });

  it('books a direct-EVM swap on a known pool as volume in both directions, canonicalised like any trade', () => {
    const canonical = (id: number) => (id === 1001 ? 5 : id);
    const rows = extractVolumeFromSwaps([evmLog(4)], 14395782, 443, prices, decimals, canonical, { uniswapV3Pools: pools });

    expect(rows).toEqual([
      expect.objectContaining({ asset_id: 222, native_volume_sell: '46181299507238469', usd_volume_sell: '0.046181299507' }),
      expect.objectContaining({ asset_id: 5, native_volume_buy: '421811245', usd_volume_buy: '0.049773726910' }),
    ]);

    const accountRows = extractTradeVolumeFromSwaps([evmLog(4)], 14395782, 443, prices, decimals, canonical, { uniswapV3Pools: pools });
    expect(accountRows.map(r => [r.asset_id, r.account, r.trade_count])).toEqual([
      [222, '0x455448006e896769ddecd994f63e5772218a820918e0ff6f0000000000000000', 1],
      [5, '0x455448006e896769ddecd994f63e5772218a820918e0ff6f0000000000000000', 1],
    ]);
  });

  it('books a router-routed v3 hop once: the Broadcast fill counts, the pool log in the same extrinsic does not', () => {
    const rows = extractVolumeFromSwaps([evmLog(4), routedFill(4)], 14395782, 443, prices, decimals, id => id, { uniswapV3Pools: pools });
    expect(rows.map(r => [r.asset_id, r.native_volume_sell, r.native_volume_buy])).toEqual([
      [222, '46181299507238469', '0'],
      [1001, '0', '421811245'],
    ]);

    const accountRows = extractTradeVolumeFromSwaps([evmLog(4), routedFill(4)], 14395782, 443, prices, decimals, id => id, { uniswapV3Pools: pools });
    expect(accountRows.map(r => r.trade_count)).toEqual([1, 1]);
  });

  it('keeps a direct swap when the routed fill belongs to a different extrinsic', () => {
    const rows = extractVolumeFromSwaps([evmLog(3), routedFill(4)], 14395782, 443, prices, decimals, id => id, { uniswapV3Pools: pools });
    // two trades, two rows each; the block's merge step sums them per asset
    expect(mergePriceAndVolumeRows([], rows).map(r => [r.asset_id, r.native_volume_sell, r.native_volume_buy])).toEqual([
      [222, '92362599014476938', '0'],
      [1001, '0', '843622490'],
    ]);
  });

  it('reads no pool logs without a pool index, on an unknown pool, or for a non-swap log', () => {
    expect(extractVolumeFromSwaps([evmLog(4)], 14395782, 443, prices, decimals)).toEqual([]);
    expect(extractVolumeFromSwaps([evmLog(4)], 14395782, 443, prices, decimals, id => id, { uniswapV3Pools: new Map() })).toEqual([]);
    const otherPool = new Map([['0x1111111111111111111111111111111111111111', { token0AssetId: 1001, token1AssetId: 222 }]]);
    expect(extractVolumeFromSwaps([evmLog(4)], 14395782, 443, prices, decimals, id => id, { uniswapV3Pools: otherPool })).toEqual([]);
    const transfer = createMockEvent('EVM.Log', { log: { address: POOL, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`], data: `0x${'0'.repeat(64)}` } });
    expect(extractVolumeFromSwaps([transfer], 14395782, 443, prices, decimals, id => id, { uniswapV3Pools: pools })).toEqual([]);
  });
});

// An OTC fill's Broadcast event is internally inconsistent, and booking it naively
// puts the wrong account on the wrong side of a trade. Measured over every OTC fill
// on chain (796, across Broadcast.Swapped/Swapped2/Swapped3):
//
//  * `inputs`/`outputs` are ALWAYS the ORDER's direction, which is the TAKER's:
//    the order's input is what the taker pays, its output what the taker receives.
//  * `swapper` names the order's MAKER in 620 of them and the taker in the other
//    176 — the same two accounts swap roles between blocks — so the legs cannot be
//    booked against `swapper`.
//  * the taker is ALWAYS one of {swapper, filler} (0 of 796 name neither), and the
//    `OTC.Filled`/`OTC.PartiallyFilled` sitting at exactly `event_index - 1`
//    (796 of 796) says which. The maker is then the other one.
//
// A maker really did trade, so both counterparties are booked — the taker with the
// legs as they stand, the maker with them mirrored. Only the taker's row counts
// toward a candle's volume (`counterparty: 0`); the maker's carries `counterparty:
// 1` so cross-account sums do not count the same tokens twice.
describe('OTC fills book both counterparties on their true sides', () => {
  const prices: PriceMap = new Map([
    [0, '0.008000000000'],
    [22, '1.000000000000'],
  ]);
  const decimals: AssetDecimals = new Map([
    [0, 12],
    [22, 6],
  ]);

  // Order 1587's shape: the maker reserved HDX (asset 0) and asked for USDC (22),
  // so the order's input is USDC and its output HDX. The taker pays the USDC.
  const otcFill = (who: string) => createMockEvent('OTC.PartiallyFilled', {
    orderId: 1587, who, amountIn: 800000n, amountOut: 100000000000000n, fee: 100000000000n,
  });
  const broadcastFill = (swapper: string, filler: string) => createMockEvent('Broadcast.Swapped3', {
    fillerType: { __kind: 'OTC', value: 1587 },
    operation: { __kind: 'ExactIn' },
    inputs: [{ asset: 22, amount: 800000n }],
    outputs: [{ asset: 0, amount: 100000000000000n }],
    fees: [], swapper, filler, operationStack: [],
  });

  const rowFor = (rows: ReturnType<typeof extractTradeVolumeFromSwaps>, account: string, assetId: number) =>
    rows.find(row => row.account === account && row.asset_id === assetId);

  // The 620-fill majority: `swapper` is the maker, so the legs belong to `filler`.
  it('credits the taker with the legs when swapper is the maker', () => {
    const rows = extractTradeVolumeFromSwaps(
      [otcFill('taker'), broadcastFill('maker', 'taker')], 100, 323, prices, decimals,
    );

    // The taker paid USDC and received HDX.
    expect(rowFor(rows, 'taker', 22)).toMatchObject({ native_volume_sell: '800000', native_volume_buy: '0', counterparty: 0 });
    expect(rowFor(rows, 'taker', 0)).toMatchObject({ native_volume_buy: '100000000000000', native_volume_sell: '0', counterparty: 0 });
    // The maker gave up the HDX and received the USDC — the mirror image, and
    // flagged so a cross-account sum counts these tokens once.
    expect(rowFor(rows, 'maker', 0)).toMatchObject({ native_volume_sell: '100000000000000', native_volume_buy: '0', counterparty: 1 });
    expect(rowFor(rows, 'maker', 22)).toMatchObject({ native_volume_buy: '800000', native_volume_sell: '0', counterparty: 1 });
  });

  // The 176-fill remainder: `swapper` already IS the taker, so the legs stay put
  // and the maker is `filler`. Same output as above — which is the point.
  it('resolves the same sides when swapper is already the taker', () => {
    const rows = extractTradeVolumeFromSwaps(
      [otcFill('taker'), broadcastFill('taker', 'maker')], 100, 323, prices, decimals,
    );

    expect(rowFor(rows, 'taker', 22)).toMatchObject({ native_volume_sell: '800000', counterparty: 0 });
    expect(rowFor(rows, 'taker', 0)).toMatchObject({ native_volume_buy: '100000000000000', counterparty: 0 });
    expect(rowFor(rows, 'maker', 0)).toMatchObject({ native_volume_sell: '100000000000000', counterparty: 1 });
    expect(rowFor(rows, 'maker', 22)).toMatchObject({ native_volume_buy: '800000', counterparty: 1 });
  });

  // The candle's own volume comes from the `prices` rows, so it must stay
  // single-counted: one fill moved one lot of HDX, whatever its two sides.
  it('leaves the candle volume rows single-counted', () => {
    const rows = extractVolumeFromSwaps(
      [otcFill('taker'), broadcastFill('maker', 'taker')], 100, 323, prices, decimals,
    );

    expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.asset_id === 0)).toHaveLength(1);
    expect(rows.filter(row => row.asset_id === 22)).toHaveLength(1);
    expect(rows.find(row => row.asset_id === 0)).toMatchObject({ native_volume_buy: '100000000000000' });
    expect(rows.find(row => row.asset_id === 22)).toMatchObject({ native_volume_sell: '800000' });
  });

  // Without the sibling OTC event there is nothing that names the taker, so the
  // trade stays booked exactly as before rather than guessing which side is which.
  it('books only the swapper when the OTC event is not in the block', () => {
    const rows = extractTradeVolumeFromSwaps([broadcastFill('maker', 'taker')], 100, 323, prices, decimals);

    expect(rows.every(row => row.account === 'maker')).toBe(true);
    expect(rows.every(row => (row.counterparty ?? 0) === 0)).toBe(true);
  });

  // A non-OTC fill is untouched: the pool is not an account and gets no row.
  it('leaves a pool-venue fill with one account', () => {
    const rows = extractTradeVolumeFromSwaps([createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Omnipool' }, operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 22, amount: 800000n }], outputs: [{ asset: 0, amount: 100000000000000n }],
      fees: [], swapper: 'alice', filler: 'pool', operationStack: [],
    })], 100, 323, prices, decimals);

    expect([...new Set(rows.map(row => row.account))]).toEqual(['alice']);
    expect(rows.every(row => (row.counterparty ?? 0) === 0)).toBe(true);
  });
});

describe('the OTC side rule needs its source events subscribed', () => {
  it('the processor fetches the OTC fill events the rule reads', async () => {
    // The rule reads the pallet fill event sitting before the Broadcast fill. If the
    // processor does not request it, `block.events` never holds it and every fill is
    // booked against whichever account the Broadcast happened to name — the exact
    // regression this pins, found live after the rule itself was already correct.
    const source = await readFile(new URL('../../src/processor.ts', import.meta.url), 'utf8')
    for (const name of OTC_FILL_EVENT_NAMES) expect(source).toContain(`'${name}'`)
  })
})

describe('an ICE settlement is the intent owner\'s trade, not the pot\'s', () => {
  const ICE_POT = '0x6d6f646c6963655f696365230000000000000000000000000000000000000000';
  const ROUTER_POT = '0x6d6f646c726f7574657265780000000000000000000000000000000000000000';
  const FEE_PROCESSOR = '0x6d6f646c66656570726f632f0000000000000000000000000000000000000000';
  const OWNER = '0x45544800553f022201fa7c88e6cc10d1c688b157d6fa77750000000000000000';

  const prices: PriceMap = new Map([
    [0, '0.008000000000'],
    [22, '1.000000000000'],
  ]);
  const decimals: AssetDecimals = new Map([
    [0, 12],
    [22, 6],
  ]);

  const withExtrinsic = (event: ReturnType<typeof createMockEvent>, extrinsicIndex: number) =>
    ({ ...event, extrinsicIndex });

  // The solution's AMM route: the solver submits it, so the pot is the swapper.
  const routeLeg = (extrinsicIndex = 2) => withExtrinsic(createMockEvent('Broadcast.Swapped3', {
    fillerType: { __kind: 'Omnipool' }, operation: { __kind: 'ExactIn' },
    inputs: [{ asset: 22, amount: 800000n }], outputs: [{ asset: 0, amount: 100000000000000n }],
    fees: [], swapper: ICE_POT, filler: 'pool', operationStack: [],
  }), extrinsicIndex);

  const transferLeg = (name: string, from: string, to: string, extrinsicIndex = 2) =>
    withExtrinsic(createMockEvent(name, { from, to, currencyId: 22, amount: 800000n }), extrinsicIndex);

  const accounts = (rows: ReturnType<typeof extractTradeVolumeFromSwaps>) =>
    [...new Set(rows.map(row => row.account))];

  it('books the route to the owner the pot moved funds with', () => {
    const rows = extractTradeVolumeFromSwaps([
      transferLeg('Currencies.Transferred', OWNER, ICE_POT),
      routeLeg(),
      transferLeg('Tokens.Transfer', ICE_POT, OWNER),
    ], 100, 443, prices, decimals);

    expect(accounts(rows)).toEqual([OWNER]);
    expect(rows.find(row => row.asset_id === 22)).toMatchObject({ native_volume_sell: '800000' });
    expect(rows.find(row => row.asset_id === 0)).toMatchObject({ native_volume_buy: '100000000000000' });
  });

  // 15 of the 150 settlements on chain move an aToken, whose only transfer event
  // is Currencies.Transferred — reading Tokens.Transfer alone leaves them on the pot.
  it('names the owner from a Currencies.Transferred leg alone', () => {
    const rows = extractTradeVolumeFromSwaps([
      routeLeg(), transferLeg('Currencies.Transferred', ICE_POT, OWNER),
    ], 100, 443, prices, decimals);

    expect(accounts(rows)).toEqual([OWNER]);
  });

  // 211 of the pot's 717 legs face another module account. Counting those as
  // owners would make every such solution look multi-owner and attribute none.
  it('ignores module accounts on the other side of a pot leg', () => {
    const rows = extractTradeVolumeFromSwaps([
      transferLeg('Tokens.Transfer', ROUTER_POT, ICE_POT),
      routeLeg(),
      transferLeg('Tokens.Transfer', ICE_POT, OWNER),
      transferLeg('Tokens.Transfer', ICE_POT, FEE_PROCESSOR),
    ], 100, 443, prices, decimals);

    expect(accounts(rows)).toEqual([OWNER]);
  });

  it('leaves the pot booked when the extrinsic names no single owner', () => {
    const other = '0x45544800aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000000';
    // Two owners in one solution: the route cannot be divided without guessing.
    expect(accounts(extractTradeVolumeFromSwaps([
      routeLeg(), transferLeg('Tokens.Transfer', ICE_POT, OWNER), transferLeg('Tokens.Transfer', ICE_POT, other),
    ], 100, 443, prices, decimals))).toEqual([ICE_POT]);
    // No leg at all — nothing names an owner.
    expect(accounts(extractTradeVolumeFromSwaps([routeLeg()], 100, 443, prices, decimals))).toEqual([ICE_POT]);
  });

  it('only takes legs from the settlement\'s own extrinsic', () => {
    const rows = extractTradeVolumeFromSwaps([
      routeLeg(2), transferLeg('Tokens.Transfer', ICE_POT, OWNER, 3),
    ], 100, 443, prices, decimals);

    expect(accounts(rows)).toEqual([ICE_POT]);
  });

  it('leaves the candle volume alone — only the per-account breakdown moves', () => {
    const events = [routeLeg(), transferLeg('Tokens.Transfer', ICE_POT, OWNER)];
    const withOwner = extractVolumeFromSwaps(events, 100, 443, prices, decimals);
    const withoutLegs = extractVolumeFromSwaps([routeLeg()], 100, 443, prices, decimals);

    expect(withOwner).toEqual(withoutLegs);
  });

  it('gives the fee processor no per-account row, having nobody to name', () => {
    const rows = extractTradeVolumeFromSwaps([withExtrinsic(createMockEvent('Broadcast.Swapped3', {
      fillerType: { __kind: 'Omnipool' }, operation: { __kind: 'ExactIn' },
      inputs: [{ asset: 22, amount: 800000n }], outputs: [{ asset: 0, amount: 100000000000000n }],
      fees: [], swapper: FEE_PROCESSOR, filler: 'pool', operationStack: [],
    }), 2)], 100, 443, prices, decimals);

    expect(rows).toEqual([]);
  });
})

describe('the ICE settlement rule needs its source events subscribed', () => {
  it('the processor fetches the transfer events that name the intent owner', async () => {
    // Same regression the OTC rule shipped once: a rule reading events the
    // processor never asked for is silently a no-op on the live path.
    const source = await readFile(new URL('../../src/processor.ts', import.meta.url), 'utf8')
    for (const name of ICE_SETTLEMENT_TRANSFER_EVENTS) expect(source).toContain(`'${name}'`)
  })
})
