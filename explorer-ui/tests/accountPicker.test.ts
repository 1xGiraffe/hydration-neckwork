import { describe, it, expect } from 'vitest'
import { tokenizeAddresses } from '../src/components/accountTokens'

// The picker accepts pasted lists exactly as people copy them — newline-,
// comma-, semicolon-, or space-separated — without caring about the separator.
describe('tokenizeAddresses', () => {
  it('splits on any separator run and drops empties', () => {
    expect(tokenizeAddresses('a, b,,c\n d;e  f')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(tokenizeAddresses('  ')).toEqual([])
    expect(tokenizeAddresses('single')).toEqual(['single'])
  })
})
