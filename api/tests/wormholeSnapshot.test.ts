import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import {
  base58Decode,
  base58Encode,
  hexToBytes,
  nttDigest,
  parseLogMessagePublished,
  parseNttTransceiverMessage,
  SOLANA_INBOX_RATE_LIMIT_DISCRIMINATOR,
  SOLANA_OUTBOX_RATE_LIMIT_DISCRIMINATOR,
  SOLANA_NTT_CONFIG_DISCRIMINATOR,
  SOLANA_NTT_CONFIG_LENGTH,
  SOLANA_NTT_INBOX_ITEM_DISCRIMINATOR,
  SOLANA_NTT_INBOX_ITEM_LENGTH,
  SOLANA_RELEASE_STATUS,
} from '../src/services/wormholeNtt.ts'

// The composer's failure semantics are the point of this file: an unread chain
// must produce nulls and never zeroes, a failing cycle must leave the previous
// snapshot serving, a chain that fails on its own must keep its last custody
// read, and an asset registered on chain must appear with no code change.

const HYDRATION_RPC = 'http://hydration.test'
const ETH_RPC = 'https://eth.test/rpc'
const SOL_RPC = 'https://solana.test/rpc'
const SCAN = 'https://scan.test'

process.env.WORMHOLE_SCAN_URL = SCAN
process.env.WORMHOLE_ORIGIN_RPC_URLS = JSON.stringify({ 1: SOL_RPC, 2: ETH_RPC })

const storageBatch = vi.fn<(keys: string[], at?: string | null) => Promise<(string | null)[]>>()
vi.mock('../src/services/substrateRpc.ts', () => ({
  SUBSTRATE_RPC_URL: HYDRATION_RPC,
  substrateStorageBatch: (keys: string[], at?: string | null) => storageBatch(keys, at),
}))

// cachedSwr is exercised by its own tests; here it must not hide a recompute.
vi.mock('../src/services/cache.ts', () => ({ cachedSwr: <T>(_k: string, _f: number, _s: number, fn: () => Promise<T>) => fn() }))

const minters = new Map<number, string>()
vi.mock('../src/services/explorerService.ts', () => ({
  nttMinterAccounts: async () => minters,
  nttMinterH160: (account: string) => '0x' + account.slice(10, 50),
  ocnChainName: (urn: string) => (urn === 'urn:ocn:ethereum:1' ? 'Ethereum' : urn === 'urn:ocn:sui:0x35834a8a' ? 'Sui' : null),
  WORMHOLE_CHAIN_URNS: { 2: 'urn:ocn:ethereum:1', 21: 'urn:ocn:sui:0x35834a8a' } as Record<number, string>,
  accountRef: (accountId: string) => ({ accountId, address: accountId }),
  ensurePrices: async () => new Map([
    [21, { price: 1, change24h: 0 }],
    [43, { price: 1, change24h: 0 }],
    [1_000_745, { price: 1.09, change24h: 0 }],
    [1_000_753, { price: 3, change24h: 0 }],
  ]),
  usdValue: (prices: Map<number, { price: number }>, assetId: number, raw: string, decimals: number) => {
    const p = prices.get(assetId)
    return p ? (Number(raw) / 10 ** decimals) * p.price : null
  },
}))
vi.mock('../src/services/explorerAssets.ts', () => ({
  assetDescriptor: (assetId: number) => ({ assetId, symbol: `#${assetId}`, decimals: 12 }),
}))

const {
  refreshWormholeBacking, runWormholeBackingConfirmation, cancelWormholeBackingConfirmation,
  getWormholeBridgeDetail, getWormholeSummary, initWormholeNttService, resetWormholeDiscoveryForTests,
} = await import('../src/services/wormholeNttService.ts')

// ── fixtures ────────────────────────────────────────────────────────────────

// Every fixture carries its OWN origin peer, so no lookup can be read as being
// keyed by a chain id when it is keyed by an asset id — asset 21 is USDC and
// chain 21 is Sui, and the two collided in an earlier shape of this file.
const USDC = { assetId: 21, symbol: 'USDC', decimals: 6, manager: '0xeceab64542a875c4472671d9ed1e690cdd4e28fc', chain: 2, token: '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', peer: '0x000000000000000000000000447b2c7485a3d6813f8197e605b10bccd8dd8398' }
const EURC = { assetId: 44, symbol: 'EURC', decimals: 6, manager: '0x8dd1286a29df5a2785fb638d6fb1598144cfbc4c', chain: 2, token: '0x00000000000000000000000060a3e35cc302bfa44cb288bc5a4f316fdb1adb42', peer: '0x000000000000000000000000d1dc3517732c98502b5c1ba2389aca9e9016d89a' }
const SUI = { assetId: 1_000_753, symbol: 'SUI', decimals: 9, manager: '0x978443f00cab6b09445140321ec73a221ebff5f8', chain: 21, token: '0x9258181f5ceac8dbffb7030890243caed69a9599d2886d957a9cb7656af3bdb3', peer: '0xa0bc45e0384140dc125f273eda89cad1434f5dee430726cf6364bdcceba1e9a3' }
// The two assets the rate-limiter queue is exercised on: sUSDS is the real
// Ethereum case, PRIME the Solana one. Their managers and peers are the live
// deployments, so the digest the queue is keyed by is the real one.
const SUSDS = { assetId: 1_000_745, symbol: 'sUSDS', decimals: 18, manager: '0x1973e7044d9a7c7bb2d6ea1693a296a9e4b7e448', chain: 2, token: '0x000000000000000000000000a3931d71877c0e7a3148cb7eb4463524fec27fbd', peer: '0x0000000000000000000000005085a4863f89ec9553f70187ee73b5aae0fd14b5' }
const PRIME = { assetId: 43, symbol: 'PRIME', decimals: 6, manager: '0xfcaf4aa069c565d25539028970703f01e47d3e0b', chain: 1, token: '0x1a4a0e9c1b2f8e51d3ffb0a44a7fbc9e5d6b3820c7194f30ad5e8266b1c40f97', peer: '0x33418b3b733b2025041e4e381380cc4d1b61977f57587611d3061c5b590a8d76' }
const ALL_ASSETS = [USDC, EURC, SUI, SUSDS, PRIME]
const ORIGIN_PEER: Record<number, string> = Object.fromEntries(ALL_ASSETS.map(a => [a.assetId, a.peer]))

const widen = (h160: string) => '0x45544800' + h160.slice(2) + '00'.repeat(8)
const locationArgs = (a: typeof USDC) => JSON.stringify({
  assetId: a.assetId,
  location: {
    parents: 0,
    interior: {
      __kind: 'X3',
      value: [
        { length: 2, data: '0x7768' + '00'.repeat(31), __kind: 'GeneralKey' },
        { __kind: 'GeneralIndex', value: String(a.chain) },
        { length: 32, data: a.token, __kind: 'GeneralKey' },
      ],
    },
  },
})

let registry: (typeof USDC)[] = []
const u128Le = (v: bigint) => '0x' + Buffer.from(new BigUint64Array([v & ((1n << 64n) - 1n), v >> 64n]).buffer).toString('hex')

let issuance = new Map<number, bigint>()
let queries: string[] = []

function fakeClient(): ClickHouseClient {
  return {
    query: async ({ query }: { query: string }) => {
      queries.push(query)
      if (query.includes('raw_blocks')) return { json: async () => [{ block_height: 13_728_047, block_timestamp: '2026-08-22 08:00:00' }] }
      // Discovery reads the registry incrementally, so the three facts it used to
      // take from one joined read now arrive separately: the `wh` locations with
      // the block each was last set at, the minter floor, and the symbol/decimals.
      if (query.includes('AssetRegistry.LocationSet')) {
        return { json: async () => registry.map(a => ({ asset_id: a.assetId, args: locationArgs(a), block: 13_400_000 })) }
      }
      // Specific to the minter FLOOR read — the minter set itself is read by
      // another query naming the same event.
      if (query.includes('min(block_height) AS min_block')) return { json: async () => [{ min_block: 13_378_659 }] }
      if (query.includes('price_data.assets')) {
        return { json: async () => registry.map(a => ({ asset_id: a.assetId, symbol: a.symbol, decimals: a.decimals })) }
      }
      if (query.includes('raw_evm_logs')) return { json: async () => [] }
      if (query.includes('Tokens.Withdrawn')) return { json: async () => [] }
      return { json: async () => [] }
    },
    insert: async () => {},
    close: async () => {},
  } as unknown as ClickHouseClient
}

// ── network stub ────────────────────────────────────────────────────────────

interface RpcCall { id: number; method: string; params: unknown[] }

