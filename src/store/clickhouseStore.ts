import { type ClickHouseClient } from '../db/client.js'
import { type PriceRow, type TradeVolumeRow, type BlockRow, type AssetRow, type RuntimeUpgradeRow } from '../db/schema.js'
import { BatchAccumulator, chunkRows } from './batch.js'
import { buildInsertDedupeToken } from './dedupeToken.js'
import { getLastProcessedBlock, saveCheckpoint } from './checkpoint.js'
import { parseClickHouseDateTime } from '../db/timestamp.js'
import { blockHeightRange } from '../util/collections.js'

type BlockHeightRow = Pick<BlockRow, 'block_height'>
type PriceKeyRow = Pick<PriceRow, 'asset_id' | 'block_height'>
type TradeVolumeKeyRow = Pick<TradeVolumeRow, 'asset_id' | 'block_height' | 'account'>
type AssetKeyRow = Pick<AssetRow, 'asset_id'>
type RuntimeUpgradeKeyRow = Pick<RuntimeUpgradeRow, 'block_height' | 'spec_version' | 'prev_spec_version'>

export interface ClickHouseStoreOptions {
  deferPublication?: boolean
}

// Append in place without spreading: `target.push(...source)` passes each element
// as a separate argument, so a large batch (a multi-thousand-block backfill range
// defers hundreds of thousands of price rows) overflows the JS argument/stack limit
// with "Maximum call stack size exceeded". A loop makes batch size irrelevant.
function appendAll<T>(target: T[], source: T[]): void {
  for (let i = 0; i < source.length; i++) target.push(source[i])
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)]
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function uniqueRowsByKey<T>(rows: T[], keyOf: (row: T) => string): T[] {
  const unique = new Map<string, T>()
  for (const row of rows) {
    unique.set(keyOf(row), row)
  }
  return [...unique.values()]
}

function blockKey(row: BlockHeightRow): string {
  return row.block_height.toString()
}

function priceKey(row: PriceKeyRow): string {
  return `${row.asset_id}:${row.block_height}`
}

function tradeVolumeKey(row: TradeVolumeKeyRow): string {
  return `${row.asset_id}:${row.block_height}:${row.account}`
}

function assetKey(row: AssetKeyRow): string {
  return row.asset_id.toString()
}

function runtimeUpgradeKey(row: RuntimeUpgradeKeyRow): string {
  return `${row.block_height}:${row.spec_version}:${row.prev_spec_version}`
}

export class ClickHouseStore {
  private readonly client: ClickHouseClient
  private readonly pricesBatch: BatchAccumulator<PriceRow>
  private readonly tradeVolumesBatch: BatchAccumulator<TradeVolumeRow>
  private readonly blocksBatch: BatchAccumulator<BlockRow>
  private readonly assetsBatch: BatchAccumulator<AssetRow>
  private readonly runtimeUpgradesBatch: BatchAccumulator<RuntimeUpgradeRow>
  private replayNamespace: string
  private readonly checkpointId: string
  private readonly deferPublication: boolean
  private readonly publicationChunkSize: number
  private readonly deferredPrices: PriceRow[] = []
  private readonly deferredTradeVolumes: TradeVolumeRow[] = []
  private readonly deferredBlocks: BlockRow[] = []
  private readonly deferredAssets: AssetRow[] = []
  private readonly deferredRuntimeUpgrades: RuntimeUpgradeRow[] = []

  constructor(
    client: ClickHouseClient,
    flushThreshold: number = 10_000,
    replayNamespace: string = 'bootstrap',
    checkpointId: string = 'main',
    options: ClickHouseStoreOptions = {},
  ) {
    this.client = client
    this.pricesBatch = new BatchAccumulator<PriceRow>(flushThreshold)
    this.tradeVolumesBatch = new BatchAccumulator<TradeVolumeRow>(flushThreshold)
    this.blocksBatch = new BatchAccumulator<BlockRow>(flushThreshold)
    this.assetsBatch = new BatchAccumulator<AssetRow>(flushThreshold)
    this.runtimeUpgradesBatch = new BatchAccumulator<RuntimeUpgradeRow>(flushThreshold)
    this.replayNamespace = replayNamespace
    this.checkpointId = checkpointId
    this.deferPublication = options.deferPublication === true
    this.publicationChunkSize = flushThreshold
  }

  addPrices(rows: PriceRow[]): void {
    this.pricesBatch.add(rows)
  }

  addTradeVolumes(rows: TradeVolumeRow[]): void {
    this.tradeVolumesBatch.add(rows)
  }

  addBlocks(rows: BlockRow[]): void {
    this.blocksBatch.add(rows)
  }

  addAssets(rows: AssetRow[]): void {
    this.assetsBatch.add(rows)
  }

  addRuntimeUpgrades(rows: RuntimeUpgradeRow[]): void {
    this.runtimeUpgradesBatch.add(rows)
  }

