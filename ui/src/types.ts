export interface ApiCandle {
  intervalStart: number  // Unix seconds
  open: number
  high: number
  low: number
  close: number
  volumeBuy: number
  volumeSell: number
  volumeTotal: number
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
}