let ethChainReachable = true
let scanReachable = true
// Rows the sweep endpoint answers with, in the operations endpoint's shape.
let scanOps: unknown[] = []
let ethCustody = 227_031_998_904n
// Per-asset overrides for the two stubs that answer for more than one asset.
const evmCustody = new Map<number, bigint>()
// digest → the getInboundQueuedTransfer struct the origin manager returns.
const evmQueue = new Map<string, string>()
let evmRateLimitSeconds = 86_400n
// Solana program id (base58) → the raw InboxItem accounts it holds.
const solanaInbox = new Map<string, string[]>()
const solanaCustody = new Map<number, bigint>()
// Digests the EVM origin manager reports it has already executed.
const evmExecuted = new Set<string>()
// The live figures the fuse block is pinned on: Ethereum caps USDC at 100,000
// with 93,411.583448 still available, Hydration's own legs are uncapped at the
// u64 trimmed ceiling, and every leg refills over 24 hours.
const ORIGIN_LIMIT_TRIMMED = 100_000_00000000n     // 100,000 at 8 trimmed decimals
const ORIGIN_CAPACITY_RAW = 93_411_583_448n        // untrimmed, USDC's 6 decimals
const RATE_LIMIT_SECONDS = 86_400n
const LAST_TX_SEC = 1_787_389_559n
// Solana states its limits in the ORIGIN mint's own units, not trimmed ones.
const SOLANA_LIMIT_NATIVE = 449_016_984_704n
const SOLANA_CAPACITY_NATIVE = 444_877_534_116n
let blockHashResolves = true

const word = (v: bigint) => v.toString(16).padStart(64, '0')
const programIdHex = (base58: string) => Buffer.from(base58Decode(base58)!).toString('hex')
const programIdBase58 = (bytes32: string) => base58Encode(hexToBytes(bytes32))

// The digests the origin was actually asked about after a given point, so a
// test can prove a settled one is never probed again.
const fetchStubCalls = () => fetchImpl.mock.calls.length
const queueProbes = (since: number) => fetchImpl.mock.calls.slice(since).flatMap(([, init]) => {
  const body = init?.body
  if (!body || !body.startsWith('[')) return []
  return (JSON.parse(body) as RpcCall[])
    .map(call => (call.params?.[0] as { data?: string } | undefined)?.data ?? '')
    .filter(data => data.startsWith('0xfd96063c'))
    .map(data => data.slice(10))
})

// The manager program's config account, laid out at the offsets the parser
// reads. Its custody token account carries the asset id in its last four bytes
// so the balance stub can answer for the right asset.
function solanaConfigAccount(tokenHex: string, assetId: number): string {
  const bytes = new Uint8Array(SOLANA_NTT_CONFIG_LENGTH)
  bytes.set(hexToBytes(SOLANA_NTT_CONFIG_DISCRIMINATOR), 0)
  bytes.set(hexToBytes(tokenHex), 42)
  bytes[106] = 0                    // LOCKING
  bytes[107] = 0; bytes[108] = 1    // chain id 1
  bytes[127] = 0                    // not paused
  const custody = new Uint8Array(32)
  new DataView(custody.buffer).setUint32(28, assetId)
  bytes.set(custody, 128)
  return Buffer.from(bytes).toString('base64')
}

// An InboxItem holding `amount` for `recipient`, either queued until
// `releaseAfterSec` or already released.
function solanaInboxItem(amount: bigint, recipientHex: string, status: number, releaseAfterSec: number): string {
  const bytes = new Uint8Array(SOLANA_NTT_INBOX_ITEM_LENGTH)
  bytes.set(hexToBytes(SOLANA_NTT_INBOX_ITEM_DISCRIMINATOR), 0)
  bytes[8] = 1
  bytes[9] = 253
  const view = new DataView(bytes.buffer)
  view.setBigUint64(10, amount, true)
  bytes.set(hexToBytes(recipientHex), 18)
  bytes[50] = 1
  bytes[66] = status
  view.setBigInt64(67, BigInt(releaseAfterSec), true)
  return '0x' + Buffer.from(bytes).toString('hex')
}

// Per-asset supply sitting at 0x…dEaD, read off the asset's ERC-20 precompile.
// Live 2026-08-22 only SUI holds anything there (10 SUI); the rest read 0.
const deadBalances = new Map<number, bigint>()
// A test that needs the pinned dEaD read to FAIL clears this.
let deadReadResolves = true
const erc20Precompile = (assetId: number) => '0x' + '0'.repeat(31) + '1' + assetId.toString(16).padStart(8, '0')

function hydrationEthCall(call: RpcCall): string | null {
  const { to, data } = call.params[0] as { to: string; data: string }
  // balanceOf(0x…dEaD) on an asset's precompile — the retired-supply term.
  const precompiled = ALL_ASSETS.find(a => erc20Precompile(a.assetId) === to.toLowerCase())
  if (precompiled && data.startsWith('0x70a08231') && data.endsWith('dead')) {
    return deadReadResolves ? '0x' + word(deadBalances.get(precompiled.assetId) ?? 0n) : null
  }
  const asset = ALL_ASSETS.find(a => a.manager === to.toLowerCase())
  if (!asset) return null
  const selector = data.slice(0, 10)
  // token() answers with the asset's own ERC-20 precompile.
  if (selector === '0xfc0c546a') return '0x' + '0'.repeat(55) + '1' + asset.assetId.toString(16).padStart(8, '0')
  if (selector === '0x295a5212') return '0x' + word(1n)                        // mode() = BURNING
  if (selector === '0x9a8a0592') return '0x' + word(73n)                       // chainId()
  if (selector === '0xb187bd26') return '0x' + word(0n)                        // isPaused()
  if (selector === '0xc128d170') return ORIGIN_PEER[asset.assetId] + word(BigInt(asset.decimals))
  if (selector === '0x74aa7bfc') return '0x' + word(RATE_LIMIT_SECONDS)
  // Hydration's own legs: uncapped, at the asset's own decimals.
  const localTrimmed = packTrimmed(184_467_440_737_00000000n, 8)
  const localUntrimmed = 184_467_440_737n * 10n ** BigInt(asset.decimals)
  if (selector === '0x86e11ffa' || selector === '0xd788c147') {
    return '0x' + word(localTrimmed) + word(localTrimmed) + word(LAST_TX_SEC)
  }
  if (selector === '0xf5cfec18' || selector === '0x02717250') return '0x' + word(localUntrimmed)
  return null
}

// NTT packs a trimmed amount as amount << 8 | decimals.
function packTrimmed(amount: bigint, decimals: number): bigint {
  return (amount << 8n) | BigInt(decimals)
}

