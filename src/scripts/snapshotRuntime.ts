import { RpcClient } from '@subsquid/rpc-client'
import { Runtime } from '@subsquid/substrate-runtime'
import { config } from '../config.js'
import { toClickHouseDateTime } from '../raw/json.js'
import type { ClickHouseClient } from '../db/client.js'

interface RuntimeVersion {
  specName: string
  specVersion: number
  implName: string
  implVersion: number
}

interface BlockHeader {
  number: string
}

// Defaults to the Hydration endpoint; pass a URL for a snapshot that reads
// another chain's state (see identityChains.ts).
export function createSnapshotRpcClient(url = config.RPC_URL): RpcClient {
  return new RpcClient({
    url,
    capacity: Math.max(1, Math.min(config.RPC_CAPACITY, 20)),
    rateLimit: Math.max(1, config.RPC_RATE_LIMIT),
    requestTimeout: 60_000,
  })
}

export async function resolveSnapshotAnchor(rpc: RpcClient, blockOverride: number | null): Promise<{ hash: string; height: number }> {
  if (blockOverride != null && blockOverride >= 0) {
    const hash = await rpc.call<string>('chain_getBlockHash', [blockOverride])
    return { hash, height: blockOverride }
  }
  const hash = await rpc.call<string>('chain_getFinalizedHead', [])
  const header = await rpc.call<BlockHeader>('chain_getHeader', [hash])
  return { hash, height: Number.parseInt(header.number, 16) }
}

// The indexed head: raw-live's checkpoint clamped to the newest block raw_events
// actually holds (the pointer can lead its rows). The same rule as the api's
// pinned refresh block (api/src/services/pinnedBlock.ts).
export async function loadIndexedHead(client: ClickHouseClient): Promise<number> {
  const state = await client.query({
    query: `SELECT argMax(last_block, updated_at) AS b FROM price_data.raw_ingestion_state WHERE pipeline_id = 'raw-live'`,
    format: 'JSONEachRow',
  })
  const head = Number((await state.json<{ b: number | string }>())[0]?.b ?? 0)
  if (!head) throw new Error('no raw-live head')
  const rows = await client.query({
    query: `SELECT max(block_height) AS b FROM price_data.raw_events WHERE block_height > {lo:UInt32} AND block_height <= {hi:UInt32}`,
    query_params: { lo: Math.max(0, head - 2_000), hi: head },
    format: 'JSONEachRow',
  })
  const b = Number((await rows.json<{ b: number | string }>())[0]?.b ?? 0)
  if (!b) throw new Error('raw_events holds no block near the raw-live head')
  return b
}

// A block every per-block observation up to which is indexed AND that can no
// longer be reorganised away: min(indexed head, finalized head). A comparison of
// storage at this block against the indexed projection is like for like.
export async function resolveIndexedSnapshotAnchor(rpc: RpcClient, client: ClickHouseClient): Promise<{ hash: string; height: number; indexedHead: number; finalizedHead: number }> {
  const [indexedHead, finalized] = await Promise.all([loadIndexedHead(client), resolveSnapshotAnchor(rpc, null)])
  const height = Math.min(indexedHead, finalized.height)
  const hash = height === finalized.height ? finalized.hash : await rpc.call<string>('chain_getBlockHash', [height])
  if (!hash || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error(`chain_getBlockHash(${height}) failed`)
  return { hash, height, indexedHead, finalizedHead: finalized.height }
}

export async function loadRuntimeAt(rpc: RpcClient, hash: string): Promise<Runtime> {
  const [runtimeVersion, metadata] = await Promise.all([
    rpc.call<RuntimeVersion>('state_getRuntimeVersion', [hash]),
    rpc.call<string>('state_getMetadata', [hash]),
  ])
  return new Runtime(runtimeVersion, metadata, undefined, rpc)
}

export async function loadSnapshotRuntime(rpc: RpcClient, hash: string): Promise<{ runtime: Runtime; timestamp: string }> {
  const runtime = await loadRuntimeAt(rpc, hash)
  const timestamp = await runtime.getStorage(hash, 'Timestamp.Now')
  if (timestamp == null) throw new Error(`Timestamp.Now is unavailable at snapshot block ${hash}`)
  const timestampMs = Number(timestamp)
  if (!Number.isFinite(timestampMs)) throw new Error(`Timestamp.Now is invalid at snapshot block ${hash}`)
  return { runtime, timestamp: toClickHouseDateTime(timestampMs) }
}

export async function runSnapshotProcess(options: {
  loop: boolean
  refreshHours: number
  runOnce: () => Promise<void>
  close: () => Promise<void> | void
}): Promise<void> {
  try {
    if (!options.loop) {
      await options.runOnce()
      return
    }

    const intervalMs = Math.max(1, options.refreshHours) * 3_600_000
    for (;;) {
      try {
        await options.runOnce()
      } catch (error) {
        console.error(error)
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    if (!options.loop) await options.close()
  }
}
