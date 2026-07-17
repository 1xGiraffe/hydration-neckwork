import type { ClickHouseClient } from '../db/client.ts'
import { xxhashAsU8a, createKeyMulti } from '@polkadot/util-crypto'
import { u8aToHex, hexToU8a, u8aConcat } from '@polkadot/util'
import { substrateStorageBatch, substrateAllKeys } from './substrateRpc.ts'

// Proxy & multisig relations for account pages.
//
// Current proxy state comes from a periodic full enumeration of Proxy.Proxies
// (a small map — ~180 entries on Hydration), which yields BOTH directions
// (delegates of an account, and the accounts an account is a proxy for) with no
// per-request chain reads. Pure-proxy provenance comes from Proxy.PureCreated /
// legacy Proxy.AnonymousCreated events in ClickHouse.
//
// Multisig composition is not stored on-chain — the multisig address IS the hash
// of (sorted signatories, threshold) — so it is reconstructed from historical
// Multisig.* calls (raw_calls, decoded args) joined with the same-extrinsic
// Multisig.* event, whose `multisig`/`approving` fields are authoritative. A
// composition is only kept when createKeyMulti over the reconstructed signatory
// set reproduces the event's multisig account. Pending operations are derived
// from indexed Multisig events.

let client: ClickHouseClient

export interface ProxyRelation { accountId: string; proxyType: string; delay: number }
export interface PureProxyInfo { creator: string; proxyType: string; blockHeight: number; timestamp: string }
export interface MultisigComposition { threshold: number; signatories: string[] }
export interface PendingMultisigOp { callHash: string; depositor: string; approvals: string[]; sinceBlock: number }

// Hydration runtime ProxyType — index order validated against decoded
// Proxy.ProxyAdded events vs live Proxy.Proxies storage bytes.
const PROXY_TYPES = ['Any', 'CancelProxy', 'Governance', 'Transfer', 'Liquidity', 'LiquidityMining']
export function proxyTypeName(index: number): string { return PROXY_TYPES[index] ?? `Type#${index}` }

const PROXIES_PREFIX = u8aToHex(u8aConcat(xxhashAsU8a('Proxy', 128), xxhashAsU8a('Proxies', 128)))

const state = {
  delegatesByDelegator: new Map<string, ProxyRelation[]>(),   // who can act for the key account
  delegatorsByDelegate: new Map<string, ProxyRelation[]>(),   // whom the key account can act for
  pureByAccount: new Map<string, PureProxyInfo>(),
  multisigByAccount: new Map<string, MultisigComposition>(),
  membershipsByAccount: new Map<string, string[]>(),          // member → multisig account ids
}

// SCALE compact<u32> — enough for vec lengths seen here.
export function decodeCompact(v: Uint8Array, off: number): [number, number] {
  if (!Number.isInteger(off) || off < 0 || off >= v.length) {
    throw new RangeError('truncated SCALE compact integer')
  }
  const b = v[off]
  const mode = b & 3
  if (mode === 0) return [b >> 2, off + 1]
  if (mode === 1) {
    if (off + 2 > v.length) throw new RangeError('truncated SCALE compact integer')
    return [(b | (v[off + 1] << 8)) >> 2, off + 2]
  }
  if (mode === 2) {
    if (off + 4 > v.length) throw new RangeError('truncated SCALE compact integer')
    return [(b | (v[off + 1] << 8) | (v[off + 2] << 16) | (v[off + 3] << 24)) >>> 2, off + 4]
  }
  throw new Error('compact too large')
}

// Proxy.Proxies value: (Vec<ProxyDefinition{delegate: AccountId32, proxyType: u8,
// delay: u32}>, deposit: u128).
export function decodeProxiesValue(hex: string): { delegate: string; proxyType: string; delay: number }[] {
  const v = hexToU8a(hex)
  const out: { delegate: string; proxyType: string; delay: number }[] = []
  let [len, off] = decodeCompact(v, 0)
  for (let i = 0; i < len; i++) {
    if (off + 37 > v.length) break
    const delegate = u8aToHex(v.slice(off, off + 32)); off += 32
    const typeByte = v[off]; off += 1
    const delay = (v[off] | (v[off + 1] << 8) | (v[off + 2] << 16) | (v[off + 3] << 24)) >>> 0; off += 4
    out.push({ delegate, proxyType: proxyTypeName(typeByte), delay })
  }
  return out
}

