import { run } from './indexer.js'
import { createClickHouseClient } from './db/client.js'
import { saveCheckpoint } from './store/checkpoint.js'
import { clearOHLCForTimeRange, rebuildOHLCForTimeRange, restoreRollbackOHLCPrefix } from './ohlc/repair.js'

function parseArgs(): {
  fromBlock?: number
  toBlock?: number
  rollbackToBlock?: number
  repairOhlcFrom?: string
  repairOhlcTo?: string
  detectGaps: boolean
  help: boolean
} {
  const args = {
    fromBlock: undefined as number | undefined,
    toBlock: undefined as number | undefined,
    rollbackToBlock: undefined as number | undefined,
    repairOhlcFrom: undefined as string | undefined,
    repairOhlcTo: undefined as string | undefined,
    detectGaps: false,
    help: false,
  }

  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg === '--detect-gaps') {
      args.detectGaps = true
    } else if (arg.startsWith('--from-block=')) {
      const value = parseInt(arg.split('=')[1], 10)
      if (!isNaN(value)) {
        args.fromBlock = value
      }
    } else if (arg.startsWith('--to-block=')) {
      const value = parseInt(arg.split('=')[1], 10)
      if (!isNaN(value)) {
        args.toBlock = value
      }
    } else if (arg.startsWith('--rollback-to-block=')) {
      const value = parseInt(arg.split('=')[1], 10)
      if (!isNaN(value) && value >= 0) {
        args.rollbackToBlock = value
      }
    } else if (arg.startsWith('--repair-ohlc-from=')) {
      args.repairOhlcFrom = arg.split('=')[1]
    } else if (arg.startsWith('--repair-ohlc-to=')) {
      args.repairOhlcTo = arg.split('=')[1]
    }
  }

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

function printHelp(): void {
  console.log(`
Hydration Price Indexer

Usage:
  npx tsx src/cli.ts [options]

Options:
  --from-block=N           Start indexing from block N (overrides checkpoint)
  --to-block=N             Stop indexing at block N (useful for testing)
  --rollback-to-block=N    Delete all data at or above block N (prices, blocks, OHLC), reset checkpoint, and exit
  --repair-ohlc-from=TS    Rebuild OHLC tables for intervals overlapping TS..TO from prices
  --repair-ohlc-to=TS      End timestamp for OHLC repair (ISO 8601 or 'YYYY-MM-DD HH:MM:SS', UTC)
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
  npm start -- --rollback-to-block=1000000

  # Rebuild corrupted OHLC intervals from prices
  npm start -- --repair-ohlc-from=2024-01-29T00:00:00Z --repair-ohlc-to=2024-02-01T00:00:00Z

  # Detect gaps in indexed data
  npm run detect-gaps

Environment Variables:
  RPC_URL               WebSocket RPC endpoint (default: wss://hydration.dotters.network)
  CLICKHOUSE_HOST       ClickHouse HTTP endpoint (default: http://localhost:18123)
  CLICKHOUSE_PASSWORD   ClickHouse password (default: empty)
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
    // Query all distinct block heights, ordered
    const result = await client.query({
      query: `
        SELECT DISTINCT block_height
        FROM price_data.blocks
        ORDER BY block_height ASC
      `,
      format: 'JSONEachRow',
    })

    const rows = await result.json<{ block_height: number }>()

    if (rows.length === 0) {
      console.log('[Gap Detection] No data found in blocks table')
      return
    }

    console.log(`[Gap Detection] Found ${rows.length} indexed blocks`)
    console.log(`[Gap Detection] Range: ${rows[0].block_height} to ${rows[rows.length - 1].block_height}`)

    // Find gaps
    const gaps: { start: number; end: number; count: number }[] = []
    for (let i = 0; i < rows.length - 1; i++) {
      const current = rows[i].block_height
      const next = rows[i + 1].block_height

      if (next - current > 1) {
        gaps.push({
          start: current + 1,
          end: next - 1,
          count: next - current - 1,
        })
      }
    }

    if (gaps.length === 0) {
      console.log('[Gap Detection] No gaps found - all blocks indexed sequentially')
    } else {
      console.log(`[Gap Detection] Found ${gaps.length} gap(s):`)
      for (const gap of gaps) {
        console.log(`  Gap: blocks ${gap.start} to ${gap.end} (${gap.count} blocks missing)`)
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
 * Deletes all rows at or above the target block from prices, blocks, runtime_upgrades, and OHLC tables.
 * Resets checkpoint to targetBlock - 1 to resume indexing from targetBlock.
 * Uses mutations_sync: 1 to ensure synchronous deletion before checkpoint reset.
 * Restores the prefix of the first affected candle from preserved prices so replay can
 * rebuild the rest of each interval without losing earlier trades.
 */
async function rollbackToBlock(targetBlock: number): Promise<void> {
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
    console.log(`[Rollback] Resetting checkpoint to block ${newCheckpoint}...`)
    await saveCheckpoint(client, newCheckpoint)

    console.log(`[Rollback] Rollback complete. Checkpoint reset to ${newCheckpoint}`)
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
    await rollbackToBlock(args.rollbackToBlock)
    process.exit(0)
  }

  setupGracefulShutdown()

  console.log('[CLI] Starting Hydration price indexer...')

  try {
    await run({
      fromBlock: args.fromBlock,
      toBlock: args.toBlock,
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
