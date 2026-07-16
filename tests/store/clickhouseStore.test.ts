import { describe, expect, it } from 'vitest'
import { ClickHouseStore } from '../../src/store/clickhouseStore.ts'

type InsertCall = {
  table: string
  values: any[]
  token?: string
}

class FakeClickHouseClient {
  readonly inserts: InsertCall[] = []
  readonly existingBlocks: Set<number>
  readonly existingPrices: Set<string>
  readonly existingTradeVolumes: Set<string>
  readonly existingRuntimeUpgrades: Set<string>

  constructor(existing: {
    blocks?: number[]
    prices?: string[]
    tradeVolumes?: string[]
    runtimeUpgrades?: string[]
  } = {}) {
    this.existingBlocks = new Set(existing.blocks ?? [])
    this.existingPrices = new Set(existing.prices ?? [])
    this.existingTradeVolumes = new Set(existing.tradeVolumes ?? [])
    this.existingRuntimeUpgrades = new Set(existing.runtimeUpgrades ?? [])
  }

  async insert(options: { table: string; values: any[]; clickhouse_settings?: { insert_deduplication_token?: string } }): Promise<void> {
    this.inserts.push({
      table: options.table,
      values: options.values,
      token: options.clickhouse_settings?.insert_deduplication_token,
    })
  }

  async query(options: { query: string; query_params?: Record<string, any> }): Promise<{ json: <T>() => Promise<T[]> }> {
    const params = options.query_params ?? {}

    if (options.query.includes('FROM price_data.blocks')) {
      const blocks = new Set<number>(params.blocks ?? [])
      const rows = [...this.existingBlocks]
        .filter(blockHeight => blocks.has(blockHeight))
        .map(blockHeight => ({ block_height: blockHeight }))
      return { json: async <T>() => rows as T[] }
    }

    if (options.query.includes('FROM price_data.prices')) {
      const blocks = new Set<number>(params.blocks ?? [])
      const assetIds = new Set<number>(params.asset_ids ?? [])
      const rows = [...this.existingPrices].flatMap(key => {
        const [assetId, blockHeight] = key.split(':').map(Number)
        return blocks.has(blockHeight) && assetIds.has(assetId)
          ? [{ asset_id: assetId, block_height: blockHeight }]
          : []
      })
      return { json: async <T>() => rows as T[] }
    }

    if (options.query.includes('FROM price_data.trade_volume_by_account')) {
      const blocks = new Set<number>(params.blocks ?? [])
      const assetIds = new Set<number>(params.asset_ids ?? [])
      const accounts = new Set<string>(params.accounts ?? [])
      const rows = [...this.existingTradeVolumes].flatMap(key => {
        const [assetIdValue, blockHeightValue, account] = key.split(':')
        const assetId = Number(assetIdValue)
        const blockHeight = Number(blockHeightValue)
        return blocks.has(blockHeight) && assetIds.has(assetId) && accounts.has(account)
          ? [{ asset_id: assetId, block_height: blockHeight, account }]
          : []
      })
      return { json: async <T>() => rows as T[] }
    }

    if (options.query.includes('FROM price_data.runtime_upgrades')) {
      const blocks = new Set<number>(params.blocks ?? [])
      const rows = [...this.existingRuntimeUpgrades].flatMap(key => {
        const [blockHeightValue, specVersionValue, prevSpecVersionValue] = key.split(':')
        const blockHeight = Number(blockHeightValue)
        return blocks.has(blockHeight)
          ? [{
              block_height: blockHeight,
              spec_version: Number(specVersionValue),
              prev_spec_version: Number(prevSpecVersionValue),
            }]
          : []
      })
      return { json: async <T>() => rows as T[] }
    }

    return { json: async <T>() => [] as T[] }
  }
}

function insertedValues(fake: FakeClickHouseClient, table: string): any[] {
  return fake.inserts.find(insert => insert.table === table)?.values ?? []
}

