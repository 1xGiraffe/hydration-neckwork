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
import { foldOmnipoolHubHops } from './hubHops.js';
import { OTC_FILLER_KIND, OTC_FILL_EVENT_NAMES, otcSides } from './otcCounterparty.js';
import {
  ICE_SETTLEMENT_TRANSFER_EVENTS,
  icePotSettlementOwner,
  isIcePotSwapper,
  isUnattributableVolumePot,
} from './icePotSettlement.js';
import { aggregateTradeVolumeRows, sumBigIntStrings, sumDecimal128Strings, sumVolumeFields } from './volumeMath.js';
import {
  EVM_LOG_EVENT_NAME,
  decodeUniswapV3Log,
  evmLogOf,
  routedUniswapV3Extrinsics,
  uniswapV3SwapTrade,
  type UniswapV3PoolIndex,
} from '../price/uniswapV3.js';

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
  /** `fillerType.__kind` of a Broadcast trade; absent on a legacy pallet event. */
  filler?: string;
  /**
   * The Broadcast `filler` ACCOUNT (distinct from `filler`, which is the venue
   * kind). Only an OTC fill needs it: there the filler is the human on the other
   * side of the trade rather than a pool, and it is one of the two accounts
   * resolveOtcCounterparties chooses between.
   */
  fillerAccount?: string | null;
  /**
   * The second account of a peer-to-peer fill, holding the MIRROR of `inputs`/
   * `outputs` — it received what the trade took in and gave up what it put out.
   * Set only for OTC, where both sides are real accounts; a pool venue has no
   * counterparty to book. See resolveOtcCounterparties.
   */
  counterparty?: string | null;
}

export type AssetCanonicalizer = (assetId: number) => number;

export interface ExtractVolumeOptions {
  /**
   * Concentrated-liquidity pools whose tokens resolved to asset ids, by pool
   * address. With one or more, a pool's `Swap` log in `EVM.Log` is booked as a
   * trade unless the same extrinsic also carries a `Broadcast.Swapped3` from the
   * UniswapV3 venue — the router-routed case, which is already counted.
   */
  uniswapV3Pools?: UniswapV3PoolIndex;
}

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
  /** Set for events in the ApplyExtrinsic phase when the processor requests the field. */
  extrinsicIndex?: number;
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

function broadcastTrade(decoded: {
  swapper: unknown;
  filler?: unknown;
  fillerType: { __kind: string };
  inputs: Array<{ asset: number; amount: bigint }>;
  outputs: Array<{ asset: number; amount: bigint }>;
}): DecodedTrade {
  return {
    trader: normalizeAccount(decoded.swapper),
    filler: decoded.fillerType.__kind,
    fillerAccount: normalizeAccount(decoded.filler),
    inputs: decoded.inputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
    outputs: decoded.outputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
  };
}

const OTC_FILL_EVENTS = new Set<string>(OTC_FILL_EVENT_NAMES);
const ICE_TRANSFER_EVENTS = new Set<string>(ICE_SETTLEMENT_TRANSFER_EVENTS);

/**
 * The pot's own transfer legs in each of `extrinsics`, which is where an ICE
 * settlement names the intent owner (see icePotSettlement.ts). Only called for a
 * block that actually settled an intent, so an ordinary block decodes no
 * transfers it would otherwise have left alone.
 */
function icePotTransferLegs(
  events: Array<EventLike>,
  extrinsics: Set<number>,
): Map<number, Array<{ from: string | null; to: string | null }>> {
  const byExtrinsic = new Map<number, Array<{ from: string | null; to: string | null }>>();
  for (const event of events) {
    const extrinsicIndex = event.extrinsicIndex;
    if (extrinsicIndex == null || !extrinsics.has(extrinsicIndex)) continue;
    if (!ICE_TRANSFER_EVENTS.has(event.name)) continue;
    const runtime = event.block?._runtime;
    if (typeof runtime?.decodeJsonEventRecordArguments !== 'function') continue;
    let args: Record<string, unknown> | null;
    try {
      args = runtime.decodeJsonEventRecordArguments(event) as Record<string, unknown> | null;
    } catch {
      continue;
    }
    const from = normalizeAccount(args?.from);
    const to = normalizeAccount(args?.to);
    if (!from || !to) continue;
    const legs = byExtrinsic.get(extrinsicIndex);
    if (legs) legs.push({ from, to });
    else byExtrinsic.set(extrinsicIndex, [{ from, to }]);
  }
  return byExtrinsic;
}

/**
 * Book an ICE solution's route legs to the intent owner the settlement names,
 * leaving them on the pot when the extrinsic names no single owner.
 */
