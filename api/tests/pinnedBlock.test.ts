import { describe, expect, it } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import { loadPinnedBlock, loadPinnedSubstrateBlock, withEthBlockHash, type RpcFn } from '../src/services/pinnedBlock.ts'

// The background refreshers read chain state at ONE block per cycle:
// min(indexed head clamped to raw_events, finalized head), by its Substrate hash
// and — for eth_call — its Ethereum hash, confirmed to name that number.
const SUB = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const ETH = (n: number) => '0x' + (n + 1).toString(16).padStart(64, 'e')

function fakeCh(rawLive: number, rowsHead: number, tags: string[] = []): ClickHouseClient {
  return {
    query: async ({ query, clickhouse_settings }: { query: string; clickhouse_settings?: { log_comment?: string } }) => {
      tags.push(clickhouse_settings?.log_comment ?? '')
      return { json: async () => (query.includes('raw_ingestion_state') ? [{ b: rawLive }] : [{ b: rowsHead }]) }
    },
  } as unknown as ClickHouseClient
}

function fakeRpc(finalized: number, opts: { ethNumberFor?: (hash: string) => number } = {}): RpcFn {
  return (async (method: string, params: unknown[]) => {
    switch (method) {
      case 'chain_getFinalizedHead': return '0xfin'
      case 'chain_getHeader': return { number: '0x' + finalized.toString(16) }
      case 'chain_getBlockHash': return SUB(params[0] as number)
      case 'eth_getBlockByNumber': { const n = Number(BigInt(params[0] as string)); return { hash: ETH(n), number: params[0] } }
      case 'eth_getBlockByHash': {
        const hash = params[0] as string
        const n = opts.ethNumberFor ? opts.ethNumberFor(hash) : Number(BigInt('0x' + hash.slice(2).replace(/^e+/, ''))) - 1
        return { number: '0x' + n.toString(16) }
      }
      default: return null
    }
  }) as RpcFn
}

describe('pinned block', () => {
  it('pins the lower of the indexed head (clamped to raw_events) and the finalized head', async () => {
    const tags: string[] = []
    expect(await loadPinnedSubstrateBlock(fakeCh(1_000, 990, tags), fakeRpc(995), 'hdx:locks-pin'))
      .toEqual({ block: 990, blockHash: SUB(990), indexedHead: 990, finalizedHead: 995 })
    expect(tags).toEqual(['hdx:locks-pin-head', 'hdx:locks-pin-rows-head'])
    expect((await loadPinnedSubstrateBlock(fakeCh(1_000, 1_000), fakeRpc(995))).block).toBe(995)
  })

  it('adds the Ethereum hash only once the node confirms it names the pinned number', async () => {
    const pin = await loadPinnedBlock(fakeCh(1_000, 1_000), fakeRpc(995))
    expect(pin).toMatchObject({ block: 995, blockHash: SUB(995), ethBlockHash: ETH(995) })
    expect(await withEthBlockHash({ block: 995, blockHash: SUB(995), indexedHead: 1_000, finalizedHead: 995 }, fakeRpc(995)))
      .toMatchObject({ block: 995, ethBlockHash: ETH(995) })
    await expect(loadPinnedBlock(fakeCh(1_000, 1_000), fakeRpc(995, { ethNumberFor: () => 1_000 }))).rejects.toThrow(/does not name block 995/)
  })

  it('fails the cycle rather than reading the head when the node cannot name the block', async () => {
    const noHash = (async (method: string, params: unknown[]) => (method === 'chain_getBlockHash' ? null : fakeRpc(995)(method, params))) as RpcFn
    await expect(loadPinnedSubstrateBlock(fakeCh(1_000, 1_000), noHash)).rejects.toThrow(/chain_getBlockHash\(995\)/)
    const noFinal = (async () => null) as RpcFn
    await expect(loadPinnedSubstrateBlock(fakeCh(1_000, 1_000), noFinal)).rejects.toThrow(/chain_getFinalizedHead/)
  })
})
