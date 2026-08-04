import type { ClickHouseClient } from '../db/client.ts'
import { xxhashAsU8a, keccakAsHex } from '@polkadot/util-crypto'
import { u8aToHex, u8aConcat, hexToU8a } from '@polkadot/util'
import { substrateAllKeys, substrateStorageBatch } from './substrateRpc.ts'

// EVM smart-contract registry.
//
// Two halves, both bounded and replay-safe:
//  - refreshContractCode(): the only writer of evm_contract_code_snapshot — a
//    periodic full enumeration of EVM.AccountCodes on the coordinated node-full
//    refresher (~1k keys). Enumeration truncation throws upstream, so a half
//    read can never mass-flag destruction; addresses absent from a FULLY
//    successful enumeration are tombstoned with destroyed=1 (rows are never
//    deleted — history stays addressable, a CREATE2 redeploy flips them back).
//  - loadContractRegistry(): merges the snapshot with the MV-fed projections
//    (evm_create_transactions ⋈ evm_executed for top-level creations, first-log
//    evidence for factory children, uniqExact/bitmap counts) into an in-memory
//    registry serving the directory, AddressDetail.contract and the O(1)
//    isContractAccount flag behind every account pill's `</>` glyph.

export type EvmAddressKind = 'contract' | 'asset-erc20' | 'oracle-adapter' | 'system-precompile' | 'sentinel' | 'planted-unknown'

// Runtime address carve-outs — none of these are user-deployed contracts even
// though EVM.AccountCodes carries code (real or the planted 0x00 marker) for
// them. Anything code-bearing but unrecognized lands in planted-unknown,
// never guessed into 'contract'.
const ASSET_PRECOMPILE_PREFIX = '00000000000000000000000000000001' // + 4-byte BE asset id
const ORACLE_PREFIX = '000001'                                     // chainlink-adapter family
const SYSTEM_PRECOMPILES = new Set([
  ...Array.from({ length: 9 }, (_, i) => (i + 1).toString(16).padStart(40, '0')), // standard 0x01–0x09
  '0401'.padStart(40, '0'), // Dispatch
  '0806'.padStart(40, '0'), // LockManager
  '080a'.padStart(40, '0'), // CallPermit
  '090a'.padStart(40, '0'), // FlashLoanReceiver
])
const SENTINELS = new Set(['ff'.repeat(20), '73796e7468'.repeat(4) /* "synth" ×4 */])
const RESERVED_H160_PREFIXES = ['6d6f646c', '7369626c', '70617261'] // modl / sibl / para

function isPlantedCode(code: Uint8Array): boolean {
  return code.length === 0 || code.every(b => b === 0)
}

export function classifyEvmAddress(h160: string, code?: Uint8Array | null): EvmAddressKind {
  const h = h160.toLowerCase().replace(/^0x/, '')
  if (h.startsWith(ASSET_PRECOMPILE_PREFIX)) return 'asset-erc20'
  if (h.startsWith(ORACLE_PREFIX)) return 'oracle-adapter'
  if (SYSTEM_PRECOMPILES.has(h)) return 'system-precompile'
  if (SENTINELS.has(h)) return 'sentinel'
  // Reserved substrate-derived truncations (module/sovereign accounts) can
  // never be user contracts; planted code there stays visible but excluded.
  if (RESERVED_H160_PREFIXES.some(p => h.startsWith(p))) return 'planted-unknown'
  if (code && isPlantedCode(code)) return 'planted-unknown'
  return 'contract'
}

// SCALE Vec<u8> (compact length prefix + payload), as state_getStorage returns
// EVM.AccountCodes values. Null on malformed/truncated input — the caller skips
// the address for this pass rather than snapshotting a wrong hash.
export function decodeScaleVecU8(hex: string): Uint8Array | null {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(hex)) return null
  const v = hexToU8a(hex)
  const mode = v[0] & 3
  let len: number, off: number
  if (mode === 0) { len = v[0] >> 2; off = 1 }
  else if (mode === 1) {
    if (v.length < 2) return null
    len = (v[0] | (v[1] << 8)) >> 2; off = 2
  } else if (mode === 2) {
    if (v.length < 4) return null
    len = (v[0] | (v[1] << 8) | (v[2] << 16) | (v[3] << 24)) >>> 2; off = 4
  } else return null
  if (v.length !== off + len) return null
  return v.slice(off)
}