function resolveIceSettlementOwners(
  slots: Array<{ trade: DecodedTrade; extrinsicIndex?: number; fromPoolLog: boolean }>,
  events: Array<EventLike>,
): void {
  const settled = new Set<number>();
  for (const slot of slots) {
    if (slot.extrinsicIndex != null && isIcePotSwapper(slot.trade.trader)) settled.add(slot.extrinsicIndex);
  }
  if (settled.size === 0) return;
  const legsByExtrinsic = icePotTransferLegs(events, settled);
  for (const slot of slots) {
    if (slot.extrinsicIndex == null || !isIcePotSwapper(slot.trade.trader)) continue;
    const owner = icePotSettlementOwner(legsByExtrinsic.get(slot.extrinsicIndex) ?? []);
    if (owner) slot.trade = { ...slot.trade, trader: owner };
  }
}

/**
 * Put the two accounts of an OTC fill on their true sides — see otcSides in
 * ./otcCounterparty.ts for why the event cannot be booked as it stands.
 *
 * `previous` is the event before this one, which is where the pallet's fill event
 * always sits; the caller walks the block in order, so no index arithmetic is
 * needed. Returns the trade unchanged when the pairing cannot be established, so
 * an unresolvable fill keeps its old booking rather than a guess.
 */
function resolveOtcCounterparties(trade: DecodedTrade, previous: EventLike | undefined): DecodedTrade {
  if (trade.filler !== OTC_FILLER_KIND || !previous || !OTC_FILL_EVENTS.has(previous.name)) return trade;
  const runtime = previous.block?._runtime;
  if (typeof runtime?.decodeJsonEventRecordArguments !== 'function') return trade;
  let taker: string | null = null;
  try {
    const args = runtime.decodeJsonEventRecordArguments(previous) as Record<string, unknown> | null;
    taker = normalizeAccount(args?.who);
  } catch {
    return trade;
  }
  const sides = otcSides(trade.trader, trade.fillerAccount, taker);
  if (!sides) return trade;
  return { ...trade, trader: sides.trader, counterparty: sides.counterparty };
}

function priceToDecimal128(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,12}))?$/.exec(value);
  if (match == null) {
    throw new Error(`Invalid non-negative USD price: ${value}`);
  }

  return BigInt(`${match[1]}${(match[2] ?? '').padEnd(12, '0')}`);
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

  // Normalize both compact and fixed-width prices to Decimal128(12).
  const priceBigInt = priceToDecimal128(priceStr);

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
function decodeSwapEvent(event: EventLike): DecodedSwap | null {
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

// Typegen arms are structural pins on the block's runtime metadata: one new enum
// variant anywhere in the event makes every arm return false and, before runtime
// 443, the swap was silently dropped from volume. When no arm matches, decode the
// JSON form the block's own metadata produces (the same path the raw indexer's
// args_json comes from), validate the swap shape, and warn once per spec version
// so the missing arm gets added instead of the loss going unnoticed.
const jsonFallbackWarned = new Set<string>();

function jsonBroadcastTrade(event: EventLike): DecodedTrade | null {
  const runtime = event.block._runtime;
  if (typeof runtime?.decodeJsonEventRecordArguments !== 'function') return null;
  const args = runtime.decodeJsonEventRecordArguments(event) as Record<string, unknown> | null;
  if (!args || typeof args !== 'object') return null;
  const fillerKind = (args.fillerType as { __kind?: unknown } | undefined)?.__kind;
  if (typeof args.swapper !== 'string' || typeof fillerKind !== 'string') return null;
  const legs = (value: unknown): Array<{ asset: number; amount: bigint }> | null => {
    if (!Array.isArray(value)) return null;
    const out: Array<{ asset: number; amount: bigint }> = [];
    for (const item of value) {
      const asset = (item as { asset?: unknown })?.asset;
      const amount = (item as { amount?: unknown })?.amount;
      if (typeof asset !== 'number') return null;
      if (typeof amount !== 'string' && typeof amount !== 'number' && typeof amount !== 'bigint') return null;
      out.push({ asset, amount: BigInt(amount) });
    }
    return out;
  };
  const inputs = legs(args.inputs);
  const outputs = legs(args.outputs);
  if (!inputs || !outputs) return null;
  const specVersion = runtime.specVersion ?? 'unknown';
  const key = `${event.name}@${specVersion}`;
  if (!jsonFallbackWarned.has(key)) {
    jsonFallbackWarned.add(key);
    console.warn(`[extractVolume] ${event.name} matched no typegen arm at spec ${specVersion}; decoded from block metadata instead — add a typegen arm for this runtime`);
  }
  return broadcastTrade({ swapper: args.swapper, filler: args.filler, fillerType: { __kind: fillerKind }, inputs, outputs });
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
        fillerAccount: normalizeAccount(decoded.filler),
        fillerType: decoded.fillerType.__kind,
        operation: decoded.operation.__kind,
        inputs: decoded.inputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
        outputs: decoded.outputs.map(({ asset, amount }) => ({ assetId: asset, amount })),
      });
    }

    if (name === 'Broadcast.Swapped2' && broadcast.swapped2.v305.is(event)) {
      return broadcastTrade(broadcast.swapped2.v305.decode(event));
    }

    if (name === 'Broadcast.Swapped3') {
      if (broadcast.swapped3.v443.is(event)) {
        return broadcastTrade(broadcast.swapped3.v443.decode(event));
      }

      if (broadcast.swapped3.v323.is(event)) {
        return broadcastTrade(broadcast.swapped3.v323.decode(event));
      }

      if (broadcast.swapped3.v313.is(event)) {
        return broadcastTrade(broadcast.swapped3.v313.decode(event));
      }
    }

    if (name.startsWith('Broadcast.Swapped')) {
      const fallback = jsonBroadcastTrade(event);
      if (fallback) return fallback;
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
  fillerAccount,
  fillerType,
  operation,
  inputs,
  outputs,
}: {
  eventName: string;
  trader?: string | null;
  fillerAccount?: string | null;
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
      filler: fillerType,
      fillerAccount,
      inputs: [{ assetId: inputs[0].assetId, amount: outputs[0].amount }],
      outputs: [{ assetId: outputs[0].assetId, amount: inputs[0].amount }],
    };
  }

  return { trader, filler: fillerType, fillerAccount, inputs, outputs };
}

