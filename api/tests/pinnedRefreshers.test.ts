import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { u8aToHex } from '@polkadot/util'
import type { ClickHouseClient } from '../src/db/client.ts'
import { storagePrefix } from '../src/services/chainPrimitives.ts'

// proxy-multisig, security-state and mm-oracle-prices each resolve ONE block per
// cycle (pinnedBlock.ts) and name it in every chain read of that cycle — storage
// by its Substrate hash, eth_call by its Ethereum hash — and stamp the result
// with it, instead of reading "whatever is newest" one call at a time.
const PIN = { block: 15_600_000, blockHash: '0x' + 'cd'.repeat(32), ethBlockHash: '0x' + 'ef'.repeat(32), indexedHead: 15_600_003, finalizedHead: 15_600_000 }
const readsAt: (string | null | undefined)[] = []
const ethAt: unknown[] = []
let storage: (key: string) => string | null = () => null
let keysOf: (prefix: string) => string[] = () => []

vi.mock('../src/services/substrateRpc.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/substrateRpc.ts')>()),
  substrateAllKeys: async (prefix: string, _p?: number, _s?: number, at?: string | null) => { readsAt.push(at); return keysOf(prefix) },
  substrateStorageBatch: async (keys: string[], at?: string | null) => { readsAt.push(at); return keys.map(k => storage(k)) },
}))
vi.mock('../src/services/pinnedBlock.ts', () => ({
  loadPinnedSubstrateBlock: async () => ({ block: PIN.block, blockHash: PIN.blockHash, indexedHead: PIN.indexedHead, finalizedHead: PIN.finalizedHead }),
  loadPinnedBlock: async () => PIN,
}))

const { initProxyMultisigService, refreshProxyMultisig, proxyInfoFor, proxyStateBlock } = await import('../src/services/proxyMultisigService.ts')
const { initSecurityService, refreshSecurityChainState } = await import('../src/services/securityService.ts')
const { initMmOraclePrices, refreshMmOraclePrices, currentMmOraclePrices, currentMmOraclePricesBlock } = await import('../src/services/mmOraclePrices.ts')
const { CORE_MM_MARKET } = await import('../src/services/explorerAssets.ts')

const le = (v: bigint, bytes: number) => { const b = new Uint8Array(bytes); for (let i = 0; i < bytes; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn); return u8aToHex(b).slice(2) }
const w = (v: bigint | number | string) => (typeof v === 'string' ? v.slice(2) : BigInt(v).toString(16)).padStart(64, '0')

function fakeClient(rows: (query: string) => unknown[] = () => []): ClickHouseClient {
  return {
    query: async ({ query }: { query: string }) => ({ json: async () => rows(query) }),
    insert: async () => {},
    command: async () => {},
  } as unknown as ClickHouseClient
}

// eth_call stub: records each call's block argument; `answer` gives its result.
function stubEthCalls(answer: (to: string, data: string) => string) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { id: number; method: string; params: [{ to: string; data: string }, unknown] } | { id: number; method: string; params: [{ to: string; data: string }, unknown] }[]
    const one = (c: { id: number; params: [{ to: string; data: string }, unknown] }) => { ethAt.push(c.params[1]); return { jsonrpc: '2.0', id: c.id, result: answer(c.params[0].to.toLowerCase(), c.params[0].data) } }
    const out = Array.isArray(body) ? body.map(one) : one(body)
    return { ok: true, json: async () => out } as unknown as Response
  }))
}

beforeEach(() => {
  readsAt.length = 0
  ethAt.length = 0
  storage = () => null
  keysOf = () => []
})
afterEach(() => { vi.unstubAllGlobals() })

