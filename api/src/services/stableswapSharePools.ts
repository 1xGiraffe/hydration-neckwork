// The CURRENT stableswap pool state a share token's derived price is computed from
// (lpMath.stableswapSharePrices): the newest raw_block_snapshots row's `stableswap`
// section, exact at the indexed head. Shared by the explorer's price map and
// /v1/accounts/balances; the Data API reads the same row through its own
// data/services/poolSnapshot.ts and applies the same age bound and last-good rule. A leaf: the client
// type, the cache and the pure snapshot parser only.

import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { SHARE_POOL_MAX_AGE_SECONDS, type StableswapSharePool } from './lpMath.ts'
import { parseStableswapPools } from './stableswapSnapshot.ts'

// Reserves move every block; held for one block interval, like the other
// current-state snapshot reads.
const TTL_MS = 3_000

// The age bound past which every share is unpriced: lpMath SHARE_POOL_MAX_AGE_SECONDS.
export { SHARE_POOL_MAX_AGE_SECONDS }

export interface StableswapShareState {
  pools: StableswapSharePool[]
  /** The snapshot block's timestamp, unix seconds. */
  blockTimestamp: number
}

// The last state read successfully. A failed read serves it (a price map that is up
// to one outage old) rather than dropping every share token's price at once — but
// only inside the age bound, which is checked against it on every call.
let lastGood: StableswapShareState | null = null

function readState(client: ClickHouseClient): Promise<StableswapShareState | null> {
  return cached('stableswap:share-pools', TTL_MS, async () => {
    try {
      const res = await client.query({
        query: `-- stableswap:share-pools
            SELECT toUnixTimestamp(block_timestamp) AS ts, JSONExtractRaw(payload_json, 'stableswap') AS ss
            FROM price_data.raw_block_snapshots
            WHERE block_height = (SELECT max(block_height) FROM price_data.raw_block_snapshots)
            ORDER BY ingested_at DESC
            LIMIT 1`,
        format: 'JSONEachRow',
      })
      const [row] = await res.json<{ ts: number | string; ss: string }>()
      if (!row) return lastGood
      let section: unknown = null
      try { section = JSON.parse(row.ss) } catch { return lastGood }
      const blockTimestamp = Number(row.ts)
      if (!Number.isFinite(blockTimestamp) || blockTimestamp <= 0) return lastGood
      lastGood = {
        pools: parseStableswapPools(section).map(p => ({ poolId: p.poolId, assetIds: p.assetIds, reserves: p.reserves, totalIssuance: p.totalIssuance })),
        blockTimestamp,
      }
      return lastGood
    } catch (err) {
      console.error('[stableswap] share pool state read failed:', err instanceof Error ? err.message : err)
      return lastGood
    }
  })
}

/**
 * The current share pool state, or null — every share unpriced — when it has never
 * been read or its snapshot is older than SHARE_POOL_MAX_AGE_SECONDS.
 */
export async function currentStableswapShareState(client: ClickHouseClient, nowMs = Date.now()): Promise<StableswapShareState | null> {
  const state = await readState(client)
  if (!state || nowMs / 1000 - state.blockTimestamp > SHARE_POOL_MAX_AGE_SECONDS) return null
  return state
}

/** The pools of currentStableswapShareState (null: every share unpriced). */
export async function currentStableswapSharePools(client: ClickHouseClient): Promise<StableswapSharePool[] | null> {
  return (await currentStableswapShareState(client))?.pools ?? null
}