export type ContractCreation =
  | { method: 'create'; deployer: string | null; deployerWhitelisted: boolean; blockHeight: number; extrinsicIndex: number; timestamp: string; txHash: string }
  | { method: 'factory'; factory: string; attribution: 'first-log'; blockHeight: number; timestamp: string; txHash: string }
  | { method: 'unknown' }

export interface ContractRegistryEntry {
  address: string          // 0x + 40 hex, lowercase
  codeHash: string
  codeSize: number
  destroyed: boolean
  creation: ContractCreation
  txCount: number
  logCount: number
  firstActivity: string | null
  lastActivity: string | null
}

interface SnapshotRow { address: string; kind: string; code_hash: string; code_size: number; destroyed: number }
interface CreateTxRow { block_height: number; extrinsic_index: number; block_timestamp: string; deployer: string; success: number }
interface CreateExecutedRow { to_address: string; block_height: number; extrinsic_index: number | null; tx_hash: string; exit_kind: string; block_timestamp: string }
interface ActivityStatsRow { address: string; c: number | string; first_ts: string; last_ts: string }
interface LogStatsRow extends ActivityStatsRow { first_block: number }
interface FirstLogExecutedRow { address: string; to_address: string; tx_hash: string; block_height: number; block_timestamp: string }

export interface ContractRegistryInputs {
  snapshot: SnapshotRow[]
  creates: CreateTxRow[]
  createExecuted: CreateExecutedRow[]
  executedStats: ActivityStatsRow[]
  palletCallStats: ActivityStatsRow[]
  logStats: LogStatsRow[]
  firstLogExecuted: FirstLogExecutedRow[]
  deployerWhitelist: Set<string>
}

const EVM_RE = /^0x[0-9a-f]{40}$/
const ACCOUNT_RE = /^0x[0-9a-f]{64}$/
const EVM_MARKER = '45544800'

// An account id's H160: the embedded address for ETH-marker truncations, the
// first 20 bytes otherwise (the runtime's AccountId32 → H160 truncation).
function h160OfAccountId(accountId: string): string {
  const acc = accountId.toLowerCase()
  if (acc.slice(2, 10) === EVM_MARKER && acc.slice(50) === '0000000000000000') return '0x' + acc.slice(10, 50)
  return '0x' + acc.slice(2, 42)
}
function truncatedAccountId(h160: string): string {
  return '0x' + EVM_MARKER + h160.toLowerCase().slice(2) + '0000000000000000'
}

// Normalize a deployer as indexed (effective_signer — AccountId32 hex, or an
// H160 from older envelopes) to the truncated-account form pills resolve.
function normalizeDeployer(raw: string): string | null {
  const d = (raw ?? '').toLowerCase()
  if (ACCOUNT_RE.test(d)) return d
  if (EVM_RE.test(d)) return truncatedAccountId(d)
  return null
}

const numeric = (v: number | string): number => Number(v) || 0
const minTs = (a: string | null, b: string | null) => (a && b ? (a < b ? a : b) : a ?? b)
const maxTs = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : a ?? b)