const fetchImpl = vi.fn(async (input: string | URL, init?: { body?: string }) => {
  const url = String(input)
  const body = init?.body ? JSON.parse(init.body) as RpcCall | RpcCall[] : null
  if (url === HYDRATION_RPC) {
    if (Array.isArray(body)) {
      return { ok: true, json: async () => body.map(call => ({ id: call.id, result: hydrationEthCall(call) ?? '0x' })) }
    }
    const call = body as RpcCall
    if (call.method === 'chain_getBlockHash') {
      // The pinned issuance read resolves the indexed head to a hash first; a
      // test that wants the pin to fail clears this flag.
      return { ok: true, json: async () => ({ result: blockHashResolves ? '0x' + 'ab'.repeat(32) : null }) }
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: call.id, result: hydrationEthCall(call) ?? '0x' }) }
  }
  if (url === ETH_RPC) {
    if (!ethChainReachable) return { ok: false, json: async () => ({}) }
    const calls = body as RpcCall[]
    return {
      ok: true,
      json: async () => calls.map(call => {
        const { to, data } = call.params[0] as { to: string; data: string }
        const selector = data.slice(0, 10)
        const byToken = ALL_ASSETS.find(a => a.token.slice(26) === to.slice(2).toLowerCase())
        const byManager = ALL_ASSETS.find(a => ORIGIN_PEER[a.assetId]?.slice(26) === to.slice(2).toLowerCase())
        if (selector === '0x70a08231') {
          const custody = byToken ? evmCustody.get(byToken.assetId) : undefined
          return { id: call.id, result: '0x' + word(custody ?? ethCustody) }
        }
        if (selector === '0xb187bd26') return { id: call.id, result: '0x' + word(0n) }
        if (selector === '0xfc0c546a') {
          // The origin manager answering for the token the registry recorded.
          return { id: call.id, result: byManager ? byManager.token : '0x' }
        }
        if (selector === '0x74aa7bfc') return { id: call.id, result: '0x' + word(evmRateLimitSeconds) }
        if (selector === '0x86e11ffa' || selector === '0xd788c147') {
          return { id: call.id, result: '0x' + word(packTrimmed(ORIGIN_LIMIT_TRIMMED, 8)) + word(packTrimmed(ORIGIN_LIMIT_TRIMMED, 8)) + word(LAST_TX_SEC) }
        }
        if (selector === '0xf5cfec18' || selector === '0x02717250') return { id: call.id, result: '0x' + word(ORIGIN_CAPACITY_RAW) }
        if (selector === '0x396c16b7') {
          return { id: call.id, result: '0x' + word(evmExecuted.has('0x' + data.slice(10)) ? 1n : 0n) }
        }
        if (selector === '0xfd96063c') {
          return { id: call.id, result: evmQueue.get('0x' + data.slice(10)) ?? '0x' + '0'.repeat(192) }
        }
        return { id: call.id, result: '0x' }
      }),
    }
  }
  if (url === SOL_RPC) {
    const call = body as RpcCall
    if (call.method === 'getProgramAccounts') {
      const programId = call.params[0] as string
      const filters = (call.params[1] as { filters?: { dataSize?: number }[] }).filters ?? []
      const size = filters.find(f => f.dataSize != null)?.dataSize
      if (size === 32 || size === 33) {
        const bytes = new Uint8Array(size)
        bytes.set(hexToBytes(size === 32 ? SOLANA_OUTBOX_RATE_LIMIT_DISCRIMINATOR : SOLANA_INBOX_RATE_LIMIT_DISCRIMINATOR), 0)
        const offset = size === 32 ? 8 : 9
        const view = new DataView(bytes.buffer)
        view.setBigUint64(offset, SOLANA_LIMIT_NATIVE, true)
        view.setBigUint64(offset + 8, SOLANA_CAPACITY_NATIVE, true)
        view.setBigInt64(offset + 16, LAST_TX_SEC, true)
        return { ok: true, json: async () => ({ result: [{ account: { data: [Buffer.from(bytes).toString('base64'), 'base64'] } }] }) }
      }
      if (size === 75) {
        const accounts = (solanaInbox.get(programId) ?? []).map(hex => ({ account: { data: [Buffer.from(hex.replace(/^0x/, ''), 'hex').toString('base64'), 'base64'] } }))
        return { ok: true, json: async () => ({ result: accounts }) }
      }
      const asset = ALL_ASSETS.find(a => ORIGIN_PEER[a.assetId] === '0x' + programIdHex(programId))
      if (!asset) return { ok: true, json: async () => ({ result: [] }) }
      return { ok: true, json: async () => ({ result: [{ account: { data: [solanaConfigAccount(asset.token, asset.assetId), 'base64'] } }] }) }
    }
    if (call.method === 'getTokenAccountBalance') {
      const bytes = base58Decode(call.params[0] as string)!
      const assetId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(28)
      const amount = solanaCustody.get(assetId)
      if (amount == null) return { ok: true, json: async () => ({}) }
      return { ok: true, json: async () => ({ result: { value: { amount: amount.toString(), decimals: 6 } } }) }
    }
    return { ok: false, json: async () => ({}) }
  }
  if (url.startsWith(SCAN)) {
    if (!scanReachable) return { ok: false, json: async () => ({}) }
    return { ok: true, json: async () => ({ operations: scanOps }) }
  }
  return { ok: false, json: async () => ({}) }
})
const fetchStub = fetchImpl as unknown as typeof fetch

beforeEach(() => {
  queries = []
  // Discovery keeps its registry read incrementally, and these cases vary the
  // fake registry between them — on chain it only ever grows.
  resetWormholeDiscoveryForTests()
  ethChainReachable = true
  scanReachable = true
  scanOps = []
  vi.stubGlobal('fetch', fetchStub)
  blockHashResolves = true
  deadReadResolves = true
  deadBalances.clear()
  evmExecuted.clear()
  // One Tokens.TotalIssuance per discovered asset, pinned to the indexed head's
  // block hash. The asset id is read back out of the key's little-endian u32
  // tail, so a reordered asset set cannot silently line up with the wrong
  // issuance.
  storageBatch.mockImplementation(async (keys: string[]) => keys.map(key => {
    const le = key.slice(-8)
    const assetId = Number.parseInt(le.slice(6, 8) + le.slice(4, 6) + le.slice(2, 4) + le.slice(0, 2), 16)
    const value = issuance.get(assetId)
    return value == null ? null : u128Le(value)
  }))
})

// A first-sighted shortfall arms a real 15s timer. Every test that produces one
// runs the pass explicitly instead, so nothing is left armed between cases.
afterEach(() => { cancelWormholeBackingConfirmation() })

describe('the Wormhole backing snapshot', () => {
  it('composes a row per discovered asset, with an unconfigured chain reading null rather than zero', async () => {
    registry = [USDC, SUI]
    minters.clear()
    minters.set(USDC.assetId, widen(USDC.manager))
    minters.set(SUI.assetId, widen(SUI.manager))
    issuance = new Map([[USDC.assetId, 227_031_998_904n], [SUI.assetId, 194_145_757_066_522n]])
    initWormholeNttService(fakeClient())

    await refreshWormholeBacking()
    const detail = await getWormholeBridgeDetail()

    expect(detail.hydrationChainId).toBe(73)
    expect(detail.assets.map(a => a.symbol).sort()).toEqual(['SUI', 'USDC'])

    const usdc = detail.assets.find(a => a.symbol === 'USDC')!
    expect(usdc.originChainName).toBe('Ethereum')
    expect(usdc.mode).toBe('burning')
    expect(usdc.peer).toBe('0x447b2c7485a3d6813f8197e605b10bccd8dd8398')
    expect(usdc.locked).toBe('227031998904')
    expect(usdc.issuance).toBe('227031998904')
    expect(usdc.residual).toBe('0')
    expect(usdc.status).toBe('ok')

    // Sui has no endpoint configured, so nothing about its custody is claimed.
    const sui = detail.assets.find(a => a.symbol === 'SUI')!
    expect(sui.locked).toBeNull()
    expect(sui.lockedUsd).toBeNull()
    expect(sui.residual).toBeNull()
    expect(sui.status).toBe('unconfigured')
    expect(detail.chains.find(c => c.chainId === 21)).toMatchObject({ configured: false, ok: false, family: 'sui' })
    expect(detail.chains.find(c => c.chainId === 2)).toMatchObject({ configured: true, ok: true, family: 'evm' })

    // The unread chain contributes nothing to the totals rather than a zero.
    expect(detail.totals.lockedUsd).toBeCloseTo(227_031.998904, 4)
    expect(detail.totals.deficitUsd).toBe(0)

    // The EVM-log scan is bounded below by the first NttMinterSet block rather
    // than sweeping all of history.
    expect(queries.find(q => q.includes('raw_evm_logs'))).toContain('block_height >= 13378659')
  })

  it('rolls the same snapshot up into the dashboard summary', async () => {
    const summary = await getWormholeSummary()
    expect(summary).toMatchObject({ assets: 2, worstStatus: 'unconfigured', deficitUsd: 0 })
    expect(summary!.lockedUsd).toBeCloseTo(227_031.998904, 4)
    expect(summary!.asOf).not.toBeNull()
  })

  it('reports unknown deficit totals, not $0, when nothing was measurable', async () => {
    registry = [SUI]
    await refreshWormholeBacking()
    const detail = await getWormholeBridgeDetail()
    expect(detail.assets.map(a => a.status)).toEqual(['unconfigured'])
    // $0 would be a measurement; nothing here measured any residual.
    expect(detail.totals.deficitUsd).toBeNull()
    expect(detail.totals.surplusUsd).toBeNull()
    expect((await getWormholeSummary())!.deficitUsd).toBeNull()
    // Restore the two-asset snapshot the neighbouring cases read.
    registry = [USDC, SUI]
    await refreshWormholeBacking()
  })

  it('picks up an asset registered on chain with no code change', async () => {
    registry = [USDC, SUI, EURC]
    minters.set(EURC.assetId, widen(EURC.manager))
    issuance.set(EURC.assetId, 360_131_957_487n)

    await refreshWormholeBacking()
    const detail = await getWormholeBridgeDetail()
    expect(detail.assets.map(a => a.symbol).sort()).toEqual(['EURC', 'SUI', 'USDC'])
    expect(detail.assets.find(a => a.symbol === 'EURC')!.issuance).toBe('360131957487')
  })

  it('keeps the previous snapshot when a cycle throws', async () => {
    const before = await getWormholeBridgeDetail()
    const broken = {
      query: async () => { throw new Error('clickhouse unavailable') },
      insert: async () => {},
      close: async () => {},
    } as unknown as ClickHouseClient
    initWormholeNttService(broken)

    await expect(refreshWormholeBacking()).rejects.toThrow('clickhouse unavailable')

    initWormholeNttService(fakeClient())
    const after = await getWormholeBridgeDetail()
    expect(after.assets.map(a => a.symbol)).toEqual(before.assets.map(a => a.symbol))
    expect(after.asOf).toBe(before.asOf)
  })

  it('keeps a chain’s last custody read when only that chain fails', async () => {
    const before = await getWormholeBridgeDetail()
    const lockedBefore = before.assets.find(a => a.symbol === 'USDC')!.locked
    const chainAsOfBefore = before.chains.find(c => c.chainId === 2)!.asOf

    ethChainReachable = false
    await refreshWormholeBacking()
    const after = await getWormholeBridgeDetail()

    const usdc = after.assets.find(a => a.symbol === 'USDC')!
    expect(usdc.locked).toBe(lockedBefore)
    expect(usdc.status).not.toBe('unconfigured')
    const chain = after.chains.find(c => c.chainId === 2)!
    expect(chain.configured).toBe(true)
    // The chain reports itself as not ok, and carries the timestamp of the read
    // that is actually being shown rather than this cycle's.
    expect(chain.ok).toBe(false)
    expect(chain.asOf).toBe(chainAsOfBefore)
  })

  it('falls back to the no-scan ladder when Wormholescan cannot be reached', async () => {
    ethChainReachable = true
    ethCustody = 227_031_998_904n - 80_000_000_000n
    scanReachable = false
    await refreshWormholeBacking()
    const detail = await getWormholeBridgeDetail()

    const usdc = detail.assets.find(a => a.symbol === 'USDC')!
    expect(detail.scan).toMatchObject({ configured: true, ok: false })
    expect(usdc.inflightIn).toBeNull()
    expect(usdc.inflightCount).toBeNull()
    // A shortfall an unreachable scan cannot rule out as a pending transfer is
    // never graded as a deficit.
    expect(usdc.status).toBe('unverified')
  })
})

