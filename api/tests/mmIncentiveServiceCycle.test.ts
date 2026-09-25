import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCacheForTests } from '../src/services/cache.ts'
import {
  assetDecimalsMismatches, computeMmIncentives, type EthBlockRef, type EthCallRequest, type RpcFn,
} from '../src/services/mmIncentiveService.ts'

// One refresher cycle driven end to end over fakes: the ClickHouse reads (by their
// `-- tag`), the node's RPC (heads and hashes), the eth_calls and the EDs.

const W = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0')
const addr = (a: string) => a.slice(2).padStart(64, '0')
const GDOT = '0x0000000000000000000000000000000100000045'
const A690 = '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad'
const RESERVE_690 = '0x00000000000000000000000000000001000002b2'
const HOLDER = '0x1111111111111111111111111111111111111111' // positive scaled balance only
const ACCRUER = '0x2222222222222222222222222222222222222222' // an Accrued row only, nothing owed now
const CLAIMER = '0x3333333333333333333333333333333333333333' // a RewardsClaimed row only
const ZERO_BAL = '0x4444444444444444444444444444444444444444' // scaled balance 0: not a candidate by balance

const INDEXED_HEAD = 15_000_100
const FINALIZED_HEAD = 15_000_050
const ETH_HASH = '0x' + 'e'.repeat(64)
const SUB_HASH = '0x' + 'a'.repeat(64)

function fakeClient(opts: { anchor?: number; scaledAnchor?: number } = {}) {
  const rowsFor = (tag: string, params: Record<string, unknown>): unknown[] => {
    switch (tag) {
      case 'mm:incentives-head': return [{ b: INDEXED_HEAD }]
      case 'mm:incentives-rows-head': return [{ b: params.hi }]
      case 'mm:incentives-programmes': return [{ asset: A690, reward: GDOT }]
      case 'mm:incentives-anchor-block': return [{ b0: opts.anchor ?? 8_200_000 }]
      case 'mm:incentives-atoken-anchor-block': return [{ b0: opts.scaledAnchor ?? 8_200_000 }]
      case 'mm:incentives-scaled': return [{ holder: HOLDER, contract: A690, scaled: '1000000000000000000' }, { holder: ZERO_BAL, contract: A690, scaled: '0' }]
      case 'mm:incentives-accruals': return [{ u: ACCRUER, asset: A690, reward: GDOT, acc: '0', idx: '5' }]
      case 'mm:incentives-claims': return []
      case 'mm:incentives-anchor': return []
      case 'mm:incentives-accrual-users': return [{ u: ACCRUER }]
      case 'mm:incentives-claim-users': return [{ u: CLAIMER }]
      case 'mm:reserve-map': return [{ asset_address: RESERVE_690, atoken: A690, vdebt: '', pool_proxy: '0xpool', market_key: 'core' }]
      case 'mm:anchor-block': return [{ b0: 8_200_000 }]
      default: throw new Error(`unexpected query ${tag}`)
    }
  }
  const seen: Array<{ tag: string; params: Record<string, unknown> }> = []
  return {
    seen,
    query: vi.fn(async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      const tag = /^\s*--\s*(\S+)/.exec(query)?.[1] ?? ''
      seen.push({ tag, params: query_params ?? {} })
      const rows = rowsFor(tag, query_params ?? {})
      return { json: async () => rows }
    }),
  }
}

const fakeRpc = (over: Record<string, unknown> = {}): RpcFn => (async (method: string, params: unknown[]) => {
  if (method in over) return over[method]
  switch (method) {
    case 'chain_getFinalizedHead': return '0xfin'
    case 'chain_getHeader': return { number: `0x${FINALIZED_HEAD.toString(16)}` }
    case 'chain_getBlockHash': return params[0] === FINALIZED_HEAD ? SUB_HASH : null
    case 'eth_getBlockByNumber': return { hash: ETH_HASH, number: params[0] }
    case 'eth_getBlockByHash': return { number: `0x${FINALIZED_HEAD.toString(16)}` }
    default: return null
  }
}) as RpcFn

// getAssetIndex returns (oldIndex, newIndex); the new index is the one brought to the block.
const OLD_INDEX = 100n
const NEW_INDEX = 3_000_000_000_000_000_000n

function fakeEthCall(chainDecimals = 18) {
  const blocks: EthBlockRef[] = []
  const users: string[] = []
  const call = vi.fn(async (calls: EthCallRequest[], at: EthBlockRef) => {
    blocks.push(at)
    return calls.map(c => {
      if (c.data.startsWith('0x9efd6f72')) return '0x' + W(chainDecimals)
      if (c.data.startsWith('0x886fe70b')) return '0x' + W(OLD_INDEX) + W(NEW_INDEX)
      if (c.data.startsWith('0x4c0369c3')) {
        const user = '0x' + c.data.slice(10 + 64 + 24, 10 + 128)
        users.push(user)
        const amount = user === HOLDER ? 3_000_000_000_000_000_000n : 0n
        return '0x' + W(64) + W(128) + W(1) + addr(GDOT) + W(1) + W(amount)
      }
      throw new Error(`unexpected call ${c.data.slice(0, 10)}`)
    })
  })
  return { call, blocks, users }
}

