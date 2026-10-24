// The NEAR end of Hydration's Wormhole NTT bridges (ZEC, wNEAR).
//
// Neither end of a NEAR hop is readable from Hydration's own logs:
// - NEAR carries an account as sha256(account id), which does not invert. An
//   outbound TransferSent therefore names its recipient only by that hash; the
//   account it credited is in the NEAR manager's `transfer_received` event.
// - The VAA of an arrival is published by a relayer and names the NEAR contract
//   that called the manager, not a user. The real sender is in the NEAR manager's
//   `transfer_sent` event, and for ZEC deposited straight from Zcash (Omni Bridge's
//   zcash-connector) it is the Zcash transaction the connector verified, whose
//   bytes travel in the connector call's arguments.
//
// The FastNear transactions API (keyless) indexes every transaction touching an
// account. Each manager's event-log transactions are synced incrementally into an
// in-memory index, which is all an explorer request ever reads: a miss schedules
// one deduplicated background sync and the row keeps its chain-only display until
// a later request. NEAR history is immutable, so nothing is ever evicted.

import { createHash } from 'node:crypto'
import { base58Encode } from './chainPrimitives.ts'

const FASTNEAR_TX_URL = process.env.EXPLORER_FASTNEAR_TX_URL?.trim() || 'https://tx.main.fastnear.com'
// Every manager is a sub-account of the deployer, so new NEAR NTT assets are found
// without a code change.
const DEPLOYER = 'hydration-whm.near'
const MANAGER_SUFFIX = '.' + DEPLOYER
const SYNC_MIN_INTERVAL_MS = 60_000
const DISCOVER_INTERVAL_MS = 3_600_000
const FETCH_TIMEOUT_MS = 10_000
const MAX_PAGES_PER_SYNC = 20
const TX_BATCH = 20 // the API's own limit per /v0/transactions request
const ACCOUNT_PAGE_SIZE = 50

// Omni Bridge's Zcash connector: a `verify_deposit_v2` call carrying the deposit's
// raw Zcash transaction. Its transfer_sent names the connector, never the user.
const ZCASH_CONNECTOR = 'zcash-connector.bridge.near'
// Zcash transparent P2PKH address prefix (t1…).
const ZCASH_P2PKH_PREFIX = Uint8Array.from([0x1c, 0xb8])

/** NEAR's Wormhole chain id. */
export const NEAR_WORMHOLE_CHAIN_ID = 15

const NEARBLOCKS = 'https://nearblocks.io'
const BLOCKCHAIR_ZCASH = 'https://blockchair.com/zcash'

export interface FarAccount { address: string; url: string | null; label?: string }

/** Where a NEAR arrival really came from. `chain` is 'Zcash' for an Omni Bridge deposit. */
export interface NearArrivalOrigin { chain: 'NEAR' | 'Zcash'; account: FarAccount | null; txUrl: string | null }

/** The NEAR account a send credited, and the transaction that credited it. */
export interface NearSendDestination { account: FarAccount; txUrl: string | null }

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex')

export function nearAccountUrl(account: string): string {
  return `${NEARBLOCKS}/address/${encodeURIComponent(account)}`
}
export function nearTxUrl(txHash: string): string {
  return `${NEARBLOCKS}/txns/${encodeURIComponent(txHash)}`
}

// ─────────────────────────── pure parsing ───────────────────────────

interface NttEvent { standard?: string; event?: string; data?: unknown }

/** The `whm-ntt` events in one log line, or none. */
export function parseNttEventLog(log: string): { event: string; data: Record<string, unknown> }[] {
  if (!log.startsWith('EVENT_JSON:')) return []
  let parsed: NttEvent
  try { parsed = JSON.parse(log.slice('EVENT_JSON:'.length)) as NttEvent } catch { return [] }
  if (parsed.standard !== 'whm-ntt' || typeof parsed.event !== 'string' || !Array.isArray(parsed.data)) return []
  return parsed.data
    .filter((d): d is Record<string, unknown> => d != null && typeof d === 'object')
    .map(data => ({ event: parsed.event!, data }))
}

