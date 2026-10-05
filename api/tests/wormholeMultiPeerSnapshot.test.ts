import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import { nttDigest, TOPIC } from '../src/services/wormholeNtt.ts'

// The composed snapshot for assets with more than one peer, on the live
// 2026-10-05 shapes: WETH minted on Hydration against two lockboxes (Ethereum
// and Robinhood, the second added by TC motion 387 with Hydration's
// inbound limit from it set to 69 WETH/day), and HDX locked on Hydration
// against a Robinhood spoke. HDX has no NttMinterSet and no `wh`
// location — it is found through its PeerUpdated log alone.

const HYDRATION_RPC = 'http://hydration.test'
const ETH_RPC = 'https://eth.test/rpc'
const RH_RPC = 'https://robinhood.test/rpc'
const SCAN = 'https://scan.test'
// A reachable scan with nothing in flight: shortfalls are graded, not held as
// "in flight unchecked".
process.env.WORMHOLE_SCAN_URL = SCAN
process.env.WORMHOLE_ORIGIN_RPC_URLS = JSON.stringify({ 2: ETH_RPC, 72: RH_RPC })

const storageBatch = vi.fn<(keys: string[], at?: string | null) => Promise<(string | null)[]>>()
vi.mock('../src/services/substrateRpc.ts', () => ({
  SUBSTRATE_RPC_URL: HYDRATION_RPC,
  substrateStorageBatch: (keys: string[], at?: string | null) => storageBatch(keys, at),
}))
vi.mock('../src/services/cache.ts', () => ({ cachedSwr: <T>(_k: string, _f: number, _s: number, fn: () => Promise<T>) => fn() }))

const WETH_MANAGER = '0xb5cef790d52a57fa619ed96edd64c5328f3dcfb7'
const HDX_MANAGER = '0x16ac5b8d9078ed4cf5a522f907fd9ddb6c8841f1'
const widen = (h160: string) => '0x45544800' + h160.slice(2) + '00'.repeat(8)
const minters = new Map<number, string>([[20, widen(WETH_MANAGER)]])
vi.mock('../src/services/explorerService.ts', () => ({
  nttMinterAccounts: async () => minters,
  nttMinterH160: (account: string) => '0x' + account.slice(10, 50),
  ocnChainName: () => null,
  WORMHOLE_CHAIN_URNS: {} as Record<number, string>,
  accountRef: (accountId: string) => ({ accountId, address: accountId }),
  ensurePrices: async () => new Map([[20, { price: 4_400, change24h: 0 }], [0, { price: 0.01, change24h: 0 }]]),
}))
vi.mock('../src/services/explorerAssets.ts', () => ({
  assetDescriptor: (assetId: number) => ({ assetId, symbol: `#${assetId}`, decimals: 12 }),
}))

const {
  refreshWormholeBacking, getWormholeBridgeDetail, getWormholeAlertState, initWormholeNttService,
  resetWormholeDiscoveryForTests, resetWormholeStaticFactsForTests, cancelWormholeBackingConfirmation,
} = await import('../src/services/wormholeNttService.ts')
const { wormholeAssetBridge, wormholeRemoteToken } = await import('../src/services/wormholeRemoteTokens.ts')

// ── chain fixtures ──────────────────────────────────────────────────────────

const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0')
const pad32 = (h160: string) => '0x' + h160.replace(/^0x/, '').padStart(64, '0')
const precompile = (assetId: number) => '0x' + '0'.repeat(31) + '1' + assetId.toString(16).padStart(8, '0')
const packTrimmed = (amount: bigint, decimals: number) => (amount << 8n) | BigInt(decimals)
const e18 = (whole: string) => { const [i, f = ''] = whole.split('.'); return BigInt(i + f.padEnd(18, '0')) }