// Real Hydration extrinsics, so the history composition is pinned against what
// the chain actually wrote: an outbound send of 3500 SUI at block 13,728,047
// and an inbound redemption of 4921.564541 USDC at block 13,725,326 whose
// extrinsic also pays the relayer and the treasury in WETH.
const SUI_SEND_LOG = {
  block_height: 13_728_047,
  event_index: 85,
  extrinsic_index: 3,
  block_timestamp: '2026-08-22 07:00:00',
  contract: '0x3792a6d63c31941b2805181771795d9176fa82a1',
  topics: ['0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2', '0x000000000000000000000000a224d6f4e0e276b34d91bfe6c3a5fe6838322af7'],
  data: '0x'
    + '000000000000000000000000000000000000000000000000000000000000000c'
    + '0000000000000000000000000000000000000000000000000000000000000000'
    + '0000000000000000000000000000000000000000000000000000000000000080'
    + '00000000000000000000000000000000000000000000000000000000000000ca'
    + '00000000000000000000000000000000000000000000000000000000000000d9'
    + '9945ff10'
    + '000000000000000000000000978443f00cab6b09445140321ec73a221ebff5f8'
    + 'a0bc45e0384140dc125f273eda89cad1434f5dee430726cf6364bdcceba1e9a3'
    + '0091'
    + '000000000000000000000000000000000000000000000000000000000000000a'
    + '000000000000000000000000fc39fcf04a8071b7409823b7c82427ce67910c6e'
    + '004f994e545408000000517da02c00'
    + '00000000000000000000000000000000000000000000000000000001000f4531'
    + '158827f09bac47981480d0e8156565b0481dc063ae9e1d0c80c56394012d45a3'
    + '00150000000000000000',
}
const USDC_RECEIVE_LOG = {
  block_height: 13_725_326,
  event_index: 18,
  extrinsic_index: 3,
  block_timestamp: '2026-08-21 20:00:00',
  contract: '0x0d7488b39aa64468a709ec3b3d354defe539ed97',
  topics: ['0xf6fc529540981400dc64edf649eb5e2e0eb5812a27f8c81bac2c1d317e71a5f0'],
  data: '0x'
    + '1ad03194fc0fd427479b7e6475238558897133cbfa23860b905c5d0b1017f7e8'
    + '0000000000000000000000000000000000000000000000000000000000000002'
    + '000000000000000000000000a108bd5dbc6ce665aebb6895351e0609c76f8efc'
    + '0000000000000000000000000000000000000000000000000000000000000032',
}
const USDC_REDEEMED_LOG = {
  block_height: 13_725_326,
  event_index: 20,
  extrinsic_index: 3,
  block_timestamp: '2026-08-21 20:00:00',
  contract: USDC.manager,
  topics: ['0x504e6efe18ab9eed10dc6501a417f5b12a2f7f2b1593aed9b89f9bce3cf29a91', '0xf7dc33b24e2405e6366142773453f4e50939646bd273077f60b60d9e4c13fe8a'],
  data: '0x',
}
const TOKEN_LEGS = [
  { block_height: 13_725_326, event_index: 13, extrinsic_index: 3, block_timestamp: '2026-08-21 20:00:00', event_name: 'Tokens.Deposited', currency_id: 21, who: '0x08e92f13621d74c766fe489a27a7fdfeef7e00f9e854af1dd102781699b4357e', from_account: '', to_account: '', amount: '4921564541' },
  { block_height: 13_725_326, event_index: 15, extrinsic_index: 3, block_timestamp: '2026-08-21 20:00:00', event_name: 'Tokens.Deposited', currency_id: 20, who: '0x45544800f1db8c4bfbb3d6a97c9b669a2ffc0b70f41f35470000000000000000', from_account: '', to_account: '', amount: '164737324773' },
  { block_height: 13_728_047, event_index: 77, extrinsic_index: 3, block_timestamp: '2026-08-22 07:00:00', event_name: 'Tokens.Transfer', currency_id: 1_000_753, who: '', from_account: '0xfc39fcf04a8071b7409823b7c82427ce67910c6ed80aa0e5093aff234624c820', to_account: '0x45544800978443f00cab6b09445140321ec73a221ebff5f80000000000000000', amount: '3500000000000' },
  { block_height: 13_728_047, event_index: 79, extrinsic_index: 3, block_timestamp: '2026-08-22 07:00:00', event_name: 'Tokens.Withdrawn', currency_id: 1_000_753, who: '0x45544800978443f00cab6b09445140321ec73a221ebff5f80000000000000000', from_account: '', to_account: '', amount: '3500000000000' },
]

function historyClient(): ClickHouseClient {
  return {
    query: async ({ query }: { query: string }) => {
      queries.push(query)
      if (query.includes('raw_blocks')) return { json: async () => [{ block_height: 13_728_100, block_timestamp: '2026-08-22 08:00:00' }] }
      if (query.includes('AssetRegistry.LocationSet')) {
        return { json: async () => [USDC, SUI].map(a => ({ asset_id: a.assetId, args: locationArgs(a), block: 13_400_000 })) }
      }
      if (query.includes('min(block_height) AS min_block')) return { json: async () => [{ min_block: 13_378_659 }] }
      if (query.includes('price_data.assets')) {
        return { json: async () => [USDC, SUI].map(a => ({ asset_id: a.assetId, symbol: a.symbol, decimals: a.decimals })) }
      }
      if (query.includes('raw_evm_logs')) return { json: async () => [SUI_SEND_LOG, USDC_RECEIVE_LOG, USDC_REDEEMED_LOG] }
      if (query.includes('Tokens.Withdrawn')) return { json: async () => TOKEN_LEGS }
      return { json: async () => [] }
    },
    insert: async () => {},
    close: async () => {},
  } as unknown as ClickHouseClient
}

describe('transfer history composed from the indexed logs', () => {
  beforeEach(async () => {
    // Pinned just after the fixture's two transfers, so they stay inside the
    // 14-day window forever — measured against the real clock, the inbound leg
    // aged out and the direction counts silently became zero.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-08-22T09:00:00Z'))
    registry = [USDC, SUI]
    minters.clear()
    minters.set(USDC.assetId, widen(USDC.manager))
    minters.set(SUI.assetId, widen(SUI.manager))
    issuance = new Map([[USDC.assetId, 227_031_998_904n], [SUI.assetId, 194_145_757_066_522n]])
    initWormholeNttService(historyClient())
    await refreshWormholeBacking()
  })
  afterEach(() => { vi.useRealTimers() })

  it('reads the outbound send from the burn and names its sender', async () => {
    const detail = await getWormholeBridgeDetail()
    const out = detail.recent.find(r => r.direction === 'out')!
    expect(out).toMatchObject({
      assetId: '1000753',
      symbol: 'SUI',
      amount: '3500000000000',
      counterpartyChainId: 21,
      blockHeight: 13_728_047,
      extrinsicIndex: 3,
      sequence: '12',
    })
    expect(out.account).toBe('0xfc39fcf04a8071b7409823b7c82427ce67910c6ed80aa0e5093aff234624c820')
    expect(out.accountRef).toEqual({
      accountId: '0xfc39fcf04a8071b7409823b7c82427ce67910c6ed80aa0e5093aff234624c820',
      address: '0xfc39fcf04a8071b7409823b7c82427ce67910c6ed80aa0e5093aff234624c820',
    })
  })

  it('reads the inbound mint past the same-extrinsic fee legs', async () => {
    const detail = await getWormholeBridgeDetail()
    const inbound = detail.recent.find(r => r.direction === 'in')!
    expect(inbound).toMatchObject({
      assetId: '21',
      amount: '4921564541',
      counterpartyChainId: 2,
      sequence: '50',
      account: '0x08e92f13621d74c766fe489a27a7fdfeef7e00f9e854af1dd102781699b4357e',
    })
    // The WETH fee refund in the same extrinsic is not a bridge transfer.
    expect(detail.recent.filter(r => r.assetId === '20')).toEqual([])
  })

  it('orders the feed newest first and counts both directions in the window', async () => {
    const detail = await getWormholeBridgeDetail()
    expect(detail.recent.map(r => r.blockHeight)).toEqual([13_728_047, 13_725_326])
    expect(detail.assets.find(a => a.symbol === 'SUI')!.transfers14d).toEqual({ out: 1, in: 0 })
    expect(detail.assets.find(a => a.symbol === 'USDC')!.transfers14d).toEqual({ out: 0, in: 1 })
  })

  it('carries a queue reading of null for an origin nothing could be read from', async () => {
    // Sui has no endpoint and no queue reader, so its queued figure is unknown
    // rather than zero — the distinction the summary block keys off.
    const detail = await getWormholeBridgeDetail()
    expect(detail.assets.find(a => a.symbol === 'SUI')!.queued).toBeNull()
    expect(detail.assets.find(a => a.symbol === 'SUI')!.queuedCount).toBeNull()
    // Ethereum was read and holds nothing back.
    expect(detail.assets.find(a => a.symbol === 'USDC')!.queued).toBe('0')
    expect(detail.queued).toEqual([])
  })

  it('states the supply NTT flows do not explain, as issuance − minted + burned', async () => {
    const detail = await getWormholeBridgeDetail()
    const sui = detail.assets.find(a => a.symbol === 'SUI')!
    expect(sui.flows).toEqual({ mintedIn: '0', burnedOut: '3500000000000', nonNtt: String(194_145_757_066_522n + 3_500_000_000_000n) })
    const usdc = detail.assets.find(a => a.symbol === 'USDC')!
    expect(usdc.flows).toEqual({ mintedIn: '4921564541', burnedOut: '0', nonNtt: String(227_031_998_904n - 4_921_564_541n) })
  })
})

