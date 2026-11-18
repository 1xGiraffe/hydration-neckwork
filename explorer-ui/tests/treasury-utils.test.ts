import { describe, expect, it } from 'vitest'
import { hdxNumber, lastFullMonth, monthLabel, overallPassRate } from '../src/utils/treasury'

describe('treasury helpers', () => {
  it('reads raw HDX as whole HDX for drawing, and nothing else as a number', () => {
    expect(hdxNumber('2236295103546075009954')).toBeCloseTo(2_236_295_103.546, 2)
    expect(hdxNumber('1')).toBe(0)
    expect(hdxNumber(null)).toBe(0)
    expect(hdxNumber('-5')).toBe(0)
  })

  it('names the last full month across a year boundary', () => {
    expect(lastFullMonth(Date.parse('2026-11-08T00:00:00Z'))).toBe('2026-10')
    expect(lastFullMonth(Date.parse('2026-01-15T00:00:00Z'))).toBe('2025-12')
    expect(monthLabel('2025-03')).toBe('Mar 2025')
  })

  it('takes the pass rate over decided referenda only', () => {
    const t = (approved: number, rejected: number, cancelled = 0) => ({ id: 0, name: 'x', approved, rejected, cancelled, timedOut: 0, killed: 0, ongoing: 0, passRate: null })
    expect(overallPassRate([t(91, 1, 4), t(9, 9)])).toEqual({ rate: 100 / 110, approved: 100, decided: 110 })
    expect(overallPassRate([t(0, 0, 3)]).rate).toBeNull()
  })
})