// Pure merge of the bounded query results into the registry. Deduplicates every
// row-shaped input by its replacement identity first, so replayed raw ranges
// (which reach us as duplicate ReplacingMergeTree rows until parts merge) can
// never change counts or duplicate creations.
export function buildContractRegistry(inputs: ContractRegistryInputs): { entries: Map<string, ContractRegistryEntry>; warnings: string[] } {
  const warnings: string[] = []
  const lastByKey = <T>(rows: T[], key: (r: T) => string): Map<string, T> => {
    const m = new Map<string, T>()
    for (const r of rows) m.set(key(r), r)
    return m
  }
  const snapshot = lastByKey(inputs.snapshot, r => r.address.toLowerCase())
  const creates = lastByKey(inputs.creates, r => `${r.block_height}:${r.extrinsic_index}`)
  const createExecuted = lastByKey(inputs.createExecuted, r => `${r.block_height}:${r.extrinsic_index}`)
  const executedStats = lastByKey(inputs.executedStats, r => r.address.toLowerCase())
  const palletCallStats = lastByKey(inputs.palletCallStats, r => r.address.toLowerCase())
  const logStats = lastByKey(inputs.logStats, r => r.address.toLowerCase())
  const firstLogExecuted = lastByKey(inputs.firstLogExecuted, r => r.address.toLowerCase())

  const entries = new Map<string, ContractRegistryEntry>()
  for (const [address, row] of snapshot) {
    if (row.kind !== 'contract') continue
    entries.set(address, {
      address,
      codeHash: row.code_hash,
      codeSize: numeric(row.code_size),
      destroyed: !!row.destroyed,
      creation: { method: 'unknown' },
      txCount: 0, logCount: 0, firstActivity: null, lastActivity: null,
    })
  }

  // Top-level creations: extrinsic success AND Executed Succeed, joined on
  // (block, extrinsic). A successful create whose address is missing from the
  // snapshot is a conservation violation — logged, never synthesized.
  for (const [key, create] of creates) {
    if (!create.success) continue
    const exec = createExecuted.get(key)
    if (!exec) {
      warnings.push(`create at ${key} has no Ethereum.Executed row`)
      continue
    }
    if (exec.exit_kind !== 'Succeed') continue
    const address = exec.to_address.toLowerCase()
    const entry = entries.get(address)
    if (!entry) {
      warnings.push(`successful create at ${key} deployed ${address} but the code snapshot has no such contract`)
      continue
    }
    const deployer = normalizeDeployer(create.deployer)
    entry.creation = {
      method: 'create',
      deployer,
      deployerWhitelisted: deployer != null && inputs.deployerWhitelist.has(h160OfAccountId(deployer)),
      blockHeight: create.block_height,
      extrinsicIndex: create.extrinsic_index,
      timestamp: create.block_timestamp,
      txHash: exec.tx_hash,
    }
  }

  // Factory attribution, evidence-labelled: the first log's extrinsic carries an
  // Ethereum.Executed row targeting another contract. to == self means the
  // contract already existed when it first logged — explicitly unknown.
  for (const [address, entry] of entries) {
    if (entry.creation.method !== 'unknown') continue
    const first = firstLogExecuted.get(address)
    if (!first || first.to_address.toLowerCase() === address) continue
    entry.creation = {
      method: 'factory',
      factory: first.to_address.toLowerCase(),
      attribution: 'first-log',
      blockHeight: first.block_height,
      timestamp: first.block_timestamp,
      txHash: first.tx_hash,
    }
  }

  for (const [address, entry] of entries) {
    const exec = executedStats.get(address)
    const calls = palletCallStats.get(address)
    const logs = logStats.get(address)
    entry.txCount = numeric(exec?.c ?? 0) + numeric(calls?.c ?? 0)
    entry.logCount = numeric(logs?.c ?? 0)
    for (const s of [exec, calls, logs]) {
      if (!s) continue
      entry.firstActivity = minTs(entry.firstActivity, s.first_ts)
      entry.lastActivity = maxTs(entry.lastActivity, s.last_ts)
    }
  }

  return { entries, warnings }
}

// Current ContractDeployer whitelist, reconstructed from its add/remove events
// (storage isn't indexed; 6 deployers ever). Advisory provenance only — the
// registry never gates on it (the whitelist is not enforced in the runner).
export function deployerWhitelistFromEvents(events: { event_name: string; who: string }[]): Set<string> {
  const set = new Set<string>()
  for (const e of events) {
    const who = e.who.toLowerCase()
    if (!EVM_RE.test(who)) continue
    if (e.event_name === 'EVMAccounts.DeployerAdded') set.add(who)
    else if (e.event_name === 'EVMAccounts.DeployerRemoved') set.delete(who)
  }
  return set
}

// `value`, `volume` and `activity` rank on the account-shaped metrics the display
// layer holds (explorerService's contractMetrics), and `name` on the verified
// name — none of which the registry knows, so pageContracts below deliberately
// covers only the registry's own columns.
export type ContractSort = 'created' | 'active' | 'txs' | 'logs' | 'value' | 'volume' | 'activity' | 'name'
export const CONTRACT_SORTS: ContractSort[] = ['created', 'active', 'txs', 'logs', 'value', 'volume', 'activity', 'name']

const creationBlock = (e: ContractRegistryEntry): number =>
  e.creation.method === 'unknown' ? -1 : e.creation.blockHeight

// Only the registry's own columns; the metric sorts are ranked by the display
// layer, which never reaches this comparator (see getContracts).
const REGISTRY_SORTS: Record<string, (e: ContractRegistryEntry) => number | string> = {
  created: (e: ContractRegistryEntry) => creationBlock(e),
  active: (e: ContractRegistryEntry) => e.lastActivity ?? '',
  txs: (e: ContractRegistryEntry) => e.txCount,
  logs: (e: ContractRegistryEntry) => e.logCount,
}

