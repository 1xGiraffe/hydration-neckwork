import type { ClickHouseClient } from '../db/client.ts'
import { queryTag } from './queryTag.ts'
import { rpc } from './substrateRpc.ts'

// The ONE block a background refresh cycle reads chain state at:
// min(the indexed head — raw-live's checkpoint clamped to the newest block
// raw_events actually holds — and the node's finalized head). Every read of the
// cycle names that block (Substrate storage by its hash, eth_call by its Ethereum
// hash), so one snapshot describes one chain state rather than several consecutive
// ones, can no longer be reorganised away, and is stamped with the block it
// describes rather than with whatever head happened to be newest.
//
// The money-market incentive refresher introduced the rule; the node-full
// refreshers on the coordinated scheduler (backgroundRefresh.ts) share it.

export type RpcFn = <T>(method: string, params: unknown[]) => Promise<T | null>

async function select<T>(ch: ClickHouseClient, query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await ch.query({ query, query_params: params, format: 'JSONEachRow', clickhouse_settings: { log_comment: queryTag(query) ?? 'pin' } })
  return res.json<T>()
}

/**
 * The indexed head, clamped to the newest block raw_events holds (raw-live's pointer
 * can lead its rows). `tag` names the two reads in system.query_log
 * (`<tag>-head`, `<tag>-rows-head`).
 */
export async function loadIndexedHead(ch: ClickHouseClient, tag = 'pin:indexed'): Promise<number> {
  const [state] = await select<{ b: number }>(ch, `-- ${tag}-head
    SELECT argMax(last_block, updated_at) AS b FROM price_data.raw_ingestion_state WHERE pipeline_id = 'raw-live'`)
  const head = Number(state?.b ?? 0)
  if (!head) throw new Error('no raw-live head')
  const [rows] = await select<{ b: number }>(ch, `-- ${tag}-rows-head
    SELECT max(block_height) AS b FROM price_data.raw_events WHERE block_height > {lo:UInt32} AND block_height <= {hi:UInt32}`, { lo: Math.max(0, head - 2_000), hi: head })
  const b = Number(rows?.b ?? 0)
  if (!b) throw new Error('raw_events holds no block near the raw-live head')
  return b
}

/** The node's finalized head number (chain_getFinalizedHead → chain_getHeader). */
export async function loadFinalizedHead(rpcFn: RpcFn = rpc): Promise<number> {
  const hash = await rpcFn<string>('chain_getFinalizedHead', [])
  if (!hash) throw new Error('chain_getFinalizedHead failed')
  const header = await rpcFn<{ number: string }>('chain_getHeader', [hash])
  const n = header?.number != null ? Number(BigInt(header.number)) : 0
  if (!n) throw new Error(`chain_getHeader(${hash}) failed`)
  return n
}

export interface PinnedSubstrateBlock { block: number; blockHash: string; indexedHead: number; finalizedHead: number }
export interface PinnedBlock extends PinnedSubstrateBlock { ethBlockHash: string }

/** The cycle's block and its Substrate hash — for refreshers that read storage only. */
export async function loadPinnedSubstrateBlock(ch: ClickHouseClient, rpcFn: RpcFn = rpc, tag?: string): Promise<PinnedSubstrateBlock> {
  const [indexedHead, finalizedHead] = await Promise.all([loadIndexedHead(ch, tag), loadFinalizedHead(rpcFn)])
  const block = Math.min(indexedHead, finalizedHead)
  const blockHash = await rpcFn<string>('chain_getBlockHash', [block])
  if (!blockHash || !/^0x[0-9a-f]{64}$/i.test(blockHash)) throw new Error(`chain_getBlockHash(${block}) failed`)
  return { block, blockHash, indexedHead, finalizedHead }
}

/**
 * The cycle's block with its Substrate hash (storage reads) and its Ethereum block
 * hash (every eth_call, EIP-1898 `{ blockHash }`). The Ethereum hash is confirmed by
 * eth_getBlockByHash to name the pinned number, because an eth_call naming an
 * unknown hash silently answers at the node's latest state.
 */
export async function loadPinnedBlock(ch: ClickHouseClient, rpcFn: RpcFn = rpc, tag?: string): Promise<PinnedBlock> {
  const [indexedHead, finalizedHead] = await Promise.all([loadIndexedHead(ch, tag), loadFinalizedHead(rpcFn)])
  const block = Math.min(indexedHead, finalizedHead)
  const ethBlockHash = await confirmEthBlockHash(block, rpcFn)
  const blockHash = await rpcFn<string>('chain_getBlockHash', [block])
  if (!blockHash) throw new Error(`chain_getBlockHash(${block}) failed`)
  return { block, blockHash, ethBlockHash, indexedHead, finalizedHead }
}

/** Upgrade a Substrate pin with its confirmed Ethereum block hash (for a cycle that needs eth_call only sometimes). */
export async function withEthBlockHash(pin: PinnedSubstrateBlock, rpcFn: RpcFn = rpc): Promise<PinnedBlock> {
  return { ...pin, ethBlockHash: await confirmEthBlockHash(pin.block, rpcFn) }
}

async function confirmEthBlockHash(block: number, rpcFn: RpcFn): Promise<string> {
  const ethBlock = await rpcFn<{ hash?: string; number?: string }>('eth_getBlockByNumber', [`0x${block.toString(16)}`, false])
  const ethBlockHash = ethBlock?.hash
  if (!ethBlockHash || ethBlock?.number == null || Number(BigInt(ethBlock.number)) !== block) throw new Error(`eth_getBlockByNumber(${block}) failed`)
  const confirm = await rpcFn<{ number?: string }>('eth_getBlockByHash', [ethBlockHash, false])
  if (confirm?.number == null || Number(BigInt(confirm.number)) !== block) throw new Error(`eth_getBlockByHash(${ethBlockHash}) does not name block ${block}`)
  return ethBlockHash
}
