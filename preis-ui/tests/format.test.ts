import { describe, expect, it } from 'vitest'
import { formatChange, formatCountdown, formatPrice } from '../src/utils/format'

describe('formatting edge cases', () => {
  it('does not expose non-finite market values', () => {
    expect(formatPrice(Number.NaN)).toBe('$0')
    expect(formatPrice(Number.POSITIVE_INFINITY, false)).toBe('0')
    expect(formatChange(Number.NaN)).toBe('—')
  })

  it('normalizes fractional and non-finite countdowns', () => {
    expect(formatCountdown(61.9)).toBe('1:01')
    expect(formatCountdown(Number.NaN)).toBe('0:00')
  })
})