describe('proxy-multisig cycle', () => {
  it('enumerates Proxy.Proxies and reads its values at the pinned hash, stamping the relations with the block', async () => {
    const PROXIES = storagePrefix('Proxy', 'Proxies')
    const delegator = '11'.repeat(32)
    const delegate = '22'.repeat(32)
    keysOf = p => (p === PROXIES ? [PROXIES + '00'.repeat(8) + delegator] : [])
    storage = k => (k.startsWith(PROXIES) ? `0x04${delegate}0000000000${'00'.repeat(16)}` : null)
    initProxyMultisigService(fakeClient())
    await refreshProxyMultisig()
    expect(readsAt).toEqual([PIN.blockHash, PIN.blockHash])
    expect(proxyStateBlock()).toBe(PIN.block)
    expect(proxyInfoFor(['0x' + delegator])?.delegates).toEqual([{ accountId: '0x' + delegate, proxyType: 'Any', delay: 0 }])
  })
})

describe('security-state cycle', () => {
  const SYSTEM_NUMBER = storagePrefix('System', 'Number')
  const USER = '0x' + '33'.repeat(20)
  const rows = (query: string) => (query.includes('money_market_latest_positions')
    ? [{ pool: CORE_MM_MARKET.poolProxy.toLowerCase(), user_address: USER, debt_usd: 10 }]
    : [])

  it('reads every storage value at the pinned hash and every eth_call at the pinned Ethereum hash', async () => {
    storage = k => (k === SYSTEM_NUMBER ? '0x' + le(BigInt(PIN.block), 4) : null)
    stubEthCalls((_to, data) => (data.startsWith('0xd1946dbc') ? '0x' + w(32) + w(0) : '0x' + w(0)))
    initSecurityService(fakeClient(rows))
    await refreshSecurityChainState()
    expect(readsAt.length).toBeGreaterThan(5)
    expect(new Set(readsAt)).toEqual(new Set([PIN.blockHash]))
    expect(ethAt.length).toBeGreaterThanOrEqual(3) // e-mode + user config per user, the pool's reserve list
    for (const at of ethAt) expect(at).toEqual({ blockHash: PIN.ethBlockHash })
  })

  it('refuses a snapshot whose System.Number is not the pinned block', async () => {
    storage = k => (k === SYSTEM_NUMBER ? '0x' + le(BigInt(PIN.block + 1), 4) : null)
    stubEthCalls((_to, data) => (data.startsWith('0xd1946dbc') ? '0x' + w(32) + w(0) : '0x' + w(0)))
    initSecurityService(fakeClient(rows))
    await expect(refreshSecurityChainState()).rejects.toThrow(/not block 15600000/)
  })
})

describe('mm-oracle-prices cycle', () => {
  it('names the pinned Ethereum hash in every eth_call and stamps the snapshot with the block', async () => {
    const provider = '0x' + 'aa'.repeat(20)
    const oracle = '0x' + 'bb'.repeat(20)
    const source = '0x' + 'cc'.repeat(20)
    const wbtc = '0x0000000000000000000000000000000100000013'
    const now = Math.floor(Date.now() / 1000)
    stubEthCalls((_to, data) => {
      switch (data.slice(0, 10)) {
        case '0x0542975c': return '0x' + w(provider)
        case '0xd1946dbc': return '0x' + w(32) + w(1) + w(wbtc)
        case '0xfca513a8': return '0x' + w(oracle)
        case '0xe19f4700': return '0x' + w(0)
        case '0x8c89b64f': return '0x' + w(100_000_000n)
        case '0xb3596f07': return '0x' + w(8_294_341_046_190n)
        case '0x92bf2be0': return '0x' + w(source)
        case '0xfeaf968c': return '0x' + w(1) + w(8_294_341_046_190n) + w(now) + w(now - 60) + w(1)
        default: return '0x'
      }
    })
    initMmOraclePrices(fakeClient())
    await refreshMmOraclePrices()
    expect(ethAt.length).toBe(8) // 2 plumbing, 1 oracle, 2 base + 2 per reserve, 1 round
    for (const at of ethAt) expect(at).toEqual({ blockHash: PIN.ethBlockHash })
    expect(currentMmOraclePricesBlock()).toBe(PIN.block)
    expect(currentMmOraclePrices().get(19)?.priceRaw).toBe('82943.4104619')
  })
})