export function pageContracts(list: ContractRegistryEntry[], offset: number, limit: number, sort: ContractSort): { rows: ContractRegistryEntry[]; total: number } {
  const value = REGISTRY_SORTS[sort] ?? REGISTRY_SORTS.created
  const sorted = [...list].sort((a, b) => {
    const va = value(a), vb = value(b)
    if (va !== vb) return va < vb ? 1 : -1
    return a.address < b.address ? -1 : 1
  })
  return { rows: sorted.slice(offset, offset + limit), total: sorted.length }
}

// ---- service state ----

let client: ClickHouseClient
export function initContractRegistryService(c: ClickHouseClient): void { client = c }

let entries = new Map<string, ContractRegistryEntry>()
let accountForms = new Set<string>()   // both H160 and ETH-prefixed AccountId32, lowercase
let warnings: string[] = []

async function rows<T>(query: string, query_params?: Record<string, unknown>): Promise<T[]> {
  const res = await client.query({ query, query_params, format: 'JSONEachRow' })
  return (res as { json: <R>() => Promise<R[]> }).json<T>()
}

async function loadRegistryUncached(): Promise<void> {
  const [snapshot, creates, createExecuted, whitelistEvents] = await Promise.all([
    rows<SnapshotRow>(`
      SELECT address, kind, code_hash, toUInt32(code_size) AS code_size, toUInt8(destroyed) AS destroyed
      FROM price_data.evm_contract_code_snapshot FINAL
      WHERE kind = 'contract'`),
    rows<CreateTxRow>(`
      SELECT block_height, extrinsic_index, toString(block_timestamp) AS block_timestamp, deployer, toUInt8(success) AS success
      FROM price_data.evm_create_transactions FINAL`),
    rows<CreateExecutedRow>(`
      SELECT DISTINCT to_address, block_height, extrinsic_index, tx_hash, exit_kind, toString(block_timestamp) AS block_timestamp
      FROM price_data.evm_executed
      WHERE extrinsic_index IS NOT NULL
        AND (block_height, assumeNotNull(extrinsic_index)) IN (SELECT block_height, extrinsic_index FROM price_data.evm_create_transactions)`),
    rows<{ event_name: string; who: string }>(`
      SELECT event_name, lower(JSONExtractString(args_json, 'who')) AS who
      FROM price_data.raw_events
      WHERE event_name IN ('EVMAccounts.DeployerAdded', 'EVMAccounts.DeployerRemoved')
      ORDER BY block_height, event_index`),
  ])

  const addrs = snapshot.map(r => r.address.toLowerCase()).filter(a => EVM_RE.test(a))
  const [executedStats, palletCallStats, logStats] = addrs.length ? await Promise.all([
    rows<ActivityStatsRow>(`
      SELECT to_address AS address, toUInt64(uniqExact((block_height, event_index))) AS c,
             toString(min(block_timestamp)) AS first_ts, toString(max(block_timestamp)) AS last_ts
      FROM price_data.evm_executed
      WHERE to_address IN ({addrs:Array(String)})
      GROUP BY to_address`, { addrs }),
    rows<ActivityStatsRow>(`
      SELECT target AS address, toUInt64(uniqExact((block_height, ifNull(extrinsic_index, 4294967295), call_address))) AS c,
             toString(min(block_timestamp)) AS first_ts, toString(max(block_timestamp)) AS last_ts
      FROM price_data.evm_pallet_calls
      WHERE target IN ({addrs:Array(String)})
      GROUP BY target`, { addrs }),
    rows<LogStatsRow>(`
      SELECT contract_address AS address, toUInt64(groupBitmapMerge(log_identity_state)) AS c,
             toString(min(first_timestamp)) AS first_ts, toString(max(last_timestamp)) AS last_ts,
             min(first_block) AS first_block
      FROM price_data.evm_contract_log_stats
      WHERE contract_address IN ({addrs:Array(String)})
      GROUP BY contract_address`, { addrs }),
  ]) : [[], [], []]

  // One batched first-log lookup for contracts with logs but no create match:
  // the log pins (contract, first_block); its extrinsic's Ethereum.Executed row
  // (if any) names the factory.
  const attached = new Set<string>()
  {
    const execByKey = new Map(createExecuted.map(r => [`${r.block_height}:${r.extrinsic_index}`, r]))
    for (const c of creates) {
      if (!c.success) continue
      const exec = execByKey.get(`${c.block_height}:${c.extrinsic_index}`)
      if (exec && exec.exit_kind === 'Succeed') attached.add(exec.to_address.toLowerCase())
    }
  }
  const logByAddr = new Map(logStats.map(r => [r.address.toLowerCase(), r]))
  const unattributed = addrs.filter(a => !attached.has(a) && logByAddr.has(a))
  let firstLogExecuted: FirstLogExecutedRow[] = []
  if (unattributed.length) {
    const pairs = unattributed
      .map(a => ({ a, b: numeric(logByAddr.get(a)!.first_block) }))
      .filter(p => Number.isInteger(p.b) && p.b > 0)
    if (pairs.length) {
      const pairList = pairs.map(p => `('${p.a}', ${p.b})`).join(',')
      const firstLogs = await rows<{ address: string; block_height: number; extrinsic_index: number | null }>(`
        SELECT lower(contract_address) AS address, block_height,
               argMin(extrinsic_index, event_index) AS extrinsic_index
        FROM price_data.raw_evm_logs
        WHERE (lower(contract_address), block_height) IN (${pairList})
        GROUP BY address, block_height`)
      const withExtrinsic = firstLogs.filter(r => r.extrinsic_index != null)
      if (withExtrinsic.length) {
        const keyList = withExtrinsic.map(r => `(${numeric(r.block_height)}, ${numeric(r.extrinsic_index!)})`).join(',')
        const execRows = await rows<CreateExecutedRow>(`
          SELECT DISTINCT to_address, block_height, assumeNotNull(extrinsic_index) AS extrinsic_index, tx_hash, exit_kind,
                 toString(block_timestamp) AS block_timestamp
          FROM price_data.evm_executed
          WHERE extrinsic_index IS NOT NULL AND (block_height, assumeNotNull(extrinsic_index)) IN (${keyList})`)
        const execByKey = new Map(execRows.map(r => [`${r.block_height}:${r.extrinsic_index}`, r]))
        firstLogExecuted = withExtrinsic.flatMap(r => {
          const exec = execByKey.get(`${r.block_height}:${r.extrinsic_index}`)
          return exec ? [{ address: r.address, to_address: exec.to_address, tx_hash: exec.tx_hash, block_height: exec.block_height, block_timestamp: exec.block_timestamp }] : []
        })
      }
    }
  }

  const built = buildContractRegistry({
    snapshot, creates, createExecuted,
    executedStats, palletCallStats, logStats, firstLogExecuted,
    deployerWhitelist: deployerWhitelistFromEvents(whitelistEvents),
  })
  for (const w of built.warnings) console.warn(`[contracts] ${w}`)
  const forms = new Set<string>()
  for (const address of built.entries.keys()) {
    forms.add(address)
    forms.add(truncatedAccountId(address))
  }
  entries = built.entries
  accountForms = forms
  warnings = built.warnings
}

