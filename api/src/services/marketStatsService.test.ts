import { describe, it, expect } from 'vitest'
import { calcChange, downsample } from './marketStatsService.ts'

describe('calcChange', () => {
  it('returns 0.5 for 50% increase (1.50 vs 1.00)', () => {
    expect(calcChange('1.50', '1.00')).toBeCloseTo(0.5, 10)
  })

  it('returns -0.25 for 25% decrease (0.75 vs 1.00)', () => {
    expect(calcChange('0.75', '1.00')).toBeCloseTo(-0.25, 10)
  })

  it('returns null when ref price is zero string', () => {
    expect(calcChange('1.00', '0')).toBeNull()
  })

  it('returns null when ref price is empty string', () => {
    expect(calcChange('1.00', '')).toBeNull()
  })

  it('returns null when ref price is Decimal128 zero string', () => {
    expect(calcChange('1.00', '0.000000000000')).toBeNull()
  })

  it('returns 0 when current equals ref', () => {
    expect(calcChange('1.00', '1.00')).toBeCloseTo(0, 10)
  })
})

describe('downsample', () => {
  it('returns array of target length when input is longer', () => {
    const result = downsample([1,2,3,4,5,6,7,8,9,10,11,12], 4)
    expect(result).toHaveLength(4)
  })

  it('returns input unchanged when input is shorter than target', () => {
    const result = downsample([1,2,3], 10)
    expect(result).toEqual([1,2,3])
  })

  it('returns empty array for empty input', () => {
    const result = downsample([], 10)
    expect(result).toEqual([])
  })

  it('always includes the last element (most recent close)', () => {
    const input = [1,2,3,4,5,6,7,8,9,10,11,12]
    const result = downsample(input, 4)
    expect(result[result.length - 1]).toBe(12)
  })

  it('returns exact input when length equals target', () => {
    const result = downsample([1,2,3,4], 4)
    expect(result).toEqual([1,2,3,4])
  })
})
