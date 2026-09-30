import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { priceAssetId } from './explorerAssets.ts'
import { getAssetById } from './assetsService.ts'
import { queryOHLCV, type OHLCVInterval } from './ohlcvService.ts'
import { queryCrossPairCandles } from './crossPair.ts'

// Candles for one pair on an explorer chart — the intent page draws a limit order
// against its market with them. The same two leaves the preis chart route and the
// public /v1/prices/pair read: a USD-pegged quote is the base asset's own USD candles,
// anything else the exact per-block cross rate (services/crossPair.ts), never the
// ratio of two stored candles. Each leg is first resolved to the series that prices
// its history (priceAssetId), because an intent trades aTokens and pool shares the
// candle model records under their reserve or wrapper (aUSDC is USDC).

export const PAIR_CHART_INTERVALS = ['15min', '1h', '4h', '1d', '1w'] as const
export type PairChartInterval = typeof PAIR_CHART_INTERVALS[number]
const INTERVAL_SECONDS: Record<PairChartInterval, number> = { '15min': 900, '1h': 3_600, '4h': 14_400, '1d': 86_400, '1w': 604_800 }
// The weekly grid is Monday-anchored like the candle model's (1970-01-05).
const INTERVAL_ANCHOR: Record<PairChartInterval, number> = { '15min': 0, '1h': 0, '4h': 0, '1d': 0, '1w': 345_600 }
export const PAIR_CHART_MAX_CANDLES = 500

/** One candle as the chart draws it: the bucket's open time (unix seconds) and its prices. */
export interface PairChartCandle { t: number; o: number; h: number; l: number; c: number }
export interface PairChart {
  /** The series each leg was read from — differs from the id asked for when it is an alias. */
  baseSeries: number
  quoteSeries: number
  interval: PairChartInterval
  candles: PairChartCandle[]
}

const num = (value: string | number): number => (typeof value === 'number' ? value : Number(value))

/**
 * The newest `count` buckets of `base` quoted in `quote`, ending with the bucket in
 * progress — a price chart shows where the price is now, which is the point of
 * drawing a resting order against it. Two ids reading one series (aUSDC and USDC)
 * have no pair to draw and answer empty.
 */
export function pairChart(client: ClickHouseClient, baseId: number, quoteId: number, interval: PairChartInterval, count: number, nowSec = Math.floor(Date.now() / 1000)): Promise<PairChart> {
  const baseSeries = priceAssetId(baseId)
  const quoteSeries = priceAssetId(quoteId)
  const seconds = INTERVAL_SECONDS[interval]
  const anchor = INTERVAL_ANCHOR[interval]
  const n = Math.max(1, Math.min(PAIR_CHART_MAX_CANDLES, Math.floor(count)))
  // Floored onto the grid so every request inside one bucket shares a key; the short
  // TTL is what moves the bucket in progress.
  const currentStart = Math.floor((nowSec - anchor) / seconds) * seconds + anchor
  const fromSec = currentStart - (n - 1) * seconds
  return cached(`explorer:pair-chart:${baseSeries}:${quoteSeries}:${interval}:${n}:${currentStart}`, 30_000, async (): Promise<PairChart> => {
    if (baseSeries === quoteSeries) return { baseSeries, quoteSeries, interval, candles: [] }
    const startTime = new Date(fromSec * 1000)
    const endTime = new Date(nowSec * 1000)
    const candles: PairChartCandle[] = getAssetById(quoteSeries)?.isUsdPegged
      ? (await queryOHLCV(client, { assetId: baseSeries, startTime, endTime, interval: interval as OHLCVInterval }))
        .map(c => ({ t: Math.floor(Date.parse(`${c.interval_start.replace(' ', 'T')}Z`) / 1000), o: num(c.open), h: num(c.high), l: num(c.low), c: num(c.close) }))
      : (await queryCrossPairCandles(client, { baseId: baseSeries, quoteId: quoteSeries, startTime, endTime, interval: interval as OHLCVInterval }))
        .map(c => ({ t: c.intervalStart, o: num(c.open), h: num(c.high), l: num(c.low), c: num(c.close) }))
    return {
      baseSeries, quoteSeries, interval,
      candles: candles.filter(c => c.t >= fromSec && [c.o, c.h, c.l, c.c].every(v => Number.isFinite(v) && v > 0)).sort((a, b) => a.t - b.t),
    }
  })
}