function readCompactSize(b: Uint8Array, o: number): [number, number] | null {
  if (o >= b.length) return null
  const x = b[o]
  if (x < 0xfd) return [x, o + 1]
  const w = x === 0xfd ? 2 : x === 0xfe ? 4 : 8
  if (o + 1 + w > b.length) return null
  let n = 0
  for (let i = w - 1; i >= 0; i--) n = n * 256 + b[o + 1 + i]
  return [n, o + 1 + w]
}

function base58Check(payload: Uint8Array): string {
  const once = createHash('sha256').update(payload).digest()
  const checksum = createHash('sha256').update(once).digest().subarray(0, 4)
  const full = new Uint8Array(payload.length + 4)
  full.set(payload)
  full.set(checksum, payload.length)
  return base58Encode(full)
}

/**
 * The transparent P2PKH addresses that signed a Zcash transaction's inputs (v4,
 * v5 and v6 layouts). A scriptSig is `<sig> <pubkey>`, so the address is
 * hash160(pubkey) under the t1 prefix. Inputs of any other shape are skipped.
 * An empty list is a transaction with no transparent input at all (spent from a
 * shielded balance); null is one whose bytes could not be read.
 */
export function zcashInputAddresses(tx: Uint8Array): string[] | null {
  if (tx.length < 8) return null
  const header = (tx[0] | (tx[1] << 8) | (tx[2] << 16) | (tx[3] << 24)) >>> 0
  const version = header & 0x7fffffff
  // v4: header, versionGroupId, then the transparent bundle.
  // v5/v6: header, versionGroupId, consensusBranchId, lockTime, expiryHeight, then it.
  let o = version === 4 ? 8 : version === 5 || version === 6 ? 20 : -1
  if (o < 0) return null
  const vin = readCompactSize(tx, o)
  if (!vin) return null
  o = vin[1]
  const out = new Set<string>()
  for (let i = 0; i < vin[0]; i++) {
    o += 36 // prevout: txid + index
    const len = readCompactSize(tx, o)
    if (!len) return [...out]
    const script = tx.subarray(len[1], len[1] + len[0])
    o = len[1] + len[0] + 4 // + sequence
    if (o > tx.length) return [...out]
    // Exactly two pushes: a signature, then a 33- or 65-byte public key.
    const sigLen = script[0]
    if (!(sigLen >= 1 && sigLen <= 75)) continue
    const pkLen = script[1 + sigLen]
    if ((pkLen !== 33 && pkLen !== 65) || 2 + sigLen + pkLen !== script.length) continue
    const pubkey = script.subarray(2 + sigLen)
    const h160 = createHash('ripemd160').update(createHash('sha256').update(pubkey).digest()).digest()
    const payload = new Uint8Array(22)
    payload.set(ZCASH_P2PKH_PREFIX)
    payload.set(h160, 2)
    out.add(base58Check(payload))
  }
  return [...out]
}

// The slice of a FastNear transaction this module reads.
export interface FastNearTx {
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: unknown[] }
  receipts: { execution_outcome: { outcome: { executor_id: string; logs: string[] } } }[]
}

function functionCallArgs(tx: FastNearTx, method: string): Record<string, unknown> | null {
  for (const a of tx.transaction.actions) {
    const fc = (a as { FunctionCall?: { method_name?: string; args?: string } } | null)?.FunctionCall
    if (fc?.method_name !== method || typeof fc.args !== 'string') continue
    try { return JSON.parse(Buffer.from(fc.args, 'base64').toString('utf8')) as Record<string, unknown> } catch { return null }
  }
  return null
}

/**
 * The one address a deposit came from: its only transparent input address, or — when
 * it spends from several — the refund address the depositor named, but only if it is
 * one of them (an address they demonstrably control). Otherwise none.
 */
