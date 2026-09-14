import { describe, expect, it } from 'vitest'
import { compactAmount, formatChange, formatCountdown, formatPrice, formatSignedPrice, tokenAmountFromRaw } from '../src/utils/format'

describe('formatting edge cases', () => {
  // An unknown price is not a zero one — a broken feed must not render as free.
  it('does not expose non-finite market values', () => {
    expect(formatPrice(Number.NaN)).toBe('—')
    expect(formatPrice(Number.POSITIVE_INFINITY, false)).toBe('—')
    expect(formatSignedPrice(Number.NaN)).toBe('—')
    expect(formatChange(Number.NaN)).toBe('—')
  })

  it('still renders a genuine zero as a price', () => {
    expect(formatPrice(0)).toBe('$0')
    expect(formatPrice(0, false)).toBe('0')
  })

  it('prices a signed delta on the same ladder as the price itself', () => {
    expect(formatSignedPrice(1.5)).toBe('+1.50')
    expect(formatSignedPrice(-1.5)).toBe('-1.50')
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

  // One rough scale for every amount: ~3 significant digits with k/M/B
  // compaction, so a tally and a token amount cannot read differently.
  it('compacts across the magnitudes a traded asset spans', () => {
    expect(compactAmount(1_230_000_000)).toBe('1.23B')
    expect(compactAmount(4_230_000)).toBe('4.23M')
    expect(compactAmount(4230)).toBe('4.23k')
    expect(compactAmount(-4230)).toBe('-4.23k')
    expect(compactAmount(4.2)).toBe('4.2')
    expect(compactAmount(0.0423)).toBe('0.0423')
    expect(compactAmount(-0.0423)).toBe('-0.0423')
    expect(compactAmount(0)).toBe('0')
    expect(compactAmount(Number.NaN)).toBe('—')
  })
})
