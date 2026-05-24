import { describe, it, expect } from 'vitest';
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

  it('defaults to 12 decimals when asset not in decimals map', () => {
    const prices: PriceMap = new Map([[5, '1.000000000000']]);
    const decimals: AssetDecimals = new Map(); // Asset 5 not in map

    // 1 token (default 12 decimals) * price 1.0 = 1.0 USDT
    const result = calculateUsdVolume(1000000000000n, 5, prices, decimals);
    expect(result).toBe('1.000000000000');
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
});
