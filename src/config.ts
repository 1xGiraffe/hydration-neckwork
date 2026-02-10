export interface Config {
  // Subsquid Network gateway for Hydration mainnet
  SQD_GATEWAY: string

  // RPC endpoint for live data and finalization checks
  RPC_URL: string
  RPC_RATE_LIMIT: number

  // ClickHouse connection settings
  CLICKHOUSE_URL: string
  CLICKHOUSE_DB: string
  CLICKHOUSE_PASSWORD: string

  // Processing parameters
  BATCH_SIZE: number
  SNAPSHOT_INTERVAL: number
  SNAPSHOT_INTERVAL_BACKFILL: number

  // Hydration chain constants
  USDT_ASSET_ID: number
  LRNA_ASSET_ID: number
}

export const config: Config = {
  // SQD Network gateway for Hydration mainnet (50-100x faster than RPC)
  // SQD archives use the original chain name 'hydradx'
  SQD_GATEWAY: 'https://v2.archive.subsquid.io/network/hydradx',

  // RPC endpoint (fallback to Dwellir public RPC)
  RPC_URL: process.env.RPC_URL ?? 'wss://hydration-rpc.dwellir.com',
  RPC_RATE_LIMIT: 10, // requests per second

  // ClickHouse connection (ports remapped to 18123/19000 per Phase 1 decisions)
  CLICKHOUSE_URL: process.env.CLICKHOUSE_HOST ?? 'http://localhost:18123',
  CLICKHOUSE_DB: 'price_data',
  CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? '',

  // Processing tuning parameters
  BATCH_SIZE: 10_000, // rows per ClickHouse insert (tunable based on performance)
  SNAPSHOT_INTERVAL: 1000, // blocks between full asset registry scans (live mode)
  SNAPSHOT_INTERVAL_BACKFILL: 10_000, // blocks between scans during backfill (archive mode)

  // Hydration chain asset IDs
  USDT_ASSET_ID: 10, // USDT is the price denomination target
  LRNA_ASSET_ID: 1,  // LRNA is the Omnipool hub token
}
