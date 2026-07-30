import { describe, expect, it } from 'vitest'
import { tsInRange } from '../src/components/Filters'
import { parseUtcTimestamp } from '../src/utils/time'

describe('UTC timestamp handling', () => {
  it('treats offset-free API timestamps as UTC and preserves explicit offsets', () => {
    expect(parseUtcTimestamp('2026-07-11 12:30:00')).toBe(Date.parse('2026-07-11T12:30:00Z'))
    expect(parseUtcTimestamp('2026-07-11T14:30:00+02:00')).toBe(Date.parse('2026-07-11T12:30:00Z'))
  })

  it('rejects invalid timestamps from date filters', () => {
    expect(tsInRange('not-a-date', '2026-07-11', '2026-07-11')).toBe(false)
  })

  it('uses an exclusive upper boundary after the selected day', () => {
    expect(tsInRange('2026-07-11 23:59:59', undefined, '2026-07-11')).toBe(true)
    expect(tsInRange('2026-07-12 00:00:00', undefined, '2026-07-11')).toBe(false)
  })
})
