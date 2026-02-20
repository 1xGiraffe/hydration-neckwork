export interface PriceRow {
  asset_id: number
  block_height: number
  usdt_price: string  // String for Decimal precision (ClickHouse returns Decimal as string)
  native_volume_buy?: string
  native_volume_sell?: string
  usdt_volume_buy?: string
  usdt_volume_sell?: string
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
