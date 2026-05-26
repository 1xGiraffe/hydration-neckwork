/**
 * Volume Extraction Module
 *
 * Pure functions for extracting and aggregating trading volume from swap events:
 * - Decodes swap events from Omnipool, XYK, and Stableswap pallets
 * - Calculates USD-denominated volumes using bigint-only arithmetic
 * - Generates bidirectional volume rows (sell + buy for each swap)
 * - Aggregates volumes by asset and merges with price rows
 *
 * All volume calculations use bigint arithmetic to prevent floating-point errors.
 * USD volumes are stored as Decimal128(12) strings for ClickHouse compatibility.
 */

import type { PriceMap, AssetDecimals } from '../price/types.js';
import type { PriceRow, TradeVolumeRow } from '../db/schema.js';
import { isSwapEvent } from '../registry/swapEvents.js';
import * as omnipool from '../types/omnipool/events.js';
import * as xyk from '../types/xyk/events.js';
import * as stableswap from '../types/stableswap/events.js';
import * as broadcast from '../types/broadcast/events.js';

/**
 * Unified swap event structure across all pool types
 */
export interface DecodedSwap {
  assetIn: number;
  assetOut: number;
  amountIn: bigint;
  amountOut: bigint;
  trader?: string | null;
}

interface DecodedTradeAssetAmount {
  assetId: number;
  amount: bigint;
}

interface DecodedTrade {
  inputs: DecodedTradeAssetAmount[];
  outputs: DecodedTradeAssetAmount[];
  trader?: string | null;
}

export type AssetCanonicalizer = (assetId: number) => number;

interface CanonicalTradeLeg extends DecodedTradeAssetAmount {
  canonicalAssetId: number;
}

/**
 * Event-like structure for decoding (subset of Subsquid Event)
 */
interface EventLike {
  name: string;
  block: { _runtime: any };
  args: unknown;
}

function canonicalTradeLegs(
  trade: DecodedTrade,
  canonicalizeAssetId: AssetCanonicalizer
): { inputs: CanonicalTradeLeg[]; outputs: CanonicalTradeLeg[] } {
  return {
    inputs: trade.inputs.map(input => ({
      ...input,
      canonicalAssetId: canonicalizeAssetId(input.assetId),
    })),
    outputs: trade.outputs.map(output => ({
      ...output,
      canonicalAssetId: canonicalizeAssetId(output.assetId),
    })),
  };
}

function originalsByCanonicalAsset(legs: CanonicalTradeLeg[]): Map<number, Set<number>> {
  const result = new Map<number, Set<number>>();
  for (const leg of legs) {
    const originals = result.get(leg.canonicalAssetId) ?? new Set<number>();
    originals.add(leg.assetId);
    result.set(leg.canonicalAssetId, originals);
  }
  return result;
}

function isCanonicalSelfConversion(
  leg: CanonicalTradeLeg,
  opposingOriginalsByCanonical: Map<number, Set<number>>
): boolean {
  const originals = opposingOriginalsByCanonical.get(leg.canonicalAssetId);
  return originals ? [...originals].some(opposingAssetId => opposingAssetId !== leg.assetId) : false;
}

function hasPositivePrice(prices: PriceMap, assetId: number): boolean {
  const price = prices.get(assetId);
  return price != null && Number(price) > 0;
}

function calculateLegUsdVolume(
  leg: CanonicalTradeLeg,
  prices: PriceMap,
  decimals: AssetDecimals
): string {
  const priceAssetId = hasPositivePrice(prices, leg.assetId) ? leg.assetId : leg.canonicalAssetId;
  return calculateUsdVolume(leg.amount, priceAssetId, prices, decimals);
}

function normalizeAccount(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (value && typeof value === 'object' && 'value' in value) {
    const nested = (value as { value?: unknown }).value;
    if (typeof nested === 'string' && nested.length > 0) {
      return nested;
    }
  }
  return null;
}