export function pickZcashSender(inputs: readonly string[] | null, refund: unknown): string | null {
  if (!inputs) return null
  if (inputs.length === 1) return inputs[0]
  return typeof refund === 'string' && inputs.includes(refund) ? refund : null
}

/** A Zcash deposit's origin, read from the connector call that carried it. */
export function zcashDepositOrigin(tx: FastNearTx): NearArrivalOrigin | null {
  if (tx.transaction.receiver_id !== ZCASH_CONNECTOR) return null
  const args = functionCallArgs(tx, 'verify_deposit_v2') ?? functionCallArgs(tx, 'verify_deposit')
  if (!args || typeof args.tx_bytes !== 'string') return null
  const senders = zcashInputAddresses(Uint8Array.from(Buffer.from(args.tx_bytes, 'base64')))
  // The connector logs the UTXO it took custody of as `<txid>@<vout>`: the Zcash
  // transaction id in the form explorers use, without hashing the v5+ txid here.
  let txid: string | null = null
  for (const r of tx.receipts) {
    if (r.execution_outcome.outcome.executor_id !== ZCASH_CONNECTOR) continue
    for (const log of r.execution_outcome.outcome.logs) {
      const m = /"utxo_storage_keys":\["([0-9a-f]{64})@\d+"/.exec(log)
      if (m) txid = m[1]
    }
  }
  const depositMsg = args.deposit_msg as { refund_address?: unknown } | undefined
  const sender = pickZcashSender(senders, depositMsg?.refund_address)
  // Spent from a shielded balance: the chain names no sender, and saying so beats a
  // blank — the refund address is only what the depositor typed, never the sender.
  const shielded = senders != null && senders.length === 0
  return {
    chain: 'Zcash',
    account: sender ? { address: sender, url: `${BLOCKCHAIR_ZCASH}/address/${sender}` } : shielded ? { address: 'shielded', url: null, label: 'shielded sender' } : null,
    txUrl: txid ? `${BLOCKCHAIR_ZCASH}/transaction/${txid}` : nearTxUrl(tx.transaction.hash),
  }
}

interface SentRecord { origin: NearArrivalOrigin }
interface ReceivedRecord { account: string; accountHash: string; amount: string; txHash: string }

export interface ManagerEvents { sent: Map<string, SentRecord>; received: ReceivedRecord[] }

/** Fold one transaction's manager events into `into`, keyed for the two lookups. */
export function foldManagerTx(manager: string, tx: FastNearTx, into: ManagerEvents): void {
  for (const r of tx.receipts) {
    const { executor_id, logs } = r.execution_outcome.outcome
    if (executor_id !== manager) continue
    for (const log of logs) {
      for (const { event, data } of parseNttEventLog(log)) {
        if (event === 'transfer_sent' && data.recipient_chain != null && data.wormhole_sequence != null) {
          const sender = typeof data.sender === 'string' ? data.sender : null
          const origin = (sender === ZCASH_CONNECTOR ? zcashDepositOrigin(tx) : null) ?? {
            chain: 'NEAR' as const,
            account: sender ? { address: sender, url: nearAccountUrl(sender) } : null,
            txUrl: nearTxUrl(tx.transaction.hash),
          }
          into.sent.set(String(data.wormhole_sequence), { origin })
        } else if (event === 'transfer_received' && typeof data.account === 'string') {
          into.received.push({ account: data.account, accountHash: sha256Hex(data.account), amount: String(data.amount ?? ''), txHash: tx.transaction.hash })
        }
      }
    }
  }
}

/**
 * The NEAR account an outbound recipient hash names, without any NEAR read, when the
 * refund address is that account's implicit form (the shape Hydration's own UI sends).
 */
export function nearRecipientFromRefund(recipientHash: string, refund: string): string | null {
  const r = refund.replace(/^0x/, '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(r) && sha256Hex(r) === recipientHash.replace(/^0x/, '').toLowerCase() ? r : null
}

// ─────────────────────────── index + sync ───────────────────────────

// Where an account's ascending read resumes, and the transactions already folded.
interface Cursor { nextHeight: number; seen: Set<string> }
interface ManagerState extends ManagerEvents, Cursor { name: string; emitter: string }

const managers = new Map<string, ManagerState>()
const deployer: Cursor = { nextHeight: 0, seen: new Set() }
let discoveredAt = 0
let lastSyncAt = 0
let inflight: Promise<void> | null = null

async function post<T>(path: string, body: unknown): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(FASTNEAR_TX_URL + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`FastNear ${path} ${res.status}`)
    return await res.json() as T
  } finally {
    clearTimeout(timer)
  }
}

