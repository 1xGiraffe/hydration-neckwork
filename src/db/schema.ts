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
