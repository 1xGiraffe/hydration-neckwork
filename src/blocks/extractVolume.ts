/**
 * Volume Extraction Module
 *
 * Pure functions for extracting and aggregating trading volume from swap events:
 * - Decodes swap events from Omnipool, XYK, and Stableswap pallets
 * - Calculates USDT-denominated volumes using bigint-only arithmetic
 * - Generates bidirectional volume rows (sell + buy for each swap)
 * - Aggregates volumes by asset and merges with price rows
 *
 * All volume calculations use bigint arithmetic to prevent floating-point errors.
 * USDT volumes are stored as Decimal128(12) strings for ClickHouse compatibility.
 */

import type { PriceMap, AssetDecimals } from '../price/types.js';
import type { PriceRow } from '../db/schema.js';
import { isSwapEvent } from '../registry/swapEvents.js';
import * as omnipool from '../types/omnipool/events.js';
import * as xyk from '../types/xyk/events.js';
import * as stableswap from '../types/stableswap/events.js';

/**
 * Unified swap event structure across all pool types
 */
export interface DecodedSwap {
  assetIn: number;
  assetOut: number;
  amountIn: bigint;
  amountOut: bigint;
}

/**
 * Event-like structure for decoding (subset of Subsquid Event)
 */
interface EventLike {
  name: string;
  block: { _runtime: any };
  args: unknown;
}

/**
 * Calculate USDT volume from native amount using bigint-only arithmetic
 *
 * Formula: (nativeAmount * price) / (10^(assetDecimals + 12))
 * - nativeAmount: e.g., 1000000000000n for 1 token with 12 decimals
 * - price: e.g., '2.000000000000' (12 decimal places as string)
 * - assetDecimals: token decimals (default 12)
 * - Output: Decimal128(12) string with 12 decimal places
 *
 * @param nativeAmount - Raw token amount in smallest unit
 * @param assetId - Asset ID for price and decimals lookup
 * @param prices - Map of asset ID to USDT price strings
 * @param decimals - Map of asset ID to decimal places
 * @returns USDT volume as Decimal128(12) string
 */
export function calculateUsdtVolume(
  nativeAmount: bigint,
  assetId: number,
  prices: PriceMap,
  decimals: AssetDecimals
): string {
  // Edge case: zero amount
  if (nativeAmount === 0n) {
    return '0.000000000000';
  }

  // Look up price
  const priceStr = prices.get(assetId);
  if (!priceStr) {
    return '0.000000000000';
  }

  // Look up decimals (default to 12)
  const assetDecimals = decimals.get(assetId) ?? 12;

  // Convert price string to bigint by removing decimal point
  // '2.000000000000' -> 2000000000000n (price with 12 decimal places)
  const priceBigInt = BigInt(priceStr.replace('.', ''));

  // Calculate USDT volume: (nativeAmount * priceBigInt) / (10^assetDecimals)
  // This gives us the volume in the same 12-decimal-place scale as the price
  // Example: (1000000000000n * 2000000000000n) / 10^12 = 2000000000000n (2.0 USDT with 12 decimals)
  const volumeBigInt = (nativeAmount * priceBigInt) / (10n ** BigInt(assetDecimals));

  // Format as Decimal128(12): split into integer and fractional parts
  const integerPart = volumeBigInt / 1000000000000n;
  const fractionalPart = volumeBigInt % 1000000000000n;

  // Pad fractional part with leading zeros to 12 digits
  const fractionalStr = fractionalPart.toString().padStart(12, '0');

  return `${integerPart}.${fractionalStr}`;
}

/**
 * Convert a decoded swap to two PriceRow entries (sell + buy volumes)
 *
 * Each swap generates exactly 2 rows:
 * 1. assetIn: native_volume_sell + usdt_volume_sell (buy volumes = 0)
 * 2. assetOut: native_volume_buy + usdt_volume_buy (sell volumes = 0)
 *
 * @param swap - Decoded swap event
 * @param blockHeight - Block height for the rows
 * @param prices - Map of asset ID to USDT price
 * @param decimals - Map of asset ID to decimal places
 * @returns Array of exactly 2 PriceRow entries
 */
