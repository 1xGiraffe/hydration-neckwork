export interface AssetMetadata {
  assetId: number
  symbol: string
  name: string
  decimals: number
  assetType?: string  // 'Token', 'PoolShare', 'StableSwap', 'Erc20', etc.
  evmAddress?: string // EVM contract address for Erc20 assets (from AssetLocations AccountKey20)
  parachainId?: number  // XCM origin parachain ID, undefined for native Hydration assets
}
