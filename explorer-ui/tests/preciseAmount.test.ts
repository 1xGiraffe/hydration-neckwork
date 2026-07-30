import { describe, expect, it } from 'vitest'
import { F } from '../src/components/ui'

// The hover/copy surfaces promise EVERY digit of the raw integer amount, so the
// formatter must be string math — a Number round-trip silently corrupts amounts
// past 2^53, which real 128-bit balances exceed.
describe('F.preciseAmountPlain', () => {
  it('places the decimal point by position, trimming trailing zeros', () => {
    expect(F.preciseAmountPlain('2581234567890123456', 12)).toBe('2581234.567890123456')
    expect(F.preciseAmountPlain('99826955091', 10)).toBe('9.9826955091')
    expect(F.preciseAmountPlain('4715345851996', 10)).toBe('471.5345851996')
    expect(F.preciseAmountPlain('1000000000000', 12)).toBe('1')
  })
  it('keeps digits a float would lose', () => {
    // 585598890862264571 is not representable as a double (2^59-ish, odd tail).
    expect(F.preciseAmountPlain('585598890862264571', 12)).toBe('585598.890862264571')
  })
  it('pads amounts smaller than one unit', () => {
    expect(F.preciseAmountPlain('42', 10)).toBe('0.0000000042')
    expect(F.preciseAmountPlain('0', 12)).toBe('0')
  })
  it('handles zero decimals and signs', () => {
    expect(F.preciseAmountPlain('123', 0)).toBe('123')
    expect(F.preciseAmountPlain('-1500000000000', 12)).toBe('-1.5')
  })
  it('rejects non-integer input', () => {
    expect(F.preciseAmountPlain('', 12)).toBe('—')
    expect(F.preciseAmountPlain(null, 12)).toBe('—')
    expect(F.preciseAmountPlain('1.5', 12)).toBe('—')
  })
})

describe('F.preciseAmount', () => {
  it('groups the integer part and keeps the exact fraction', () => {
    expect(F.preciseAmount('2581234567890123456', 12)).toBe('2,581,234.567890123456')
    expect(F.preciseAmount('585598890862264571', 12)).toBe('585,598.890862264571')
    expect(F.preciseAmount('-1234567000000000000', 12)).toBe('-1,234,567')
  })
})
