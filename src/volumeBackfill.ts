/**
 * Volume Backfill Module
 *
 * Backfills historical volume data for blocks already indexed with prices only.
 * Uses a separate SQD processor (swap events only) to replay blocks and calculate volumes
 * from stored prices in ClickHouse.
 *
 * Architecture:
 * - Runs independently of main indexer
 * - Tracks progress via 'volume_backfill' checkpoint key
 * - Reads stored prices from ClickHouse for USDT volume calculation
 * - Inserts complete (price+volume) rows that replace price-only rows via ReplacingMergeTree
 * - Only fetches blocks with swap events (much faster than replaying all blocks)
 */

import { createProcessor } from './processor.js'
import { createClickHouseClient, type ClickHouseClient } from './db/client.js'
import { config } from './config.js'
import { getLastProcessedBlock, saveCheckpoint } from './store/checkpoint.js'
import { extractVolumeFromSwaps, mergePriceAndVolumeRows } from './blocks/extractVolume.js'
import { AssetRegistryTracker } from './registry/tracker.js'
import type { PriceRow } from './db/schema.js'
import type { HotDatabase, HotDatabaseState, FinalTxInfo, HotTxInfo, HashAndHeight } from '@subsquid/util-internal-processor-tools'
import { ClickHouseStore } from './store/clickhouseStore.js'

const VOLUME_CHECKPOINT_KEY = 'volume_backfill'

/**
 * Read stored prices from ClickHouse for a block range
 *
 * Returns a map of block_height -> (asset_id -> usdt_price)
 */
async function readStoredPrices(
  client: ClickHouseClient,
  fromBlock: number,
  toBlock: number
): Promise<Map<number, Map<number, string>>> {
  const result = await client.query({
    query: `SELECT asset_id, block_height, usdt_price
            FROM price_data.prices
            WHERE block_height >= {fromBlock: UInt32} AND block_height <= {toBlock: UInt32}
            ORDER BY block_height`,
    query_params: { fromBlock, toBlock },
    format: 'JSONEachRow',
  })

  const rows = await result.json<{ asset_id: number; block_height: number; usdt_price: string }>()

  const pricesByBlock = new Map<number, Map<number, string>>()
  for (const row of rows) {
    let blockPrices = pricesByBlock.get(row.block_height)
    if (!blockPrices) {
      blockPrices = new Map()
      pricesByBlock.set(row.block_height, blockPrices)
    }
    blockPrices.set(row.asset_id, row.usdt_price)
  }

  return pricesByBlock
}

/**
 * VolumeDatabase adapter
 *
 * Minimal HotDatabase implementation for volume backfill that uses a dedicated checkpoint key.
 * Re-uses ClickHouseStore but only calls flushPrices() (no blocks, assets, or runtime upgrades).
 */
class VolumeDatabase implements HotDatabase<ClickHouseStore> {
  supportsHotBlocks = true as const
  private store: ClickHouseStore | null = null

  async connect(): Promise<HotDatabaseState> {
    const client = createClickHouseClient()
    this.store = new ClickHouseStore(client, config.BATCH_SIZE)

    const lastBlock = await getLastProcessedBlock(client, VOLUME_CHECKPOINT_KEY)

    return {
      height: lastBlock,
      hash: '0x',
      top: [],
    }
  }

  async transact(info: FinalTxInfo, cb: (store: ClickHouseStore) => Promise<void>): Promise<void> {
    if (!this.store) {
      throw new Error('VolumeDatabase not connected')
    }

    await cb(this.store)
    await this.store.flushPrices()
    await saveCheckpoint(this.store['client'], info.nextHead.height, VOLUME_CHECKPOINT_KEY)
  }

