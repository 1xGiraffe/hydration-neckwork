import { runRaw } from './indexer.js'
import { parseBlockHeight, validateBlockRange } from '../blockRange.js'

function parseArgs(): { fromBlock?: number; toBlock?: number; pipelineId?: string; help: boolean } {
  const args: { fromBlock?: number; toBlock?: number; pipelineId?: string; help: boolean } = {
    help: false,
  }

  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg.startsWith('--from-block=')) {
      args.fromBlock = parseBlockHeight(arg.slice('--from-block='.length), '--from-block')
    } else if (arg.startsWith('--to-block=')) {
      args.toBlock = parseBlockHeight(arg.slice('--to-block='.length), '--to-block')
    } else if (arg.startsWith('--pipeline-id=')) {
      args.pipelineId = arg.split('=')[1]
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  validateBlockRange(args)
  return args
}

function printHelp(): void {
  console.log(`
Hydration Raw Data Lake Indexer

Usage:
  npx tsx src/raw/cli.ts [options]

Options:
  --from-block=N        Start indexing from block N
  --to-block=N          Stop indexing at block N and finalize the completed raw range
  --pipeline-id=ID      Override raw ingestion pipeline id
  --help, -h            Print this help message

Environment Variables:
  RPC_URL                       HTTP(S) or WebSocket RPC endpoint
  RAW_EVM_RPC_URL               HTTP(S) endpoint with historical eth_call support for Money Market positions
  RAW_EVM_RPC_FALLBACK_URLS     Comma-separated fallback HTTP(S) endpoints for Money Market eth_call reads
  RPC_RATE_LIMIT                RPC request rate limit (Docker Compose default: 50)
  RPC_CAPACITY                  Max concurrent RPC requests (default: 20; Docker Compose uses 10)
  CLICKHOUSE_HOST               ClickHouse HTTP endpoint
  CLICKHOUSE_PASSWORD           ClickHouse password (default: empty; Docker Compose uses dev)
  RAW_PIPELINE_ID               Raw ingestion checkpoint id (default: raw-main)
  RAW_BALANCE_READ_CONCURRENCY  Concurrent post-state balance storage reads (default: 20)
  RAW_BALANCE_READ_BATCH_SIZE   Batch size for post-state balance storage reads (default: 250)
  RAW_BALANCE_READ_BATCH_CONCURRENCY Concurrent post-state balance read batches (default: 4)
  RAW_MONEY_MARKET_ETH_CALL_TIMEOUT_MS  Money Market eth_call timeout (default: 20000)
  RAW_MONEY_MARKET_POSITION_CONCURRENCY Concurrent Money Market position eth_call reads (default: 8)
  RAW_MONEY_MARKET_BATCH_SIZE   Money Market eth_call batch size (default: 50)
  RAW_MM_PERIODIC_SNAPSHOT_ENABLED  Re-snapshot all MM borrowers periodically (default: true)
  RAW_MM_SNAPSHOT_INTERVAL_BLOCKS   Block interval between MM borrower re-snapshots (default: 7200)
  RAW_ASSET_SNAPSHOT_INTERVAL   Asset registry refresh interval in blocks
`)
}

function setupGracefulShutdown(): void {
  let shuttingDown = false

  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true

    console.log(`\n[Raw][Shutdown] Received ${signal}, waiting for processor cleanup...`)
    setTimeout(() => {
      console.log('[Raw][Shutdown] Cleanup timeout reached, forcing exit')
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
    return
  }

  setupGracefulShutdown()
  console.log('[Raw] Starting Hydration raw data lake indexer...')

  await runRaw({
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    pipelineId: args.pipelineId,
  })
}

main().catch(error => {
  console.error('[Raw] Fatal error:', error)
  process.exit(1)
})
