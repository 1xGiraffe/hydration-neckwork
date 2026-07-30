import type { OHLCVInterval } from '../types'

const FIXED_INTERVAL_SECONDS: Record<Exclude<OHLCVInterval, '1M'>, number> = {
  '5min': 5 * 60,
  '15min': 15 * 60,
  '30min': 30 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
}

export interface TimestampRange {
  from: number
  to: number
}

function utcMonthStart(timestamp: number): number {
  const date = new Date(timestamp * 1000)
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000)
}

/**
 * Shift a candle timestamp by whole UTC calendar months. Monthly candles are
 * anchored to the first day of a month, so this deliberately normalizes the
 * result to midnight on day one instead of relying on Date#setUTCMonth's
 * end-of-month rollover semantics.
 */
export function shiftUtcMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp * 1000)
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1) / 1000)
}

export function candleEndTimestamp(intervalStart: number, interval: OHLCVInterval): number {
  return interval === '1M'
    ? shiftUtcMonths(intervalStart, 1)
    : intervalStart + FIXED_INTERVAL_SECONDS[interval]
}

/** Range for the most recent `count` candles, including the current candle. */
export function recentCandleRange(
  interval: OHLCVInterval,
  to: number,
  count: number,
): TimestampRange {
  if (interval === '1M') {
    return {
      from: shiftUtcMonths(utcMonthStart(to), -(Math.max(1, count) - 1)),
      to,
    }
  }

  return {
    from: to - FIXED_INTERVAL_SECONDS[interval] * Math.max(1, count),
    to,
  }
}

/** Range immediately before the oldest loaded candle. */
export function previousCandleRange(
  interval: OHLCVInterval,
  oldestIntervalStart: number,
  count: number,
): TimestampRange {
  return {
    from: interval === '1M'
      ? shiftUtcMonths(oldestIntervalStart, -Math.max(1, count))
      : oldestIntervalStart - FIXED_INTERVAL_SECONDS[interval] * Math.max(1, count),
    to: oldestIntervalStart - 1,
  }
}