// ── origin rate-limiter queue ───────────────────────────────────────────────

// The real Ethereum case. 79,998.96642431 sUSDS left Hydration at block
// 13,703,216 extrinsic 2 (core bridge event 24, VAA sequence 8); Ethereum
// redeemed it and its manager 0x5085a486…14b5 then held it queued under digest
// 0x319c998f…d41c until 2026-08-21T12:20:35Z. The payload below is the log's
// data field byte for byte, so the digest the service probes with is derived,
// not asserted.
const SUSDS_SEND_LOG = {
  block_height: 13_703_216,
  event_index: 24,
  extrinsic_index: 2,
  block_timestamp: '2026-08-20 12:19:45',
  contract: '0x3792a6d63c31941b2805181771795d9176fa82a1',
  topics: ['0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2', '0x00000000000000000000000068ecadd7934d4fcfeabafb209c95d379b96400cb'],
  data: '0x'
    + '0000000000000000000000000000000000000000000000000000000000000008'
    + '0000000000000000000000000000000000000000000000000000000000000000'
    + '0000000000000000000000000000000000000000000000000000000000000080'
    + '00000000000000000000000000000000000000000000000000000000000000ca'
    + '00000000000000000000000000000000000000000000000000000000000000d9'
    + '9945ff10'
    + '0000000000000000000000001973e7044d9a7c7bb2d6ea1693a296a9e4b7e448'
    + '0000000000000000000000005085a4863f89ec9553f70187ee73b5aae0fd14b5'
    + '0091'
    + '0000000000000000000000000000000000000000000000000000000000000006'
    + '000000000000000000000000a1a687bee8249b337bfa3f644f6e1cc7dca68e36'
    + '004f994e545408000007469eff637f'
    + '00000000000000000000000000000000000000000000000000000001000f4529'
    + '000000000000000000000000e84121cad17d2da9e0220aa8453f85396e73aa3e'
    + '00020000000000000000',
}
const SUSDS_DIGEST = '0x319c998f9e8ab534fb886dbfc4db6fccf0d10101cdb687f1a6657f79cb83d41c'
const SUSDS_QUEUED_STRUCT = '0x'
  + '0000000000000000000000000000000000000000000000000007469eff637f08'
  + '000000000000000000000000000000000000000000000000000000006a86f113'
  + '000000000000000000000000e84121cad17d2da9e0220aa8453f85396e73aa3e'
const SUSDS_QUEUED_RAW = 79_998_966_424_310_000_000_000n
const SUSDS_SEED_SURPLUS = 410_000_000_000_000_000n
const SUSDS_LOCKED = 3_284_711_408_355_733_425_437_090n

// A Solana-bound PRIME send of 2 PRIME. Its InboxItem is matched back to this
// send by recipient and amount, which is how the account layout was validated
// against the live programs.
const PRIME_RECIPIENT = '0x6d836da38c4d4dfaee11ee00745980f820e416b2ca3675c606360b402262de61'
const PRIME_QUEUED_RAW = 2_000_000n
const PRIME_LOCKED = 100_000_000_000n
const PRIME_RELEASE_AT = 1_785_863_686

// LogMessagePublished data for an outbound NTT send, framed the way the core
// bridge writes it.
function sendLogData(sequence: number, sourceManager: string, recipientManager: string, transfer: {
  trimmedDecimals: number; trimmedAmount: bigint; assetId: number; recipient: string; toChain: number
}): string {
  const pad32 = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
  const ntt = '994e5454'
    + transfer.trimmedDecimals.toString(16).padStart(2, '0')
    + transfer.trimmedAmount.toString(16).padStart(16, '0')
    + '0'.repeat(55) + '1' + transfer.assetId.toString(16).padStart(8, '0')
    + pad32(transfer.recipient)
    + transfer.toChain.toString(16).padStart(4, '0')
  const managerMessage = pad32('0x' + sequence.toString(16))
    + pad32('0x' + 'a1a687bee8249b337bfa3f644f6e1cc7dca68e36')
    + (ntt.length / 2).toString(16).padStart(4, '0') + ntt
  const payload = '9945ff10' + pad32(sourceManager) + pad32(recipientManager)
    + (managerMessage.length / 2).toString(16).padStart(4, '0') + managerMessage + '0000'
  const length = payload.length / 2
  return '0x' + word(BigInt(sequence)) + word(0n) + word(128n) + word(202n) + word(BigInt(length))
    + payload.padEnd(Math.ceil(length / 32) * 64, '0')
}

const PRIME_SEND_LOG = {
  block_height: 13_700_000,
  event_index: 12,
  extrinsic_index: 2,
  block_timestamp: '2026-08-19 09:00:00',
  contract: '0x3792a6d63c31941b2805181771795d9176fa82a1',
  topics: ['0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2', '0x000000000000000000000000c0ffee254729296a45a3885639ac7e10f9d54979'],
  data: sendLogData(4, PRIME.manager, ORIGIN_PEER[PRIME.assetId], {
    trimmedDecimals: 6, trimmedAmount: PRIME_QUEUED_RAW, assetId: PRIME.assetId, recipient: PRIME_RECIPIENT, toChain: 1,
  }),
}

function queueClient(): ClickHouseClient {
  return {
    query: async ({ query }: { query: string }) => {
      queries.push(query)
      if (query.includes('raw_blocks')) return { json: async () => [{ block_height: 13_728_100, block_timestamp: '2026-08-22 08:00:00' }] }
      if (query.includes('AssetRegistry.LocationSet')) {
        return { json: async () => [SUSDS, PRIME].map(a => ({ asset_id: a.assetId, args: locationArgs(a), block: 13_400_000 })) }
      }
      if (query.includes('min(block_height) AS min_block')) return { json: async () => [{ min_block: 13_378_659 }] }
      if (query.includes('price_data.assets')) {
        return { json: async () => [SUSDS, PRIME].map(a => ({ asset_id: a.assetId, symbol: a.symbol, decimals: a.decimals })) }
      }
      if (query.includes('raw_evm_logs')) return { json: async () => [SUSDS_SEND_LOG, PRIME_SEND_LOG] }
      return { json: async () => [] }
    },
    insert: async () => {},
    close: async () => {},
  } as unknown as ClickHouseClient
}