  private async existingBlockHeights(rows: BlockHeightRow[]): Promise<Set<string>> {
    const blockHeights = uniqueNumbers(rows.map(row => row.block_height))
    if (blockHeights.length === 0) return new Set()

    const result = await this.client.query({
      query: `
        SELECT DISTINCT block_height
        FROM price_data.blocks
        WHERE block_height IN ({blocks:Array(UInt32)})
      `,
      query_params: { blocks: blockHeights },
      format: 'JSONEachRow',
    })
    const existing = await result.json<BlockHeightRow>()
    return new Set(existing.map(blockKey))
  }

  private async existingPriceKeys(rows: PriceRow[]): Promise<Set<string>> {
    const blockHeights = uniqueNumbers(rows.map(row => row.block_height))
    const assetIds = uniqueNumbers(rows.map(row => row.asset_id))
    if (blockHeights.length === 0 || assetIds.length === 0) return new Set()

    const result = await this.client.query({
      query: `
        SELECT asset_id, block_height
        FROM price_data.prices FINAL
        WHERE block_height IN ({blocks:Array(UInt32)})
          AND asset_id IN ({asset_ids:Array(UInt32)})
      `,
      query_params: { blocks: blockHeights, asset_ids: assetIds },
      format: 'JSONEachRow',
    })
    const existing = await result.json<PriceKeyRow>()
    return new Set(existing.map(priceKey))
  }

  private async existingTradeVolumeKeys(rows: TradeVolumeRow[]): Promise<Set<string>> {
    const blockHeights = uniqueNumbers(rows.map(row => row.block_height))
    const assetIds = uniqueNumbers(rows.map(row => row.asset_id))
    const accounts = uniqueStrings(rows.map(row => row.account))
    if (blockHeights.length === 0 || assetIds.length === 0 || accounts.length === 0) return new Set()

    const result = await this.client.query({
      query: `
        SELECT asset_id, block_height, account
        FROM price_data.trade_volume_by_account FINAL
        WHERE block_height IN ({blocks:Array(UInt32)})
          AND asset_id IN ({asset_ids:Array(UInt32)})
          AND account IN ({accounts:Array(String)})
      `,
      query_params: { blocks: blockHeights, asset_ids: assetIds, accounts },
      format: 'JSONEachRow',
    })
    const existing = await result.json<TradeVolumeKeyRow>()
    return new Set(existing.map(tradeVolumeKey))
  }

  private async existingRuntimeUpgradeKeys(rows: RuntimeUpgradeRow[]): Promise<Set<string>> {
    const blockHeights = uniqueNumbers(rows.map(row => row.block_height))
    if (blockHeights.length === 0) return new Set()

    const result = await this.client.query({
      query: `
        SELECT block_height, spec_version, prev_spec_version
        FROM price_data.runtime_upgrades
        WHERE block_height IN ({blocks:Array(UInt32)})
      `,
      query_params: { blocks: blockHeights },
      format: 'JSONEachRow',
    })
    const existing = await result.json<RuntimeUpgradeKeyRow>()
    return new Set(existing.map(runtimeUpgradeKey))
  }

