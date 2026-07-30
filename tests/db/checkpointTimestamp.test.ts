import type { ClickHouseClient } from '@clickhouse/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseClickHouseDateTime, toClickHouseDateTime64 } from '../../src/db/timestamp.ts'
import { saveRawCheckpoint } from '../../src/raw/checkpoint.ts'
import { markRawRangeRunning } from '../../src/raw/ranges.ts'
import { saveCheckpoint } from '../../src/store/checkpoint.ts'

interface InsertCall {
  table: string
  values: Array<Record<string, unknown>>
}

function insertOnlyClient(calls: InsertCall[]): ClickHouseClient {
  return {
    insert: async (options: InsertCall) => {
      calls.push(options)
    },
  } as unknown as ClickHouseClient
}

function emptyRangeClient(calls: InsertCall[]): ClickHouseClient {
  return {
    query: () => ({
      json: async () => [],
    }),
    insert: async (options: InsertCall) => {
      calls.push(options)
    },
  } as unknown as ClickHouseClient
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ClickHouse version timestamps', () => {
  it('formats DateTime64 values without discarding milliseconds', () => {
    expect(toClickHouseDateTime64(new Date('2026-07-11T12:34:56.789Z')))
      .toBe('2026-07-11 12:34:56.789')
  })

  it('rejects invalid dates', () => {
    expect(() => toClickHouseDateTime64(new Date(Number.NaN))).toThrow(RangeError)
  })

  it('parses timezone-free ClickHouse timestamps as UTC', () => {
    expect(parseClickHouseDateTime('1970-01-01 00:00:00')).toBe(0)
    expect(parseClickHouseDateTime('2026-07-11 12:34:56.789')).toBe(
      Date.parse('2026-07-11T12:34:56.789Z'),
    )
  })

  it('preserves milliseconds in main and raw checkpoint versions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:34:56.789Z'))
    const calls: InsertCall[] = []
    const client = insertOnlyClient(calls)

    await saveCheckpoint(client, 123, 'main-test')
    await saveRawCheckpoint(client, 'raw-test', 123, '0x123', 'archive')

    expect(calls.map(call => call.values[0].updated_at)).toEqual([
      '2026-07-11 12:34:56.789',
      '2026-07-11 12:34:56.789',
    ])
  })

  it('preserves milliseconds in raw range state versions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:34:56.789Z'))
    const calls: InsertCall[] = []

    await markRawRangeRunning(emptyRangeClient(calls), 'range-test', 10, 20)

    expect(calls).toHaveLength(1)
    expect(calls[0].values[0]).toMatchObject({
      started_at: '2026-07-11 12:34:56',
      updated_at: '2026-07-11 12:34:56.789',
    })
  })
})