// Multisig.Multisigs value: Timepoint{height: u32, index: u32} + deposit u128 +
// depositor AccountId32 + approvals Vec<AccountId32>.
export function decodeMultisigOpValue(hex: string): { sinceBlock: number; depositor: string; approvals: string[] } | null {
  const v = hexToU8a(hex)
  if (v.length < 8 + 16 + 32 + 1) return null
  const sinceBlock = (v[0] | (v[1] << 8) | (v[2] << 16) | (v[3] << 24)) >>> 0
  let off = 8 + 16
  const depositor = u8aToHex(v.slice(off, off + 32)); off += 32
  const [len, o2] = decodeCompact(v, off); off = o2
  if (off + len * 32 > v.length) return null
  const approvals: string[] = []
  for (let i = 0; i < len; i++) { approvals.push(u8aToHex(v.slice(off, off + 32))); off += 32 }
  return { sinceBlock, depositor, approvals }
}

export function deriveMultisigAccountId(signatories: string[], threshold: number): string {
  return u8aToHex(createKeyMulti(signatories.map(s => hexToU8a(s)), threshold))
}

async function refreshProxies(): Promise<void> {
  const keys = await substrateAllKeys(PROXIES_PREFIX)
  if (!keys.length) return // RPC hiccup — keep last good state
  const values = await substrateStorageBatch(keys)
  if (!values.some(Boolean)) return // storage reads failed wholesale — keep last good state
  const byDelegator = new Map<string, ProxyRelation[]>()
  const byDelegate = new Map<string, ProxyRelation[]>()
  for (let i = 0; i < keys.length; i++) {
    const raw = values[i]
    if (!raw) continue
    // Key layout: prefix(32B) + twox64(delegator)(8B) + delegator(32B).
    const delegator = '0x' + keys[i].slice(-64)
    for (const d of decodeProxiesValue(raw)) {
      const fw = byDelegator.get(delegator) ?? []; fw.push({ accountId: d.delegate, proxyType: d.proxyType, delay: d.delay }); byDelegator.set(delegator, fw)
      const rv = byDelegate.get(d.delegate) ?? []; rv.push({ accountId: delegator, proxyType: d.proxyType, delay: d.delay }); byDelegate.set(d.delegate, rv)
    }
  }
  state.delegatesByDelegator = byDelegator
  state.delegatorsByDelegate = byDelegate
}

async function refreshPureProxies(): Promise<void> {
  const res = await client.query({
    query: `SELECT event_name, args_json, block_height, toString(block_timestamp) AS ts
            FROM price_data.raw_events
            WHERE event_name IN ('Proxy.PureCreated', 'Proxy.AnonymousCreated')
            ORDER BY block_height`,
    format: 'JSONEachRow',
  })
  const pure = new Map<string, PureProxyInfo>()
  for (const r of await res.json<{ event_name: string; args_json: string; block_height: number; ts: string }>()) {
    try {
      const a = JSON.parse(r.args_json) as { pure?: string; anonymous?: string; who?: string; proxyType?: { __kind?: string } }
      const account = a.pure ?? a.anonymous
      if (!account || !a.who) continue
      pure.set(account, { creator: a.who, proxyType: a.proxyType?.__kind ?? 'Any', blockHeight: r.block_height, timestamp: r.ts })
    } catch { /* skip malformed row */ }
  }
  // Only pure proxies that still exist (they always keep ≥1 proxy entry; a
  // killed pure proxy disappears from Proxy.Proxies).
  for (const acc of pure.keys()) if (!state.delegatesByDelegator.has(acc)) pure.delete(acc)
  state.pureByAccount = pure
}

async function refreshMultisigs(): Promise<void> {
  // Every historical multisig call, paired with its extrinsic's Multisig event:
  // the event's `multisig` and `approving` come from the runtime, the call args
  // carry threshold + other signatories.
  const res = await client.query({
    query: `SELECT c.args_json AS call_args, c.call_name,
                   e.multisig, e.actor
            FROM price_data.multisig_call_activity AS c FINAL
            INNER JOIN price_data.multisig_event_activity AS e FINAL
            ON e.block_height = c.block_height AND e.extrinsic_index = c.extrinsic_index`,
    format: 'JSONEachRow',
  })
  const compositions = new Map<string, MultisigComposition>()
  for (const r of await res.json<{ call_args: string; call_name: string; multisig: string; actor: string }>()) {
    try {
      const call = JSON.parse(r.call_args) as { threshold?: number; otherSignatories?: string[] }
      if (!r.multisig || !r.actor || !Array.isArray(call.otherSignatories)) continue
      const threshold = r.call_name === 'Multisig.as_multi_threshold_1' ? 1 : call.threshold
      if (!threshold || threshold < 1) continue
      const signatories = [...new Set([r.actor, ...call.otherSignatories])].sort()
      if (signatories.length < threshold) continue
      // An extrinsic can hold several multisig calls (batch); the derivation
      // check keeps only correctly-paired rows.
      if (deriveMultisigAccountId(signatories, threshold) !== r.multisig) continue
      compositions.set(r.multisig, { threshold, signatories })
    } catch { /* skip malformed row */ }
  }
  const memberships = new Map<string, string[]>()
  for (const [multisig, comp] of compositions) {
    for (const s of comp.signatories) {
      const list = memberships.get(s) ?? []; list.push(multisig); memberships.set(s, list)
    }
  }
  state.multisigByAccount = compositions
  state.membershipsByAccount = memberships
}