describe('ClickHouseStore retry idempotency', () => {
  it('skips existing row keys without treating existing blocks as completed prices', async () => {
    const fake = new FakeClickHouseClient({
      blocks: [10],
      prices: ['1:10'],
      tradeVolumes: ['2:10:account-a'],
      runtimeUpgrades: ['20:300:299'],
    })
    const store = new ClickHouseStore(fake as any, 10_000, 'retry', 'main-backfill-10-20')

    store.addBlocks([
      { block_height: 10, block_timestamp: '2026-06-21 00:00:00', spec_version: 1 },
      { block_height: 11, block_timestamp: '2026-06-21 00:00:12', spec_version: 1 },
    ])
    store.addPrices([
      { asset_id: 1, block_height: 10, usd_price: '1.000000000000' },
      { asset_id: 2, block_height: 10, block_timestamp: '2026-06-21 00:00:00', usd_price: '2.000000000000' },
      { asset_id: 1, block_height: 11, block_timestamp: '2026-06-21 00:00:12', usd_price: '1.100000000000' },
    ])
    store.addTradeVolumes([
      { asset_id: 2, block_height: 10, account: 'account-a', trade_count: 1 },
      { asset_id: 3, block_height: 10, account: 'account-b', trade_count: 1 },
    ])
    store.addRuntimeUpgrades([
      { block_height: 20, spec_version: 300, prev_spec_version: 299 },
      { block_height: 21, spec_version: 301, prev_spec_version: 300 },
    ])

    await store.flushAll()

    expect(insertedValues(fake, 'price_data.blocks').map(row => row.block_height)).toEqual([11])
    expect(insertedValues(fake, 'price_data.prices').map(row => `${row.asset_id}:${row.block_height}`)).toEqual([
      '2:10',
      '1:11',
    ])
    expect(insertedValues(fake, 'price_data.trade_volume_by_account').map(row => `${row.asset_id}:${row.block_height}:${row.account}`)).toEqual([
      '3:10:account-b',
    ])
    expect(insertedValues(fake, 'price_data.runtime_upgrades').map(row => `${row.block_height}:${row.spec_version}:${row.prev_spec_version}`)).toEqual([
      '21:301:300',
    ])
  })

  it('deduplicates repeated rows within the same flush batch', async () => {
    const fake = new FakeClickHouseClient()
    const store = new ClickHouseStore(fake as any, 10_000, 'retry', 'main-backfill-5-6')

    store.addBlocks([
      { block_height: 5, block_timestamp: '2026-06-21 00:00:00', spec_version: 1 },
      { block_height: 5, block_timestamp: '2026-06-21 00:00:12', spec_version: 2 },
    ])
    store.addPrices([
      { asset_id: 1, block_height: 5, block_timestamp: '2026-06-21 00:00:00', usd_price: '1.000000000000' },
      { asset_id: 1, block_height: 5, block_timestamp: '2026-06-21 00:00:12', usd_price: '1.100000000000' },
    ])

    await store.flushAll()

    expect(insertedValues(fake, 'price_data.blocks')).toEqual([
      { block_height: 5, block_timestamp: '2026-06-21 00:00:12', spec_version: 2 },
    ])
    expect(insertedValues(fake, 'price_data.prices')).toEqual([
      { asset_id: 1, block_height: 5, block_timestamp: '2026-06-21 00:00:12', usd_price: '1.100000000000' },
    ])
  })

  it('uses content-addressed tokens for equal-sized batches with the same bounds', async () => {
    const fake = new FakeClickHouseClient()
    const store = new ClickHouseStore(fake as any, 10_000, 'same-replay')

    store.addAssets([{ asset_id: 1, symbol: 'ONE', name: 'One', decimals: 12, parachain_id: null }])
    await store.flushAssets()
    store.addAssets([{ asset_id: 1, symbol: 'ONE2', name: 'One v2', decimals: 12, parachain_id: null }])
    await store.flushAssets()

    expect(fake.inserts).toHaveLength(2)
    expect(fake.inserts[0].token).not.toBe(fake.inserts[1].token)
  })

  it('honors the configured insert batch size', async () => {
    const fake = new FakeClickHouseClient()
    const store = new ClickHouseStore(fake as any, 2, 'chunked')
    store.addBlocks(Array.from({ length: 5 }, (_, blockHeight) => ({
      block_height: blockHeight,
      block_timestamp: '2026-06-21 00:00:00',
      spec_version: 1,
    })))

    await store.flushBlocks()

    expect(fake.inserts.map(insert => insert.values.length)).toEqual([2, 2, 1])
  })

  it('defers historical publication until explicitly published', async () => {
    const fake = new FakeClickHouseClient()
    const store = new ClickHouseStore(fake as any, 10_000, 'deferred', 'main-backfill-10-12', {
      deferPublication: true,
    })

    store.addBlocks([
      { block_height: 10, block_timestamp: '2026-06-21 00:00:00', spec_version: 1 },
    ])
    store.addPrices([
      { asset_id: 1, block_height: 10, block_timestamp: '2026-06-21 00:00:00', usd_price: '1.000000000000' },
    ])
    await store.flushAll()

    store.addBlocks([
      { block_height: 11, block_timestamp: '2026-06-21 00:00:12', spec_version: 1 },
      { block_height: 11, block_timestamp: '2026-06-21 00:00:12', spec_version: 1 },
    ])
    store.addPrices([
      { asset_id: 1, block_height: 11, block_timestamp: '2026-06-21 00:00:12', usd_price: '1.100000000000' },
      { asset_id: 1, block_height: 11, block_timestamp: '2026-06-21 00:00:12', usd_price: '1.100000000000' },
    ])
    await store.flushAll()

    expect(fake.inserts).toEqual([])

    await store.publishDeferred()

    expect(insertedValues(fake, 'price_data.blocks').map(row => row.block_height)).toEqual([10, 11])
    expect(insertedValues(fake, 'price_data.prices').map(row => `${row.asset_id}:${row.block_height}`)).toEqual([
      '1:10',
      '1:11',
    ])
  })

  it('publishes deferred rows in threshold-sized chunks', async () => {
    const fake = new FakeClickHouseClient()
    const store = new ClickHouseStore(fake as any, 2, 'deferred-chunks', 'main-backfill-1-5', {
      deferPublication: true,
    })
    store.addBlocks(Array.from({ length: 5 }, (_, index) => ({
      block_height: index + 1,
      block_timestamp: '2026-06-21 00:00:00',
      spec_version: 1,
    })))

    await store.flushAll()
    await store.publishDeferred()

    expect(fake.inserts.map(insert => insert.values.length)).toEqual([2, 2, 1])
  })

  it('rejects new price rows without a timestamp instead of silently skipping OHLC', async () => {
    const fake = new FakeClickHouseClient()
    const store = new ClickHouseStore(fake as any)
    store.addPrices([{ asset_id: 1, block_height: 12, usd_price: '1.2' }])

    await expect(store.flushPrices()).rejects.toThrow('has no valid block_timestamp')
    expect(fake.inserts).toEqual([])
  })

  it('accepts the epoch timestamp only for genesis price rows', async () => {
    const fake = new FakeClickHouseClient()
    const store = new ClickHouseStore(fake as any)
    store.addPrices([{
      asset_id: 1,
      block_height: 0,
      block_timestamp: '1970-01-01 00:00:00',
      usd_price: '1.000000000000',
    }])

    await store.flushPrices()

    expect(insertedValues(fake, 'price_data.prices')).toHaveLength(1)
  })
})
