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
 * A concentrated-liquidity (Uniswap v3) pool flattened to the constant-product
 * pool tangent to its curve at the current price: reserveA/reserveB are the
 * VIRTUAL reserves x = L·2^96/√P and y = L·√P/2^96 in raw token units (assetA =
 * token0, assetB = token1), so the graph prices it exactly like an XYK pool
 * whose depth is the in-range liquidity.
 */
export interface UniswapV3PoolEdge extends XYKPool {
  poolAddress: string;
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
  totalIssuance?: bigint; // LP share issuance, used by package math for spot pricing
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

export type EdgeKind = 'xyk' | 'stableswap' | 'atoken' | 'uniswapv3';

export interface GraphEdge {
  toAsset: number;
  poolId: number | null;        // null for aToken equivalences
  kind: EdgeKind;
  liquidity: bigint;            // For tie-breaking: normalized reserve sum
  computePrice: (knownPrice: bigint, precision: number) => bigint;
  computeLiquidityUsd?: (knownPrice: bigint, computedPrice: bigint) => bigint;
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