/**
 * Calculate USD volume from native amount using bigint-only arithmetic
 *
 * Formula: (nativeAmount * price) / (10^(assetDecimals + 12))
 * - nativeAmount: e.g., 1000000000000n for 1 token with 12 decimals
 * - price: e.g., '2.000000000000' (12 decimal places as string)
 * - assetDecimals: token decimals
 * - Output: Decimal128(12) string with 12 decimal places
 *
 * @param nativeAmount - Raw token amount in smallest unit
 * @param assetId - Asset ID for price and decimals lookup
 * @param prices - Map of asset ID to USD price strings
 * @param decimals - Map of asset ID to decimal places
 * @returns USD volume as Decimal128(12) string
 */
export function calculateUsdVolume(
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

  const assetDecimals = decimals.get(assetId);
  if (assetDecimals === undefined) {
    return '0.000000000000';
  }

  // Convert price string to bigint by removing decimal point
  // '2.000000000000' -> 2000000000000n (price with 12 decimal places)
  const priceBigInt = BigInt(priceStr.replace('.', ''));

  // Calculate USD volume: (nativeAmount * priceBigInt) / (10^assetDecimals)
  // This gives us the volume in the same 12-decimal-place scale as the price
  // Example: (1000000000000n * 2000000000000n) / 10^12 = 2000000000000n (2.0 USD with 12 decimals)
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
 * 1. assetIn: native_volume_sell + usd_volume_sell (buy volumes = 0)
 * 2. assetOut: native_volume_buy + usd_volume_buy (sell volumes = 0)
 *
 * @param swap - Decoded swap event
 * @param blockHeight - Block height for the rows
 * @param prices - Map of asset ID to USD price
 * @param decimals - Map of asset ID to decimal places
 * @returns Array of exactly 2 PriceRow entries
 */
export function swapToVolumeRows(
  swap: DecodedSwap,
  blockHeight: number,
  prices: PriceMap,
  decimals: AssetDecimals
): PriceRow[] {
  return tradeToVolumeRows(
    {
      inputs: [{ assetId: swap.assetIn, amount: swap.amountIn }],
      outputs: [{ assetId: swap.assetOut, amount: swap.amountOut }],
    },
    blockHeight,
    prices,
    decimals
  );
}

function tradeToVolumeRows(
  trade: DecodedTrade,
  blockHeight: number,
  prices: PriceMap,
  decimals: AssetDecimals,
  canonicalizeAssetId: AssetCanonicalizer = assetId => assetId
): PriceRow[] {
  const rows: PriceRow[] = [];
  const { inputs, outputs } = canonicalTradeLegs(trade, canonicalizeAssetId);
  const outputOriginalsByCanonical = originalsByCanonicalAsset(outputs);
  const inputOriginalsByCanonical = originalsByCanonicalAsset(inputs);

  for (const input of inputs) {
    if (isCanonicalSelfConversion(input, outputOriginalsByCanonical)) {
      continue;
    }

    rows.push({
      asset_id: input.canonicalAssetId,
      block_height: blockHeight,
      usd_price: '0', // Price comes from price rows, not volume rows
      native_volume_sell: input.amount.toString(),
      usd_volume_sell: calculateLegUsdVolume(input, prices, decimals),
      native_volume_buy: '0',
      usd_volume_buy: '0.000000000000',
    });
  }

  for (const output of outputs) {
    if (isCanonicalSelfConversion(output, inputOriginalsByCanonical)) {
      continue;
    }

    rows.push({
      asset_id: output.canonicalAssetId,
      block_height: blockHeight,
      usd_price: '0',
      native_volume_buy: output.amount.toString(),
      usd_volume_buy: calculateLegUsdVolume(output, prices, decimals),
      native_volume_sell: '0',
      usd_volume_sell: '0.000000000000',
    });
  }

  return rows;
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
  const isLegacySwapName =
    name === 'Omnipool.SellExecuted' ||
    name === 'Omnipool.BuyExecuted' ||
    name === 'XYK.SellExecuted' ||
    name === 'XYK.BuyExecuted' ||
    name === 'Stableswap.SellExecuted' ||
    name === 'Stableswap.BuyExecuted';

  if (!isLegacySwapName) {
    return null;
  }

  try {
    // Omnipool.SellExecuted
    if (name === 'Omnipool.SellExecuted') {
      // Try newest to oldest: v201 -> v170 -> v115
      if (omnipool.sellExecuted.v201.is(event)) {
        const decoded = omnipool.sellExecuted.v201.decode(event);
        return {
          trader: normalizeAccount(decoded.who),
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.amountIn,
          amountOut: decoded.amountOut,
        };
      }
      if (omnipool.sellExecuted.v170.is(event)) {
        const decoded = omnipool.sellExecuted.v170.decode(event);
        return {
          trader: normalizeAccount(decoded.who),
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.amountIn,
          amountOut: decoded.amountOut,
        };
      }
      if (omnipool.sellExecuted.v115.is(event)) {
        const decoded = omnipool.sellExecuted.v115.decode(event);
        return {
          trader: normalizeAccount(decoded.who),
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
          trader: normalizeAccount(decoded.who),
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.amountIn,
          amountOut: decoded.amountOut,
        };
      }
      if (omnipool.buyExecuted.v170.is(event)) {
        const decoded = omnipool.buyExecuted.v170.decode(event);
        return {
          trader: normalizeAccount(decoded.who),
          assetIn: decoded.assetIn,
          assetOut: decoded.assetOut,
          amountIn: decoded.amountIn,
          amountOut: decoded.amountOut,
        };
      }
      if (omnipool.buyExecuted.v115.is(event)) {
        const decoded = omnipool.buyExecuted.v115.decode(event);
        return {
          trader: normalizeAccount(decoded.who),
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
          trader: normalizeAccount(decoded.who),
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
          trader: normalizeAccount(decoded.who),
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
          trader: normalizeAccount(decoded.who),
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
          trader: normalizeAccount(decoded.who),
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

function decodeTradeEvent(event: EventLike): DecodedTrade | null {
  const legacySwap = decodeSwapEvent(event);
  if (legacySwap) {
    return {
      trader: legacySwap.trader,
      inputs: [{ assetId: legacySwap.assetIn, amount: legacySwap.amountIn }],
      outputs: [{ assetId: legacySwap.assetOut, amount: legacySwap.amountOut }],
    };
  }

  const { name } = event;

  try {
    if (name === 'Broadcast.Swapped' && broadcast.swapped.v282.is(event)) {
      const decoded = broadcast.swapped.v282.decode(event);
      return decorateLegacyBroadcastTrade({
        eventName: name,
        trader: normalizeAccount(decoded.swapper),
        fillerType: decoded.fillerType.__kind,
        operation: decoded.operation.__kind,
        inputs: decoded.inputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
        outputs: decoded.outputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
      });
    }

    if (name === 'Broadcast.Swapped2' && broadcast.swapped2.v305.is(event)) {
      const decoded = broadcast.swapped2.v305.decode(event);
      return {
        trader: normalizeAccount(decoded.swapper),
        inputs: decoded.inputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
        outputs: decoded.outputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
      };
    }

    if (name === 'Broadcast.Swapped3') {
      if (broadcast.swapped3.v323.is(event)) {
        const decoded = broadcast.swapped3.v323.decode(event);
        return {
          trader: normalizeAccount(decoded.swapper),
          inputs: decoded.inputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
          outputs: decoded.outputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
        };
      }

      if (broadcast.swapped3.v313.is(event)) {
        const decoded = broadcast.swapped3.v313.decode(event);
        return {
          trader: normalizeAccount(decoded.swapper),
          inputs: decoded.inputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
          outputs: decoded.outputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
        };
      }
    }

    console.warn(`[extractVolume] Unable to decode swap event: ${name} (no matching version)`);
    return null;
  } catch (error) {
    console.warn(`[extractVolume] Error decoding swap event ${name}:`, error);
    return null;
  }
}

function decorateLegacyBroadcastTrade({
  eventName,
  trader,
  fillerType,
  operation,
  inputs,
  outputs,
}: {
  eventName: string;
  trader?: string | null;
  fillerType: string;
  operation: string;
  inputs: DecodedTradeAssetAmount[];
  outputs: DecodedTradeAssetAmount[];
}): DecodedTrade {
  // Broadcast.Swapped had inverted exact-out XYK/LBP amounts. Swapped2+ fixed it.
  if (
    eventName === 'Broadcast.Swapped' &&
    operation === 'ExactOut' &&
    (fillerType === 'XYK' || fillerType === 'LBP') &&
    inputs.length === 1 &&
    outputs.length === 1
  ) {
    return {
      trader,
      inputs: [{ assetId: inputs[0].assetId, amount: outputs[0].amount }],
      outputs: [{ assetId: outputs[0].assetId, amount: inputs[0].amount }],
    };
  }

  return { trader, inputs, outputs };
}

/**
 * Extract volume rows from all swap events in a block
 *
 * Filters events using swap event registry, decodes each swap,
 * and generates bidirectional volume rows.
 *
 * @param events - All events from a block
 * @param blockHeight - Block height for volume rows
 * @param prices - Map of asset ID to USD price
 * @param decimals - Map of asset ID to decimal places
 * @returns Array of volume PriceRow entries (2 per swap)
 */
export function extractVolumeFromSwaps(
  events: Array<EventLike>,
  blockHeight: number,
  specVersion: number,
  prices: PriceMap,
  decimals: AssetDecimals,
  canonicalizeAssetId: AssetCanonicalizer = assetId => assetId
): PriceRow[] {
  const volumeRows: PriceRow[] = [];

  for (const event of events) {
    // Filter to swap events only
    if (!isSwapEvent(event.name, specVersion)) {
      continue;
    }

    // Decode swap event
    const trade = decodeTradeEvent(event);
    if (!trade) {
      console.warn(`[extractVolume] Skipping event ${event.name} at block ${blockHeight} (decode failed)`);
      continue;
    }

    // Generate volume rows from all input and output asset legs
    const rows = tradeToVolumeRows(trade, blockHeight, prices, decimals, canonicalizeAssetId);
    volumeRows.push(...rows);
  }

  return volumeRows;
}

function tradeToAccountVolumeRows(
  trade: DecodedTrade,
  blockHeight: number,
  prices: PriceMap,
  decimals: AssetDecimals,
  canonicalizeAssetId: AssetCanonicalizer = assetId => assetId
): TradeVolumeRow[] {
  const account = normalizeAccount(trade.trader);
  if (!account) {
    return [];
  }

  const rowsByAsset = new Map<number, TradeVolumeRow>();
  const { inputs, outputs } = canonicalTradeLegs(trade, canonicalizeAssetId);
  const outputOriginalsByCanonical = originalsByCanonicalAsset(outputs);
  const inputOriginalsByCanonical = originalsByCanonicalAsset(inputs);

  const rowForAsset = (assetId: number): TradeVolumeRow => {
    let row = rowsByAsset.get(assetId);
    if (!row) {
      row = {
        asset_id: assetId,
        block_height: blockHeight,
        account,
        native_volume_buy: '0',
        native_volume_sell: '0',
        usd_volume_buy: '0.000000000000',
        usd_volume_sell: '0.000000000000',
        trade_count: 1,
      };
      rowsByAsset.set(assetId, row);
    }
    return row;
  };

  for (const input of inputs) {
    if (isCanonicalSelfConversion(input, outputOriginalsByCanonical)) {
      continue;
    }

    const row = rowForAsset(input.canonicalAssetId);
    row.native_volume_sell = sumBigIntStrings(row.native_volume_sell ?? '0', input.amount.toString());
    row.usd_volume_sell = sumDecimal128Strings(
      row.usd_volume_sell ?? '0.000000000000',
      calculateLegUsdVolume(input, prices, decimals)
    );
  }

  for (const output of outputs) {
    if (isCanonicalSelfConversion(output, inputOriginalsByCanonical)) {
      continue;
    }

    const row = rowForAsset(output.canonicalAssetId);
    row.native_volume_buy = sumBigIntStrings(row.native_volume_buy ?? '0', output.amount.toString());
    row.usd_volume_buy = sumDecimal128Strings(
      row.usd_volume_buy ?? '0.000000000000',
      calculateLegUsdVolume(output, prices, decimals)
    );
  }

  return Array.from(rowsByAsset.values());
}

/**
 * Extract per-account trade volume from all swap events in a block.
 *
 * This mirrors extractVolumeFromSwaps but preserves the trader account so
 * candles can expose Omniwatch-style top trader and contributor details.
 */
export function extractTradeVolumeFromSwaps(
  events: Array<EventLike>,
  blockHeight: number,
  specVersion: number,
  prices: PriceMap,
  decimals: AssetDecimals,
  canonicalizeAssetId: AssetCanonicalizer = assetId => assetId
): TradeVolumeRow[] {
  const tradeRows: TradeVolumeRow[] = [];

  for (const event of events) {
    if (!isSwapEvent(event.name, specVersion)) {
      continue;
    }

    const trade = decodeTradeEvent(event);
    if (!trade) {
      continue;
    }

    tradeRows.push(...tradeToAccountVolumeRows(trade, blockHeight, prices, decimals, canonicalizeAssetId));
  }

  return aggregateTradeVolumeRows(tradeRows);
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
 * arithmetic for USD volumes (convert to bigint, sum, reformat).
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
        usd_volume_sell: volumeRow.usd_volume_sell,
        native_volume_buy: volumeRow.native_volume_buy,
        usd_volume_buy: volumeRow.usd_volume_buy,
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
        usd_volume_sell: sumDecimal128Strings(
          existing.usd_volume_sell ?? '0.000000000000',
          row.usd_volume_sell ?? '0.000000000000'
        ),
        native_volume_buy: sumBigIntStrings(
          existing.native_volume_buy ?? '0',
          row.native_volume_buy ?? '0'
        ),
        usd_volume_buy: sumDecimal128Strings(
          existing.usd_volume_buy ?? '0.000000000000',
          row.usd_volume_buy ?? '0.000000000000'
        ),
      });
    } else {
      // First entry for this asset
      aggregated.set(row.asset_id, { ...row });
    }
  }

  return Array.from(aggregated.values());
}

function aggregateTradeVolumeRows(volumeRows: TradeVolumeRow[]): TradeVolumeRow[] {
  const aggregated = new Map<string, TradeVolumeRow>();

  for (const row of volumeRows) {
    const key = `${row.asset_id}:${row.block_height}:${row.account}`;
    const existing = aggregated.get(key);

    if (existing) {
      aggregated.set(key, {
        ...existing,
        native_volume_sell: sumBigIntStrings(
          existing.native_volume_sell ?? '0',
          row.native_volume_sell ?? '0'
        ),
        usd_volume_sell: sumDecimal128Strings(
          existing.usd_volume_sell ?? '0.000000000000',
          row.usd_volume_sell ?? '0.000000000000'
        ),
        native_volume_buy: sumBigIntStrings(
          existing.native_volume_buy ?? '0',
          row.native_volume_buy ?? '0'
        ),
        usd_volume_buy: sumDecimal128Strings(
          existing.usd_volume_buy ?? '0.000000000000',
          row.usd_volume_buy ?? '0.000000000000'
        ),
        trade_count: existing.trade_count + row.trade_count,
      });
    } else {
      aggregated.set(key, { ...row });
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
 * Sum two Decimal128(12) strings (USD volumes)
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