describe('computeMmIncentives', () => {
  beforeEach(() => resetCacheForTests())
  afterEach(() => vi.restoreAllMocks())

  it('pins min(indexed head, finalized head), calls by Ethereum block hash, decodes the second getAssetIndex word and unions the candidates', async () => {
    const ch = fakeClient()
    const eth = fakeEthCall()
    const eds = vi.fn(async () => new Map([[69, 10n ** 16n]]))
    const cycle = await computeMmIncentives(ch as never, { ethCall: eth.call, eds, rpc: fakeRpc(), registryDecimals: () => 18 })
    expect(cycle.block).toBe(FINALIZED_HEAD)
    expect(cycle.indexedHead).toBe(INDEXED_HEAD)
    expect(cycle.blockHash).toBe(SUB_HASH)
    // Every ClickHouse read that is bounded by the block is bounded by the pinned one.
    expect(ch.seen.find(q => q.tag === 'mm:incentives-accruals')!.params.b).toBe(FINALIZED_HEAD)
    expect(eth.blocks.every(b => typeof b === 'object' && b.blockHash === ETH_HASH)).toBe(true)
    expect(eds).toHaveBeenCalledWith(SUB_HASH, [69])
    // accrual users ∪ claim users ∪ positive scaled holders; a zero balance alone is not a candidate.
    expect(eth.users.sort()).toEqual([HOLDER, ACCRUER, CLAIMER].sort())
    expect(cycle.candidates).toBe(3)
    // Pending = 1e18 scaled × (NEW_INDEX − 0) / 1e18 = NEW_INDEX, reconciled with the chain's 3e18.
    const leg = cycle.rows.find(r => r.holder === HOLDER && r.assetAddress === A690)!
    expect(leg.assetIndex).toBe(NEW_INDEX)
    expect(leg.pendingRaw).toBe(NEW_INDEX)
    expect(cycle.rows.find(r => r.holder === HOLDER && r.assetAddress === '')!.reconciled).toBe(true)
    expect(cycle.decimalsMismatches).toEqual([])
  })

  it('pins the indexed head when it trails finality', async () => {
    const ch = fakeClient()
    const eth = fakeEthCall()
    const rpc = fakeRpc({
      chain_getHeader: { number: `0x${(INDEXED_HEAD + 10).toString(16)}` },
      chain_getBlockHash: SUB_HASH,
      eth_getBlockByHash: { number: `0x${INDEXED_HEAD.toString(16)}` },
    })
    const cycle = await computeMmIncentives(ch as never, { ethCall: eth.call, eds: async () => new Map(), rpc, registryDecimals: () => 18 })
    expect(cycle.block).toBe(INDEXED_HEAD)
  })

  // An eth_call naming a hash the node does not know answers at its latest state, so
  // the hash is used only once eth_getBlockByHash has confirmed the pinned number.
  it('refuses an Ethereum block hash the node does not map to the pinned number', async () => {
    const eth = fakeEthCall()
    await expect(computeMmIncentives(fakeClient() as never, { ethCall: eth.call, eds: async () => new Map(), rpc: fakeRpc({ eth_getBlockByHash: null }) }))
      .rejects.toThrow('does not name block')
    expect(eth.call).not.toHaveBeenCalled()
  })

  // Without both anchors at one block every pair would publish unreconciled: the cycle
  // throws, so the refresher keeps the previous generation.
  it('throws without a common anchor block', async () => {
    const eth = fakeEthCall()
    await expect(computeMmIncentives(fakeClient({ scaledAnchor: 0 }) as never, { ethCall: eth.call, eds: async () => new Map(), rpc: fakeRpc() }))
      .rejects.toThrow('no common anchor block')
    await expect(computeMmIncentives(fakeClient({ anchor: 8_200_000, scaledAnchor: 8_100_000 }) as never, { ethCall: eth.call, eds: async () => new Map(), rpc: fakeRpc() }))
      .rejects.toThrow('keeping the previous generation')
    expect(eth.call).not.toHaveBeenCalled()
  })

  it('logs a getAssetDecimals / registry mismatch and still publishes on the chain\'s decimals', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cycle = await computeMmIncentives(fakeClient() as never, { ethCall: fakeEthCall(6).call, eds: async () => new Map(), rpc: fakeRpc(), registryDecimals: id => (id === 690 ? 18 : null) })
    expect(cycle.decimalsMismatches).toEqual([{ asset: A690, chain: 6, registry: 18 }])
    expect(warn).toHaveBeenCalledWith('[mm-incentives] getAssetDecimals disagrees with the registry', { asset: A690, chain: 6, registry: 18 })
    expect(cycle.rows.length).toBeGreaterThan(0)
  })
})

describe('assetDecimalsMismatches', () => {
  it('skips an aToken the registry cannot name', () => {
    expect(assetDecimalsMismatches(new Map([[A690, 18]]), [{ atoken: A690, assetAddress: RESERVE_690 }], () => null)).toEqual([])
    expect(assetDecimalsMismatches(new Map([[A690, 18]]), [], () => 6)).toEqual([])
  })
})