export function swapToVolumeRows(
  swap: DecodedSwap,
  blockHeight: number,
  prices: PriceMap,
  decimals: AssetDecimals
): PriceRow[] {
  // Calculate USDT volumes
  const usdtVolumeSell = calculateUsdtVolume(swap.amountIn, swap.assetIn, prices, decimals);
  const usdtVolumeBuy = calculateUsdtVolume(swap.amountOut, swap.assetOut, prices, decimals);

  return [
    // assetIn: SELL volume
    {
      asset_id: swap.assetIn,
      block_height: blockHeight,
      usdt_price: '0', // Price comes from price rows, not volume rows
      native_volume_sell: swap.amountIn.toString(),
      usdt_volume_sell: usdtVolumeSell,
      native_volume_buy: '0',
      usdt_volume_buy: '0.000000000000',
    },
    // assetOut: BUY volume
    {
      asset_id: swap.assetOut,
      block_height: blockHeight,
      usdt_price: '0',
      native_volume_buy: swap.amountOut.toString(),
      usdt_volume_buy: usdtVolumeBuy,
      native_volume_sell: '0',
      usdt_volume_sell: '0.000000000000',
    },
  ];
}

/**
 * Decode a swap event using version-guarded typegen codecs
 *
 * Handles all swap events across Omnipool, XYK, and Stableswap with
 * runtime version detection via .is() and schema-specific decoding.
 *
 * Field mapping:
 * - Omnipool: direct field mapping (assetIn, assetOut, amountIn, amountOut)
 * - XYK.SellExecuted: amount -> amountIn, salePrice -> amountOut
 * - XYK.BuyExecuted: buyPrice -> amountIn, amount -> amountOut
 * - Stableswap: direct field mapping
 *
 * @param event - Event-like object with name, block, and args
 * @returns DecodedSwap or null if event is not a swap or decoding fails
 */
export function decodeSwapEvent(event: EventLike): DecodedSwap | null {
  const { name } = event;

  try {
    // Omnipool.SellExecuted
    if (name === 'Omnipool.SellExecuted') {
      // Try newest to oldest: v201 -> v170 -> v115
      if (omnipool.sellExecuted.v201.is(event)) {
        const decoded = omnipool.sellExecuted.v201.decode(event);
        return {
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.amountIn,
          amountOut: decoded.amountOut,
        };
      }
      if (omnipool.sellExecuted.v170.is(event)) {
        const decoded = omnipool.sellExecuted.v170.decode(event);
        return {
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.amountIn,
          amountOut: decoded.amountOut,
        };
      }
      if (omnipool.sellExecuted.v115.is(event)) {
        const decoded = omnipool.sellExecuted.v115.decode(event);
        return {
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.amountIn,
          amountOut: decoded.amountOut,
        };
      }
    }

    // Omnipool.BuyExecuted
    if (name === 'Omnipool.BuyExecuted') {
      // Try newest to oldest: v201 -> v170 -> v115
      if (omnipool.buyExecuted.v201.is(event)) {
        const decoded = omnipool.buyExecuted.v201.decode(event);
        return {
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.amountIn,
          amountOut: decoded.amountOut,
        };
      }
      if (omnipool.buyExecuted.v170.is(event)) {
        const decoded = omnipool.buyExecuted.v170.decode(event);
        return {
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.amountIn,
          amountOut: decoded.amountOut,
        };
      }
      if (omnipool.buyExecuted.v115.is(event)) {
        const decoded = omnipool.buyExecuted.v115.decode(event);
        return {
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.amountIn,
          amountOut: decoded.amountOut,
        };
      }
    }

    // XYK.SellExecuted
    if (name === 'XYK.SellExecuted') {
      if (xyk.sellExecuted.v183.is(event)) {
        const decoded = xyk.sellExecuted.v183.decode(event);
        return {
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.amount,      // XYK: amount -> amountIn
          amountOut: decoded.salePrice,  // XYK: salePrice -> amountOut
        };
      }
    }

    // XYK.BuyExecuted
    if (name === 'XYK.BuyExecuted') {
      if (xyk.buyExecuted.v183.is(event)) {
        const decoded = xyk.buyExecuted.v183.decode(event);
        return {
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.buyPrice,    // XYK: buyPrice -> amountIn
          amountOut: decoded.amount,     // XYK: amount -> amountOut
        };
      }
    }

    // Stableswap.SellExecuted
    if (name === 'Stableswap.SellExecuted') {
      if (stableswap.sellExecuted.v183.is(event)) {
        const decoded = stableswap.sellExecuted.v183.decode(event);
        return {
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.amountIn,
          amountOut: decoded.amountOut,
        };
      }
    }

    // Stableswap.BuyExecuted
    if (name === 'Stableswap.BuyExecuted') {
      if (stableswap.buyExecuted.v183.is(event)) {
        const decoded = stableswap.buyExecuted.v183.decode(event);
        return {
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.amountIn,
          amountOut: decoded.amountOut,
        };
      }
    }

    // Unknown event or version mismatch
    console.warn(`[extractVolume] Unable to decode swap event: ${name} (no matching version)`);
    return null;
  } catch (error) {
    console.warn(`[extractVolume] Error decoding swap event ${name}:`, error);
    return null;
  }
}