const WETH9 = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const RH_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
const RH_HDX = '0xb423c0b59c615793b0903668dc414e4fa3a64a33'
const ETH_LOCKBOX = '0x283b14b5dd352e32154df014ea96834f395e04b6'
const RH_WETH_LOCKBOX = '0xb1a2abcbc1fa276212f6ed239645161deea9861a'
const RH_HDX_SPOKE = '0xf1a5fe4252d9a1c39b0fb9de1f19049ee57ed188'
const BASE_LOCKBOX = '0x' + '3b'.repeat(20)
const DEPLOYER = '0x71feb8b2849101a6e62e3369eaafdc6154cd0bc0'
const MOTION_387 = '0x15aecaa1590cb1d7eb984e0195e6f8e88a222e5b1673970e823467f70ae97d2e'
const UNCAPPED = 184_467_440_737_00000000n

let wethIssuance = e18('70.655976376348102811')
let ethCustody = e18('61.70971223')
let rhCustody = e18('8.95591664')
let hdxLockedOnHydration = 106_000_000_000_000n
let hdxSupplyOnRobinhood = 106_000_000_000_000n
// Whether Hydration's WETH manager reports a third peer, on Base (chain 30) —
// which this deployment has no endpoint for.
let basePeer = false
// Whether the Robinhood WETH lockbox is registered yet — live on Hydration's
// manager and as its indexed PeerUpdated log.
let rhWethRegistered = true
// Whether Robinhood's WETH lockbox answers token().
let rhTokenAnswers = true

// Hydration's managers: limits as `[limit trimmed at 8 decimals]` per leg.
function hydrationCall(to: string, data: string): string | null {
  const selector = data.slice(0, 10)
  const arg = data.length > 10 ? Number(BigInt('0x' + data.slice(10))) : null
  if (to === precompile(20)) {
    if (selector === '0x70a08231') return '0x' + word(0)               // balanceOf(dEaD)
    if (selector === '0x18160ddd') return '0x' + word(wethIssuance)
  }
  if (to === precompile(0)) {
    if (selector === '0x70a08231' && data.endsWith(HDX_MANAGER.slice(2))) return '0x' + word(hdxLockedOnHydration)
    if (selector === '0x70a08231') return '0x' + word(0)
  }
  const manager = to === WETH_MANAGER ? 'weth' : to === HDX_MANAGER ? 'hdx' : null
  if (!manager) return null
  if (selector === '0xfc0c546a') return pad32(precompile(manager === 'weth' ? 20 : 0))
  if (selector === '0x295a5212') return '0x' + word(manager === 'weth' ? 1 : 0)        // BURNING / LOCKING
  if (selector === '0x9a8a0592') return '0x' + word(73)
  if (selector === '0xb187bd26') return '0x' + word(0)
  if (selector === '0x74aa7bfc') return '0x' + word(86_400)
  if (selector === '0xc128d170') {
    const peer = manager === 'weth'
      ? arg === 2 ? ETH_LOCKBOX : arg === 72 && rhWethRegistered ? RH_WETH_LOCKBOX : arg === 30 && basePeer ? BASE_LOCKBOX : null
      : arg === 72 ? RH_HDX_SPOKE : null
    return peer ? pad32(peer) + word(manager === 'weth' ? 18 : 12) : '0x' + word(0) + word(0)
  }
  const dec = manager === 'weth' ? 18 : 12
  const legLimit = (s: string): bigint => {
    // Hydration's inbound limit FROM Robinhood is 69 WETH; every other leg is uncapped.
    if (manager === 'weth' && (s === '0xd788c147' || s === '0x02717250') && arg === 72) return 69_00000000n
    return manager === 'hdx' ? 10_000_000_00000000n : UNCAPPED
  }
  if (selector === '0x86e11ffa' || selector === '0xd788c147') {
    const limit = packTrimmed(legLimit(selector), 8)
    return '0x' + word(limit) + word(limit) + word(1_791_000_000)
  }
  if (selector === '0xf5cfec18' || selector === '0x02717250') return '0x' + word(legLimit(selector) * 10n ** BigInt(dec - 8))
  return null
}

