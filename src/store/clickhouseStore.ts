import { type ClickHouseClient } from '../db/client.js'
import { type PriceRow, type BlockRow, type AssetRow, type RuntimeUpgradeRow } from '../db/schema.js'
import { BatchAccumulator } from './batch.js'
import { getLastProcessedBlock, saveCheckpoint } from './checkpoint.js'

// Stack-safe min/max computation for large arrays.
// Avoids spread operator which can cause stack overflow on large batches.
function minMax(rows: { block_height: number }[]): { min: number; max: number } {
  let min = rows[0].block_height
  let max = rows[0].block_height
  for (let i = 1; i < rows.length; i++) {
    const h = rows[i].block_height
    if (h < min) min = h
    if (h > max) max = h
  }
  return { min, max }
}

export class ClickHouseStore {
  private readonly client: ClickHouseClient
  private readonly pricesBatch: BatchAccumulator<PriceRow>
  private readonly blocksBatch: BatchAccumulator<BlockRow>
  private readonly assetsBatch: BatchAccumulator<AssetRow>
  private readonly runtimeUpgradesBatch: BatchAccumulator<RuntimeUpgradeRow>

  constructor(client: ClickHouseClient, flushThreshold: number = 10_000) {
    this.client = client
    this.pricesBatch = new BatchAccumulator<PriceRow>(flushThreshold)
    this.blocksBatch = new BatchAccumulator<BlockRow>(flushThreshold)
    this.assetsBatch = new BatchAccumulator<AssetRow>(flushThreshold)
    this.runtimeUpgradesBatch = new BatchAccumulator<RuntimeUpgradeRow>(flushThreshold)
  }

  addPrices(rows: PriceRow[]): void {
    this.pricesBatch.add(rows)
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

  async flushPrices(): Promise<void> {
    const rows = this.pricesBatch.flush()
    if (rows.length === 0) return

    const { min: minBlock, max: maxBlock } = minMax(rows)
    const token = `prices-${minBlock}-${maxBlock}-${rows.length}`

    await this.client.insert({
      table: 'price_data.prices',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: token,
      },
    })
  }

  async flushBlocks(): Promise<void> {
    const rows = this.blocksBatch.flush()
    if (rows.length === 0) return

    const { min: minBlock, max: maxBlock } = minMax(rows)
    const token = `blocks-${minBlock}-${maxBlock}`

    await this.client.insert({
      table: 'price_data.blocks',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: token,
      },
    })
  }

  async flushAssets(): Promise<void> {
    const rows = this.assetsBatch.flush()
    if (rows.length === 0) return

    const assetIds = rows.map(r => r.asset_id).sort((a, b) => a - b)
    const minAssetId = assetIds[0]
    const maxAssetId = assetIds[assetIds.length - 1]
    const token = `assets-${minAssetId}-${maxAssetId}-${rows.length}`

    await this.client.insert({
      table: 'price_data.assets',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: token,
      },
    })
  }

  async flushRuntimeUpgrades(): Promise<void> {
    const rows = this.runtimeUpgradesBatch.flush()
    if (rows.length === 0) return

    const { min: minBlock, max: maxBlock } = minMax(rows)
    const token = `runtime-upgrades-${minBlock}-${maxBlock}`

    await this.client.insert({
      table: 'price_data.runtime_upgrades',
      values: rows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        insert_deduplication_token: token,
      },
    })
  }

  // Blocks must be flushed before prices -- OHLC materialized views JOIN against
  // blocks on INSERT to prices, so missing blocks = incomplete candles.
  async flushAll(): Promise<void> {
    await this.flushBlocks()
    await this.flushPrices()
    await this.flushAssets()
    await this.flushRuntimeUpgrades()
  }

  async saveCheckpoint(blockHeight: number): Promise<void> {
    await saveCheckpoint(this.client, blockHeight)
  }

  async getLastProcessedBlock(): Promise<number> {
    return await getLastProcessedBlock(this.client)
  }
}