async function refresh(): Promise<void> {
  await refreshProxies()
  await Promise.all([refreshPureProxies(), refreshMultisigs()])
}

const REFRESH_MS = 10 * 60_000
let refreshTimer: ReturnType<typeof setInterval> | null = null
let refreshInflight: Promise<void> | null = null

function runRefresh(label: 'initial load' | 'refresh'): Promise<void> {
  if (refreshInflight) return refreshInflight
  const request = refresh()
    .catch(err => console.error(`[proxy-multisig] ${label} failed`, err))
    .finally(() => {
      if (refreshInflight === request) refreshInflight = null
    })
  refreshInflight = request
  return request
}

export function initProxyMultisigService(c: ClickHouseClient): void {
  if (refreshTimer) return
  client = c
  void runRefresh('initial load')
  refreshTimer = setInterval(() => { void runRefresh('refresh') }, REFRESH_MS)
  refreshTimer.unref()
}

export function stopProxyMultisigService(): void {
  if (!refreshTimer) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

// lookups (in-memory, resolved per related-account set)

export interface AccountProxyInfo {
  isPure: PureProxyInfo | null
  delegates: ProxyRelation[]
  delegatorOf: ProxyRelation[]
}

export function proxyInfoFor(accountIds: string[]): AccountProxyInfo | null {
  let isPure: PureProxyInfo | null = null
  const delegates: ProxyRelation[] = []
  const delegatorOf: ProxyRelation[] = []
  for (const id of accountIds) {
    isPure = isPure ?? state.pureByAccount.get(id) ?? null
    delegates.push(...(state.delegatesByDelegator.get(id) ?? []))
    delegatorOf.push(...(state.delegatorsByDelegate.get(id) ?? []))
  }
  if (!isPure && !delegates.length && !delegatorOf.length) return null
  return { isPure, delegates, delegatorOf }
}

export function multisigCompositionFor(accountIds: string[]): MultisigComposition | null {
  for (const id of accountIds) {
    const comp = state.multisigByAccount.get(id)
    if (comp) return comp
  }
  return null
}

export function multisigMembershipsFor(accountIds: string[]): { accountId: string; threshold: number; signatories: number }[] {
  const out: { accountId: string; threshold: number; signatories: number }[] = []
  const seen = new Set<string>()
  for (const id of accountIds) {
    for (const multisig of state.membershipsByAccount.get(id) ?? []) {
      if (seen.has(multisig)) continue
      seen.add(multisig)
      const comp = state.multisigByAccount.get(multisig)!
      out.push({ accountId: multisig, threshold: comp.threshold, signatories: comp.signatories.length })
    }
  }
  return out
}

// Pending operations for a multisig account, reconstructed from indexed Multisig.*
// events (no per-request storage read). An op (multisig, callHash) is pending when its
// latest NewMultisig is not followed by a MultisigExecuted/MultisigCancelled; approvals
// are the distinct approvers since that NewMultisig; depositor is its creator.
export async function pendingMultisigOps(accountId: string): Promise<PendingMultisigOp[]> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(accountId)) return []
  const res = await client.query({
    query: `
      WITH ev AS (
        SELECT call_hash AS callHash,
               multiIf(event_name='Multisig.NewMultisig', 'new',
                 event_name='Multisig.MultisigApproval', 'approval', 'done') AS kind,
               lower(actor) AS who, block_height AS b
        FROM price_data.multisig_event_activity FINAL
        WHERE multisig = {m:String}
      ),
      life AS (
        SELECT callHash, max(if(kind='new', b, 0)) AS newBlock, max(if(kind='done', b, 0)) AS doneBlock, argMaxIf(who, b, kind='new') AS depositor
        FROM ev GROUP BY callHash
      )
      SELECT l.callHash AS callHash, l.newBlock AS sinceBlock, l.depositor AS depositor,
             arrayDistinct(groupArrayIf(e.who, e.kind IN ('new','approval') AND e.b >= l.newBlock AND e.who != '')) AS approvals
      FROM life l INNER JOIN ev e ON e.callHash = l.callHash
      WHERE l.newBlock > 0 AND (l.doneBlock = 0 OR l.doneBlock < l.newBlock)
      GROUP BY l.callHash, l.newBlock, l.depositor
      ORDER BY sinceBlock DESC`,
    query_params: { m: accountId }, format: 'JSONEachRow',
  })
  return (await res.json<{ callHash: string; sinceBlock: number; depositor: string; approvals: string[] }>())
    .map(r => ({ callHash: r.callHash, depositor: r.depositor, approvals: r.approvals, sinceBlock: Number(r.sinceBlock) }))
}