  private async insertPriceRows(rowsToInsert: PriceRow[]): Promise<void> {
    const rows = uniqueRowsByKey(rowsToInsert, priceKey)
    if (rows.length === 0) return

    const existing = await this.existingPriceKeys(rows)
    const newRows = rows.filter(row => !existing.has(priceKey(row)))
    if (newRows.length === 0) return
    const invalidTimestamp = newRows.find(row => {
      if (row.block_timestamp == null) return true
      const millis = parseClickHouseDateTime(row.block_timestamp)
      return !Number.isFinite(millis) || millis < 0 || (millis === 0 && row.block_height !== 0)
    })
    if (invalidTimestamp) {
      throw new Error(`Price ${priceKey(invalidTimestamp)} has no valid block_timestamp; refusing to publish a price without OHLC candles`)
    }

    const { min: minBlock, max: maxBlock } = blockHeightRange(newRows)
    const token = buildInsertDedupeToken('prices', this.replayNamespace, newRows, [minBlock, maxBlock])

    await this.client.insert({
      table: 'price_data.prices',
      values: newRows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: token,
      },
    })
  }

  async flushPrices(): Promise<void> {
    for (const rows of this.pricesBatch.flushChunks()) {
      await this.insertPriceRows(rows)
    }
  }

  private async insertTradeVolumeRows(rowsToInsert: TradeVolumeRow[]): Promise<void> {
    const rows = uniqueRowsByKey(rowsToInsert, tradeVolumeKey)
    if (rows.length === 0) return

    const existing = await this.existingTradeVolumeKeys(rows)
    const newRows = rows.filter(row => !existing.has(tradeVolumeKey(row)))
    if (newRows.length === 0) return

    const { min: minBlock, max: maxBlock } = blockHeightRange(newRows)
    const token = buildInsertDedupeToken('trade-volumes', this.replayNamespace, newRows, [minBlock, maxBlock])

    await this.client.insert({
      table: 'price_data.trade_volume_by_account',
      values: newRows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: token,
      },
    })
  }

  async flushTradeVolumes(): Promise<void> {
    for (const rows of this.tradeVolumesBatch.flushChunks()) {
      await this.insertTradeVolumeRows(rows)
    }
  }

  private async insertBlockRows(rowsToInsert: BlockRow[]): Promise<void> {
    const rows = uniqueRowsByKey(rowsToInsert, blockKey)
    if (rows.length === 0) return

    const existing = await this.existingBlockHeights(rows)
    const newRows = rows.filter(row => !existing.has(blockKey(row)))
    if (newRows.length === 0) return

    const { min: minBlock, max: maxBlock } = blockHeightRange(newRows)
    const token = buildInsertDedupeToken('blocks', this.replayNamespace, newRows, [minBlock, maxBlock])

    await this.client.insert({
      table: 'price_data.blocks',
      values: newRows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: token,
      },
    })
  }

  async flushBlocks(): Promise<void> {
    for (const rows of this.blocksBatch.flushChunks()) {
      await this.insertBlockRows(rows)
    }
  }

  private async insertAssetRows(rowsToInsert: AssetRow[]): Promise<void> {
    const rows = uniqueRowsByKey(rowsToInsert, assetKey)
    if (rows.length === 0) return

    const assetIds = rows.map(r => r.asset_id).sort((a, b) => a - b)
    const minAssetId = assetIds[0]
    const maxAssetId = assetIds[assetIds.length - 1]
    const token = buildInsertDedupeToken('assets', this.replayNamespace, rows, [minAssetId, maxAssetId])

    await this.client.insert({
      table: 'price_data.assets',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: token,
      },
    })
  }

  async flushAssets(): Promise<void> {
    for (const rows of this.assetsBatch.flushChunks()) {
      await this.insertAssetRows(rows)
    }
  }

  private async insertRuntimeUpgradeRows(rowsToInsert: RuntimeUpgradeRow[]): Promise<void> {
    const rows = uniqueRowsByKey(rowsToInsert, runtimeUpgradeKey)
    if (rows.length === 0) return

    const existing = await this.existingRuntimeUpgradeKeys(rows)
    const newRows = rows.filter(row => !existing.has(runtimeUpgradeKey(row)))
    if (newRows.length === 0) return

    const { min: minBlock, max: maxBlock } = blockHeightRange(newRows)
    const token = buildInsertDedupeToken('runtime-upgrades', this.replayNamespace, newRows, [minBlock, maxBlock])

    await this.client.insert({
      table: 'price_data.runtime_upgrades',
      values: newRows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: token,
      },
    })
  }

  async flushRuntimeUpgrades(): Promise<void> {
    for (const rows of this.runtimeUpgradesBatch.flushChunks()) {
      await this.insertRuntimeUpgradeRows(rows)
    }
  }

  private stageCurrentBatches(): void {
    appendAll(this.deferredBlocks, this.blocksBatch.flush())
    appendAll(this.deferredPrices, this.pricesBatch.flush())
    appendAll(this.deferredTradeVolumes, this.tradeVolumesBatch.flush())
    appendAll(this.deferredAssets, this.assetsBatch.flush())
    appendAll(this.deferredRuntimeUpgrades, this.runtimeUpgradesBatch.flush())
  }

  async publishDeferred(): Promise<void> {
    this.stageCurrentBatches()

    for (const rows of chunkRows(this.deferredBlocks, this.publicationChunkSize)) {
      await this.insertBlockRows(rows)
    }
    for (const rows of chunkRows(this.deferredPrices, this.publicationChunkSize)) {
      await this.insertPriceRows(rows)
    }
    for (const rows of chunkRows(this.deferredTradeVolumes, this.publicationChunkSize)) {
      await this.insertTradeVolumeRows(rows)
    }
    for (const rows of chunkRows(this.deferredAssets, this.publicationChunkSize)) {
      await this.insertAssetRows(rows)
    }
    for (const rows of chunkRows(this.deferredRuntimeUpgrades, this.publicationChunkSize)) {
      await this.insertRuntimeUpgradeRows(rows)
    }

    this.deferredBlocks.length = 0
    this.deferredPrices.length = 0
    this.deferredTradeVolumes.length = 0
    this.deferredAssets.length = 0
    this.deferredRuntimeUpgrades.length = 0
  }

  // Keep blocks and prices visible in block order. Price rows now contain their
  // own timestamps, but publishing the block first preserves the public API's
  // expectation that every visible price has corresponding block metadata.
  async flushAll(): Promise<void> {
    if (this.deferPublication) {
      this.stageCurrentBatches()
      return
    }

    await this.flushBlocks()
    await this.flushPrices()
    await this.flushTradeVolumes()
    await this.flushAssets()
    await this.flushRuntimeUpgrades()
  }

  async saveCheckpoint(blockHeight: number): Promise<void> {
    this.replayNamespace = await saveCheckpoint(this.client, blockHeight, this.checkpointId)
  }

  setReplayNamespace(replayNamespace: string): void {
    this.replayNamespace = replayNamespace
  }

  async getLastProcessedBlock(): Promise<import('./checkpoint.js').IndexerCheckpointState> {
    return await getLastProcessedBlock(this.client, this.checkpointId)
  }
}
