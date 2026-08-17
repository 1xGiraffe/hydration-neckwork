import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { iso } from '../schemas/common.ts'

// Indexer status for GET /v1/status. The SQL is the ClickHouse half of
// api/src/routes/indexer.ts (the explorer's /indexer route), duplicated
// deliberately: the public contract is versioned and frozen while the explorer's
// is not, so the two must be free to diverge (spec: "Isolation rule").
//
// The chain-head RPC sampler is NOT copied. This service does no chain access at
// all, so `chainBlockHeight` is the raw pipeline's own checkpoint (the same
// fallback the explorer route uses when its RPC sample is unavailable) and
// `blocksBehindHead` therefore means "behind raw ingestion", not "behind the
// chain". Both pipelines stall together, so this stays a usable lag signal; a
// consumer needing true chain distance must ask a node.
export interface PublicStatus {
  blockHeight: number
  blockTimestamp: string
  lagSeconds: number
  chainBlockHeight: number
  blocksBehindHead: number
}

// Matches the route's max-age: clients are told to reuse a status response for 3s,
// so holding it in process for the same window keeps ClickHouse load O(1) in readers.
//
// Wall clock, and deliberately not re-derived from the block time: at the chain's
// present ~6 s cadence this is under one block, and at 2 s it would span one to
// two, so a poller would see the head move in steps. That is a freshness choice
// rather than a correctness one — both reads here are metadata-scale `max()`
// aggregates whose cost does not change with block rate — so the value is left
// alone and the trade-off is recorded for the cadence change rather than guessed
// at now. It must stay equal to the route's own max-age in cacheControl.ts.
const TTL_MS = 3_000

export function publicStatus(client: ClickHouseClient): Promise<PublicStatus> {
  return cached('public:v1:status', TTL_MS, () => loadStatus(client))
}

function uintValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

async function loadStatus(client: ClickHouseClient): Promise<PublicStatus> {
  const [mainRes, rawRes] = await Promise.all([
    client.query({
      query: `
          SELECT
            toUInt64(max(block_height)) AS block_height,
            toString(max(block_timestamp)) AS block_timestamp
          FROM price_data.blocks
        `,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
          SELECT toUInt64(max(last_block)) AS block_height
          FROM price_data.raw_ingestion_state FINAL
        `,
      format: 'JSONEachRow',
    }),
  ])
  const [main] = await mainRes.json<{ block_height: string; block_timestamp: string }>()
  const [raw] = await rawRes.json<{ block_height: string }>()

  const blockHeight = uintValue(main?.block_height)
  const rawBlockHeight = uintValue(raw?.block_height)
  const chainBlockHeight = Math.max(rawBlockHeight, blockHeight)
  // An empty database reports the DateTime epoch rather than a missing value;
  // keep the field a real timestamp so the wire shape never varies.
  const blockTimestamp = iso(main?.block_timestamp || 0)
  const blockTimeMs = Date.parse(blockTimestamp)
  return {
    blockHeight,
    blockTimestamp,
    lagSeconds: Math.max(0, Math.floor((Date.now() - blockTimeMs) / 1000)),
    chainBlockHeight,
    blocksBehindHead: Math.max(0, chainBlockHeight - blockHeight),
  }
}
