export interface PriceRow {
  asset_id: number
  block_height: number
  // New writes carry their wall-clock time so OHLC materialized views do not
  // need to scan and join the complete blocks table for every insert batch.
  block_timestamp?: Date | string
  usd_price: string  // String for Decimal precision (ClickHouse returns Decimal as string)
  native_volume_buy?: string
  native_volume_sell?: string
  usd_volume_buy?: string
  usd_volume_sell?: string
  hops?: number
}

export interface TradeVolumeRow {
  asset_id: number
  block_height: number
  account: string
  native_volume_buy?: string
  native_volume_sell?: string
  usd_volume_buy?: string
  usd_volume_sell?: string
  trade_count: number
  /**
   * 1 when this row is the PASSIVE side of a peer-to-peer fill — an OTC order's
   * maker, whose resting order was hit. Its volume is the same tokens the taker's
   * row already carries, seen from the other side, so a per-account read counts it
   * (the maker really did trade) while any sum ACROSS accounts must restrict to
   * `counterparty = 0` or it counts one trade's tokens twice.
   *
   * Defaulted to 0 in ClickHouse, so every row written before OTC fills were
   * two-sided reads as a principal — which is what they were.
   */
  counterparty?: number
}

export interface BlockRow {
  block_height: number
  block_timestamp: string  // ISO datetime string
  spec_version: number
}

export interface AssetRow {
  asset_id: number
  symbol: string
  name: string
  decimals: number
  parachain_id: number | null  // XCM origin parachain ID, null for native Hydration assets
  origin_ecosystem?: string | null
  origin_chain_id?: string | null
  origin_asset_id?: string | null
  // Deployed ERC-20 contract of an `Erc20` registry asset (lowercase 0x + 40 hex),
  // '' for every other asset — what lets SQL map an EVM token address to its id.
  evm_address: string
}

export interface IndexerStateRow {
  id: string
  last_block: number
  updated_at?: string
}

export interface RuntimeUpgradeRow {
  block_height: number
  spec_version: number
  prev_spec_version: number
}

export interface RuntimeErrorNameRow {
  spec_version: number
  pallet_index: number
  error_index: number
  pallet_name: string
  error_name: string
  docs: string
}
