import { run } from './indexer.js'
import { parseBlockHeight, validateBlockRange } from './blockRange.js'
import { createClickHouseClient } from './db/client.js'
import { saveCheckpoint } from './store/checkpoint.js'
import { clearOHLCForTimeRange, rebuildOHLCForTimeRange, restoreRollbackOHLCPrefix } from './ohlc/repair.js'

function parseArgs(): {
  fromBlock?: number
  toBlock?: number
  rollbackToBlock?: number
  applyRollback: boolean
  repairOhlcFrom?: string
  repairOhlcTo?: string
  pipelineId?: string
  allowUnfinalizedRaw: boolean
  detectGaps: boolean
  help: boolean
} {
  const args = {
    fromBlock: undefined as number | undefined,
    toBlock: undefined as number | undefined,
    rollbackToBlock: undefined as number | undefined,
    applyRollback: false,
    repairOhlcFrom: undefined as string | undefined,
    repairOhlcTo: undefined as string | undefined,
    pipelineId: undefined as string | undefined,
    allowUnfinalizedRaw: false,
    detectGaps: false,
    help: false,
  }

  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg === '--detect-gaps') {
      args.detectGaps = true
    } else if (arg === '--allow-unfinalized-raw') {
      args.allowUnfinalizedRaw = true
    } else if (arg === '--apply-rollback') {
      args.applyRollback = true
    } else if (arg.startsWith('--from-block=')) {
      args.fromBlock = parseBlockHeight(arg.slice('--from-block='.length), '--from-block')
    } else if (arg.startsWith('--to-block=')) {
      args.toBlock = parseBlockHeight(arg.slice('--to-block='.length), '--to-block')
    } else if (arg.startsWith('--rollback-to-block=')) {
      const raw = arg.split('=')[1]
      const value = Number(raw)
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('--rollback-to-block must be a positive integer')
      }
      args.rollbackToBlock = value
    } else if (arg.startsWith('--repair-ohlc-from=')) {
      args.repairOhlcFrom = arg.split('=')[1]
    } else if (arg.startsWith('--repair-ohlc-to=')) {
      args.repairOhlcTo = arg.split('=')[1]
    } else if (arg.startsWith('--pipeline-id=')) {
      args.pipelineId = arg.split('=')[1]
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  validateBlockRange(args)
  return args
}

function toClickHouseDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}

function parseTimestampArg(value: string): string {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const withTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`
  const parsed = new Date(withTimezone)

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`)
  }

  return toClickHouseDateTime(parsed)
}

function isMissingTradeVolumeTable(error: unknown): boolean {
  return error instanceof Error && error.message.includes('trade_volume_by_account')
}

function printHelp(): void {
  console.log(`
Hydration Price Indexer

Usage:
  npx tsx src/cli.ts [options]

Options:
  --from-block=N           Start indexing from block N (overrides checkpoint)
  --to-block=N             Stop indexing at block N (useful for testing)
  --rollback-to-block=N    Delete all data at or above positive block N, reset checkpoint, and exit
  --apply-rollback         Required confirmation for --rollback-to-block
  --repair-ohlc-from=TS    Rebuild OHLC tables for intervals overlapping TS..TO from prices
  --repair-ohlc-to=TS      End timestamp for OHLC repair (ISO 8601 or 'YYYY-MM-DD HH:MM:SS', UTC)
  --pipeline-id=ID         Override main indexer checkpoint id
  --allow-unfinalized-raw  Allow historical fallback to direct RPC/state reads
  --detect-gaps            Scan ClickHouse for missing block ranges and exit
  --help, -h               Print this help message

Examples:
  # Start backfill from genesis (or resume from checkpoint)
  npm start

  # Start from a specific block
  npm start -- --from-block=1000000

  # Process a specific range
  npm start -- --from-block=1000000 --to-block=1100000

  # Rollback data to block 999999 (deletes block 1000000 and above)
  npm start -- --rollback-to-block=1000000 --apply-rollback

  # Rebuild corrupted OHLC intervals from prices
  npm start -- --repair-ohlc-from=2024-01-29T00:00:00Z --repair-ohlc-to=2024-02-01T00:00:00Z

  # Detect gaps in indexed data
  npm run detect-gaps

Environment Variables:
  RPC_URL               HTTP(S) or WebSocket RPC endpoint (default: https://rpc.hydradx.cloud)
  RPC_CAPACITY          Max concurrent RPC requests (default: 20)
  INDEXER_PIPELINE_ID   Main indexer checkpoint id (default: main)
  MAIN_REQUIRE_FINALIZED_RAW  Require finalized raw ranges for historical mode (default: true)
  CLICKHOUSE_HOST       ClickHouse HTTP endpoint (default: http://localhost:18123)
  CLICKHOUSE_PASSWORD   ClickHouse password (default: empty; Docker Compose uses dev)
`)
}