// A peer manager on its own chain, answered the same whether asked directly or
// inside an aggregate3.
function peerCall(chain: 'eth' | 'rh', to: string, data: string): string {
  const selector = data.slice(0, 10)
  const arg = data.length > 10 ? data.slice(10) : ''
  const lockbox = chain === 'eth' ? ETH_LOCKBOX : RH_WETH_LOCKBOX
  const wethToken = chain === 'eth' ? WETH9 : RH_WETH
  if (to === lockbox || (chain === 'rh' && to === RH_HDX_SPOKE)) {
    const hdx = to === RH_HDX_SPOKE
    if (selector === '0xfc0c546a') return chain === 'rh' && !hdx && !rhTokenAnswers ? '0x' : pad32(hdx ? RH_HDX : wethToken)
    if (selector === '0x295a5212') return '0x' + word(hdx ? 1 : 0)
    if (selector === '0xb187bd26') return '0x' + word(0)
    if (selector === '0x74aa7bfc') return '0x' + word(86_400)
    // Every peer is peered with Hydration only.
    if (selector === '0xc128d170') return Number(BigInt('0x' + arg)) === 73 ? pad32(hdx ? HDX_MANAGER : WETH_MANAGER) + word(18) : '0x' + word(0) + word(0)
    const limit = hdx ? 10_000_000_00000000n : chain === 'eth' ? 10_000_00000000n : 69_00000000n
    if (selector === '0x86e11ffa' || selector === '0xd788c147') return '0x' + word(packTrimmed(limit, 8)) + word(packTrimmed(limit, 8)) + word(1_791_000_000)
    if (selector === '0xf5cfec18' || selector === '0x02717250') return '0x' + word(limit * 10n ** BigInt((hdx ? 12 : 18) - 8))
    if (selector === '0x396c16b7') return '0x' + word(1)
    if (selector === '0xfd96063c') return '0x' + '0'.repeat(192)
    return '0x'
  }
  const isWeth = to === wethToken
  const isHdx = chain === 'rh' && to === RH_HDX
  if (!isWeth && !isHdx) return '0x'
  if (selector === '0x70a08231') {
    if (arg.endsWith('dead')) return '0x' + word(0)
    return '0x' + word(isHdx ? 0n : chain === 'eth' ? ethCustody : rhCustody)
  }
  if (selector === '0x18160ddd') return '0x' + word(isHdx ? hdxSupplyOnRobinhood : 10n ** 24n)
  if (selector === '0x313ce567') return '0x' + word(isHdx ? 12 : 18)
  const str = (text: string) => '0x' + word(32) + word(text.length) + Buffer.from(text).toString('hex').padEnd(64, '0')
  if (selector === '0x95d89b41') return str(isHdx ? 'HDX' : 'WETH')
  if (selector === '0x06fdde03') return str(isHdx ? 'Hdx' : chain === 'eth' ? 'Wrapped Ether' : 'WETH')
  return '0x'
}

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
function unwrapAggregate3(data: string): { to: string; data: string }[] {
  const body = data.slice(10)
  const at = (byteOffset: number) => Number(BigInt('0x' + body.slice(byteOffset * 2, byteOffset * 2 + 64)))
  const arrayAt = at(0)
  const count = at(arrayAt)
  const base = arrayAt + 32
  const legs: { to: string; data: string }[] = []
  for (let i = 0; i < count; i++) {
    const item = base + at(base + i * 32)
    const to = '0x' + body.slice((item + 12) * 2, (item + 32) * 2)
    const bytesAt = item + at(item + 64)
    const length = at(bytesAt)
    legs.push({ to, data: '0x' + body.slice((bytesAt + 32) * 2, (bytesAt + 32) * 2 + length * 2) })
  }
  return legs
}
function stubAggregate3(chain: 'eth' | 'rh', data: string): string {
  const results = unwrapAggregate3(data).map(leg => {
    const answer = peerCall(chain, leg.to.toLowerCase(), leg.data).replace(/^0x/, '')
    const bytes = answer.length / 2
    return word(answer.length ? 1n : 0n) + word(64n) + word(BigInt(bytes)) + (bytes ? answer.padEnd(Math.ceil(answer.length / 64) * 64, '0') : '')
  })
  let cursor = results.length * 32
  const offsets = results.map(r => { const here = cursor; cursor += r.length / 2; return word(BigInt(here)) })
  return '0x' + word(32n) + word(BigInt(results.length)) + offsets.join('') + results.join('')
}

