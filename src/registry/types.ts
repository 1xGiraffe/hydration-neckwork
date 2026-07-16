export interface AssetMetadata {
  assetId: number
  symbol: string
  name: string
  decimals: number
  assetType?: string  // 'Token', 'PoolShare', 'StableSwap', 'Erc20', etc.
  evmAddress?: string // EVM contract address for Erc20 assets (from AssetLocations AccountKey20)
  parachainId?: number  // XCM origin parachain ID, undefined for native Hydration assets
  originEcosystem?: string // metadata CDN ecosystem, e.g. polkadot or ethereum
  originChainId?: string   // parachain id or EVM chain id
  originAssetId?: string   // origin-chain asset key (EVM contract, GeneralIndex, …)
}