/**
 * One block's swap trades, in event order, with each routed Omnipool trade's
 * two hub hops folded back into the one trade the pallet executed (see
 * hubHops.ts). Both volume extractors read trades through here so the hub asset
 * is booked the same way for candles and for per-account volume.
 */
function decodeBlockTrades(
  events: Array<EventLike>,
  blockHeight: number,
  specVersion: number,
  options: ExtractVolumeOptions = {},
): DecodedTrade[] {
  const uniswapV3Pools = options.uniswapV3Pools;
  const readPoolLogs = uniswapV3Pools != null && uniswapV3Pools.size > 0;
  // Event order is kept; a pool's Swap log is only decided once the whole block
  // is read, because the Broadcast fill of a routed hop follows the log in its
  // extrinsic.
  const slots: Array<{ trade: DecodedTrade; extrinsicIndex?: number; fromPoolLog: boolean }> = [];
  // The event before the one being read. An OTC fill's Broadcast event needs it:
  // the pallet's own fill event sits immediately ahead of it and is the only thing
  // that names the taker (see resolveOtcCounterparties). Tracked over EVERY event,
  // not just swaps — the OTC event is not itself a swap event.
  let previous: EventLike | undefined;
  for (const event of events) {
    const priorEvent = previous;
    previous = event;
    if (isSwapEvent(event.name, specVersion)) {
      const decoded = decodeTradeEvent(event);
      if (!decoded) {
        console.warn(`[extractVolume] Skipping event ${event.name} at block ${blockHeight} (decode failed)`);
        continue;
      }
      const trade = resolveOtcCounterparties(decoded, priorEvent);
      slots.push({ trade, extrinsicIndex: event.extrinsicIndex, fromPoolLog: false });
      continue;
    }
    if (!readPoolLogs || event.name !== EVM_LOG_EVENT_NAME) continue;
    const log = evmLogOf(event.args);
    const decoded = log ? decodeUniswapV3Log(log) : null;
    if (decoded?.kind !== 'swap') continue;
    const swap = uniswapV3SwapTrade(decoded, uniswapV3Pools);
    if (!swap) continue;
    slots.push({
      trade: { trader: swap.account, filler: swap.filler, inputs: swap.inputs, outputs: swap.outputs },
      extrinsicIndex: event.extrinsicIndex,
      fromPoolLog: true,
    });
  }

  resolveIceSettlementOwners(slots, events);

  const routedExtrinsics = routedUniswapV3Extrinsics(
    slots.filter(slot => !slot.fromPoolLog).map(slot => ({ filler: slot.trade.filler, extrinsicIndex: slot.extrinsicIndex })),
  );
  const trades = slots
    .filter(slot => !slot.fromPoolLog || slot.extrinsicIndex == null || !routedExtrinsics.has(slot.extrinsicIndex))
    .map(slot => slot.trade);
  return foldOmnipoolHubHops(trades, trade => trade.trader);
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
  canonicalizeAssetId: AssetCanonicalizer = assetId => assetId,
  options: ExtractVolumeOptions = {},
): PriceRow[] {
  const volumeRows: PriceRow[] = [];

  for (const trade of decodeBlockTrades(events, blockHeight, specVersion, options)) {
    // Generate volume rows from all input and output asset legs
    const rows = tradeToVolumeRows(trade, blockHeight, prices, decimals, canonicalizeAssetId);
    volumeRows.push(...rows);
  }

  return volumeRows;
}

