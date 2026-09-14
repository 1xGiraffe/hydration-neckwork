import type { AssetMarketStats, Period } from '../types'

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
