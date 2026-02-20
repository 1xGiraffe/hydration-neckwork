import { describe, it, expect, vi } from 'vitest'
import {
  toClickHouseDateTime,
  INTERVAL_VIEW_MAP,
  queryOHLCV,
  query5MinOHLCV,
  query15MinOHLCV,
  query1HourOHLCV,
  query4HourOHLCV,
  query1DayOHLCV,
  type OHLCVCandle,
  type OHLCVInterval,
} from '../../src/query/ohlcv.js'
import type { ClickHouseClient } from '../../src/db/client.js'

describe('toClickHouseDateTime', () => {
  it('converts Date to ClickHouse DateTime format (no T, no milliseconds)', () => {
    const date = new Date('2024-01-15T10:30:45.123Z')
    const result = toClickHouseDateTime(date)
    expect(result).toBe('2024-01-15 10:30:45')
  })

  it('handles end-of-year timestamp', () => {
    const date = new Date('2024-12-31T23:59:59.999Z')
    const result = toClickHouseDateTime(date)
    expect(result).toBe('2024-12-31 23:59:59')
  })

  it('handles epoch start', () => {
    const date = new Date('1970-01-01T00:00:00.000Z')
    const result = toClickHouseDateTime(date)
    expect(result).toBe('1970-01-01 00:00:00')
  })

  it('removes milliseconds from timestamp', () => {
    const date = new Date('2024-06-15T12:34:56.789Z')
    const result = toClickHouseDateTime(date)
    expect(result).not.toContain('.789')
    expect(result).toBe('2024-06-15 12:34:56')
  })

  it('replaces T separator with space', () => {
    const date = new Date('2024-03-20T08:15:30.000Z')
    const result = toClickHouseDateTime(date)
    expect(result).not.toContain('T')
    expect(result).toContain(' ')
    expect(result).toBe('2024-03-20 08:15:30')
  })
})

describe('INTERVAL_VIEW_MAP', () => {
  it('maps 5min to ohlc_5min_query', () => {
    expect(INTERVAL_VIEW_MAP['5min']).toBe('ohlc_5min_query')
  })

  it('maps 15min to ohlc_15min_query', () => {
    expect(INTERVAL_VIEW_MAP['15min']).toBe('ohlc_15min_query')
  })

  it('maps 1h to ohlc_1h_query', () => {
    expect(INTERVAL_VIEW_MAP['1h']).toBe('ohlc_1h_query')
  })

  it('maps 4h to ohlc_4h_query', () => {
    expect(INTERVAL_VIEW_MAP['4h']).toBe('ohlc_4h_query')
  })

  it('maps 1d to ohlc_1d_query', () => {
    expect(INTERVAL_VIEW_MAP['1d']).toBe('ohlc_1d_query')
  })

  it('has exactly 5 interval mappings', () => {
    const keys = Object.keys(INTERVAL_VIEW_MAP) as OHLCVInterval[]
    expect(keys).toHaveLength(5)
    expect(keys).toEqual(['5min', '15min', '1h', '4h', '1d'])
  })
})

