import { describe, expect, it } from 'vitest'
import { formatChange, formatCountdown, formatPrice, formatTokenAmount, tokenAmountFromRaw } from '../src/utils/format'

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

describe('token amounts', () => {
  it('scales raw integer units by the asset decimals', () => {
    // 509081.244584532579 HDX, well past the 2^53 mark as a raw 12-decimal integer
    expect(tokenAmountFromRaw('509081244584532579', 12)).toBeCloseTo(509081.244584, 5)
    expect(tokenAmountFromRaw('100000000', 8)).toBe(1)
    expect(tokenAmountFromRaw('0', 18)).toBe(0)
  })

  it('does not invent an amount when the input is missing', () => {
    expect(tokenAmountFromRaw(null, 12)).toBe(0)
    expect(tokenAmountFromRaw('123', Number.NaN)).toBe(0)
  })

  it('compacts across the magnitudes a traded asset spans', () => {
    expect(formatTokenAmount(4_230_000)).toBe('4.23M')
    expect(formatTokenAmount(4230)).toBe('4.23K')
    expect(formatTokenAmount(-4230)).toBe('-4.23K')
    expect(formatTokenAmount(4.2)).toBe('4.20')
    expect(formatTokenAmount(0.0423)).toBe('0.0423')
    expect(formatTokenAmount(-0.0423)).toBe('-0.0423')
    expect(formatTokenAmount(0)).toBe('0')
    expect(formatTokenAmount(Number.NaN)).toBe('0')
  })
})