describe('transfers held by an origin rate limiter', () => {
  beforeEach(async () => {
    // Pinned to a moment while both transfers were still held, so the fixtures
    // stay inside the lookback window forever.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-08-21T00:00:00Z'))
    registry = [SUSDS, PRIME]
    minters.clear()
    minters.set(SUSDS.assetId, widen(SUSDS.manager))
    minters.set(PRIME.assetId, widen(PRIME.manager))
    issuance = new Map([
      [SUSDS.assetId, SUSDS_LOCKED - SUSDS_QUEUED_RAW - SUSDS_SEED_SURPLUS],
      [PRIME.assetId, PRIME_LOCKED - PRIME_QUEUED_RAW],
    ])
    evmCustody.clear()
    evmCustody.set(SUSDS.assetId, SUSDS_LOCKED)
    solanaCustody.clear()
    solanaCustody.set(PRIME.assetId, PRIME_LOCKED)
    evmQueue.clear()
    evmQueue.set(SUSDS_DIGEST, SUSDS_QUEUED_STRUCT)
    solanaInbox.clear()
    solanaInbox.set(programIdBase58(ORIGIN_PEER[PRIME.assetId]), [
      solanaInboxItem(PRIME_QUEUED_RAW, PRIME_RECIPIENT, SOLANA_RELEASE_STATUS.releaseAfter, PRIME_RELEASE_AT),
    ])
    initWormholeNttService(queueClient())
    await refreshWormholeBacking()
  })

  afterEach(() => { vi.useRealTimers() })

  it('finds the real sUSDS transfer under the digest derived from its own log', async () => {
    const detail = await getWormholeBridgeDetail()
    const queued = detail.queued.find(q => q.symbol === 'sUSDS')!
    expect(queued.digest).toBe(SUSDS_DIGEST)
    expect(queued.amount).toBe(SUSDS_QUEUED_RAW.toString())
    expect(queued.chainId).toBe(2)
    expect(queued.recipient).toBe('0xe84121cad17d2da9e0220aa8453f85396e73aa3e')
    expect(queued.queuedAt).toBe('2026-08-20T12:20:35.000Z')
    // txTimestamp + rateLimitDuration(), read once per manager.
    expect(queued.releasableAt).toBe('2026-08-21T12:20:35.000Z')
    expect(queued.releasable).toBe(false)
  })

  it('turns what would read as custody surplus into a balanced asset', async () => {
    const detail = await getWormholeBridgeDetail()
    const susds = detail.assets.find(a => a.symbol === 'sUSDS')!
    expect(susds.queued).toBe(SUSDS_QUEUED_RAW.toString())
    expect(susds.queuedCount).toBe(1)
    // locked − issuance − inflight − queued leaves only the seeded overfunding.
    expect(susds.residual).toBe(SUSDS_SEED_SURPLUS.toString())
    expect(susds.status).toBe('ok')
  })

  it('reads a Solana inbox item the same way, in the asset’s own decimals', async () => {
    const detail = await getWormholeBridgeDetail()
    const queued = detail.queued.find(q => q.symbol === 'PRIME')!
    expect(queued.chainId).toBe(1)
    expect(queued.amount).toBe(PRIME_QUEUED_RAW.toString())
    // Solana records only the release time, never the time it was queued.
    expect(queued.queuedAt).toBeNull()
    expect(queued.releasableAt).toBe('2026-08-04T17:14:46.000Z')
    expect(queued.releasable).toBe(true)

    const prime = detail.assets.find(a => a.symbol === 'PRIME')!
    expect(prime.queued).toBe(PRIME_QUEUED_RAW.toString())
    expect(prime.residual).toBe('0')
    expect(prime.status).toBe('ok')
  })

  it('keeps the previous queue reading when the origin cannot be reached', async () => {
    const before = await getWormholeBridgeDetail()
    ethChainReachable = false
    await refreshWormholeBacking()
    const after = await getWormholeBridgeDetail()
    const susds = after.assets.find(a => a.symbol === 'sUSDS')!
    expect(susds.queued).toBe(before.assets.find(a => a.symbol === 'sUSDS')!.queued)
    expect(susds.queued).not.toBeNull()
  })

  it('rolls the queue up into the dashboard summary', async () => {
    const summary = await getWormholeSummary()
    expect(summary!.queuedCount).toBe(2)
    expect(summary!.queuedUsd).toBeCloseTo(79_998.96642431 * 1.09 + 2, 2)
  })

  // Last, because a settled digest is cached for the life of the process and
  // that is exactly what the second half asserts.
  it('drops an item the origin has released, and never probes its digest again', async () => {
    solanaInbox.set(programIdBase58(ORIGIN_PEER[PRIME.assetId]), [
      solanaInboxItem(PRIME_QUEUED_RAW, PRIME_RECIPIENT, SOLANA_RELEASE_STATUS.released, PRIME_RELEASE_AT),
    ])
    evmQueue.set(SUSDS_DIGEST, '0x' + '0'.repeat(192))
    await refreshWormholeBacking()
    const detail = await getWormholeBridgeDetail()
    expect(detail.queued).toEqual([])
    expect(detail.assets.find(a => a.symbol === 'sUSDS')!.queued).toBe('0')
    expect(detail.assets.find(a => a.symbol === 'PRIME')!.queued).toBe('0')

    // A release zeroes the record permanently, so the digest is cached settled
    // and the next cycle stops asking about it even though the manager would
    // answer again.
    const before = fetchStubCalls()
    evmQueue.set(SUSDS_DIGEST, SUSDS_QUEUED_STRUCT)
    await refreshWormholeBacking()
    expect(queueProbes(before)).not.toContain(SUSDS_DIGEST.slice(2))
    expect((await getWormholeBridgeDetail()).queued).toEqual([])
  })
})

// ── reads pinned to one block ───────────────────────────────────────────────

// The transient deficit this pin exists to prevent, measured live: a 5,977.41
// USDC inbound minted at block 13,730,752 but whose ReceivedMessage log reached
// the index 39 seconds later. Read at the chain's head, the mint was inside
// issuance while the redemption was not yet in the indexed set — so the same
// transfer counted as supply AND as a pending transfer, and the residual fell by
// its full amount for two cycles. Both sides now read at the indexed head, where
// the mint and its log are the same extrinsic.
const RACE_AMOUNT = 5_977_410_000n

function pinnedClient(head: number): ClickHouseClient {
  return {
    query: async ({ query }: { query: string }) => {
      queries.push(query)
      if (query.includes('raw_blocks')) return { json: async () => [{ block_height: head, block_timestamp: '2026-08-22 09:22:00' }] }
      if (query.includes('AssetRegistry.LocationSet')) {
        return { json: async () => [USDC].map(a => ({ asset_id: a.assetId, args: locationArgs(a), block: 13_400_000 })) }
      }
      if (query.includes('min(block_height) AS min_block')) return { json: async () => [{ min_block: 13_378_659 }] }
      if (query.includes('price_data.assets')) {
        return { json: async () => [USDC].map(a => ({ asset_id: a.assetId, symbol: a.symbol, decimals: a.decimals })) }
      }
      return { json: async () => [] }
    },
    insert: async () => {},
    close: async () => {},
  } as unknown as ClickHouseClient
}

