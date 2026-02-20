/**
 * Swap Event Registry Catalog
 *
 * Catalogs all swap events across Omnipool, XYK, and Stableswap pallets with:
 * - Full qualified event names
 * - Pallet identification
 * - First-appearance block heights
 * - Schema-change version tracking
 * - Event classification (swap/liquidity/lifecycle)
 * - Direct codec references for runtime consumption
 *
 * Generated from Subsquid typegen output and Hydration metadata.
 * Consumed directly by the indexer at runtime.
 */

import * as omnipool from '../types/omnipool/events'
import * as xyk from '../types/xyk/events'
import * as stableswap from '../types/stableswap/events'

/**
 * Schema version with first-appearance block height
 */
export interface SwapEventVersion {
  /** Runtime spec version where this schema was introduced */
  specVersion: number
  /** Block height where this spec version first appeared */
  firstBlock: number
}

/**
 * Complete swap event catalog entry
 */
export interface SwapEventEntry {
  /** Full qualified event name, e.g. 'Omnipool.SellExecuted' */
  name: string
  /** Pallet that emits this event */
  pallet: 'Omnipool' | 'XYK' | 'Stableswap'
  /** Block height where this event first appeared */
  firstBlock: number
  /** Schema-change versions with first-appearance blocks */
  versions: SwapEventVersion[]
  /** Typegen-generated event object with .vXXX.is() and .vXXX.decode() methods */
  codec: Record<string, unknown>
}

/**
 * Event classification categories
 */
export enum EventCategory {
  SWAP = 'SWAP',
  LIQUIDITY = 'LIQUIDITY',
  LIFECYCLE = 'LIFECYCLE',
}

/**
 * Omnipool swap events
 *
 * First appeared in v115 (block 1475996) when Omnipool pallet was introduced.
 * Schema changes at v170 (fee tracking) and v201 (hub amount tracking).
 */
export const OMNIPOOL_SWAP_EVENTS: SwapEventEntry[] = [
  {
    name: 'Omnipool.SellExecuted',
    pallet: 'Omnipool',
    firstBlock: 1475996,
    versions: [
      { specVersion: 115, firstBlock: 1475996 },
      { specVersion: 170, firstBlock: 3112600 },
      { specVersion: 201, firstBlock: 4221778 },
    ],
    codec: omnipool.sellExecuted,
  },
  {
    name: 'Omnipool.BuyExecuted',
    pallet: 'Omnipool',
    firstBlock: 1475996,
    versions: [
      { specVersion: 115, firstBlock: 1475996 },
      { specVersion: 170, firstBlock: 3112600 },
      { specVersion: 201, firstBlock: 4221778 },
    ],
    codec: omnipool.buyExecuted,
  },
]

/**
 * XYK swap events
 *
 * First appeared in v183 (block 3632973) when XYK pallet was upgraded.
 * No schema changes detected by typegen after initial version.
 */
export const XYK_SWAP_EVENTS: SwapEventEntry[] = [
  {
    name: 'XYK.SellExecuted',
    pallet: 'XYK',
    firstBlock: 3632973,
    versions: [
      { specVersion: 183, firstBlock: 3632973 },
    ],
    codec: xyk.sellExecuted,
  },
  {
    name: 'XYK.BuyExecuted',
    pallet: 'XYK',
    firstBlock: 3632973,
    versions: [
      { specVersion: 183, firstBlock: 3632973 },
    ],
    codec: xyk.buyExecuted,
  },
]

/**
 * Stableswap swap events
 *
 * First appeared in v183 (block 3632973) when Stableswap pallet was introduced.
 * No schema changes detected by typegen after initial version.
 */
export const STABLESWAP_SWAP_EVENTS: SwapEventEntry[] = [
  {
    name: 'Stableswap.SellExecuted',
    pallet: 'Stableswap',
    firstBlock: 3632973,
    versions: [
      { specVersion: 183, firstBlock: 3632973 },
    ],
    codec: stableswap.sellExecuted,
  },
  {
    name: 'Stableswap.BuyExecuted',
    pallet: 'Stableswap',
    firstBlock: 3632973,
    versions: [
      { specVersion: 183, firstBlock: 3632973 },
    ],
    codec: stableswap.buyExecuted,
  },
]

/**
 * Unified swap event catalog across all pool types
 *
 * Total: 6 swap events (2 per pool type × 3 pool types)
 * - Omnipool: SellExecuted, BuyExecuted (3 schema versions)
 * - XYK: SellExecuted, BuyExecuted (1 schema version)
 * - Stableswap: SellExecuted, BuyExecuted (1 schema version)
 */
export const SWAP_EVENT_CATALOG: SwapEventEntry[] = [
  ...OMNIPOOL_SWAP_EVENTS,
  ...XYK_SWAP_EVENTS,
  ...STABLESWAP_SWAP_EVENTS,
]

/**
 * Event classification map
 *
 * Distinguishes swap events from liquidity operations and pool lifecycle events
 * across all three pool pallets. This enables filtering and categorization at
 * runtime without hardcoding event names in the indexer.
 */
export const EVENT_CLASSIFICATION: Record<string, EventCategory> = {
  // Omnipool swap events
  'Omnipool.SellExecuted': EventCategory.SWAP,
  'Omnipool.BuyExecuted': EventCategory.SWAP,

  // Omnipool lifecycle events
  'Omnipool.TokenAdded': EventCategory.LIFECYCLE,
  'Omnipool.TokenRemoved': EventCategory.LIFECYCLE,

  // XYK swap events
  'XYK.SellExecuted': EventCategory.SWAP,
  'XYK.BuyExecuted': EventCategory.SWAP,

  // XYK lifecycle events
  'XYK.PoolCreated': EventCategory.LIFECYCLE,
  'XYK.PoolDestroyed': EventCategory.LIFECYCLE,

  // Stableswap swap events
  'Stableswap.SellExecuted': EventCategory.SWAP,
  'Stableswap.BuyExecuted': EventCategory.SWAP,

  // Stableswap lifecycle and liquidity events
  'Stableswap.PoolCreated': EventCategory.LIFECYCLE,
  'Stableswap.LiquidityAdded': EventCategory.LIQUIDITY,
}

/**
 * Check if an event name represents a swap event
 *
 * @param eventName - Full qualified event name (e.g., 'Omnipool.SellExecuted')
 * @returns True if the event is classified as a swap event
 *
 * @example
 * isSwapEvent('Omnipool.SellExecuted') // true
 * isSwapEvent('XYK.PoolCreated') // false
 * isSwapEvent('Stableswap.LiquidityAdded') // false
 */
export function isSwapEvent(eventName: string): boolean {
  return EVENT_CLASSIFICATION[eventName] === EventCategory.SWAP
}
