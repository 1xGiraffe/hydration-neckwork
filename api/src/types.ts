/**
 * OHLCV candle as returned from ClickHouse query views.
 * All numeric values are Decimal128(12) returned as strings.
 */
export interface OHLCVCandle {
  asset_id: number
  interval_start: string
  open: string
  high: string
  low: string
  close: string
  volume_buy: string
  volume_sell: string
  volume_total: string
}

/**
 * OHLCV candle formatted for API JSON response.
 * All values converted to JavaScript numbers.
 * Timestamps as Unix seconds (Lightweight Charts native format).
 */
export interface ApiCandle {
  intervalStart: number
  open: number
  high: number
  low: number
  close: number
  volumeBuy: number
  volumeSell: number
  volumeTotal: number
}

/**
 * Asset metadata from price_data.assets table.
 */
export interface Asset {
  assetId: number
  symbol: string
  name: string | null  // null when name matches symbol
  decimals: number
  isStablecoin: boolean
}