/**
 * Extract volume rows from all swap events in a block
 *
 * Filters events using swap event registry, decodes each swap,
 * and generates bidirectional volume rows.
 *
 * @param events - All events from a block
 * @param blockHeight - Block height for volume rows
 * @param prices - Map of asset ID to USDT price
 * @param decimals - Map of asset ID to decimal places
 * @returns Array of volume PriceRow entries (2 per swap)
 */
export function extractVolumeFromSwaps(
  events: Array<EventLike>,
  blockHeight: number,
  prices: PriceMap,
  decimals: AssetDecimals
): PriceRow[] {
  const volumeRows: PriceRow[] = [];

  for (const event of events) {
    // Filter to swap events only
    if (!isSwapEvent(event.name)) {
      continue;
    }

    // Decode swap event
    const swap = decodeSwapEvent(event);
    if (!swap) {
      console.warn(`[extractVolume] Skipping event ${event.name} at block ${blockHeight} (decode failed)`);
      continue;
    }

    // Generate volume rows
    const rows = swapToVolumeRows(swap, blockHeight, prices, decimals);
    volumeRows.push(...rows);
  }

  return volumeRows;
}

/**
 * Merge price rows and volume rows
 *
 * Logic:
 * 1. Aggregate volumeRows by asset_id (sum all 4 volume fields)
 * 2. For each aggregated volume entry:
 *    - If price row exists for that asset: merge volume into price row
 *    - Otherwise: add volume row as standalone
 * 3. Return all rows (price+volume merged + standalone price + standalone volume)
 *
 * Volume summing uses bigint arithmetic for native volumes and decimal string
 * arithmetic for USDT volumes (convert to bigint, sum, reformat).
 *
 * @param priceRows - Price rows from price calculation
 * @param volumeRows - Volume rows from swap events
 * @returns Merged PriceRow array
 */
