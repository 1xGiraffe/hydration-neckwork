import type { ApiCandle, AssetMarketStats, OHLCVInterval, Period } from '../types'
import { candleEndTimestamp } from './candleTime'

/** The up/down/flat tone every change figure is coloured by. */
export function changeTone(change: number | null): 'up' | 'down' | 'flat' {
  if (change === null || !Number.isFinite(change)) return 'flat'
  if (change > 0) return 'up'
  if (change < 0) return 'down'
  return 'flat'
}

const DAY_SECONDS = 86_400

/**
 * The last close, plus the fallback 24h change for pairs the market-stats feed
 * cannot derive one for. Candles are ascending, so the window's first bar is
 * found by walking back from the end — the loaded history can run to thousands
 * of bars after scrollback, and only the last day of it matters here.
 *
 * The walk needs the bucket width, which is why the interval is a parameter:
 * a bar at least a day wide has no bar inside the window to walk back to, so
 * its own open would stand in for the 24h reference and the figure would be a
 * week- or month-to-date move under a "24H" label. A history that does not
 * reach back a full day has no reference either. Both report null rather than
 * a number measured over the wrong window.
 */
export function deriveFromCandles(
  candles: ApiCandle[],
  interval: OHLCVInterval,
): { price: number | null; change24h: number | null } {
  if (candles.length === 0) return { price: null, change24h: null }
  const last = candles[candles.length - 1]
  const price = last.close

  if (candleEndTimestamp(last.intervalStart, interval) - last.intervalStart >= DAY_SECONDS) {
    return { price, change24h: null }
  }

  const cutoff = last.intervalStart - DAY_SECONDS
  let first = candles.length - 1
  while (first > 0 && candles[first - 1].intervalStart >= cutoff) first--
  // Stopping at index 0 above the cutoff means the history ran out, not that
  // the window closed.
  if (first === 0 && candles[0].intervalStart > cutoff) return { price, change24h: null }

  const refOpen = candles[first].open
  return { price, change24h: refOpen > 0 ? (last.close - refOpen) / refOpen : null }
}

/** The asset's own USD change over the selected period. */
export function changeForPeriod(stats: AssetMarketStats, period: Period): number | null {
  return period === '1h' ? stats.change1h : period === '7d' ? stats.change7d : stats.change24h
}

/**
 * A pair's change over `period`.
 *
 * The API reports per-asset USD changes, so a cross pair's change is the change
 * of the base/quote RATIO, not the base's alone: each leg's price one period ago
 * is `price_now / (1 + change)`, and the pair moved by the ratio of the two
 * ratios. When the quote stands in for USD the base's own change already is the
 * pair's change. Null whenever either leg is missing a price or a change — an
 * unknown move is never reported as zero.
 */
export function crossChange(
  base: AssetMarketStats | undefined,
  quote: AssetMarketStats | undefined,
  period: Period,
  isUsdQuote: boolean,
): number | null {
  if (!base?.price) return null
  const baseChange = changeForPeriod(base, period)
  if (baseChange == null) return null
  if (isUsdQuote) return baseChange
  if (!quote?.price) return null
  const quoteChange = changeForPeriod(quote, period)
  if (quoteChange == null) return null
  if (baseChange === -1 || quoteChange === -1) return null
  const baseThen = base.price / (1 + baseChange)
  const quoteThen = quote.price / (1 + quoteChange)
  if (quoteThen === 0) return null
  const ratioThen = baseThen / quoteThen
  if (ratioThen === 0) return null
  return (base.price / quote.price) / ratioThen - 1
}