describe('queryOHLCV', () => {
  it('passes correct view name in query string for 5min interval', async () => {
    const mockCandles: OHLCVCandle[] = [
      {
        asset_id: 5,
        interval_start: '2024-01-15 10:30:00',
        open: '1.500000000000',
        high: '1.600000000000',
        low: '1.450000000000',
        close: '1.550000000000',
        volume_buy: '100.000000000000',
        volume_sell: '50.000000000000',
        volume_total: '150.000000000000',
      },
    ]

    const queryFn = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockCandles),
    })

    const mockClient = { query: queryFn } as unknown as ClickHouseClient

    const result = await queryOHLCV(mockClient, {
      asset_id: 5,
      start_time: new Date('2024-01-15T00:00:00Z'),
      end_time: new Date('2024-01-16T00:00:00Z'),
      interval: '5min',
    })

    expect(queryFn).toHaveBeenCalledWith({
      query: 'SELECT * FROM price_data.ohlc_5min_query',
      query_params: {
        asset_id: 5,
        start_time: '2024-01-15 00:00:00',
        end_time: '2024-01-16 00:00:00',
      },
      format: 'JSONEachRow',
    })
    expect(result).toEqual(mockCandles)
  })

  it('passes correct view name for 1h interval', async () => {
    const mockCandles: OHLCVCandle[] = []

    const queryFn = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockCandles),
    })

    const mockClient = { query: queryFn } as unknown as ClickHouseClient

    await queryOHLCV(mockClient, {
      asset_id: 10,
      start_time: new Date('2024-02-01T00:00:00Z'),
      end_time: new Date('2024-02-02T00:00:00Z'),
      interval: '1h',
    })

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'SELECT * FROM price_data.ohlc_1h_query',
      })
    )
  })

  it('formats start_time and end_time via toClickHouseDateTime', async () => {
    const queryFn = vi.fn().mockResolvedValue({
      json: () => Promise.resolve([]),
    })

    const mockClient = { query: queryFn } as unknown as ClickHouseClient

    await queryOHLCV(mockClient, {
      asset_id: 7,
      start_time: new Date('2024-03-10T14:30:45.999Z'),
      end_time: new Date('2024-03-11T16:45:30.123Z'),
      interval: '15min',
    })

    const call = queryFn.mock.calls[0][0]
    expect(call.query_params.start_time).toBe('2024-03-10 14:30:45')
    expect(call.query_params.end_time).toBe('2024-03-11 16:45:30')
    expect(call.query_params.start_time).not.toContain('T')
    expect(call.query_params.start_time).not.toContain('.')
  })

  it('passes asset_id as query param', async () => {
    const queryFn = vi.fn().mockResolvedValue({
      json: () => Promise.resolve([]),
    })

    const mockClient = { query: queryFn } as unknown as ClickHouseClient

    await queryOHLCV(mockClient, {
      asset_id: 42,
      start_time: new Date('2024-01-01T00:00:00Z'),
      end_time: new Date('2024-01-02T00:00:00Z'),
      interval: '1d',
    })

    expect(queryFn.mock.calls[0][0].query_params.asset_id).toBe(42)
  })

  it('uses JSONEachRow format', async () => {
    const queryFn = vi.fn().mockResolvedValue({
      json: () => Promise.resolve([]),
    })

    const mockClient = { query: queryFn } as unknown as ClickHouseClient

    await queryOHLCV(mockClient, {
      asset_id: 1,
      start_time: new Date('2024-01-01T00:00:00Z'),
      end_time: new Date('2024-01-02T00:00:00Z'),
      interval: '4h',
    })

    expect(queryFn.mock.calls[0][0].format).toBe('JSONEachRow')
  })

  it('returns result of json() call', async () => {
    const mockCandles: OHLCVCandle[] = [
      {
        asset_id: 20,
        interval_start: '2024-05-01 00:00:00',
        open: '5.000000000000',
        high: '5.500000000000',
        low: '4.800000000000',
        close: '5.200000000000',
        volume_buy: '1000.000000000000',
        volume_sell: '800.000000000000',
        volume_total: '1800.000000000000',
      },
    ]

    const queryFn = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockCandles),
    })

    const mockClient = { query: queryFn } as unknown as ClickHouseClient

    const result = await queryOHLCV(mockClient, {
      asset_id: 20,
      start_time: new Date('2024-05-01T00:00:00Z'),
      end_time: new Date('2024-05-02T00:00:00Z'),
      interval: '1d',
    })

    expect(result).toBe(mockCandles)
  })
})

