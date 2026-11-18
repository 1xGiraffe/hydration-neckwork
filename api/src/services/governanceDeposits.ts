import { xxhashAsU8a } from '@polkadot/util-crypto'
import { hexToU8a, u8aConcat, u8aToHex } from '@polkadot/util'
import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { allOpengovLifecycle, isConcludingEvent, referendumStatusFrom } from './governanceService.ts'
import { substrateAllKeys, substrateStorageBatch } from './substrateRpc.ts'
import { loadPinnedSubstrateBlock } from './pinnedBlock.ts'
import { accountRef, type AccountRef } from './explorerService.ts'
import { referendumTitleFor } from './referendumTitleService.ts'

// The HDX governance holds as deposits, and what can be done to get it back.
//
// Referendum deposits are chain-derived from indexed events (referendum_lifecycle_events,
// an MV over raw_events): Referenda.DecisionDepositPlaced names its payer and amount, the
// two Refunded events close them, and the submission deposit's payer is the account the
// submit extrinsic reserved it from — the last Balances.Reserved of that extrinsic before
// its Referenda.Submitted (Referenda::submit takes the deposit, then emits Submitted; the
// event itself names no depositor). Which deposit can be refunded follows the pallet
// (pallet-referenda `take_decision_deposit` / `take_submission_deposit`):
//   - decision deposit: refundable once the referendum is Approved, Rejected, TimedOut or
//     Cancelled; a Killed referendum's is slashed;
//   - submission deposit: refundable only when Approved or Cancelled; a Rejected or
//     TimedOut referendum keeps it reserved for good, a Killed one slashes it.
// Both refunds are permissionless (`refund_*_deposit(index)`, any signed origin) and pay
// the depositor, never the caller.
//
// Preimage deposits cannot be followed from events: noting a preimage someone already
// requested takes no deposit, and the owner's unnote of a requested preimage drops the
// deposit without an event. So they are CURRENT chain state — Preimage.RequestStatusFor
// enumerated at one pinned block by the coordinated refresher (a few hundred entries) —
// held in memory and stamped with that block. Only the owner can unnote (and so be
// refunded); unnoting an unrequested preimage also removes the call text, so one a
// running referendum still needs is never offered.

let client: ClickHouseClient
export function initGovernanceDeposits(c: ClickHouseClient): void { client = c }

export type DepositState = 'held' | 'refundable' | 'refunded' | 'kept' | 'slashed'

export interface ReferendumDeposit {
  index: number
  kind: 'submission' | 'decision'
  /** The depositor's account id (hex): a refund pays this account, whoever signs it. */
  who: string
  amount: string
  placedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string }
  state: DepositState
  refundedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
}

export interface ReferendumDeposits {
  index: number
  /** The referendum's status word (the directory's). */
  status: string
  /** True while the referendum runs without a decision deposit (anyone can place it). */
  needsDecisionDeposit: boolean
  submission: ReferendumDeposit | null
  decision: ReferendumDeposit | null
}

type LifecycleRow = { event_name: string; block_height: number; extrinsic_index: number | null; ts: string; args_json: string }

const ACCOUNT_RE = /^0x[0-9a-f]{64}$/

function args(row: LifecycleRow): Record<string, unknown> {
  try { return JSON.parse(row.args_json) as Record<string, unknown> } catch { return {} }
}

const isoOf = (chTs: string): string => {
  const t = Date.parse(chTs.includes('T') ? chTs : `${chTs.replace(' ', 'T')}Z`)
  return Number.isFinite(t) ? new Date(t).toISOString() : chTs
}
const at = (row: LifecycleRow) => ({ blockHeight: row.block_height, extrinsicIndex: row.extrinsic_index, timestamp: isoOf(row.ts) })

/** What the pallet lets happen to each deposit, by the referendum's outcome (see the header). */
export function depositStates(status: string): { decision: DepositState; submission: DepositState } {
  if (status === 'killed') return { decision: 'slashed', submission: 'slashed' }
  if (status === 'approved' || status === 'executed' || status === 'cancelled') return { decision: 'refundable', submission: 'refundable' }
  if (status === 'rejected' || status === 'timed out') return { decision: 'refundable', submission: 'kept' }
  return { decision: 'held', submission: 'held' }
}

// The submission depositor per referendum never changes once indexed, so it is
// remembered for the life of the process and only new referenda are looked up.
const submitters = new Map<number, { who: string; amount: string }>()

