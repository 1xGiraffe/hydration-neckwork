import { describe, expect, it } from 'vitest'
import {
  candleEndTimestamp,
  previousCandleRange,
  recentCandleRange,
  shiftUtcMonths,
} from '../src/utils/candleTime'

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

describe('calendar-month candle ranges', () => {
  it('uses the next UTC month as the candle boundary', () => {
    expect(candleEndTimestamp(unix('2024-01-01T00:00:00Z'), '1M'))
      .toBe(unix('2024-02-01T00:00:00Z'))
    expect(candleEndTimestamp(unix('2024-02-01T00:00:00Z'), '1M'))
      .toBe(unix('2024-03-01T00:00:00Z'))
    expect(candleEndTimestamp(unix('2026-03-01T00:00:00Z'), '1M'))
      .toBe(unix('2026-04-01T00:00:00Z'))
  })

  it('loads an exact number of preceding calendar months', () => {
    const oldest = unix('2024-03-01T00:00:00Z')
    expect(previousCandleRange('1M', oldest, 3)).toEqual({
      from: unix('2023-12-01T00:00:00Z'),
      to: oldest - 1,
    })

    expect(previousCandleRange('1M', oldest, 500).from)
      .toBe(shiftUtcMonths(oldest, -500))
  })

  it('includes the current month in the recent range', () => {
    const now = unix('2026-07-10T13:14:15Z')
    expect(recentCandleRange('1M', now, 3)).toEqual({
      from: unix('2026-05-01T00:00:00Z'),
      to: now,
    })
  })

  it('preserves fixed-duration interval behavior', () => {
    const start = unix('2026-07-10T12:00:00Z')
    expect(candleEndTimestamp(start, '1h')).toBe(start + 3_600)
    expect(previousCandleRange('1h', start, 5)).toEqual({
      from: start - 5 * 3_600,
      to: start - 1,
    })
  })
})
