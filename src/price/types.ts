// hubReserve comes from Omnipool.Assets storage
// reserve comes from Tokens.Accounts for the Omnipool sovereign account
export interface OmnipoolAssetState {
  hubReserve: bigint;    // LRNA reserves
  reserve: bigint;       // Token reserves (from Tokens pallet)
  shares: bigint;
  protocolShares: bigint;
  cap: bigint;
  tradable: number;      // Tradability bits
}

/**
 * XYK constant product pool
 */
export interface XYKPool {
  assetA: number;
  assetB: number;
  reserveA: bigint;
  reserveB: bigint;
}

/**
 * Stableswap pool with amplification curve
 */
export interface StableswapPool {
  poolId: number;
  assets: number[];      // Asset IDs in the pool
  reserves: bigint[];    // Reserves for each asset
  amplification: bigint; // Current amplification parameter
  fee: number;          // Permill fee
  pegMultipliers?: [bigint, bigint][]; // Per-asset peg ratios [numerator, denominator]
}

/**
 * Map of asset ID to decimal places
 */
export type AssetDecimals = Map<number, number>;

/**
 * Map of asset ID to USD price (as decimal string with 12 precision)
 */
export type PriceMap = Map<number, string>;

export type EdgeKind = 'xyk' | 'stableswap' | 'atoken';

export interface GraphEdge {
  toAsset: number;
  poolId: number | null;        // null for aToken equivalences
  kind: EdgeKind;
  liquidity: bigint;            // For tie-breaking: normalized reserve sum
  computePrice: (knownPrice: bigint, precision: number) => bigint;
}

export interface QueueEntry {
  assetId: number;
  priceBigint: bigint;   // 24-decimal internal representation
  hopCount: number;       // real pool crossings (aToken edges = 0 cost)
}

export interface ResolvedPrices {
  prices: PriceMap;
  hopCounts: Map<number, number>;
  unpricedConnected: number[];
}
