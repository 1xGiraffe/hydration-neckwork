export interface OmniwatchTrader {
  account: string
  shortAccount: string
  emoji: string
  emojiName?: string
  emojiUrl?: string
  volumeBuy: number
  volumeSell: number
  volumeTotal: number
  netVolume: number
  tradeCount: number
  // Traded amounts in the base asset's own raw integer units, as exact decimal
  // strings — scale by the asset's decimals to display them.
  nativeVolumeBuy: string
  nativeVolumeSell: string
  nativeVolumeTotal: string
  nativeNetVolume: string
}

interface OmniwatchCandleSummary {
  topTrader: OmniwatchTrader
  accountCount: number
  tradeCount: number
  volumeBuy: number
  volumeSell: number
  volumeTotal: number
  netVolume: number
  nativeNetVolume: string
}

export interface OmniwatchVolumeDetails {
  accounts: OmniwatchTrader[]
  accountCount: number
  tradeCount: number
  volumeBuy: number
  volumeSell: number
  volumeTotal: number
  netVolume: number
  nativeVolumeBuy: string
  nativeVolumeSell: string
  nativeVolumeTotal: string
  nativeNetVolume: string
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


export interface AssetOrigin {
  ecosystem: string
  chainId: string
  assetId: string | null
}

export interface Asset {
  assetId: number
  symbol: string
  name: string | null
  decimals: number
  isStablecoin: boolean
  // Whether the asset stands in for USD when it quotes a pair. EURC/HEURC are
  // stablecoins but track the euro, so a pair quoted in them is not a USD series.
  isUsdPegged?: boolean
  parachainId: number | null  // XCM origin parachain ID for origin badge
  origin?: AssetOrigin | null
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
