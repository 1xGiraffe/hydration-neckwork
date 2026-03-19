import { describe, it, expect } from 'vitest'
import { deriveCrossPairCandles } from '../src/services/crossPair.ts'
import type { OHLCVCandle } from '../src/types.ts'

function makeCandle(overrides: Partial<OHLCVCandle> & { interval_start: string }): OHLCVCandle {
  return {
    asset_id: 1,
    open: '10.000000000000',
    high: '12.000000000000',
    low: '8.000000000000',
    close: '11.000000000000',
    volume_buy: '100.000000000000',
    volume_sell: '50.000000000000',
    volume_total: '150.000000000000',
    ...overrides,
  }
}

describe('deriveCrossPairCandles', () => {
  it('computes open and close as A/B division', () => {
    const base = [makeCandle({ interval_start: '2024-01-01 00:00:00', open: '10.000000000000', close: '11.000000000000' })]
    const quote = [makeCandle({ interval_start: '2024-01-01 00:00:00', open: '2.000000000000', close: '5.500000000000' })]

    const result = deriveCrossPairCandles(base, quote)

    expect(result).toHaveLength(1)
    expect(result[0].open).toBeCloseTo(5.0, 10)    // 10/2
    expect(result[0].close).toBeCloseTo(2.0, 10)   // 11/5.5
  })

  it('computes high as high_A / low_B (not high_A / high_B)', () => {
    const base = [makeCandle({ interval_start: '2024-01-01 00:00:00', high: '12.000000000000' })]
    const quote = [makeCandle({ interval_start: '2024-01-01 00:00:00', high: '4.000000000000', low: '2.000000000000' })]

    const result = deriveCrossPairCandles(base, quote)

    // high = 12 / 2 = 6 (using low_B), NOT 12 / 4 = 3 (using high_B)
    expect(result[0].high).toBeCloseTo(6.0, 10)
  })

  it('computes low as low_A / high_B (not low_A / low_B)', () => {
    const base = [makeCandle({ interval_start: '2024-01-01 00:00:00', low: '8.000000000000' })]
    const quote = [makeCandle({ interval_start: '2024-01-01 00:00:00', high: '4.000000000000', low: '2.000000000000' })]

    const result = deriveCrossPairCandles(base, quote)

    // low = 8 / 4 = 2 (using high_B), NOT 8 / 2 = 4 (using low_B)
    expect(result[0].low).toBeCloseTo(2.0, 10)
  })

  it('omits candles where either series has no data (inner join)', () => {
    const base = [
      makeCandle({ interval_start: '2024-01-01 00:00:00' }),
      makeCandle({ interval_start: '2024-01-01 01:00:00' }),
      makeCandle({ interval_start: '2024-01-01 02:00:00' }),
    ]
    const quote = [
      makeCandle({ interval_start: '2024-01-01 00:00:00' }),
      // 01:00:00 missing — asset not yet listed
      makeCandle({ interval_start: '2024-01-01 02:00:00' }),
    ]

    const result = deriveCrossPairCandles(base, quote)

    expect(result).toHaveLength(2)
    // 01:00:00 candle is absent from output
    expect(result[0].intervalStart).toBe(Math.floor(new Date('2024-01-01 00:00:00Z').getTime() / 1000))
    expect(result[1].intervalStart).toBe(Math.floor(new Date('2024-01-01 02:00:00Z').getTime() / 1000))
  })

  it('uses base asset volume, not divided volume', () => {
    const base = [makeCandle({
      interval_start: '2024-01-01 00:00:00',
      volume_buy: '100.500000000000',
      volume_sell: '50.250000000000',
      volume_total: '150.750000000000',
    })]
    const quote = [makeCandle({
      interval_start: '2024-01-01 00:00:00',
      volume_buy: '999.000000000000',
      volume_sell: '888.000000000000',
      volume_total: '1887.000000000000',
    })]

    const result = deriveCrossPairCandles(base, quote)

    expect(result[0].volumeBuy).toBeCloseTo(100.5, 6)
    expect(result[0].volumeSell).toBeCloseTo(50.25, 6)
    expect(result[0].volumeTotal).toBeCloseTo(150.75, 6)
  })

  it('preserves precision for small Decimal128 values via decimal.js', () => {
    const base = [makeCandle({
      interval_start: '2024-01-01 00:00:00',
      open: '0.000000012345678901',
      high: '0.000000012345678901',
      low: '0.000000012345678901',
      close: '0.000000012345678901',
    })]
    const quote = [makeCandle({
      interval_start: '2024-01-01 00:00:00',
      open: '0.000000000987654321',
      high: '0.000000000987654321',
      low: '0.000000000987654321',
      close: '0.000000000987654321',
    })]

    const result = deriveCrossPairCandles(base, quote)

    // 0.000000012345678901 / 0.000000000987654321 ≈ 12.5
    // With float64 this would lose significant digits; decimal.js preserves
    const expected = 0.000000012345678901 / 0.000000000987654321
    expect(result[0].open).toBeCloseTo(expected, 5)
    // Key: the value should be a reasonable number, not NaN or 0
    expect(result[0].open).toBeGreaterThan(10)
    expect(result[0].open).toBeLessThan(15)
  })

  it('returns empty array when no timestamps overlap', () => {
    const base = [makeCandle({ interval_start: '2024-01-01 00:00:00' })]
    const quote = [makeCandle({ interval_start: '2024-01-02 00:00:00' })]

    const result = deriveCrossPairCandles(base, quote)

    expect(result).toHaveLength(0)
  })

  it('returns empty array when either input is empty', () => {
    expect(deriveCrossPairCandles([], [makeCandle({ interval_start: '2024-01-01 00:00:00' })])).toHaveLength(0)
    expect(deriveCrossPairCandles([makeCandle({ interval_start: '2024-01-01 00:00:00' })], [])).toHaveLength(0)
  })
})
