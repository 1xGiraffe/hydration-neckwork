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

  // Hydration chain constants
  LRNA_ASSET_ID: number
  // Assets that can bridge Omnipool state into USD pricing.
  OMNIPOOL_BRIDGE_IDS: number[]
  // Canonical USD references. These are treated as a peer basket.
  USD_REFERENCE_IDS: number[]
}

function intFromEnv(name: string, fallback: number): number {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const config: Config = {
  // SQD Network gateway for Hydration mainnet (50-100x faster than RPC)
  // SQD archives use the original chain name 'hydradx'
  SQD_GATEWAY: 'https://v2.archive.subsquid.io/network/hydradx',

  // RPC endpoint (fallback to Dotters network RPC)
  RPC_URL: process.env.RPC_URL ?? 'wss://hydration.dotters.network',
  RPC_RATE_LIMIT: intFromEnv('RPC_RATE_LIMIT', 100), // requests per second

  // ClickHouse connection (ports remapped to 18123/19000 per Phase 1 decisions)
  CLICKHOUSE_URL: process.env.CLICKHOUSE_HOST ?? 'http://localhost:18123',
  CLICKHOUSE_DB: 'price_data',
  CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? '',

  // Processing tuning parameters
  BATCH_SIZE: intFromEnv('BATCH_SIZE', 10_000), // rows per ClickHouse insert (tunable based on performance)
  SNAPSHOT_INTERVAL: intFromEnv('SNAPSHOT_INTERVAL', 1000), // blocks between full asset registry scans (live mode)

  // Hydration chain asset IDs
  LRNA_ASSET_ID: 1,   // LRNA is the Omnipool hub token
  // Assets that can bridge Omnipool pricing into the stable basket.
  // 222 is deliberately treated as a bridge, not as a canonical USD reference.
  OMNIPOOL_BRIDGE_IDS: [10, 22, 222],
  // USD references are treated symmetrically: the basket stays centered on $1,
  // while any 10/22 deviation is split across both assets instead of privileging 10.
  USD_REFERENCE_IDS: [10, 22],
}