interface RpcCall { id: number; method: string; params: unknown[] }
const fetchImpl = vi.fn(async (input: string | URL, init?: { body?: string }) => {
  const url = String(input)
  const body = init?.body ? JSON.parse(init.body) as RpcCall | RpcCall[] : null
  if (url === HYDRATION_RPC) {
    const answer = (call: RpcCall) => {
      if (call.method === 'chain_getBlockHash') return { id: call.id, result: '0x' + 'ab'.repeat(32) }
      const { to, data } = call.params[0] as { to: string; data: string }
      return { id: call.id, result: hydrationCall(to.toLowerCase(), data) ?? '0x' }
    }
    return { ok: true, json: async () => (Array.isArray(body) ? body.map(answer) : answer(body as RpcCall)) }
  }
  if (url === ETH_RPC || url === RH_RPC) {
    const chain = url === ETH_RPC ? 'eth' : 'rh'
    const answer = (call: RpcCall) => {
      const { to, data } = call.params[0] as { to: string; data: string }
      return { id: call.id, result: to.toLowerCase() === MULTICALL3 ? stubAggregate3(chain, data) : peerCall(chain, to.toLowerCase(), data) }
    }
    return { ok: true, json: async () => (Array.isArray(body) ? body.map(answer) : answer(body as RpcCall)) }
  }
  if (url.startsWith(SCAN)) return { ok: true, json: async () => ({ operations: [] }) }
  return { ok: false, json: async () => ({}) }
})

// ── ClickHouse fake ─────────────────────────────────────────────────────────

const locationArgs = JSON.stringify({
  assetId: 20,
  location: { parents: 0, interior: { __kind: 'X3', value: [
    { length: 2, data: '0x7768' + '00'.repeat(30), __kind: 'GeneralKey' },
    { __kind: 'GeneralIndex', value: '2' },
    { length: 32, data: pad32(WETH9), __kind: 'GeneralKey' },
  ] } },
})
const peerLog = (contract: string, block: number, chainId: number, peer: string, decimals: number) => ({
  block_height: block, event_index: 9, extrinsic_index: 2, block_timestamp: '2026-09-16 01:57:24', contract,
  topics: [TOPIC.peerUpdated, '0x' + word(chainId)],
  data: '0x' + word(0) + word(0) + pad32(peer).slice(2) + word(decimals),
})
let extraPeerLogs: ReturnType<typeof peerLog>[] = []