async function loadSubmitters(indices: number[]): Promise<void> {
  const missing = indices.filter(i => !submitters.has(i))
  if (!missing.length) return
  // One bounded read: the Submitted rows of the missing referenda, then their blocks'
  // Balances.Reserved by primary-key prefix (block_height IN …), matched on extrinsic.
  const res = await client.query({
    query: `-- governance:submission-depositors
      WITH s AS (
        SELECT ref_index, block_height, event_index, extrinsic_index
        FROM price_data.referendum_lifecycle_events FINAL
        WHERE pallet = 'opengov' AND event_name = 'Referenda.Submitted' AND ref_index IN {ids:Array(UInt32)}
      )
      SELECT s.ref_index AS i,
             argMax(JSONExtractString(r.args_json, 'who'), r.event_index) AS who,
             argMax(JSONExtractString(r.args_json, 'amount'), r.event_index) AS amount
      FROM s
      INNER JOIN (
        SELECT block_height, event_index, extrinsic_index, args_json FROM price_data.raw_events
        WHERE block_height IN (SELECT block_height FROM s) AND event_name = 'Balances.Reserved'
      ) AS r ON r.block_height = s.block_height AND r.extrinsic_index = s.extrinsic_index
      WHERE r.event_index < s.event_index
      GROUP BY s.ref_index`,
    query_params: { ids: missing }, format: 'JSONEachRow',
    clickhouse_settings: { max_threads: 4 },
  })
  for (const r of await res.json<{ i: number; who: string; amount: string }>()) {
    const who = String(r.who).toLowerCase()
    if (ACCOUNT_RE.test(who) && /^\d+$/.test(r.amount)) submitters.set(Number(r.i), { who, amount: r.amount })
  }
}

/** Every OpenGov referendum's two deposits, from the lifecycle projection (cached one block). */
export async function referendumDepositLedger(): Promise<Map<number, ReferendumDeposits>> {
  return cached('governance:deposits:ledger', 6_000, async () => {
    const lifecycle = await allOpengovLifecycle()
    await loadSubmitters([...lifecycle.keys()])
    const out = new Map<number, ReferendumDeposits>()
    for (const [index, rows] of lifecycle) {
      const status = referendumStatusFrom('opengov', rows.map(r => r.event_name))
      const states = depositStates(status)
      const submittedRow = rows.find(r => r.event_name === 'Referenda.Submitted') ?? null
      const placedRow = rows.find(r => r.event_name === 'Referenda.DecisionDepositPlaced') ?? null
      const subRefund = rows.find(r => r.event_name === 'Referenda.SubmissionDepositRefunded') ?? null
      const decRefund = rows.find(r => r.event_name === 'Referenda.DecisionDepositRefunded') ?? null
      const concluded = rows.some(r => isConcludingEvent(r.event_name))
      let submission: ReferendumDeposit | null = null
      if (submittedRow) {
        const refundArgs = subRefund ? args(subRefund) : null
        const known = submitters.get(index)
        const who = String(refundArgs?.who ?? known?.who ?? '').toLowerCase()
        const amount = String(refundArgs?.amount ?? known?.amount ?? '')
        if (ACCOUNT_RE.test(who) && /^\d+$/.test(amount)) {
          submission = { index, kind: 'submission', who, amount, placedAt: at(submittedRow), state: subRefund ? 'refunded' : states.submission, refundedAt: subRefund ? at(subRefund) : null }
        }
      }
      let decision: ReferendumDeposit | null = null
      if (placedRow) {
        const a = args(placedRow)
        const r = decRefund ? args(decRefund) : null
        const who = String(a.who ?? r?.who ?? '').toLowerCase()
        const amount = String(a.amount ?? r?.amount ?? '')
        if (ACCOUNT_RE.test(who) && /^\d+$/.test(amount)) {
          decision = { index, kind: 'decision', who, amount, placedAt: at(placedRow), state: decRefund ? 'refunded' : states.decision, refundedAt: decRefund ? at(decRefund) : null }
        }
      }
      out.set(index, { index, status, needsDecisionDeposit: !concluded && !placedRow, submission, decision })
    }
    return out
  })
}

// ---- preimage deposits (current chain state) ----

