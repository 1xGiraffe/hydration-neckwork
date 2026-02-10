export interface AssetMetadata {
  assetId: number
  symbol: string
  name: string
  decimals: number
  assetType?: string  // 'Token', 'PoolShare', 'StableSwap', etc.
}