interface AccountTxsPage { account_txs: { transaction_hash: string; tx_block_height: number }[]; resume_token?: string }

// The account's transactions at or above `fromHeight`, oldest first. FastNEAR answers
// "ascending from 0" and "newest first" in well under a second but "ascending from
// block N" in ~30 s (measured 2026-10-21), past the request timeout — which aborted
// every incremental sync after the first. So a later sync reads newest first and
// pages back only until it reaches the synced height. The page size is always
// explicit: newest first with is_event_log and the default size stalled past 60 s,
// the same read at limit 50 answered in 0.4 s.
async function accountTxs(account: string, fromHeight: number, eventLogOnly: boolean): Promise<AccountTxsPage['account_txs']> {
  const out: AccountTxsPage['account_txs'] = []
  const desc = fromHeight > 0
  let resume: string | undefined
  let reached = !desc
  for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
    const res = await post<AccountTxsPage>('/v0/account', {
      account_id: account, desc, limit: ACCOUNT_PAGE_SIZE, ...(desc ? {} : { from_tx_block_height: 0 }),
      ...(eventLogOnly ? { is_event_log: true } : {}), ...(resume ? { resume_token: resume } : {}),
    })
    const txs = res.account_txs ?? []
    out.push(...txs.filter(t => t.tx_block_height >= fromHeight))
    if (desc && txs.some(t => t.tx_block_height < fromHeight)) { reached = true; break }
    if (!res.resume_token) { reached = true; break }
    resume = res.resume_token
  }
  if (!reached) console.warn(`[Explorer] NEAR bridge read of ${account} stopped at the page cap before block ${fromHeight}; older transactions wait for the next sync`)
  return out.sort((a, b) => a.tx_block_height - b.tx_block_height)
}

async function transactions(hashes: string[]): Promise<FastNearTx[]> {
  const out: FastNearTx[] = []
  for (let i = 0; i < hashes.length; i += TX_BATCH) {
    const res = await post<{ transactions: FastNearTx[] }>('/v0/transactions', { tx_hashes: hashes.slice(i, i + TX_BATCH) })
    out.push(...(res.transactions ?? []).filter(t => t?.transaction?.hash))
  }
  return out
}

/**
 * The account's transactions not read before, oldest first. The cursor stays at the
 * last height read — a later transaction in that block may not be indexed yet, and
 * `seen` keeps the overlap from folding twice — and never moves past a transaction
 * the details endpoint did not return, which the next sync then asks for again.
 */
async function readNew(account: string, cursor: Cursor, eventLogOnly: boolean): Promise<FastNearTx[]> {
  const list = (await accountTxs(account, cursor.nextHeight, eventLogOnly)).filter(t => !cursor.seen.has(t.transaction_hash))
  if (!list.length) return []
  const txs = (await transactions(list.map(t => t.transaction_hash))).filter(t => !cursor.seen.has(t.transaction.hash))
  for (const t of txs) cursor.seen.add(t.transaction.hash)
  const missing = list.filter(t => !cursor.seen.has(t.transaction_hash)).map(t => t.tx_block_height)
  cursor.nextHeight = Math.max(cursor.nextHeight, missing.length ? Math.min(...missing) : Math.max(...list.map(t => t.tx_block_height)))
  return txs
}

