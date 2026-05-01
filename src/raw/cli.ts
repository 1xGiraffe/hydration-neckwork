import { runRaw } from './indexer.js'

function parseArgs(): { fromBlock?: number; toBlock?: number; pipelineId?: string; help: boolean } {
  const args: { fromBlock?: number; toBlock?: number; pipelineId?: string; help: boolean } = {
    help: false,
  }

  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg.startsWith('--from-block=')) {
      const value = Number.parseInt(arg.split('=')[1], 10)
      if (!Number.isNaN(value)) args.fromBlock = value
    } else if (arg.startsWith('--to-block=')) {
      const value = Number.parseInt(arg.split('=')[1], 10)
      if (!Number.isNaN(value)) args.toBlock = value
    } else if (arg.startsWith('--pipeline-id=')) {
      args.pipelineId = arg.split('=')[1]
    }
  }

  return args
}

function printHelp(): void {
  console.log(`
Hydration Raw Data Lake Indexer

Usage:
  npx tsx src/raw/cli.ts [options]

Options:
  --from-block=N        Start indexing from block N
  --to-block=N          Stop indexing at block N
  --pipeline-id=ID      Override raw ingestion pipeline id
  --help, -h            Print this help message

Environment Variables:
  RPC_URL                       WebSocket RPC endpoint
  RPC_RATE_LIMIT                RPC request rate limit
  CLICKHOUSE_HOST               ClickHouse HTTP endpoint
  CLICKHOUSE_PASSWORD           ClickHouse password
  RAW_PIPELINE_ID               Raw ingestion checkpoint id (default: raw-main)
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
