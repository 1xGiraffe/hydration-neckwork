import { describe, expect, it } from 'vitest'
import { changeOverDays, performancePoints } from '../src/components/performance'

// Daily series ending 2026-07-08; index 0 is the oldest point.
function daily(values: number[]): { series: number[]; dates: string[] } {
  const end = Date.parse('2026-07-08T00:00:00Z')
  const dates = values.map((_, i) => new Date(end - (values.length - 1 - i) * 86_400_000).toISOString().slice(0, 10))
  return { series: values, dates }
}

describe('changeOverDays', () => {
  it('computes the percentage change against the nearest point at/behind the window', () => {
    const { series, dates } = daily([100, 100, 100, 100, 100, 100, 100, 110])
    expect(changeOverDays(series, dates, 7)).toBeCloseTo(10)
  })

  it('returns null when the baseline is below minBase (funding noise, not performance)', () => {
    const { series, dates } = daily([0.07, 0.07, 0.07, 0.07, 0.07, 0.07, 0.07, 1151])
    expect(changeOverDays(series, dates, 7, { minBase: 1 })).toBeNull()
    // Without the guard the raw (useless) value is still computable.
    expect(changeOverDays(series, dates, 7)).toBeGreaterThan(1_000_000)
  })

  it('returns null when growth exceeds maxRatio (initial funding inside the window)', () => {
    const { series, dates } = daily([50, 50, 50, 50, 50, 50, 50, 2000])
    expect(changeOverDays(series, dates, 7, { maxRatio: 20 })).toBeNull()
  })

  it('keeps large declines (a drained account is real information)', () => {
    const { series, dates } = daily([2000, 2000, 2000, 2000, 2000, 2000, 2000, 10])
    expect(changeOverDays(series, dates, 7, { minBase: 1, maxRatio: 20 })).toBeCloseTo(-99.5)
  })

  it('keeps genuine multi-x growth under the ratio cap', () => {
    const { series, dates } = daily([100, 100, 100, 100, 100, 100, 100, 900])
    expect(changeOverDays(series, dates, 7, { minBase: 1, maxRatio: 20 })).toBeCloseTo(800)
  })
})

describe('performancePoints', () => {
  it('drops suppressed windows entirely instead of rendering absurd values', () => {
    const { series, dates } = daily([0.07, 0.07, 0.07, 0.07, 0.07, 0.07, 0.07, 1151])
    const pts = performancePoints(series, dates, [{ label: '1W', days: 7 }], { minBase: 1, maxRatio: 20 })
    expect(pts).toEqual([])
  })
})