export interface PreimageDeposit {
  hash: string
  /** The owner's account id (hex): the only account that can unnote it. */
  owner: string
  amount: string
  len: number | null
  /** Requested (by the scheduler, for an enactment): unnoting then only returns the deposit and keeps the call. */
  requested: boolean
  /**
   * Stored in the pallet's old map (Preimage.StatusFor, a reserved deposit from before
   * the hold-based format). The owner's unnote migrates it and returns the deposit
   * like any other.
   */
  legacy: boolean
}

const REQUEST_STATUS_PREFIX = u8aToHex(u8aConcat(xxhashAsU8a('Preimage', 128), xxhashAsU8a('RequestStatusFor', 128)))
// The old map, same value layout (`deposit: (AccountId, Balance)` in place of the ticket).
const LEGACY_STATUS_PREFIX = u8aToHex(u8aConcat(xxhashAsU8a('Preimage', 128), xxhashAsU8a('StatusFor', 128)))

let preimageState: { block: number; rows: PreimageDeposit[] } | null = null

/**
 * Preimage.RequestStatusFor (a value of pallet-preimage's RequestStatus with
 * HoldConsideration's ticket, a u128):
 *   0 Unrequested { ticket: (AccountId32, u128), len: u32 }
 *   1 Requested { maybe_ticket: Option<(AccountId32, u128)>, count: u32, maybe_len: Option<u32> }
 * Null for a value without a ticket (no deposit) or a shape this does not know.
 */
