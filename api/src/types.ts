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
 * Market statistics for a single asset, returned by GET /market-stats.
 * All prices and changes are in USDT terms.
 */
export interface AssetMarketStats {
  assetId: number
  symbol: string
  price: number | null          // Current USDT price
  change1h: number | null       // Decimal ratio, e.g. 0.0523 = +5.23%
  change24h: number | null
  change7d: number | null
  sparkline: number[]           // 24-48 hourly close prices (7d, downsampled)
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
  parachainId: number | null  // XCM origin parachain ID, null for native Hydration assets
}
