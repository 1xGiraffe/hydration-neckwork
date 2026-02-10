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
}

/**
 * Map of asset ID to decimal places
 */
export type AssetDecimals = Map<number, number>;

/**
 * Map of asset ID to USDT price (as decimal string with 12 precision)
 */
export type PriceMap = Map<number, string>;