export function mergePriceAndVolumeRows(
  priceRows: PriceRow[],
  volumeRows: PriceRow[]
): PriceRow[] {
  // Edge case: no volumes
  if (volumeRows.length === 0) {
    return priceRows;
  }

  // Edge case: no prices
  if (priceRows.length === 0) {
    // Still need to aggregate volumes by asset_id
    return aggregateVolumeRows(volumeRows);
  }

  // Aggregate volumes by asset_id
  const aggregatedVolumes = aggregateVolumeRows(volumeRows);

  // Create a map of aggregated volumes by asset_id for quick lookup
  const volumeMap = new Map<number, PriceRow>();
  for (const row of aggregatedVolumes) {
    volumeMap.set(row.asset_id, row);
  }

  // Process price rows first (preserves price row order)
  const result: PriceRow[] = [];
  const processedAssetIds = new Set<number>();

  for (const priceRow of priceRows) {
    const volumeRow = volumeMap.get(priceRow.asset_id);

    if (volumeRow) {
      // Merge volume into existing price row
      result.push({
        ...priceRow,
        native_volume_sell: volumeRow.native_volume_sell,
        usdt_volume_sell: volumeRow.usdt_volume_sell,
        native_volume_buy: volumeRow.native_volume_buy,
        usdt_volume_buy: volumeRow.usdt_volume_buy,
      });
      processedAssetIds.add(priceRow.asset_id);
    } else {
      // Standalone price row (no matching volume)
      result.push(priceRow);
    }
  }

  // Add standalone volume rows (no matching price)
  for (const volumeRow of aggregatedVolumes) {
    if (!processedAssetIds.has(volumeRow.asset_id)) {
      result.push(volumeRow);
    }
  }

  return result;
}

/**
 * Aggregate multiple volume rows by asset_id (sum all volume fields)
 *
 * Helper for mergePriceAndVolumeRows. Handles multiple swaps for the same
 * asset in a single block by summing volumes.
 *
 * @param volumeRows - Volume rows to aggregate
 * @returns Aggregated volume rows (one per unique asset_id)
 */
function aggregateVolumeRows(volumeRows: PriceRow[]): PriceRow[] {
  const aggregated = new Map<number, PriceRow>();

  for (const row of volumeRows) {
    const existing = aggregated.get(row.asset_id);

    if (existing) {
      // Sum volumes
      aggregated.set(row.asset_id, {
        ...existing,
        native_volume_sell: sumBigIntStrings(
          existing.native_volume_sell ?? '0',
          row.native_volume_sell ?? '0'
        ),
        usdt_volume_sell: sumDecimal128Strings(
          existing.usdt_volume_sell ?? '0.000000000000',
          row.usdt_volume_sell ?? '0.000000000000'
        ),
        native_volume_buy: sumBigIntStrings(
          existing.native_volume_buy ?? '0',
          row.native_volume_buy ?? '0'
        ),
        usdt_volume_buy: sumDecimal128Strings(
          existing.usdt_volume_buy ?? '0.000000000000',
          row.usdt_volume_buy ?? '0.000000000000'
        ),
      });
    } else {
      // First entry for this asset
      aggregated.set(row.asset_id, { ...row });
    }
  }

  return Array.from(aggregated.values());
}

/**
 * Sum two bigint strings (native volumes)
 *
 * @param a - First bigint string
 * @param b - Second bigint string
 * @returns Sum as string
 */
function sumBigIntStrings(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

/**
 * Sum two Decimal128(12) strings (USDT volumes)
 *
 * Converts to bigint by removing decimal point, sums, then reformats.
 *
 * @param a - First Decimal128(12) string
 * @param b - Second Decimal128(12) string
 * @returns Sum as Decimal128(12) string
 */
function sumDecimal128Strings(a: string, b: string): string {
  // Convert to bigint (remove decimal point)
  const aBigInt = BigInt(a.replace('.', ''));
  const bBigInt = BigInt(b.replace('.', ''));

  // Sum
  const sumBigInt = aBigInt + bBigInt;

  // Format as Decimal128(12)
  const integerPart = sumBigInt / 1000000000000n;
  const fractionalPart = sumBigInt % 1000000000000n;
  const fractionalStr = fractionalPart.toString().padStart(12, '0');

  return `${integerPart}.${fractionalStr}`;
}
