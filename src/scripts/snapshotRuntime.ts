import { RpcClient } from '@subsquid/rpc-client'
import { Runtime } from '@subsquid/substrate-runtime'
import { config } from '../config.js'
import { toClickHouseDateTime } from '../raw/json.js'

interface RuntimeVersion {
  specName: string
  specVersion: number
  implName: string
  implVersion: number
}

interface BlockHeader {
  number: string
}

export function createSnapshotRpcClient(): RpcClient {
  return new RpcClient({
    url: config.RPC_URL,
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