async function discoverManagers(): Promise<void> {
  for (const tx of await readNew(DEPLOYER, deployer, false)) {
    const name = tx.transaction.receiver_id
    if (!name.endsWith(MANAGER_SUFFIX) || managers.has(name)) continue
    managers.set(name, { name, emitter: sha256Hex(name), nextHeight: 0, seen: new Set(), sent: new Map(), received: [] })
  }
  discoveredAt = Date.now()
}

// One discovery at a time, shared by the sync and by nearManagerNames.
let discovering: Promise<void> | null = null
function ensureDiscovered(): Promise<void> {
  if (Date.now() - discoveredAt <= DISCOVER_INTERVAL_MS) return Promise.resolve()
  discovering ??= discoverManagers().finally(() => { discovering = null })
  return discovering
}

/**
 * Every Hydration NTT manager on NEAR, keyed by the hash Wormhole carries it as
 * (sha256 of the account id, no 0x) — how a peer registration names it. For the
 * backing monitor, which awaits this inside its own cycle; a failed discovery
 * leaves the managers already known.
 */
export async function nearManagerNames(): Promise<ReadonlyMap<string, string>> {
  try { await ensureDiscovered() } catch (err) {
    console.error('[wormhole] NEAR manager discovery failed:', err instanceof Error ? err.message : err)
  }
  return new Map([...managers.values()].map(m => [m.emitter, m.name]))
}

async function sync(): Promise<void> {
  await ensureDiscovered()
  // One manager failing must not hold back the others' resolutions.
  for (const m of managers.values()) {
    try {
      for (const tx of await readNew(m.name, m, true)) foldManagerTx(m.name, tx, m)
    } catch (err) {
      console.error(`[Explorer] NEAR bridge sync of ${m.name} failed:`, err instanceof Error ? err.message : err)
    }
  }
}

/** One background sync at a time, at most once a minute; never awaited by a request. */
function scheduleSync(): void {
  if (inflight || Date.now() - lastSyncAt < SYNC_MIN_INTERVAL_MS) return
  lastSyncAt = Date.now()
  inflight = sync()
    .catch(err => console.error('[Explorer] NEAR bridge sync failed:', err instanceof Error ? err.message : err))
    .finally(() => { inflight = null })
}

// ─────────────────────────── lookups ───────────────────────────

/**
 * The origin of an arrival from NEAR, by its VAA's emitter (sha256 of the NEAR
 * manager's account) and sequence. Null while unknown; a miss schedules a sync.
 */
export function nearArrivalOrigin(emitter: string, sequence: string): NearArrivalOrigin | null {
  const e = emitter.replace(/^0x/, '').toLowerCase()
  for (const m of managers.values()) {
    if (m.emitter !== e) continue
    const hit = m.sent.get(sequence)
    if (hit) return hit.origin
  }
  scheduleSync()
  return null
}

/**
 * The NEAR account a send's recipient hash names. Any credit to the hash's preimage
 * names it exactly. The crediting transaction is linked only on the account's one
 * credit of this amount: a lone credit of another amount may be an earlier send while
 * this one is not indexed yet. (NEAR amounts are in the token's own decimals, so a
 * token whose decimals differ from ours gets the account but no transaction.)
 * Null while unknown.
 */
export function nearSendDestination(recipientHash: string, amount: string): NearSendDestination | null {
  const h = recipientHash.replace(/^0x/, '').toLowerCase()
  const credits: ReceivedRecord[] = []
  for (const m of managers.values()) for (const r of m.received) if (r.accountHash === h) credits.push(r)
  if (!credits.length) { scheduleSync(); return null }
  const sameAmount = credits.filter(r => r.amount === amount)
  const tx = sameAmount.length === 1 ? sameAmount[0] : null
  if (!tx) scheduleSync()
  return {
    account: { address: credits[0].account, url: nearAccountUrl(credits[0].account) },
    txUrl: tx ? nearTxUrl(tx.txHash) : null,
  }
}
