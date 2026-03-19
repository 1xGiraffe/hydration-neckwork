import Decimal from 'decimal.js'
import type { OHLCVCandle, ApiCandle } from '../types.ts'

/**
 * Derive cross-pair OHLCV candles from two USDT-denominated candle series.
 *
 * Given A/USDT and B/USDT candles, computes A/B candles where:
 * - open  = open_A  / open_B
 * - high  = high_A  / low_B   (NOT high_A / high_B — captures max A price at min B price)
 * - low   = low_A   / high_B  (NOT low_A / low_B — captures min A price at max B price)
 * - close = close_A / close_B
 * - volume = base asset (A) USDT-denominated volume (not divided)
 *
 * Only returns candles where both assets have data at the same interval_start
 * (inner join). Per domain decision: Omnipool prices update every block, so gaps
 * only occur before an asset was listed.
 *
 * All division uses decimal.js to avoid float64 precision loss.
 * toNumber() is called only at the final output step.
 *
 * @param baseCandles  - A/USDT candles (Decimal128 as strings from ClickHouse)
 * @param quoteCandles - B/USDT candles (Decimal128 as strings from ClickHouse)
 * @returns A/B candles with numbers (ready for JSON serialization)
 */
export function deriveCrossPairCandles(
  baseCandles: OHLCVCandle[],
  quoteCandles: OHLCVCandle[]
): ApiCandle[] {
  const quoteByTime = new Map(quoteCandles.map(c => [c.interval_start, c]))

  const results: ApiCandle[] = []

  for (const base of baseCandles) {
    const quote = quoteByTime.get(base.interval_start)
    if (!quote) continue

    const qOpen  = new Decimal(quote.open)
    const qHigh  = new Decimal(quote.high)
    const qLow   = new Decimal(quote.low)
    const qClose = new Decimal(quote.close)

    // Skip candles where any quote price is zero (would produce Infinity)
    if (qOpen.isZero() || qHigh.isZero() || qLow.isZero() || qClose.isZero()) continue

    const bOpen  = new Decimal(base.open)
    const bHigh  = new Decimal(base.high)
    const bLow   = new Decimal(base.low)
    const bClose = new Decimal(base.close)

    results.push({
      intervalStart: Math.floor(new Date(base.interval_start.replace(' ', 'T') + 'Z').getTime() / 1000),
      open:        bOpen.div(qOpen).toNumber(),
      high:        bHigh.div(qLow).toNumber(),    // high_A / low_B
      low:         bLow.div(qHigh).toNumber(),     // low_A / high_B
      close:       bClose.div(qClose).toNumber(),
      volumeBuy:   parseFloat(base.volume_buy),
      volumeSell:  parseFloat(base.volume_sell),
      volumeTotal: parseFloat(base.volume_total),
    })
  }

  return results
}