/**
 * Detect gaps in indexed block data
 *
 * Queries ClickHouse for all distinct block heights in the blocks table,
 * then finds ranges where consecutive blocks differ by more than 1.
 */
async function detectGaps(): Promise<void> {
  console.log('[Gap Detection] Scanning ClickHouse for missing block ranges...')

  const client = createClickHouseClient()

  try {
    const summaryResult = await client.query({
      query: `
        SELECT
          count() AS indexed_blocks,
          min(block_height) AS min_block,
          max(block_height) AS max_block
        FROM (SELECT DISTINCT block_height FROM price_data.blocks)
      `,
      format: 'JSONEachRow',
    })
    const summaryRows = await summaryResult.json<{
      indexed_blocks: string | number
      min_block: number | null
      max_block: number | null
    }>()
    const summary = summaryRows[0]
    const indexedBlocks = Number(summary?.indexed_blocks ?? 0)

    if (indexedBlocks === 0) {
      console.log('[Gap Detection] No data found in blocks table')
      return
    }

    console.log(`[Gap Detection] Found ${indexedBlocks} indexed blocks`)
    console.log(`[Gap Detection] Range: ${summary?.min_block} to ${summary?.max_block}`)

    const gapsSql = `
      WITH
        ordered AS (
          SELECT
            block_height,
            block_height - row_number() OVER (ORDER BY block_height) AS gap_group
          FROM (SELECT DISTINCT block_height FROM price_data.blocks)
        ),
        ranges AS (
          SELECT min(block_height) AS from_block, max(block_height) AS to_block
          FROM ordered
          GROUP BY gap_group
        ),
        gaps AS (
          SELECT
            from_block,
            lagInFrame(to_block, 1, 0) OVER (
              ORDER BY from_block ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS previous_to
          FROM ranges
        )
      SELECT
        previous_to + 1 AS start,
        from_block - 1 AS end,
        from_block - previous_to - 1 AS count
      FROM gaps
      WHERE previous_to > 0 AND from_block > previous_to + 1
    `
    const countResult = await client.query({
      query: `SELECT count() AS c FROM (${gapsSql})`,
      format: 'JSONEachRow',
    })
    const countRows = await countResult.json<{ c: string | number }>()
    const gapCount = Number(countRows[0]?.c ?? 0)

    if (gapCount === 0) {
      console.log('[Gap Detection] No gaps found - all blocks indexed sequentially')
    } else {
      const gapsResult = await client.query({
        query: `${gapsSql} ORDER BY start ASC LIMIT 100`,
        format: 'JSONEachRow',
      })
      const gaps = await gapsResult.json<{ start: number; end: number; count: number }>()
      console.log(`[Gap Detection] Found ${gapCount} gap(s):`)
      for (const gap of gaps) {
        console.log(`  Gap: blocks ${gap.start} to ${gap.end} (${gap.count} blocks missing)`)
      }
      if (gapCount > gaps.length) {
        console.log(`  ... ${gapCount - gaps.length} more gap(s) omitted`)
      }
    }
  } catch (error) {
    console.error('[Gap Detection] Error querying ClickHouse:', error)
    process.exit(1)
  } finally {
    await client.close()
  }
}

/**
 * Rollback all data to a specific block height
 *
 * Deletes all rows at or above the target block from prices, blocks, trade volumes,
 * runtime_upgrades, and OHLC tables.
 * Resets checkpoint to targetBlock - 1 to resume indexing from targetBlock.
 * Uses mutations_sync: 1 to ensure synchronous deletion before checkpoint reset.
 * Restores the prefix of the first affected candle from preserved prices so replay can
 * rebuild the rest of each interval without losing earlier trades.
 */
