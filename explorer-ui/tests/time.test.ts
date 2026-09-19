import { describe, expect, it } from 'vitest'
import { parseUtcTimestamp } from '../src/utils/time'

describe('UTC timestamp handling', () => {
  it('treats offset-free API timestamps as UTC and preserves explicit offsets', () => {
    expect(parseUtcTimestamp('2026-07-11 12:30:00')).toBe(Date.parse('2026-07-11T12:30:00Z'))
    expect(parseUtcTimestamp('2026-07-11T14:30:00+02:00')).toBe(Date.parse('2026-07-11T12:30:00Z'))
  })

})
