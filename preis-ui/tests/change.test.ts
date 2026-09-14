import { describe, expect, it } from 'vitest'
import { changeTone, deriveFromCandles } from '../src/utils/change'
import type { ApiCandle, OHLCVInterval } from '../src/types'

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

/** An ascending run of `count` candles ending at `endIso`, one per bucket. */
function series(endIso: string, bucketSeconds: number, count: number, opens: number[]): ApiCandle[] {
  const end = unix(endIso)
  return opens.slice(-count).map((open, i) => {
    const intervalStart = end - (count - 1 - i) * bucketSeconds
    return {
      intervalStart,
      open,
      high: open,
      low: open,
      close: open,
      volumeBuy: 0,
      volumeSell: 0,
      volumeTotal: 0,
    }
  })
}

// The header's fallback chip is LABELLED "24H", so it may only ever report a
// 24-hour move. The window is walked over the loaded bars, which means the
// bucket width decides whether such a bar exists at all: on a daily, weekly or
// monthly candle the walk cannot leave the current bucket, and reporting its
// open-to-close move under a 24H label is a wrong number, not a coarse one.
describe('deriveFromCandles', () => {
  const hour = 3_600

  it('measures against the bar one day back on an hourly series', () => {
    // 26 hourly bars: the oldest falls outside the window and must be ignored,
    // and the 25th-from-last opens exactly one day before the newest.
    const opens = [999, 100, ...Array.from({ length: 24 }, () => 200)]
    const candles = series('2026-09-14T12:00:00Z', hour, 26, opens)
    const { price, change24h } = deriveFromCandles(candles, '1h')
    expect(price).toBe(200)
    // +100% against the 100 open a day back — not 0%, the move since the
    // previous bar, and not a figure pulled from the out-of-window 999.
    expect(change24h).toBe(1)
  })

  it.each<OHLCVInterval>(['1d', '1w', '1M'])(
    'reports no 24h change on a %s candle, whose bucket is at least a day wide',
    interval => {
      const bucket = interval === '1d' ? 86_400 : interval === '1w' ? 604_800 : 2_592_000
      const candles = series('2026-09-01T00:00:00Z', bucket, 8, Array.from({ length: 8 }, (_, i) => 100 + i))
      const derived = deriveFromCandles(candles, interval)
      expect(derived.price).toBe(107)
      expect(derived.change24h).toBeNull()
    },
  )

  it('reports no change when the loaded history is shorter than a day', () => {
    const candles = series('2026-09-14T12:00:00Z', hour, 6, Array.from({ length: 6 }, () => 100))
    expect(deriveFromCandles(candles, '1h').change24h).toBeNull()
  })

  it('has nothing to report for an empty series', () => {
    expect(deriveFromCandles([], '1h')).toEqual({ price: null, change24h: null })
  })
})

describe('changeTone', () => {
  it('separates a flat move from an unknown one only by what it renders beside', () => {
    expect(changeTone(0.01)).toBe('up')
    expect(changeTone(-0.01)).toBe('down')
    expect(changeTone(0)).toBe('flat')
    expect(changeTone(null)).toBe('flat')
    expect(changeTone(Number.NaN)).toBe('flat')
  })
})