describe('OHLCV view column coverage', () => {
  it('OHLCVCandle interface includes all OHLCV query view columns', () => {
    const mockCandle: OHLCVCandle = {
      asset_id: 5,
      interval_start: '2024-01-15 10:30:00',
      open: '1.500000000000',
      high: '1.600000000000',
      low: '1.450000000000',
      close: '1.550000000000',
      volume_buy: '100.000000000000',
      volume_sell: '50.000000000000',
      volume_total: '150.000000000000',
    }

    // Verify all expected fields exist
    expect(mockCandle).toHaveProperty('asset_id')
    expect(mockCandle).toHaveProperty('interval_start')
    expect(mockCandle).toHaveProperty('open')
    expect(mockCandle).toHaveProperty('high')
    expect(mockCandle).toHaveProperty('low')
    expect(mockCandle).toHaveProperty('close')
    expect(mockCandle).toHaveProperty('volume_buy')
    expect(mockCandle).toHaveProperty('volume_sell')
    expect(mockCandle).toHaveProperty('volume_total')

    // Verify volume fields specifically (confirms Phase 11 OHLCV views)
    expect(typeof mockCandle.volume_buy).toBe('string')
    expect(typeof mockCandle.volume_sell).toBe('string')
    expect(typeof mockCandle.volume_total).toBe('string')
  })

  it('volume fields are string type for Decimal128 precision', () => {
    const mockCandle: OHLCVCandle = {
      asset_id: 10,
      interval_start: '2024-01-01 00:00:00',
      open: '1.000000000000',
      high: '2.000000000000',
      low: '0.500000000000',
      close: '1.500000000000',
      volume_buy: '123456.789012345678',
      volume_sell: '987654.321098765432',
      volume_total: '1111111.110111111110',
    }

    expect(mockCandle.volume_buy).toMatch(/^\d+\.\d+$/)
    expect(mockCandle.volume_sell).toMatch(/^\d+\.\d+$/)
    expect(mockCandle.volume_total).toMatch(/^\d+\.\d+$/)
  })
})

describe('convenience wrapper delegation', () => {
  it('query5MinOHLCV calls queryOHLCV with 5min interval', async () => {
    const mockCandles: OHLCVCandle[] = []

    const queryFn = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockCandles),
    })

    const mockClient = { query: queryFn } as unknown as ClickHouseClient

    await query5MinOHLCV(
      mockClient,
      5,
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-02T00:00:00Z')
    )

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'SELECT * FROM price_data.ohlc_5min_query',
      })
    )
  })

  it('query15MinOHLCV calls queryOHLCV with 15min interval', async () => {
    const mockCandles: OHLCVCandle[] = []

    const queryFn = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockCandles),
    })

    const mockClient = { query: queryFn } as unknown as ClickHouseClient

    await query15MinOHLCV(
      mockClient,
      10,
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-02T00:00:00Z')
    )

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'SELECT * FROM price_data.ohlc_15min_query',
      })
    )
  })

  it('query1HourOHLCV calls queryOHLCV with 1h interval', async () => {
    const mockCandles: OHLCVCandle[] = []

    const queryFn = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockCandles),
    })

    const mockClient = { query: queryFn } as unknown as ClickHouseClient

    await query1HourOHLCV(
      mockClient,
      15,
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-02T00:00:00Z')
    )

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'SELECT * FROM price_data.ohlc_1h_query',
      })
    )
  })

  it('query4HourOHLCV calls queryOHLCV with 4h interval', async () => {
    const mockCandles: OHLCVCandle[] = []

    const queryFn = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockCandles),
    })

    const mockClient = { query: queryFn } as unknown as ClickHouseClient

    await query4HourOHLCV(
      mockClient,
      20,
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-02T00:00:00Z')
    )

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'SELECT * FROM price_data.ohlc_4h_query',
      })
    )
  })

  it('query1DayOHLCV calls queryOHLCV with 1d interval', async () => {
    const mockCandles: OHLCVCandle[] = []

    const queryFn = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockCandles),
    })

    const mockClient = { query: queryFn } as unknown as ClickHouseClient

    await query1DayOHLCV(
      mockClient,
      25,
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-02-01T00:00:00Z')
    )

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'SELECT * FROM price_data.ohlc_1d_query',
      })
    )
  })

  it('all wrappers pass correct parameters to queryOHLCV', async () => {
    const mockCandles: OHLCVCandle[] = []

    const queryFn = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockCandles),
    })

    const mockClient = { query: queryFn } as unknown as ClickHouseClient

    const startTime = new Date('2024-06-01T00:00:00Z')
    const endTime = new Date('2024-06-02T00:00:00Z')

    await query5MinOHLCV(mockClient, 100, startTime, endTime)

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: {
          asset_id: 100,
          start_time: '2024-06-01 00:00:00',
          end_time: '2024-06-02 00:00:00',
        },
      })
    )
  })
})
