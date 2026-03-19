import { describe, it, expect } from 'vitest'
import { candleToResponse, toClickHouseDateTime, INTERVAL_VIEW_MAP } from '../src/services/ohlcvService.ts'
import type { OHLCVCandle } from '../src/types.ts'

describe('INTERVAL_VIEW_MAP', () => {
  it('has exactly 8 intervals', () => {
    expect(Object.keys(INTERVAL_VIEW_MAP)).toHaveLength(8)
  })

  it('includes all expected intervals', () => {
    const keys = Object.keys(INTERVAL_VIEW_MAP)
    expect(keys).toContain('5min')
    expect(keys).toContain('15min')
    expect(keys).toContain('30min')
    expect(keys).toContain('1h')
    expect(keys).toContain('4h')
    expect(keys).toContain('1d')
    expect(keys).toContain('1w')
    expect(keys).toContain('1M')
  })

  it('maps 1M (month) to ohlc_1m_query (lowercase m in view name)', () => {
    expect(INTERVAL_VIEW_MAP['1M']).toBe('ohlc_1m_query')
  })
})

describe('toClickHouseDateTime', () => {
  it('converts Date to ClickHouse format without T separator or milliseconds', () => {
    const date = new Date('2024-01-15T10:30:45.123Z')
    expect(toClickHouseDateTime(date)).toBe('2024-01-15 10:30:45')
  })
})

describe('candleToResponse', () => {
  const mockCandle: OHLCVCandle = {
    asset_id: 5,
    interval_start: '2024-01-01 00:00:00',
    open: '7.123456789012',
    high: '7.500000000000',
    low: '6.800000000000',
    close: '7.250000000000',
    volume_buy: '1234.567890123456',
    volume_sell: '987.654321098765',
    volume_total: '2222.222211222221',
  }

  it('converts interval_start to Unix seconds', () => {
    const result = candleToResponse(mockCandle)
    expect(result.intervalStart).toBe(1704067200)
  })

  it('converts Decimal128 string open to number', () => {
    const result = candleToResponse(mockCandle)
    expect(result.open).toBeCloseTo(7.123456789012, 10)
  })

  it('converts all OHLCV fields to numbers', () => {
    const result = candleToResponse(mockCandle)
    expect(typeof result.open).toBe('number')
    expect(typeof result.high).toBe('number')
    expect(typeof result.low).toBe('number')
    expect(typeof result.close).toBe('number')
    expect(typeof result.volumeBuy).toBe('number')
    expect(typeof result.volumeSell).toBe('number')
    expect(typeof result.volumeTotal).toBe('number')
  })

  it('uses camelCase field names in response', () => {
    const result = candleToResponse(mockCandle)
    expect('intervalStart' in result).toBe(true)
    expect('volumeBuy' in result).toBe(true)
    expect('volumeSell' in result).toBe(true)
    expect('volumeTotal' in result).toBe(true)
  })
})