export function decodeRequestStatus(hex: string): { owner: string; amount: bigint; len: number | null; requested: boolean } | null {
  const v = hexToU8a(hex)
  const u32 = (o: number) => (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0
  const u128 = (o: number) => { let x = 0n; for (let i = 15; i >= 0; i--) x = (x << 8n) | BigInt(v[o + i]); return x }
  if (v[0] === 0) {
    if (v.length !== 1 + 32 + 16 + 4) return null
    return { owner: u8aToHex(v.slice(1, 33)), amount: u128(33), len: u32(49), requested: false }
  }
  if (v[0] === 1) {
    if (v[1] === 0) return null
    if (v[1] !== 1 || v.length < 2 + 32 + 16 + 4 + 1) return null
    const owner = u8aToHex(v.slice(2, 34))
    const amount = u128(34)
    let o = 50 + 4
    const len = v[o] === 1 && v.length >= o + 5 ? u32(o + 1) : null
    o += v[o] === 1 ? 5 : 1
    if (o !== v.length) return null
    return { owner, amount, len, requested: true }
  }
  return null
}

/**
 * One pinned read of every preimage request status, in both of the pallet's maps (the
 * coordinated refresher, every few minutes). A hash lives in one map at a time: the
 * pallet moves an old entry to the new map the first time anything touches it.
 */
export async function refreshPreimageDeposits(): Promise<void> {
  if (!client) return
  const pin = await loadPinnedSubstrateBlock(client, undefined, 'governance:preimage-pin')
  const rows: PreimageDeposit[] = []
  for (const [prefix, legacy] of [[REQUEST_STATUS_PREFIX, false], [LEGACY_STATUS_PREFIX, true]] as const) {
    const keys = await substrateAllKeys(prefix, undefined, undefined, pin.blockHash)
    // The new map always holds entries; no keys there is an RPC hiccup: keep the last good state.
    if (!keys.length) { if (legacy) continue; return }
    const values = await substrateStorageBatch(keys, pin.blockHash)
    if (values.some(v => v == null)) return // a partial read is never published
    keys.forEach((k, i) => {
      const d = decodeRequestStatus(values[i]!)
      if (!d || d.amount <= 0n) return
      // Key layout: prefix (32 bytes) + the hash itself (Identity hasher).
      rows.push({ hash: `0x${k.slice(-64)}`.toLowerCase(), owner: d.owner.toLowerCase(), amount: d.amount.toString(), len: d.len, requested: d.requested, legacy })
    })
  }
  preimageState = { block: pin.block, rows }
}

export function preimageDepositsReady(): boolean { return preimageState != null }

/** The referenda whose proposal is a preimage hash (Lookup), with their status. */
async function referendaByPreimage(): Promise<Map<string, { index: number; status: string }[]>> {
  return cached('governance:deposits:preimage-users', 6_000, async () => {
    const lifecycle = await allOpengovLifecycle()
    const out = new Map<string, { index: number; status: string }[]>()
    for (const [index, rows] of lifecycle) {
      const s = rows.find(r => r.event_name === 'Referenda.Submitted')
      const hash = s ? String((args(s).proposal as { hash?: unknown } | undefined)?.hash ?? '').toLowerCase() : ''
      if (!/^0x[0-9a-f]{64}$/.test(hash)) continue
      const list = out.get(hash) ?? []
      list.push({ index, status: referendumStatusFrom('opengov', rows.map(r => r.event_name)) })
      out.set(hash, list)
    }
    return out
  })
}

const RUNNING = new Set(['submitted', 'deciding', 'confirming'])

// ---- an account's deposits ----

export interface AccountReferendumDeposit extends ReferendumDeposit { status: string; title: string | null }
export interface AccountPreimageDeposit extends PreimageDeposit {
  /** Referenda whose proposal this preimage is. */
  usedBy: { index: number; status: string }[]
  /** The owner may unnote it now without harming a referendum. */
  refundable: boolean
  /** Why not, when it is not. */
  blocked: string | null
}

export interface AccountDeposits {
  /** Deposits not yet returned: held by a running referendum, refundable now, or kept by the chain. */
  referenda: AccountReferendumDeposit[]
  /** Null until the first preimage read has loaded. */
  preimages: AccountPreimageDeposit[] | null
  preimagesAsOfBlock: number | null
  /**
   * Raw HDX: `held` is what will or can come back (held by a running referendum,
   * refundable now, or a preimage deposit); `refundable` the part a refund or unnote
   * returns now; `kept` the submission deposits the chain keeps for good (rejected or
   * timed-out referenda), never part of `held`.
   */
  totals: { held: string; refundable: string; kept: string }
}

const OPEN_STATES = new Set<DepositState>(['held', 'refundable', 'kept'])

export async function accountDeposits(accountIds: string[]): Promise<AccountDeposits> {
  const ids = new Set(accountIds.map(a => a.toLowerCase()))
  const [ledger, users] = await Promise.all([referendumDepositLedger(), referendaByPreimage()])
  const referenda: AccountReferendumDeposit[] = []
  for (const d of ledger.values()) {
    for (const dep of [d.submission, d.decision]) {
      if (dep && ids.has(dep.who) && OPEN_STATES.has(dep.state)) referenda.push({ ...dep, status: d.status, title: referendumTitleFor('opengov', d.index) })
    }
  }
  referenda.sort((a, b) => b.index - a.index || a.kind.localeCompare(b.kind))
  const preimages = preimageState ? preimageState.rows.filter(p => ids.has(p.owner)).map(p => {
    const usedBy = users.get(p.hash) ?? []
    const live = usedBy.filter(u => RUNNING.has(u.status))
    // Unnoting a REQUESTED preimage keeps the call (only the deposit goes back); an
    // unrequested one is removed, which a running referendum could not survive.
    const blocked = !p.requested && live.length ? `Referendum #${live[0].index} still needs this call: removing it now would leave nothing to enact.` : null
    return { ...p, usedBy, refundable: !blocked, blocked }
  }).sort((a, b) => Number(BigInt(b.amount) - BigInt(a.amount))) : null
  let held = 0n, refundable = 0n, kept = 0n
  for (const r of referenda) {
    if (r.state === 'kept') { kept += BigInt(r.amount); continue }
    held += BigInt(r.amount)
    if (r.state === 'refundable') refundable += BigInt(r.amount)
  }
  for (const p of preimages ?? []) { held += BigInt(p.amount); if (p.refundable) refundable += BigInt(p.amount) }
  return { referenda, preimages, preimagesAsOfBlock: preimageState?.block ?? null, totals: { held: held.toString(), refundable: refundable.toString(), kept: kept.toString() } }
}

/** One referendum's deposits, for its page (null for an unknown or Democracy one), each with its depositor's account reference. */
export async function referendumDeposits(index: number): Promise<(Omit<ReferendumDeposits, 'submission' | 'decision'> & {
  submission: (ReferendumDeposit & { account: AccountRef }) | null
  decision: (ReferendumDeposit & { account: AccountRef }) | null
}) | null> {
  const d = (await referendumDepositLedger()).get(index)
  if (!d) return null
  const withRef = (x: ReferendumDeposit | null) => (x ? { ...x, account: accountRef(x.who) } : null)
  return { ...d, submission: withRef(d.submission), decision: withRef(d.decision) }
}

export const __test = { setPreimageState: (s: typeof preimageState) => { preimageState = s }, preimageState: () => preimageState, submitters }