// One inbound WETH transfer from Robinhood, as Hydration indexed it: the
// transceiver's ReceivedMessage and the manager's TransferRedeemed (or, when
// Hydration's own 69/day limiter holds it, InboundTransferQueued) in one
// extrinsic, with the payload — and so the amount — only in the call.
function inboundFixture(amountTrimmed: bigint, queued: boolean) {
  const recipient = '0x' + '11'.repeat(20)
  const transfer = '994e5454' + '08' + amountTrimmed.toString(16).padStart(16, '0')
    + pad32(RH_WETH).slice(2) + pad32(recipient).slice(2) + (73).toString(16).padStart(4, '0')
  const managerMessage = word(7) + pad32(DEPLOYER).slice(2) + (transfer.length / 2).toString(16).padStart(4, '0') + transfer
  const payload = '9945ff10' + pad32(RH_WETH_LOCKBOX).slice(2) + pad32(WETH_MANAGER).slice(2)
    + (managerMessage.length / 2).toString(16).padStart(4, '0') + managerMessage + '0000'
  const digest = nttDigest(72, '0x' + managerMessage)
  const block = 15_420_000
  const logs = [
    { block_height: block, event_index: 20, extrinsic_index: 2, block_timestamp: '2026-10-05 10:00:00', contract: '0x8acce9ca511d5d7213f8c3f813b8916087cd00ae',
      topics: [TOPIC.receivedMessage], data: '0x' + word(1) + word(72) + pad32('0x' + '77'.repeat(20)).slice(2) + word(42) },
    queued
      ? { block_height: block, event_index: 21, extrinsic_index: 2, block_timestamp: '2026-10-05 10:00:00', contract: WETH_MANAGER,
        topics: [TOPIC.inboundTransferQueued], data: digest }
      : { block_height: block, event_index: 21, extrinsic_index: 2, block_timestamp: '2026-10-05 10:00:00', contract: WETH_MANAGER,
        topics: [TOPIC.transferRedeemed, digest], data: '0x' },
  ]
  return { logs, callArgs: JSON.stringify({ transaction: { value: { input: '0xf953cec7' + '00'.repeat(40) + payload } } }), recipient }
}
let inbound: ReturnType<typeof inboundFixture> | null = null

function fakeClient(): ClickHouseClient {
  return {
    query: async ({ query }: { query: string }) => {
      const rows = (r: unknown[]) => ({ json: async () => r })
      if (query.includes('raw_blocks')) return rows([{ block_height: 15_430_000, block_timestamp: new Date(Date.now() - 20_000).toISOString().slice(0, 19).replace('T', ' ') }])
      if (query.includes('AssetRegistry.LocationSet')) return rows([{ asset_id: 20, args: locationArgs, block: 13_400_000 }])
      if (query.includes('min(block_height) AS min_block')) return rows([{ min_block: 13_378_659 }])
      if (query.includes(TOPIC.peerUpdated) && !query.includes('WITH xs')) {
        return rows([
          peerLog(WETH_MANAGER, 13_381_902, 2, ETH_LOCKBOX, 18),
          ...(rhWethRegistered ? [{ ...peerLog(WETH_MANAGER, 14_653_644, 72, RH_WETH_LOCKBOX, 18), event_index: 15 }] : []),
          peerLog(HDX_MANAGER, 14_278_472, 72, RH_HDX_SPOKE, 12),
          ...extraPeerLogs,
        ])
      }
      if (query.includes("'TechnicalCommittee.Executed', 'Ethereum.Executed'")) {
        return rows([
          { block_height: 13_381_902, extrinsic_index: 2, event_name: 'Ethereum.Executed', args_json: JSON.stringify({ from: DEPLOYER, to: WETH_MANAGER }) },
          { block_height: 14_278_472, extrinsic_index: 2, event_name: 'Ethereum.Executed', args_json: JSON.stringify({ from: DEPLOYER, to: HDX_MANAGER }) },
          { block_height: 14_653_644, extrinsic_index: 2, event_name: 'TechnicalCommittee.Executed', args_json: JSON.stringify({ proposalHash: MOTION_387 }) },
        ])
      }
      if (query.includes("'TechnicalCommittee.Proposed'")) return rows([{ hash: MOTION_387, motion: 387 }])
      if (query.includes('WITH xs')) return rows(inbound?.logs ?? [])
      if (query.includes('raw_extrinsics')) return rows(inbound ? [{ block_height: 15_420_000, extrinsic_index: 2, call_args_json: inbound.callArgs }] : [])
      if (query.includes('price_data.assets')) return rows([{ asset_id: 20, symbol: 'WETH', decimals: 18 }, { asset_id: 0, symbol: 'HDX', decimals: 12 }])
      return rows([])
    },
    insert: async () => {},
    close: async () => {},
  } as unknown as ClickHouseClient
}