async function rollbackToBlock(targetBlock: number, checkpointId = 'main'): Promise<void> {
  console.log(`[Rollback] Rolling back to block ${targetBlock}...`)

  const client = createClickHouseClient()

  try {
    // Find affected timestamp range BEFORE deleting data
    // (we need timestamps from blocks that are ABOUT TO be deleted)
    console.log(`[Rollback] Finding affected timestamp range...`)
    const timeRangeResult = await client.query({
      query: `SELECT min(block_timestamp) AS start_time, max(block_timestamp) AS end_time
              FROM price_data.blocks
              WHERE block_height >= ${targetBlock}`,
      format: 'JSONEachRow',
    })
    const timeRange = await timeRangeResult.json<{ start_time: string; end_time: string }>()

    // Delete from prices table
    console.log(`[Rollback] Deleting prices at or above block ${targetBlock}...`)
    await client.command({
      query: `DELETE FROM price_data.prices WHERE block_height >= ${targetBlock}`,
      clickhouse_settings: {
        mutations_sync: '1',
      },
    })

    console.log(`[Rollback] Deleting trade volumes at or above block ${targetBlock}...`)
    try {
      await client.command({
        query: `DELETE FROM price_data.trade_volume_by_account WHERE block_height >= ${targetBlock}`,
        clickhouse_settings: {
          mutations_sync: '1',
        },
      })
    } catch (error) {
      if (!isMissingTradeVolumeTable(error)) throw error
      console.log('[Rollback] trade_volume_by_account table not found; skipping')
    }

    // Delete from blocks table
    console.log(`[Rollback] Deleting blocks at or above block ${targetBlock}...`)
    await client.command({
      query: `DELETE FROM price_data.blocks WHERE block_height >= ${targetBlock}`,
      clickhouse_settings: {
        mutations_sync: '1',
      },
    })

    // Delete from runtime_upgrades table
    console.log(`[Rollback] Deleting runtime upgrades at or above block ${targetBlock}...`)
    await client.command({
      query: `DELETE FROM price_data.runtime_upgrades WHERE block_height >= ${targetBlock}`,
      clickhouse_settings: {
        mutations_sync: '1',
      },
    })

    // Delete affected OHLC intervals
    if (timeRange.length > 0 && timeRange[0].start_time) {
      const { start_time, end_time } = timeRange[0]
      console.log(`[Rollback] Cleaning OHLC tables for time range ${start_time} to ${end_time}...`)
      await clearOHLCForTimeRange(client, start_time, end_time)
      await restoreRollbackOHLCPrefix(client, start_time)
      console.log('[Rollback] OHLC tables cleaned')
    }

    // Reset checkpoint to targetBlock - 1
    const newCheckpoint = targetBlock - 1
    console.log(`[Rollback] Resetting checkpoint ${checkpointId} to block ${newCheckpoint}...`)
    await saveCheckpoint(client, newCheckpoint, checkpointId)

    console.log(`[Rollback] Rollback complete. Checkpoint ${checkpointId} reset to ${newCheckpoint}`)
  } catch (error) {
    console.error('[Rollback] Error during rollback:', error)
    throw error
  } finally {
    await client.close()
  }
}

async function repairOHLC(fromTime: string, toTime: string): Promise<void> {
  console.log(`[OHLC Repair] Rebuilding OHLC tables for ${fromTime} to ${toTime}...`)

  const client = createClickHouseClient()

  try {
    await rebuildOHLCForTimeRange(client, fromTime, toTime)
    console.log('[OHLC Repair] OHLC tables rebuilt successfully')
  } catch (error) {
    console.error('[OHLC Repair] Error rebuilding OHLC tables:', error)
    throw error
  } finally {
    await client.close()
  }
}

function setupGracefulShutdown(): void {
  let shuttingDown = false

  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true

    console.log(`\n[Shutdown] Received ${signal}, shutting down gracefully...`)
    console.log('[Shutdown] Waiting up to 10 seconds for pending operations to complete...')

    // Give SQD processor time to flush pending batches
    // processor.run() handles cleanup automatically on process exit
    setTimeout(() => {
      console.log('[Shutdown] Cleanup timeout reached, forcing exit')
      process.exit(0)
    }, 10_000)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

async function main(): Promise<void> {
  const args = parseArgs()

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  if (args.detectGaps) {
    await detectGaps()
    process.exit(0)
  }

  if ((args.repairOhlcFrom && !args.repairOhlcTo) || (!args.repairOhlcFrom && args.repairOhlcTo)) {
    throw new Error('Both --repair-ohlc-from and --repair-ohlc-to are required')
  }

  if (args.repairOhlcFrom && args.repairOhlcTo) {
    await repairOHLC(parseTimestampArg(args.repairOhlcFrom), parseTimestampArg(args.repairOhlcTo))
    process.exit(0)
  }

  if (args.rollbackToBlock !== undefined) {
    if (!args.applyRollback) {
      throw new Error('Rollback is destructive; re-run with --apply-rollback to confirm')
    }
    await rollbackToBlock(args.rollbackToBlock, args.pipelineId)
    process.exit(0)
  }

  setupGracefulShutdown()

  console.log('[CLI] Starting Hydration price indexer...')

  try {
    await run({
      fromBlock: args.fromBlock,
      toBlock: args.toBlock,
      pipelineId: args.pipelineId,
      requireFinalizedRaw: !args.allowUnfinalizedRaw,
    })
  } catch (error) {
    console.error('[CLI] Fatal error:', error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('[CLI] Unhandled error:', error)
  process.exit(1)
})
