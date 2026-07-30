import { afterEach, describe, expect, it } from 'vitest'
import { RawClickHouseStore } from '../../src/raw/store.ts'
import type { RawBalanceObservationRow } from '../../src/raw/types.ts'

class FakeClickHouseClient {
  readonly inserts: Array<{ table: string; values: unknown[] }> = []

  async insert(options: { table: string; values: unknown[] }): Promise<void> {
    this.inserts.push({ table: options.table, values: options.values })
  }
}

function balanceRow(blockHeight: number, id: number): RawBalanceObservationRow {
  return {
    block_height: blockHeight,
    block_timestamp: '2026-07-01 00:00:00',
    observation_id: `event:${id}`,
    account_id: `0x${id.toString(16).padStart(64, '0')}`,
    asset_kind: 'substrate',
    asset_id: '0',
    free: '1',
    reserved: '0',
    frozen: '0',
    total: '1',
    nonce: 0,
    flags: null,
    source_kind: 'event',
    source_name: 'Balances.Transfer',
    source_event_index: id,
    source_call_address: null,
    evidence_json: '{}',
    ingest_source: 'test',
  }
}

describe('RawClickHouseStore balance observation inserts', () => {
  afterEach(() => {
    delete process.env.RAW_BALANCE_INSERT_CHUNK_SIZE
    delete process.env.RAW_BALANCE_INSERT_MAX_BYTES
  })

  it('chunks large balance observation flushes by row count', async () => {
    process.env.RAW_BALANCE_INSERT_CHUNK_SIZE = '2'
    const fake = new FakeClickHouseClient()
    const store = new RawClickHouseStore(fake as never, 10_000)

    store.addBalanceObservations([
      balanceRow(10, 1),
      balanceRow(11, 2),
      balanceRow(12, 3),
      balanceRow(13, 4),
      balanceRow(14, 5),
    ])

    await store.flushBalanceObservations()

    expect(fake.inserts.map(i => i.values.length)).toEqual([2, 2, 1])
    expect(fake.inserts.map(i => i.table)).toEqual([
      'price_data.raw_balance_observations',
      'price_data.raw_balance_observations',
      'price_data.raw_balance_observations',
    ])
    // Every observation is written exactly once, in order: chunking must not drop
    // or repeat a row, and the ReplacingMergeTree key is what makes a replay safe.
    expect(fake.inserts.flatMap(i => (i.values as RawBalanceObservationRow[]).map(row => row.block_height)))
      .toEqual([10, 11, 12, 13, 14])
  })

  it('splits balance observation inserts by estimated JSON bytes', async () => {
    process.env.RAW_BALANCE_INSERT_CHUNK_SIZE = '100'
    process.env.RAW_BALANCE_INSERT_MAX_BYTES = '900'
    const fake = new FakeClickHouseClient()
    const store = new RawClickHouseStore(fake as never, 10_000)

    const rows = [balanceRow(20, 1), balanceRow(21, 2), balanceRow(22, 3)]
      .map((row, i) => ({ ...row, evidence_json: JSON.stringify({ payload: 'x'.repeat(500), i }) }))
    store.addBalanceObservations(rows)

    await store.flushBalanceObservations()

    expect(fake.inserts).toHaveLength(3)
    expect(fake.inserts.every(i => i.values.length === 1)).toBe(true)
    expect(fake.inserts.flatMap(i => (i.values as RawBalanceObservationRow[]).map(row => row.block_height)))
      .toEqual([20, 21, 22])
  })
})