const u128Le = (v: bigint) => '0x' + Buffer.from(new BigUint64Array([v & ((1n << 64n) - 1n), v >> 64n]).buffer).toString('hex')

beforeEach(() => {
  resetWormholeDiscoveryForTests()
  resetWormholeStaticFactsForTests()
  vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch)
  wethIssuance = e18('70.655976376348102811')
  ethCustody = e18('61.70971223')
  rhCustody = e18('8.95591664')
  hdxLockedOnHydration = 106_000_000_000_000n
  hdxSupplyOnRobinhood = 106_000_000_000_000n
  basePeer = false
  rhWethRegistered = true
  rhTokenAnswers = true
  extraPeerLogs = []
  inbound = null
  // TotalIssuance: WETH only. HDX (Balances) and an absent key read as null.
  storageBatch.mockImplementation(async (keys: string[]) => keys.map(key => {
    const le = key.slice(-8)
    const assetId = Number.parseInt(le.slice(6, 8) + le.slice(4, 6) + le.slice(2, 4) + le.slice(0, 2), 16)
    return assetId === 20 ? u128Le(wethIssuance) : null
  }))
  initWormholeNttService(fakeClient())
})
afterEach(() => { cancelWormholeBackingConfirmation() })

describe('an asset backed by more than one lockbox', () => {
  it('sums both custodies and lists each lockbox with its own token', async () => {
    await refreshWormholeBacking()
    const d = await getWormholeBridgeDetail()
    const weth = d.assets.find(a => a.symbol === 'WETH')!
    expect(weth.hydrationRole).toBe('spoke')
    expect(weth.locked).toBe((e18('61.70971223') + e18('8.95591664')).toString())
    expect(weth.issuance).toBe(wethIssuance.toString())
    expect(weth.status).toBe('surplus')
    expect(weth.lockboxCount).toBe(2)
    expect(weth.peers.map(p => [p.chainName, p.role, p.token?.address, p.balance])).toEqual([
      ['Ethereum', 'lockbox', WETH9, e18('61.70971223').toString()],
      ['Robinhood', 'lockbox', RH_WETH, e18('8.95591664').toString()],
    ])
    // The peer added by TC motion 387, found from its own PeerUpdated log.
    const rh = weth.peers.find(p => p.chainId === 72)!
    expect(rh.since).toMatchObject({ blockHeight: 14_653_644, origin: { kind: 'technical-committee', motionIndex: 387 } })
    expect(rh.evidence).toBe('confirmed')
    expect(rh.layer).toBe('l2')
    expect(rh.riskNote).toMatch(/Robinhood is an Ethereum L2/)
    expect(d.lockboxes.filter(l => l.symbol === 'WETH').map(l => l.chainName)).toEqual(['Ethereum', 'Robinhood'])
  })

  it('keys every rate limit by chain: Ethereum’s 10,000 and Robinhood’s 69 both stand', async () => {
    await refreshWormholeBacking()
    const d = await getWormholeBridgeDetail()
    const weth = d.assets.find(a => a.symbol === 'WETH')!
    // The primary-origin block is Ethereum's — no longer whichever chain was read last.
    expect(weth.limits?.in?.limit).toBe(e18('10000').toString())
    expect(weth.limits?.out?.limit).toBe(e18('10000').toString())
    const eth = weth.peers.find(p => p.chainId === 2)!
    const rh = weth.peers.find(p => p.chainId === 72)!
    expect(eth.limits?.peerOut?.limit).toBe(e18('10000').toString())
    expect(rh.limits?.peerOut?.limit).toBe(e18('69').toString())
    expect(rh.limits?.peerIn?.limit).toBe(e18('69').toString())
    // Hydration's own inbound limit is per source chain: 69 from Robinhood,
    // uncapped from Ethereum — the outbound leg is one, shared.
    expect(rh.limits?.hydrationIn?.limit).toBe(e18('69').toString())
    expect(BigInt(eth.limits!.hydrationIn!.limit) > e18('1000000')).toBe(true)
    expect(rh.limits?.hydrationOut?.limit).toBe(eth.limits?.hydrationOut?.limit)
    // The alert lane reads the same primary block the page renders.
    const alert = await getWormholeAlertState()
    expect(alert!.assets.find(a => a.symbol === 'WETH')!.fuses.in?.limit).toBe(10_000)
  })

  it('reads a shortfall in one lockbox as a shortfall of the asset', async () => {
    rhCustody = e18('0.5')
    await refreshWormholeBacking()
    await refreshWormholeBacking()
    const d = await getWormholeBridgeDetail()
    expect(d.assets.find(a => a.symbol === 'WETH')!.status).toBe('deficit')
  })

  it('states what each lockbox can pay out', async () => {
    await refreshWormholeBacking()
    const d = await getWormholeBridgeDetail()
    const rh = d.assets.find(a => a.symbol === 'WETH')!.peers.find(p => p.chainId === 72)!
    expect(rh.status).toBe('ok')
    expect(rh.payout?.capacity).toBe(e18('8.95591664').toString())
    // Its limit lets 69 WETH a day toward it; it holds less — said, not alarmed.
    expect(rh.payout?.potential).toBe(e18('69').toString())
    expect(rh.payout?.coversPotential).toBe(false)
  })

  it('publishes each peer’s token for the activity rows and the asset page', async () => {
    await refreshWormholeBacking()
    expect(wormholeRemoteToken(20, 72)).toMatchObject({ chainName: 'Robinhood', address: RH_WETH, symbol: 'WETH', role: 'lockbox' })
    expect(wormholeRemoteToken(20, 2)).toMatchObject({ address: WETH9, primary: true })
    expect(wormholeRemoteToken(20, 30)).toBeNull()
    expect(wormholeAssetBridge(20)?.peers.map(p => p.chainName)).toEqual(['Ethereum', 'Robinhood'])
  })

  // Manager facts are cached for an hour, but a newly registered lockbox starts
  // taking custody at once: the transfers it backs are minted here while its
  // balance would go unread, which is a shortfall the size of that balance.
  it('reads a lockbox from the cycle its registration is indexed, not when the facts expire', async () => {
    rhWethRegistered = false
    wethIssuance = ethCustody
    await refreshWormholeBacking()
    expect((await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'WETH')!.lockboxCount).toBe(1)

    rhWethRegistered = true
    wethIssuance = e18('70.655976376348102811')
    await refreshWormholeBacking()
    const weth = (await getWormholeBridgeDetail()).assets.find(a => a.symbol === 'WETH')!
    expect(weth.lockboxCount).toBe(2)
    expect(weth.locked).toBe((e18('61.70971223') + e18('8.95591664')).toString())
    expect(weth.status).toBe('surplus')
  })

  it('still lists a lockbox whose token has not been read, with the token unread', async () => {
    rhTokenAnswers = false
    await refreshWormholeBacking()
    const peers = wormholeAssetBridge(20)!.peers
    expect(peers.map(p => [p.chainName, p.role, p.address])).toEqual([
      ['Ethereum', 'lockbox', WETH9],
      ['Robinhood', 'lockbox', null],
    ])
    // An activity row names a token or nothing — never one without an address.
    expect(wormholeRemoteToken(20, 72)).toBeNull()
  })

  it('holds the asset at unverified, never a deficit, when a peer’s chain has no endpoint', async () => {
    basePeer = true
    extraPeerLogs = [{ ...peerLog(WETH_MANAGER, 15_000_000, 30, BASE_LOCKBOX, 18), event_index: 4 }]
    await refreshWormholeBacking()
    await refreshWormholeBacking()
    const d = await getWormholeBridgeDetail()
    const weth = d.assets.find(a => a.symbol === 'WETH')!
    expect(weth.status).toBe('unverified')
    expect(weth.statusDetail).toContain('Base')
    const base = weth.peers.find(p => p.chainId === 30)!
    expect(base.status).toBe('unconfigured')
    expect(base.configured).toBe(false)
    expect(base.balance).toBeNull()
    // Unverified grades inconclusive, so the deficit lane carries nothing.
    expect(d.totals.deficitUsd).toBe(0)
  })
})