  async transactHot(info: HotTxInfo, cb: (store: ClickHouseStore, block: HashAndHeight) => Promise<void>): Promise<void> {
    if (!this.store) {
      throw new Error('VolumeDatabase not connected')
    }

    for (const block of info.newBlocks) {
      await cb(this.store, block)
    }

    await this.store.flushPrices()
    await saveCheckpoint(this.store['client'], info.finalizedHead.height, VOLUME_CHECKPOINT_KEY)
  }
}

/**
 * Backfill volumes for blocks already indexed with prices only
 *
 * Main entry point for the --backfill-volumes CLI command.
 */
export async function backfillVolumes(): Promise<void> {
  const client = createClickHouseClient()

  // Get the main indexer's checkpoint as our ceiling
  const mainCheckpoint = await getLastProcessedBlock(client, 'main')
  if (mainCheckpoint === 0) {
    console.log('[VolumeBackfill] No indexed data found. Run main indexer first.')
    await client.close()
    return
  }

  // Get volume backfill progress
  const volumeCheckpoint = await getLastProcessedBlock(client, VOLUME_CHECKPOINT_KEY)
  const startBlock = volumeCheckpoint > 0 ? volumeCheckpoint + 1 : 0

  if (startBlock > mainCheckpoint) {
    console.log(`[VolumeBackfill] Already caught up to main indexer (block ${mainCheckpoint})`)
    await client.close()
    return
  }

  console.log(`[VolumeBackfill] Backfilling volumes from block ${startBlock} to ${mainCheckpoint}`)
  await client.close()

  // Create a volume-only processor
  const volumeProcessor = createProcessor('volume-only')
  volumeProcessor.setBlockRange({ from: startBlock, to: mainCheckpoint })

  // Registry for decimals lookup (needed for USDT volume calculation)
  const registry = new AssetRegistryTracker(config.SNAPSHOT_INTERVAL_BACKFILL)

  let lastLogBlock = startBlock
  let swapEventsProcessed = 0
  let blocksWithSwaps = 0
  const logInterval = 1000

  const database = new VolumeDatabase()

  volumeProcessor.run(database, async (ctx) => {
    if (ctx.blocks.length === 0) return

    const minBlock = ctx.blocks[0].header.height
    const maxBlock = ctx.blocks[ctx.blocks.length - 1].header.height

    // Batch-read stored prices from ClickHouse for this block range
    const clientForQuery = createClickHouseClient()
    const storedPrices = await readStoredPrices(clientForQuery, minBlock, maxBlock)
    await clientForQuery.close()

    for (const block of ctx.blocks) {
      const blockHeight = block.header.height

      // Snapshot assets for decimals (same as main indexer)
      await registry.maybeSnapshot(blockHeight, block.header)
      const decimals = registry.getDecimals()

      // Get prices for this block from stored data
      const blockPrices = storedPrices.get(blockHeight)
      if (!blockPrices || blockPrices.size === 0) {
        // No stored prices for this block -- skip (shouldn't happen but defensive)
        continue
      }

      // Extract volumes using stored prices
      const volumeRows = extractVolumeFromSwaps(block.events, blockHeight, blockPrices, decimals)
      if (volumeRows.length === 0) continue

      blocksWithSwaps++
      swapEventsProcessed += volumeRows.length / 2

      // Build complete price+volume rows by reading existing price for each asset
      const priceRows: PriceRow[] = Array.from(blockPrices.entries()).map(([assetId, price]) => ({
        asset_id: assetId,
        block_height: blockHeight,
        usdt_price: price,
      }))

      const combinedRows = mergePriceAndVolumeRows(priceRows, volumeRows)
      ctx.store.addPrices(combinedRows)

      if (blockHeight - lastLogBlock >= logInterval) {
        console.log(
          `[VolumeBackfill] Block ${blockHeight}/${mainCheckpoint} | ` +
          `${blocksWithSwaps} blocks with swaps | ` +
          `${swapEventsProcessed} swap events`
        )
        lastLogBlock = blockHeight
        blocksWithSwaps = 0
        swapEventsProcessed = 0
      }
    }
  })
}
