import {
  integerFromEnvironment,
  minutesFromEnvironment,
  optionalStringFromEnvironment,
  stringFromEnvironment,
} from './util/env.js'

export interface Config {
  // Subsquid Network gateway for Hydration mainnet
  SQD_GATEWAY: string
  SQD_GATEWAY_API_KEY?: string

  // RPC endpoint for live data and finalization checks
  RPC_URL: string
  RPC_RATE_LIMIT: number
  RPC_CAPACITY: number
  RPC_HEAD_POLL_MS: number

  // Non-Hydration identity sources, `key=url[@block]` and highest priority first.
  IDENTITY_CHAINS: string

  // ClickHouse connection settings
  CLICKHOUSE_URL: string
  CLICKHOUSE_DB: string
  CLICKHOUSE_PASSWORD: string

  // Processing parameters
  BATCH_SIZE: number
  SNAPSHOT_INTERVAL_MINUTES: number
  RAW_FLUSH_BLOCKS: number
  RAW_FLUSH_INTERVAL_MS: number

  // Hydration chain constants
  LRNA_ASSET_ID: number
  // Assets that can bridge Omnipool state into USD pricing.
  OMNIPOOL_BRIDGE_IDS: number[]
  // Dollar references that anchor Omnipool pricing, as peer baskets in falling preference.
  USD_REFERENCE_BASKETS: number[][]
  // Minimum bottleneck liquidity for non-Omnipool graph paths to be used as price observations.
  GRAPH_MIN_PATH_LIQUIDITY_USD: number
}

export const config: Config = {
  // SQD Network gateway for Hydration mainnet (50-100x faster than RPC)
  // SQD archives use the original chain name 'hydradx'
  SQD_GATEWAY: stringFromEnvironment('SQD_GATEWAY', 'https://v2.archive.subsquid.io/network/hydradx'),
  SQD_GATEWAY_API_KEY: optionalStringFromEnvironment('SQD_GATEWAY_API_KEY'),

  // RPC endpoint (falls back to the project's own unthrottled Hydration archive)
  RPC_URL: stringFromEnvironment('RPC_URL', 'https://hydration-rpc.neckwork.net'),
  RPC_RATE_LIMIT: integerFromEnvironment('RPC_RATE_LIMIT', 100), // requests per second
  RPC_CAPACITY: integerFromEnvironment('RPC_CAPACITY', 20), // max concurrent RPC requests
  // How often the SQD live follower polls the chain for a new head (the RPC
  // endpoints are HTTPS, so heads arrive by polling, not subscription). The
  // upstream default of 5000ms was the single largest controllable slice of
  // block-to-explorer latency; a chain_getHeader every 750ms is trivial load on
  // an RPC that runs on the same host (measured: 0 errors/retries in 6h at 2000ms,
  // and the poll does not appear in raw-live's cost at all — its per-block wall
  // time is ClickHouse insert round-trips).
  // 750ms rather than 2000ms because the poll interval has to stay well under a
  // block: at a 2s block time 2000ms is exactly one poll per block, so any jitter
  // costs a full block of lag and a missed poll is invisible. At 6s it oversampled
  // 3:1; 750ms keeps roughly that ratio at 2s and 8:1 today.
  RPC_HEAD_POLL_MS: integerFromEnvironment('RPC_HEAD_POLL_MS', 750),

  // Identity sources beyond Hydration, in falling display priority. The People
  // chains are where Polkadot and Kusama identities actually live — both relay
  // chains migrated theirs in 2024 and no Asset Hub ever carried the pallet.
  // Testnet names are free to mint, so they rank last and only fill gaps.
  // Set IDENTITY_CHAINS to an empty string to use Hydration alone.
  IDENTITY_CHAINS: process.env.IDENTITY_CHAINS ?? [
    'polkadot-people=https://polkadot-people-rpc.polkadot.io',
    'kusama-people=https://kusama-people-rpc.polkadot.io',
    'westend-people=https://westend-people-rpc.polkadot.io',
    'paseo-people=https://people-paseo.rotko.net',
  ].join(','),

  // ClickHouse connection
  CLICKHOUSE_URL: stringFromEnvironment('CLICKHOUSE_HOST', 'http://localhost:18123'),
  CLICKHOUSE_DB: 'price_data',
  CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? '',

  // Processing tuning parameters
  BATCH_SIZE: integerFromEnvironment('BATCH_SIZE', 50_000), // rows per ClickHouse insert (tunable based on performance)
  // Chain time between full asset registry scans in live mode. Measured in the
  // blocks' own timestamps rather than a block count, so the scan rate is fixed
  // through a block-time change (100 min is what the previous SNAPSHOT_INTERVAL
  // of 1,000 blocks meant at 6 s; at 2 s that same count would have scanned every
  // ~33 min). The deprecated SNAPSHOT_INTERVAL is still read, at 6 s per block.
  SNAPSHOT_INTERVAL_MINUTES: minutesFromEnvironment('SNAPSHOT_INTERVAL_MINUTES', 100, { name: 'SNAPSHOT_INTERVAL' }),
  // Raw flush accumulation while behind chain head — see src/raw/flushPolicy.ts.
  // At head every batch still flushes immediately, so these only shape catch-up
  // and backfill, where the small-part churn actually accumulates.
  RAW_FLUSH_BLOCKS: integerFromEnvironment('RAW_FLUSH_BLOCKS', 10, { min: 1 }),
  RAW_FLUSH_INTERVAL_MS: integerFromEnvironment('RAW_FLUSH_INTERVAL_MS', 5_000, { min: 0 }),

  // Hydration chain asset IDs
  LRNA_ASSET_ID: 1,   // LRNA is the Omnipool hub token
  // Assets that can bridge Omnipool pricing into the stable basket.
  // 222 is deliberately treated as a bridge, not as a canonical USD reference.
  OMNIPOOL_BRIDGE_IDS: [10, 22, 222],
  // The block's dollar anchor is the deepest Omnipool member of the first basket
  // that has one. Members of a basket are peers: it stays centered on $1, and any
  // 10/22 deviation is split across both assets instead of privileging 10. A later
  // basket anchors — and is seeded at $1 — only while no member of an earlier one
  // is in the Omnipool: DAI (Acala Wormhole, 2) was the pool's only dollar asset
  // from launch until USDT joined, and is thinly traded today, so it must never
  // carry a $1 seed while USDT/USDC are present.
  USD_REFERENCE_BASKETS: [[10, 22], [2]],
  // 0 (no gate) on purpose: any positive floor permanently unprices every asset
  // whose only venue is an isolated pool below it (PEN, NEURO, UNQ, SUB, NODL, …
  // were dark for five weeks under the previous 12 000), and the surfaces that
  // read those prices — the official-UI API, preis, account valuations — treat
  // "no price" as "does not exist". The gate is also not what protects deep
  // assets: Omnipool prices are authoritative and the weighted median prefers
  // the deepest path, so a dust pool can only ever price an asset that has no
  // deeper venue — for which its actual on-chain marginal price is the best
  // available truth.
  GRAPH_MIN_PATH_LIQUIDITY_USD: integerFromEnvironment('GRAPH_MIN_PATH_LIQUIDITY_USD', 0, { min: 0 }),
}