describe('an asset Hydration locks rather than mints', () => {
  it('is discovered from its PeerUpdated log alone and backed by Hydration’s own custody', async () => {
    await refreshWormholeBacking()
    const d = await getWormholeBridgeDetail()
    const hdx = d.assets.find(a => a.symbol === 'HDX')!
    expect(hdx.hydrationRole).toBe('lockbox')
    expect(hdx.mode).toBe('locking')
    // Native here: the primary origin is Hydration itself.
    expect(hdx.originChainId).toBe(73)
    expect(hdx.hydrationLocked).toBe('106000000000000')
    expect(hdx.locked).toBe('106000000000000')
    expect(hdx.issuance).toBe('106000000000000')
    expect(hdx.status).toBe('ok')
    expect(hdx.flows.nonNtt).toBeNull()
    const spoke = hdx.peers[0]
    expect(spoke).toMatchObject({ chainName: 'Robinhood', role: 'spoke', mode: 'burning', payout: null })
    expect(spoke.token).toMatchObject({ address: RH_HDX, symbol: 'HDX', decimals: 12 })
    expect(d.lockboxes.find(l => l.symbol === 'HDX')).toMatchObject({ chainName: 'Hydration', balance: '106000000000000', status: 'ok' })
  })

  it('reads supply minted on the spoke beyond Hydration’s custody as a deficit', async () => {
    hdxSupplyOnRobinhood = 5_106_000_000_000_000n
    await refreshWormholeBacking()
    await refreshWormholeBacking()
    const d = await getWormholeBridgeDetail()
    expect(d.assets.find(a => a.symbol === 'HDX')!.status).toBe('deficit')
  })
})

