export interface OmniwatchTrader {
  account: string
  shortAccount: string
  subscanUrl: string
  emoji: string
  emojiName?: string
  emojiUrl?: string
  volumeBuy: number
  volumeSell: number
  volumeTotal: number
  netVolume: number
  tradeCount: number
}

export interface OmniwatchCandleSummary {
  topTrader: OmniwatchTrader
  accountCount: number
  tradeCount: number
  volumeBuy: number
  volumeSell: number
  volumeTotal: number
  netVolume: number
}

export interface OmniwatchVolumeDetails {
  accounts: OmniwatchTrader[]
  accountCount: number
  tradeCount: number
  volumeBuy: number
  volumeSell: number
  volumeTotal: number
  netVolume: number
  limit: number
  offset: number
  hasMore: boolean
  nextOffset: number | null
}

export interface ApiCandle {
  intervalStart: number  // Unix seconds
  open: number
  high: number
  low: number
  close: number
  volumeBuy: number
  volumeSell: number
  volumeTotal: number
  omniwatch?: OmniwatchCandleSummary
}

export const INTERVALS = ['5min', '15min', '30min', '1h', '4h', '1d', '1w', '1M'] as const
export type OHLCVInterval = typeof INTERVALS[number]

export const INTERVAL_LABELS: Record<OHLCVInterval, string> = {
  '5min': '5m',
  '15min': '15m',
  '30min': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': 'D',
  '1w': 'W',
  '1M': 'M',
}


export interface Asset {
  assetId: number
  symbol: string
  name: string | null
  decimals: number
  isStablecoin: boolean
  parachainId: number | null  // XCM origin parachain ID for origin badge
}

/**
 * Market statistics for a single asset from GET /market-stats.
 * Mirrors the API response shape.
 */
export const PERIODS = ['1h', '24h', '7d'] as const
export type Period = typeof PERIODS[number]

export interface AssetMarketStats {
  assetId: number
  symbol: string
  price: number | null
  change1h: number | null
  change24h: number | null
  change7d: number | null
  sparkline: number[]
  volumeUsd24h: number
}
