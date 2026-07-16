import { describe, expect, it } from 'vitest'
import { toClickHouseDateTime } from '../../src/raw/json.ts'

describe('toClickHouseDateTime', () => {
  it('formats a valid block timestamp', () => {
    expect(toClickHouseDateTime(Date.parse('2026-07-11T12:34:56.789Z')))
      .toBe('2026-07-11 12:34:56')
  })

  it('uses the Unix epoch only for the timestamp-less genesis block', () => {
    expect(toClickHouseDateTime(undefined, 0)).toBe('1970-01-01 00:00:00')
    expect(toClickHouseDateTime(0, 0)).toBe('1970-01-01 00:00:00')
    expect(() => toClickHouseDateTime(undefined, 1)).toThrow(RangeError)
  })

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    'rejects invalid block timestamp %s',
    (timestamp) => {
      expect(() => toClickHouseDateTime(timestamp)).toThrow(RangeError)
    },
  )
})