let loadInflight: Promise<void> | null = null
export function loadContractRegistry(): Promise<void> {
  if (loadInflight) return loadInflight
  const request = loadRegistryUncached().finally(() => {
    if (loadInflight === request) loadInflight = null
  })
  loadInflight = request
  return request
}

let refreshTimer: ReturnType<typeof setInterval> | null = null
export function startContractRegistryRefresh(intervalMs = 5 * 60_000): void {
  if (refreshTimer) return
  refreshTimer = setInterval(() => { void loadContractRegistry().catch(() => {}) }, intervalMs)
  refreshTimer.unref()
}
export function stopContractRegistryRefresh(): void {
  if (!refreshTimer) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

export function contractByH160(h160: string): ContractRegistryEntry | null {
  return entries.get(h160.toLowerCase()) ?? null
}
export function isContractAccount(accountIdOrH160: string): boolean {
  return accountForms.has(accountIdOrH160.toLowerCase())
}
export function allContracts(): ContractRegistryEntry[] {
  return [...entries.values()]
}
export function contractsPage(offset: number, limit: number, sort: ContractSort): { rows: ContractRegistryEntry[]; total: number } {
  return pageContracts(allContracts(), offset, limit, sort)
}
export function contractRegistryWarnings(): string[] {
  return [...warnings]
}

// ---- chain-state snapshot refresher (node-full; scheduled by backgroundRefresh) ----

const ACCOUNT_CODES_PREFIX = u8aToHex(u8aConcat(xxhashAsU8a('EVM', 128), xxhashAsU8a('AccountCodes', 128)))
const KECCAK_PLANTED = keccakAsHex(new Uint8Array([0x00]))

// Planted-marker check for rows whose bytes we no longer hold: the runtime's
// marker is exactly one 0x00 byte, so size + its keccak identify it.
function isPlantedSnapshotRow(row: SnapshotRow): boolean {
  return numeric(row.code_size) === 0 || (numeric(row.code_size) === 1 && row.code_hash === KECCAK_PLANTED)
}

async function refreshCodeUncached(): Promise<void> {
  // Throws on truncation — a half-read enumeration must never publish (it would
  // mass-flag destruction). Callers keep the previous snapshot.
  const keys = await substrateAllKeys(ACCOUNT_CODES_PREFIX)
  if (!keys.length) return // an empty AccountCodes map is not a real chain state — keep previous
  const keyByAddress = new Map<string, string>()
  for (const key of keys) {
    const address = '0x' + key.slice(-40).toLowerCase()
    if (EVM_RE.test(address)) keyByAddress.set(address, key)
  }

  const prev = new Map((await rows<SnapshotRow>(`
    SELECT address, kind, code_hash, toUInt32(code_size) AS code_size, toUInt8(destroyed) AS destroyed
    FROM price_data.evm_contract_code_snapshot FINAL`)).map(r => [r.address.toLowerCase(), r]))

  // Fetch code only for addresses new to the snapshot (or returning after a
  // destroyed tombstone — a CREATE2 redeploy needs its new hash).
  const toFetch = [...keyByAddress.keys()].filter(a => { const p = prev.get(a); return !p || !!p.destroyed })
  const codeByAddress = new Map<string, Uint8Array>()
  if (toFetch.length) {
    const values = await substrateStorageBatch(toFetch.map(a => keyByAddress.get(a)!))
    toFetch.forEach((address, i) => {
      const raw = values[i]
      if (!raw) return // transient read failure — retried next pass
      const code = decodeScaleVecU8(raw)
      if (!code) {
        console.warn(`[contracts] undecodable AccountCodes value at ${address}; skipping this pass`)
        return
      }
      codeByAddress.set(address, code)
    })
  }

  const out: Record<string, unknown>[] = []
  for (const address of keyByAddress.keys()) {
    const p = prev.get(address)
    if (p && !p.destroyed) {
      // Known live address: re-run the pattern classifier (so a classifier fix
      // reclassifies on the next pass) but keep the stored code identity.
      const patternKind = classifyEvmAddress(address)
      const kind = patternKind !== 'contract' ? patternKind : isPlantedSnapshotRow(p) ? 'planted-unknown' : 'contract'
      out.push({ address, kind, code_hash: p.code_hash, code_size: numeric(p.code_size), destroyed: 0 })
    } else if (codeByAddress.has(address)) {
      const code = codeByAddress.get(address)!
      out.push({ address, kind: classifyEvmAddress(address, code), code_hash: keccakAsHex(code), code_size: code.length, destroyed: 0 })
    }
    // else: new (or redeployed) address whose value read failed — no row this pass.
  }
  // Absent from a fully successful enumeration ⇒ destroyed (identity preserved).
  for (const [address, p] of prev) {
    if (!p.destroyed && !keyByAddress.has(address)) {
      out.push({ address, kind: p.kind, code_hash: p.code_hash, code_size: numeric(p.code_size), destroyed: 1 })
    }
  }
  if (!out.length) return
  await client.insert({ table: 'price_data.evm_contract_code_snapshot', values: out, format: 'JSONEachRow' })
  await loadContractRegistry()
}

let refreshInflight: Promise<void> | null = null

// Cadence is owned by the coordinated background scheduler
// (backgroundRefresh.ts); this keeps only the single-flight guard.
export function refreshContractCode(): Promise<void> {
  if (refreshInflight) return refreshInflight
  const request = refreshCodeUncached()
    .catch(err => console.error('[contracts] code snapshot refresh failed', err))
    .finally(() => { if (refreshInflight === request) refreshInflight = null })
  refreshInflight = request
  return request
}
