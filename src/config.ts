import { integerFromEnvironment, optionalStringFromEnvironment, stringFromEnvironment } from './util/env.js'

export interface Config {
  // Subsquid Network gateway for Hydration mainnet
  SQD_GATEWAY: string
  SQD_GATEWAY_API_KEY?: string

  // RPC endpoint for live data and finalization checks
  RPC_URL: string
  RPC_RATE_LIMIT: number
  RPC_CAPACITY: number

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
  // Minimum bottleneck liquidity for non-Omnipool graph paths to be used as price observations.
  GRAPH_MIN_PATH_LIQUIDITY_USD: number
}

export const config: Config = {
  // SQD Network gateway for Hydration mainnet (50-100x faster than RPC)
  // SQD archives use the original chain name 'hydradx'
  SQD_GATEWAY: stringFromEnvironment('SQD_GATEWAY', 'https://v2.archive.subsquid.io/network/hydradx'),
  SQD_GATEWAY_API_KEY: optionalStringFromEnvironment('SQD_GATEWAY_API_KEY'),

  // RPC endpoint (fallback to public Hydration RPC)
  RPC_URL: stringFromEnvironment('RPC_URL', 'https://rpc.hydradx.cloud'),
  RPC_RATE_LIMIT: integerFromEnvironment('RPC_RATE_LIMIT', 100), // requests per second
  RPC_CAPACITY: integerFromEnvironment('RPC_CAPACITY', 20), // max concurrent RPC requests

  // ClickHouse connection
  CLICKHOUSE_URL: stringFromEnvironment('CLICKHOUSE_HOST', 'http://localhost:18123'),
  CLICKHOUSE_DB: 'price_data',
  CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? '',

  // Processing tuning parameters
  BATCH_SIZE: integerFromEnvironment('BATCH_SIZE', 50_000), // rows per ClickHouse insert (tunable based on performance)
  SNAPSHOT_INTERVAL: integerFromEnvironment('SNAPSHOT_INTERVAL', 1000), // blocks between full asset registry scans (live mode)

  // Hydration chain asset IDs
  LRNA_ASSET_ID: 1,   // LRNA is the Omnipool hub token
  // Assets that can bridge Omnipool pricing into the stable basket.
  // 222 is deliberately treated as a bridge, not as a canonical USD reference.
  OMNIPOOL_BRIDGE_IDS: [10, 22, 222],
  // USD references are treated symmetrically: the basket stays centered on $1,
  // while any 10/22 deviation is split across both assets instead of privileging 10.
  USD_REFERENCE_IDS: [10, 22],
  GRAPH_MIN_PATH_LIQUIDITY_USD: integerFromEnvironment('GRAPH_MIN_PATH_LIQUIDITY_USD', 12_000, { min: 0 }),
}