/**
 * One account's side of a trade. `mirrored` books the legs the other way round —
 * inputs bought, outputs sold — which is what the passive side of a peer-to-peer
 * fill actually did, and flags the row so cross-account sums count the traded
 * tokens once (see resolveOtcCounterparties and TradeVolumeRow.counterparty).
 */
function accountSideVolumeRows(
  trade: DecodedTrade,
  account: string,
  mirrored: boolean,
  blockHeight: number,
  prices: PriceMap,
  decimals: AssetDecimals,
  canonicalizeAssetId: AssetCanonicalizer
): TradeVolumeRow[] {
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
        counterparty: mirrored ? 1 : 0,
      };
      rowsByAsset.set(assetId, row);
    }
    return row;
  };

  // A mirrored side sold what the trade output and bought what it took in.
  const addSell = (row: TradeVolumeRow, leg: CanonicalTradeLeg) => {
    row.native_volume_sell = sumBigIntStrings(row.native_volume_sell ?? '0', leg.amount.toString());
    row.usd_volume_sell = sumDecimal128Strings(
      row.usd_volume_sell ?? '0.000000000000',
      calculateLegUsdVolume(leg, prices, decimals)
    );
  };
  const addBuy = (row: TradeVolumeRow, leg: CanonicalTradeLeg) => {
    row.native_volume_buy = sumBigIntStrings(row.native_volume_buy ?? '0', leg.amount.toString());
    row.usd_volume_buy = sumDecimal128Strings(
      row.usd_volume_buy ?? '0.000000000000',
      calculateLegUsdVolume(leg, prices, decimals)
    );
  };

  for (const input of inputs) {
    if (isCanonicalSelfConversion(input, outputOriginalsByCanonical)) {
      continue;
    }

    const row = rowForAsset(input.canonicalAssetId);
    (mirrored ? addBuy : addSell)(row, input);
  }

  for (const output of outputs) {
    if (isCanonicalSelfConversion(output, inputOriginalsByCanonical)) {
      continue;
    }

    const row = rowForAsset(output.canonicalAssetId);
    (mirrored ? addSell : addBuy)(row, output);
  }

  return Array.from(rowsByAsset.values());
}

function tradeToAccountVolumeRows(
  trade: DecodedTrade,
  blockHeight: number,
  prices: PriceMap,
  decimals: AssetDecimals,
  canonicalizeAssetId: AssetCanonicalizer = assetId => assetId
): TradeVolumeRow[] {
  const account = normalizeAccount(trade.trader);
  const rows: TradeVolumeRow[] = [];
  // A pot that swaps as machinery with nobody behind it (the fee processor
  // converting collected fees) gets no per-account row: it is not a trader, and
  // there is no account its volume could be handed to. The candle's own volume
  // still counts the swap — only the per-account breakdown drops it.
  if (account && !isUnattributableVolumePot(account)) {
    rows.push(...accountSideVolumeRows(trade, account, false, blockHeight, prices, decimals, canonicalizeAssetId));
  }
  // The passive side of a peer-to-peer fill traded too, so it is booked with the
  // legs mirrored. Only OTC sets this; a pool venue has no account to credit.
  const counterparty = normalizeAccount(trade.counterparty);
  if (counterparty && counterparty !== account && !isUnattributableVolumePot(counterparty)) {
    rows.push(...accountSideVolumeRows(trade, counterparty, true, blockHeight, prices, decimals, canonicalizeAssetId));
  }
  return rows;
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
  canonicalizeAssetId: AssetCanonicalizer = assetId => assetId,
  options: ExtractVolumeOptions = {},
): TradeVolumeRow[] {
  const tradeRows: TradeVolumeRow[] = [];

  for (const trade of decodeBlockTrades(events, blockHeight, specVersion, options)) {
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
      aggregated.set(row.asset_id, {
        ...existing,
        ...sumVolumeFields(existing, row),
      });
    } else {
      // First entry for this asset
      aggregated.set(row.asset_id, { ...row });
    }
  }

  return Array.from(aggregated.values());
}