describe('reads pinned to the indexed head', () => {
  beforeEach(() => {
    registry = [USDC]
    minters.clear()
    minters.set(USDC.assetId, widen(USDC.manager))
    evmCustody.clear()
    storageBatch.mockClear()
  })

  // The consecutive-negative count lives for the life of the process, so a case
  // about the damping has to establish its own starting point rather than
  // inherit whatever the previous one left behind.
  const balancedCycle = async () => {
    issuance = new Map([[USDC.assetId, 227_031_998_904n]])
    evmCustody.set(USDC.assetId, 227_031_998_904n)
    initWormholeNttService(pinnedClient(13_730_752))
    await refreshWormholeBacking()
  }

  it('reads issuance at the indexed head’s block hash, not at the chain’s', async () => {
    issuance = new Map([[USDC.assetId, 227_031_998_904n]])
    evmCustody.set(USDC.assetId, 227_031_998_904n)
    initWormholeNttService(pinnedClient(13_730_752))
    await refreshWormholeBacking()

    const [keys, at] = storageBatch.mock.calls.at(-1)!
    expect(at).toBe('0x' + 'ab'.repeat(32))
    expect(keys).toHaveLength(1)
    // The log window is bounded by the same block, so the redemption set and the
    // issuance read describe one chain state rather than two.
    expect(queries.find(q => q.includes('raw_evm_logs'))).toContain('block_height <= 13730752')
  })

  // Supply burned at the dead address must be read in the SAME chain state as
  // issuance, because it is subtracted from it. A head-read here would put the
  // two sides of one subtraction in different blocks.
  it('reads the dead-address balance pinned to the same indexed head', async () => {
    issuance = new Map([[USDC.assetId, 227_031_998_904n]])
    evmCustody.set(USDC.assetId, 227_031_998_904n)
    initWormholeNttService(pinnedClient(13_730_752))
    fetchImpl.mockClear()
    await refreshWormholeBacking()

    // Hydration's RPC only: the origin custody read uses the same selector, and
    // it is neither pinned nor supposed to be.
    const balanceOfCalls = fetchImpl.mock.calls
      .filter(([input]) => String(input) === HYDRATION_RPC)
      .flatMap(([, init]) => {
        const body = init?.body ? JSON.parse(init.body) as RpcCall | RpcCall[] : null
        return Array.isArray(body) ? body : []
      })
      .filter(c => c.method === 'eth_call' && String((c.params[0] as { data?: string }).data ?? '').startsWith('0x70a08231'))
    expect(balanceOfCalls.length).toBeGreaterThan(0)
    for (const call of balanceOfCalls) {
      expect(String((call.params[0] as { to: string }).to)).toBe('0x' + '0'.repeat(31) + '1' + USDC.assetId.toString(16).padStart(8, '0'))
      expect(call.params[1]).toBe('0x' + (13_730_752).toString(16))
    }
  })

  it('fails the cycle when the pinned dead-address read cannot be answered', async () => {
    await balancedCycle()
    const before = await getWormholeBridgeDetail()

    deadReadResolves = false
    await expect(refreshWormholeBacking()).rejects.toThrow('dead-address balance read at the indexed head')
    // An unread dead balance treated as zero would restate every token burned
    // there as an unbacked one, so the previous snapshot keeps serving.
    expect((await getWormholeBridgeDetail()).asOf).toBe(before.asOf)
  })

  it('states the equation on circulating supply, and says so', async () => {
    // The live SUI shape, on USDC's fixture: 10 units of supply sit at 0x…dEaD,
    // and custody is 10 short of GROSS issuance because of it.
    issuance = new Map([[USDC.assetId, 227_031_998_904n]])
    evmCustody.set(USDC.assetId, 227_031_998_904n - 10_000_000n)
    deadBalances.set(USDC.assetId, 10_000_000n)
    initWormholeNttService(pinnedClient(13_730_752))
    await refreshWormholeBacking()

    const usdc = (await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!
    // `issuance` stays GROSS on the wire; `burned` is the additive new term.
    expect(usdc.issuance).toBe('227031998904')
    expect(usdc.burned).toBe('10000000')
    expect(usdc.residual).toBe('0')
    expect(usdc.status).toBe('ok')
    expect(usdc.statusDetail).toContain('10 USDC burned at the dead address are excluded')
  })

  it('reports zero for an asset with nothing at the dead address', async () => {
    await balancedCycle()
    const usdc = (await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!
    expect(usdc.burned).toBe('0')
    expect(usdc.statusDetail).not.toContain('dead address')
  })

  // The reason the term exists at all: closing a gap raises issuance and the
  // dead-address balance by the same amount in the same block. That must not
  // read as a brand new shortfall of exactly the size of the fix.
  it('leaves the residual unchanged when a gap-closing mint lands', async () => {
    await balancedCycle()
    const before = (await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!

    const mint = 40_000_000n
    issuance = new Map([[USDC.assetId, 227_031_998_904n + mint]])
    deadBalances.set(USDC.assetId, mint)
    await refreshWormholeBacking()

    const after = (await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!
    expect(after.issuance).toBe((227_031_998_904n + mint).toString())
    expect(after.burned).toBe(mint.toString())
    expect(after.residual).toBe(before.residual)
    expect(after.status).toBe('ok')
  })

  it('does not raise a deficit from a single cycle’s shortfall', async () => {
    // Issuance carries the inbound mint; custody has not moved. Exactly the
    // shape the indexing lag produced.
    issuance = new Map([[USDC.assetId, 227_031_998_904n + RACE_AMOUNT]])
    evmCustody.set(USDC.assetId, 227_031_998_904n)
    initWormholeNttService(pinnedClient(13_730_752))
    await refreshWormholeBacking()

    const usdc = (await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!
    expect(usdc.residual).toBe((-RACE_AMOUNT).toString())
    expect(usdc.status).toBe('ok')
    expect(usdc.statusDetail).toContain('has not been confirmed by a second reading')
    expect((await getWormholeSummary())!.deficitUsd).toBe(0)
  })

  // The damping rule is "two independent reads agree", not "two full cycles".
  // A first sighting arms a narrow pass over the flagged assets ~15s out, and
  // THAT pass is what publishes the shortfall — a fifth of the old latency for
  // the same guarantee.
  it('publishes the shortfall once a targeted re-read confirms it, and clears it at once', async () => {
    await balancedCycle()
    issuance = new Map([[USDC.assetId, 227_031_998_904n + RACE_AMOUNT]])
    await refreshWormholeBacking()
    expect((await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!.status).toBe('ok')

    await runWormholeBackingConfirmation()
    const confirmed = (await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!
    expect(confirmed.status).toBe('deficit')
    expect(confirmed.statusDetail).toContain('not backed')

    // A recovery needs no confirmation: an upgrade applies on the next cycle.
    issuance = new Map([[USDC.assetId, 227_031_998_904n]])
    await refreshWormholeBacking()
    expect((await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!.status).toBe('ok')
  })

  it('leaves the row unconfirmed when the re-read comes back clean', async () => {
    await balancedCycle()
    issuance = new Map([[USDC.assetId, 227_031_998_904n + RACE_AMOUNT]])
    await refreshWormholeBacking()

    // The indexing lag the damping exists for: by the confirming read, custody
    // has caught up with the mint.
    evmCustody.set(USDC.assetId, 227_031_998_904n + RACE_AMOUNT)
    await runWormholeBackingConfirmation()
    expect((await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!.status).toBe('ok')

    // …and the clean reading reset the count, so the NEXT bad cycle is a first
    // sighting again rather than an instant downgrade.
    evmCustody.set(USDC.assetId, 227_031_998_904n)
    await refreshWormholeBacking()
    expect((await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!.status).toBe('ok')
  })

  it('leaves the row unconfirmed when the re-read itself fails', async () => {
    await balancedCycle()
    issuance = new Map([[USDC.assetId, 227_031_998_904n + RACE_AMOUNT]])
    await refreshWormholeBacking()

    blockHashResolves = false
    await runWormholeBackingConfirmation()          // throws inside, swallowed
    blockHashResolves = true
    expect((await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!.status).toBe('ok')

    // The count was left exactly where it stood rather than reset, so the next
    // full cycle is still the second agreeing reading — the pre-existing
    // two-cycle path remains the fallback when the fast one cannot read.
    await refreshWormholeBacking()
    expect((await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!.status).toBe('deficit')
  })

  // The confirming read is the same scoped cycle, so it re-reads the flagged
  // assets' dead-address balance too — a gap closed between the two readings
  // refutes the shortfall instead of confirming it.
  it('re-reads the dead-address balance for the assets it confirms', async () => {
    await balancedCycle()
    issuance = new Map([[USDC.assetId, 227_031_998_904n + RACE_AMOUNT]])
    await refreshWormholeBacking()

    // The gap is closed the way the devs close one: the extra supply is at
    // 0x…dEaD by the time the confirming read runs.
    deadBalances.set(USDC.assetId, RACE_AMOUNT)
    await runWormholeBackingConfirmation()
    const usdc = (await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!
    expect(usdc.status).toBe('ok')
    expect(usdc.statusDetail).not.toContain('not backed')
  })

  it('does nothing at all when no asset flagged', async () => {
    await balancedCycle()
    const before = (await getWormholeBridgeDetail()).asOf
    await runWormholeBackingConfirmation()
    expect((await getWormholeBridgeDetail()).asOf).toBe(before)
  })

  it('fails the cycle rather than falling back to the chain’s head', async () => {
    issuance = new Map([[USDC.assetId, 227_031_998_904n]])
    evmCustody.set(USDC.assetId, 227_031_998_904n)
    initWormholeNttService(pinnedClient(13_730_752))
    await refreshWormholeBacking()
    const before = await getWormholeBridgeDetail()

    blockHashResolves = false
    await expect(refreshWormholeBacking()).rejects.toThrow('no block hash for indexed head')
    // A failed pin leaves the previous snapshot serving; it never reads latest.
    expect((await getWormholeBridgeDetail()).asOf).toBe(before.asOf)

    blockHashResolves = true
    storageBatch.mockImplementation(async (keys: string[]) => keys.map(() => null))
    await expect(refreshWormholeBacking()).rejects.toThrow('returned nothing')
    expect((await getWormholeBridgeDetail()).asOf).toBe(before.asOf)
  })
})

// ── outbound redemption decided with custody ────────────────────────────────

const OUTBOUND_SEND_LOG = {
  block_height: 13_720_000,
  event_index: 12,
  extrinsic_index: 2,
  block_timestamp: '2026-08-21 09:00:00',
  contract: '0x3792a6d63c31941b2805181771795d9176fa82a1',
  topics: ['0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2', '0x000000000000000000000000c0ffee254729296a45a3885639ac7e10f9d54979'],
  data: sendLogData(77, USDC.manager, USDC.peer, {
    trimmedDecimals: 6, trimmedAmount: 1_000_000_000n, assetId: USDC.assetId, recipient: '0x' + '11'.repeat(32), toChain: 2,
  }),
}

function outboundClient(): ClickHouseClient {
  return {
    query: async ({ query }: { query: string }) => {
      queries.push(query)
      if (query.includes('raw_blocks')) return { json: async () => [{ block_height: 13_728_100, block_timestamp: '2026-08-22 08:00:00' }] }
      if (query.includes('AssetRegistry.LocationSet')) {
        return { json: async () => [USDC].map(a => ({ asset_id: a.assetId, args: locationArgs(a), block: 13_400_000 })) }
      }
      if (query.includes('min(block_height) AS min_block')) return { json: async () => [{ min_block: 13_378_659 }] }
      if (query.includes('price_data.assets')) {
        return { json: async () => [USDC].map(a => ({ asset_id: a.assetId, symbol: a.symbol, decimals: a.decimals })) }
      }
      if (query.includes('raw_evm_logs')) return { json: async () => [OUTBOUND_SEND_LOG] }
      return { json: async () => [] }
    },
    insert: async () => {},
    close: async () => {},
  } as unknown as ClickHouseClient
}

describe('outbound redemption read alongside custody', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-08-22T00:00:00Z'))
    registry = [USDC]
    minters.clear()
    minters.set(USDC.assetId, widen(USDC.manager))
    issuance = new Map([[USDC.assetId, 227_031_998_904n]])
    evmCustody.clear()
    evmCustody.set(USDC.assetId, 227_031_998_904n)
    evmQueue.clear()
    initWormholeNttService(outboundClient())
  })

  afterEach(() => { vi.useRealTimers() })

  it('counts a send the origin has not executed as in flight', async () => {
    await refreshWormholeBacking()
    const detail = await getWormholeBridgeDetail()
    expect(detail.inflight.map(op => op.sequence)).toEqual(['77'])
    expect(detail.assets[0].inflightOut).toBe('1000000000')
  })

  it('drops it the moment the manager says it executed the message', async () => {
    // The mirror of the inbound race: the unlock has already reduced custody, so
    // counting the transfer in flight as well subtracts it twice. The manager
    // that holds the custody is asked in the same pass, so the two cannot
    // disagree — and Wormholescan is never consulted for this.
    const send = await refreshWormholeBacking().then(() => getWormholeBridgeDetail())
    expect(send.inflight).toHaveLength(1)

    evmExecuted.add(nttDigestOf(OUTBOUND_SEND_LOG))
    await refreshWormholeBacking()
    const after = await getWormholeBridgeDetail()
    expect(after.inflight).toEqual([])
    expect(after.assets[0].inflightOut).toBe('0')
  })
})

// The digest the origin is asked about, derived from the log exactly the way the
// service derives it — a hard-coded one would pass while the framing was wrong.
function nttDigestOf(log: { topics: string[]; data: string }): string {
  const published = parseLogMessagePublished(log.topics, log.data)!
  return nttDigest(73, parseNttTransceiverMessage(published.payload)!.managerMessage)
}

// ── the confirmation merge and other assets' in-flight rows ─────────────────

// The scoped pass sweeps Wormholescan globally but can only attribute ops to
// the assets it re-read, so every other asset's op comes back from it as an
// unattributed row. The merge must take those from the base snapshot alone.
describe('the confirmation merge and other assets’ in-flight rows', () => {
  const SUSDS_ISSUANCE = 100_000_000_000_000_000_000n
  const SUSDS_INFLIGHT_RAW = 5_000_000_000_000_000_000n // 5 sUSDS, trimmed '5000000' at 6 decimals

  const susdsInboundOp = {
    id: '2/' + 'a108bd5dbc6ce665aebb6895351e0609c76f8efc'.padStart(64, '0') + '/9',
    emitterChain: 2,
    emitterAddress: { hex: 'a108bd5dbc6ce665aebb6895351e0609c76f8efc'.padStart(64, '0'), native: '0xa108bd5dbc6ce665aebb6895351e0609c76f8efc' },
    sequence: '9',
    content: {
      payload: {
        transceiverMessage: {
          sourceNttManager: SUSDS.peer,
          recipientNttManager: '0x' + SUSDS.manager.slice(2).padStart(64, '0'),
        },
        nttMessage: { trimmedAmount: { amount: '5000000', decimals: 6 } },
      },
      standarizedProperties: { fromChain: 2, toChain: 73 },
    },
    sourceChain: { chainId: 2, timestamp: '2026-08-21T12:00:00Z', transaction: { txHash: '0xfeed' } },
  }

  function twoAssetClient(): ClickHouseClient {
    return {
      query: async ({ query }: { query: string }) => {
        queries.push(query)
        if (query.includes('raw_blocks')) return { json: async () => [{ block_height: 13_730_752, block_timestamp: '2026-08-22 09:22:00' }] }
        if (query.includes('AssetRegistry.LocationSet')) {
          return { json: async () => [USDC, SUSDS].map(a => ({ asset_id: a.assetId, args: locationArgs(a), block: 13_400_000 })) }
        }
        if (query.includes('min(block_height) AS min_block')) return { json: async () => [{ min_block: 13_378_659 }] }
        if (query.includes('price_data.assets')) {
          return { json: async () => [USDC, SUSDS].map(a => ({ asset_id: a.assetId, symbol: a.symbol, decimals: a.decimals })) }
        }
        return { json: async () => [] }
      },
      insert: async () => {},
      close: async () => {},
    } as unknown as ClickHouseClient
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-08-22T00:00:00Z'))
    registry = [USDC, SUSDS]
    minters.clear()
    minters.set(USDC.assetId, widen(USDC.manager))
    minters.set(SUSDS.assetId, widen(SUSDS.manager))
    issuance = new Map([[USDC.assetId, 227_031_998_904n], [SUSDS.assetId, SUSDS_ISSUANCE]])
    evmCustody.clear()
    evmCustody.set(USDC.assetId, 227_031_998_904n)
    // Custody covers issuance plus the transfer still in flight towards us.
    evmCustody.set(SUSDS.assetId, SUSDS_ISSUANCE + SUSDS_INFLIGHT_RAW)
    evmQueue.clear()
    scanOps = [susdsInboundOp]
    initWormholeNttService(twoAssetClient())
  })

  afterEach(() => { vi.useRealTimers() })

  it('keeps a non-scoped asset’s in-flight row exactly once', async () => {
    await refreshWormholeBacking()                         // balanced baseline
    issuance.set(USDC.assetId, 227_031_998_904n + RACE_AMOUNT)
    await refreshWormholeBacking()                         // first sighting flags USDC only
    const flagged = await getWormholeBridgeDetail()
    expect(flagged.assets.find(a => a.symbol === 'USDC')!.status).toBe('ok')
    expect(flagged.inflight).toHaveLength(1)

    await runWormholeBackingConfirmation()
    const detail = await getWormholeBridgeDetail()
    expect(detail.assets.find(a => a.symbol === 'USDC')!.status).toBe('deficit')
    // The sUSDS op stays attributed and single; the scoped pass's unattributed
    // reading of the same transfer must not ride along into the merge.
    expect(detail.inflight).toHaveLength(1)
    expect(detail.inflight[0].assetId).toBe(String(SUSDS.assetId))
    expect(detail.assets.find(a => a.symbol === 'sUSDS')!.status).toBe('ok')
  })
})

// ── rate-limit fuses on the row ─────────────────────────────────────────────

describe('the rate-limit fuses a row carries', () => {
  beforeEach(() => {
    registry = [USDC, SUI]
    minters.clear()
    minters.set(USDC.assetId, widen(USDC.manager))
    minters.set(SUI.assetId, widen(SUI.manager))
    issuance = new Map([[USDC.assetId, 227_031_998_904n], [SUI.assetId, 194_145_757_066_522n]])
    evmCustody.clear()
    initWormholeNttService(fakeClient())
  })

  it('states both origin legs and both local ones at the asset’s precision', async () => {
    await refreshWormholeBacking()
    const usdc = (await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!
    // Ethereum's real cap on USDC: 100,000 either way, a few percent consumed
    // on the entry leg.
    expect(usdc.limits!.in).toMatchObject({ limit: '100000000000', capacity: '93411583448', durationSec: 86_400 })
    expect(usdc.limits!.in!.utilizationPct).toBeCloseTo(6.5884, 4)
    expect(usdc.limits!.out!.limit).toBe('100000000000')
    // Hydration's own legs are uncapped at the u64 trimmed ceiling, which is
    // what makes the origin side the only real fuse.
    expect(usdc.limits!.localOut).toMatchObject({ limit: '184467440737000000', utilizationPct: 0 })
    expect(usdc.limits!.localIn!.limit).toBe('184467440737000000')
    expect(usdc.limits!.in!.lastConsumedAt).toBe('2026-08-22T09:05:59.000Z')
  })

  it('carries no fuses at all for an origin chain nothing could be read from', async () => {
    // Sui has no endpoint here. A dormant tile is honest; a zero would read as a
    // fuse with no headroom left.
    await refreshWormholeBacking()
    expect((await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'SUI')!.limits).toBeNull()
  })

  it('keeps the previous fuses when the origin fails on one poll', async () => {
    await refreshWormholeBacking()
    const before = (await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!.limits
    ethChainReachable = false
    await refreshWormholeBacking()
    expect((await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'USDC')!.limits).toEqual(before)
  })
})