describe('flows between Hydration and each peer', () => {
  it('measures an arrival by the amount its own payload carried, per source chain', async () => {
    inbound = inboundFixture(150_000_000n, false) // 1.5 WETH at 8 trimmed decimals
    await refreshWormholeBacking()
    const d = await getWormholeBridgeDetail()
    const weth = d.assets.find(a => a.symbol === 'WETH')!
    const rh = weth.peers.find(p => p.chainId === 72)!
    expect(rh.flows).toMatchObject({ received: e18('1.5').toString(), sent: '0', transfersIn: 1, transfersOut: 0 })
    expect(weth.peers.find(p => p.chainId === 2)!.flows.transfersIn).toBe(0)
    // The far side's token rides on the arrival row.
    const row = d.recent.find(r => r.direction === 'in')!
    expect(row.counterpartyChainId).toBe(72)
    expect(row.counterpartyToken).toMatchObject({ address: RH_WETH, symbol: 'WETH' })
  })

  it('counts an arrival Hydration’s own limiter holds as queued on Hydration', async () => {
    inbound = inboundFixture(150_000_000n, true)
    await refreshWormholeBacking()
    const d = await getWormholeBridgeDetail()
    const held = d.queued.find(q => q.direction === 'in')!
    expect(held).toMatchObject({ chainId: 73, fromChainId: 72, amount: e18('1.5').toString(), symbol: 'WETH' })
    // 24h after it was queued, from Hydration's own window for that chain.
    expect(Date.parse(held.releasableAt!) - Date.parse(held.queuedAt!)).toBe(86_400_000)
    const weth = d.assets.find(a => a.symbol === 'WETH')!
    expect(weth.queued).toBe(e18('1.5').toString())
    expect(weth.peers.find(p => p.chainId === 72)!.queuedHydration).toBe(e18('1.5').toString())
  })
})
