import { createHash } from 'node:crypto'
import { xxhashAsU8a } from '@polkadot/util-crypto'
import { u8aToHex, hexToU8a, u8aConcat } from '@polkadot/util'
import type { ClickHouseClient } from '../db/client.ts'
import { substrateStorageBatch, substrateAllKeys } from './substrateRpc.ts'
import { decodeCompact } from './proxyMultisigService.ts'

// Per-account lock/reserve/hold breakdown snapshots.
//
// The HDX dashboard refresh (hdxService) already enumerates Balances.Locks and
// Vesting.VestingSchedules chain-wide every 15 minutes. This module extends the
// same refresh with the remaining lock-shaped storages — named reserves, holds,
// orml token locks/reserves, and the deposit-taking pallets that explain the
// otherwise opaque "reserved" figure (identity, proxy, multisig, referenda,
// legacy preimages) — and persists one per-account, per-asset component row set
// to ClickHouse. The account and tag balance endpoints read that bounded
// background snapshot; the request path never enumerates chain state.
//
// Semantics worth keeping straight everywhere downstream:
//  - Locks OVERLAP: each lock freezes free balance independently, so the
//    non-transferable part of `free` is max(lock amounts), not their sum.
//  - Named reserves, holds and pallet deposits are ADDITIVE slices of
//    `reserved` (holds are accounted inside `reserved` by pallet-balances).
//  - `claimable` on the vesting lock is HDX whose periods already elapsed but
//    that no one claimed yet — locked on-chain, releasable with vesting.claim.

export type BreakdownKind = 'lock' | 'reserve' | 'hold' | 'deposit'

// GigaHdx unstakes mature 403,200 parachain blocks (28 days) after the unstake.
export const GIGA_UNBONDING_BLOCKS = 403_200

// One raw Balances.Locks / Tokens.Locks entry (id is the 8-byte ascii lock id).
export interface LockRow { accountId: string; id: string; amount: bigint }
// Structurally matches hdxService's VestingScheduleAgg (start/period in RELAY blocks).
export interface VestingScheduleRaw { accountId: string; start: number; period: number; periodCount: number; perPeriod: bigint }
// Structurally matches hdxService's VoteClassState (one entry per conviction class).
export interface VoteClassState { activeAmount: bigint; hasActiveVotes: boolean; priorUnlock: number; priorBalance: bigint }
// Stored rows also carry the synthetic per-account 'timeline' kind (the binding
// unlock timeline) — it is not a balance component and never sums with them.
export type StoredRowKind = BreakdownKind | 'timeline'
export interface BreakdownRow { accountId: string; assetId: number; kind: StoredRowKind; source: string; amount: bigint; claimable: bigint; detail: string }

// A lock decomposed by WHEN it can release: already releasable (an unlock/claim
// call away), scheduled (a known block), or open-ended (held by active votes,
// delegations or staking that must end first). Tranche amounts always sum to
// the lock amount.
export interface LockTranche { state: 'releasable' | 'scheduled' | 'active'; amount: bigint; untilBlock?: number; linear?: boolean }

// One slice of the account-level BINDING unlock timeline. Locks overlap, so a
// single lock's own schedule can mislead — e.g. a vote lock that is "unlockable
// now" frees nothing while a GIGAHDX lock still binds the same tokens. The
// timeline decomposes frozen (= max lock) across ALL lock sources under
// act-now semantics (staking exits instantly, GIGAHDX staked exits after the
// 28-day unbond): each slice says when that much balance can be transferable
// at the earliest and which lock binds it ('cause'; ties join with '+').
// `conditional` marks act-now durations (only real if the owner unstakes now).
// Open-ended floors (active votes/delegations) surface only with the amount
// EXCEEDING every other lock's coverage — the envelope residual. When dated
// locks (e.g. 5x/6x conviction priors) hold the same balance underneath an
// open floor, the active slice carries that known minimum as `untilMs`
// ("not before <date>, longer while the vote stays"). Slice amounts sum to
// frozen.
export interface TimelineSlice { state: 'releasable' | 'scheduled' | 'active'; cause: string; amount: bigint; untilMs?: number; linear?: boolean; conditional?: boolean }

const prefix = (p: string, s: string) => u8aToHex(u8aConcat(xxhashAsU8a(p, 128), xxhashAsU8a(s, 128)))
const RESERVES_PREFIX = prefix('Balances', 'Reserves')
const HOLDS_PREFIX = prefix('Balances', 'Holds')
const TOKEN_LOCKS_PREFIX = prefix('Tokens', 'Locks')
const TOKEN_RESERVES_PREFIX = prefix('Tokens', 'Reserves')
const IDENTITY_OF_PREFIX = prefix('Identity', 'IdentityOf')
const SUBS_OF_PREFIX = prefix('Identity', 'SubsOf')
const PROXIES_PREFIX = prefix('Proxy', 'Proxies')
const ANNOUNCEMENTS_PREFIX = prefix('Proxy', 'Announcements')
const MULTISIGS_PREFIX = prefix('Multisig', 'Multisigs')
const REFERENDUM_INFO_PREFIX = prefix('Referenda', 'ReferendumInfoFor')
const PREIMAGE_STATUS_PREFIX = prefix('Preimage', 'StatusFor')

// Chain lock ids → semantic sources (discovered by chain-wide enumeration; an
// unmapped id passes through verbatim so future pallets surface untranslated
// rather than vanish). `phrelect` locks are orphaned — the elections pallet
// left the runtime, so no unlock path exists. `insuffED` sits on the Treasury:
// ED cover collected for insufficient-asset accounts.
export const LOCK_ID_SOURCES: Record<string, string> = {
  ormlvest: 'vesting',
  stk_stks: 'staking',
  pyconvot: 'vote',
  ghdxlock: 'gigahdx',
  democrac: 'democracy',
  phrelect: 'elections',
  insuffED: 'sufficiency',
}
export const RESERVE_ID_SOURCES: Record<string, string> = { dcaorder: 'dca', otcorder: 'otc' }
// RuntimeHoldReason is (pallet index, variant index); Preimage is pallet 15.
const HOLD_PALLET_SOURCES: Record<number, string> = { 15: 'preimage' }

const u32At = (b: Uint8Array, off: number) => (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0
function u128At(b: Uint8Array, off: number): bigint {
  if (off + 16 > b.length) throw new RangeError('truncated u128')
  let n = 0n
  for (let i = 15; i >= 0; i--) n = (n << 8n) | BigInt(b[off + i])
  return n
}
const asciiId = (b: Uint8Array, off: number) => Buffer.from(b.slice(off, off + 8)).toString('latin1').replace(/\0+$/, '')

// Vec<{id [u8;8], amount u128, ...}>: Balances.Locks items carry a trailing
// reasons byte (25 bytes), orml Tokens.Locks and both Reserves lists don't (24).
export function decodeIdAmountVec(b: Uint8Array, itemSize: 24 | 25): { id: string; amount: bigint }[] {
  const [n, start] = decodeCompact(b, 0)
  const out: { id: string; amount: bigint }[] = []
  let off = start
  for (let i = 0; i < n && off + itemSize <= b.length; i++) {
    out.push({ id: asciiId(b, off), amount: u128At(b, off + 8) })
    off += itemSize
  }
  return out
}

// Balances.Holds: Vec<{id: RuntimeHoldReason (pallet u8, variant u8), amount u128}>.
export function decodeHoldVec(b: Uint8Array): { pallet: number; variant: number; amount: bigint }[] {
  const [n, start] = decodeCompact(b, 0)
  const out: { pallet: number; variant: number; amount: bigint }[] = []
  let off = start
  for (let i = 0; i < n && off + 18 <= b.length; i++) {
    out.push({ pallet: b[off], variant: b[off + 1], amount: u128At(b, off + 2) })
    off += 18
  }
  return out
}

// Identity.IdentityOf: Registration { judgements: Vec<(u32, Judgement)>, deposit
// u128, info } — only the FeePaid(1) judgement variant carries a balance payload.
export function decodeIdentityDeposit(b: Uint8Array): bigint {
  let [n, off] = decodeCompact(b, 0)
  for (let i = 0; i < n; i++) {
    off += 4
    const tag = b[off]
    off += 1 + (tag === 1 ? 16 : 0)
  }
  return u128At(b, off)
}

// Identity.SubsOf: (deposit u128, BoundedVec<AccountId>).
export const decodeSubsOfDeposit = (b: Uint8Array): bigint => u128At(b, 0)

// Proxy.Proxies: (Vec<{delegate 32B, proxyType u8, delay u32}>, deposit u128).
export function decodeProxiesDeposit(b: Uint8Array): bigint {
  const [n, start] = decodeCompact(b, 0)
  return u128At(b, start + n * 37)
}

// Proxy.Announcements: (Vec<{real 32B, callHash 32B, height u32}>, deposit u128).
export function decodeAnnouncementsDeposit(b: Uint8Array): bigint {
  const [n, start] = decodeCompact(b, 0)
  return u128At(b, start + n * 68)
}

// Multisig.Multisigs: {when {height u32, index u32}, deposit u128, depositor
// 32B, approvals}. The deposit is reserved on the DEPOSITOR, not the multisig.
export function decodeMultisigDeposit(b: Uint8Array): { depositor: string; amount: bigint } {
  return { amount: u128At(b, 8), depositor: u8aToHex(b.slice(24, 56)) }
}

// Referenda.ReferendumInfoFor. Deposits (submission, decision) stay reserved on
// their payers until explicitly refunded, including on finished referenda:
//   0 Ongoing(status) — status = track u16, origin, proposal, enactment,
//     submitted u32, submission Deposit, decision Option<Deposit>, ...
//   1..4 Approved/Rejected/Cancelled/TimedOut (since u32, Option<Deposit> ×2)
//   5 Killed(u32) — deposits slashed, nothing reserved.
// Deposit = (who 32B, amount u128). Origin is a 2-byte unit variant for every
// track origin except system.Signed, which carries an account id.
export function decodeReferendumDeposits(b: Uint8Array): { who: string; amount: bigint }[] {
  const out: { who: string; amount: bigint }[] = []
  const depositAt = (off: number) => ({ who: u8aToHex(b.slice(off, off + 32)), amount: u128At(b, off + 32) })
  const optionDepositAt = (off: number): number => {
    if (b[off] !== 1) return off + 1
    const d = depositAt(off + 1)
    if (d.amount > 0n) out.push(d)
    return off + 49
  }
  if (b[0] >= 1 && b[0] <= 4) {
    optionDepositAt(optionDepositAt(5))
  } else if (b[0] === 0) {
    let off = 3 // variant + track u16
    const originPallet = b[off]
    const originVariant = b[off + 1]
    off += 2
    if (originPallet === 0 && originVariant === 1) off += 32 // system.Signed(account)
    const proposalTag = b[off]
    off += 1
    if (proposalTag === 0) off += 32 // Legacy { hash }
    else if (proposalTag === 1) { const [len, next] = decodeCompact(b, off); off = next + len } // Inline(bytes)
    else if (proposalTag === 2) off += 36 // Lookup { hash, len u32 }
    else throw new RangeError('unknown bounded-call variant')
    off += 5 // enactment: DispatchTime variant + u32
    off += 4 // submitted block
    const submission = depositAt(off)
    if (submission.amount > 0n) out.push(submission)
    optionDepositAt(off + 48)
  }
  return out
}

// Preimage.StatusFor (legacy deposit-based preimages):
//   0 Unrequested { deposit (who 32B, amount u128), len u32 }
//   1 Requested { deposit Option<(who, amount)>, count u32, len Option<u32> }
export function decodePreimageLegacyDeposit(b: Uint8Array): { who: string; amount: bigint } | null {
  if (b[0] === 0) return { who: u8aToHex(b.slice(1, 33)), amount: u128At(b, 33) }
  if (b[0] === 1 && b[1] === 1) return { who: u8aToHex(b.slice(2, 34)), amount: u128At(b, 34) }
  return null
}

// Remaining orml-vesting amount per account at `relayHeight`, raw units.
// Only future periods count as locked; the difference to the on-chain ormlvest
// lock is vested-but-unclaimed (the lock only shrinks when vesting.claim runs).
export function unvestedByAccountRaw(schedules: VestingScheduleRaw[], relayHeight: number): Map<string, bigint> {
  const out = new Map<string, bigint>()
  for (const s of schedules) {
    const elapsed = Math.max(0, Math.min(s.periodCount, Math.floor((relayHeight - s.start) / s.period)))
    const remaining = BigInt(s.periodCount - elapsed) * s.perPeriod
    if (remaining > 0n) out.set(s.accountId, (out.get(s.accountId) ?? 0n) + remaining)
  }
  return out
}

// Decompose a conviction-voting (pyconvot) lock into duration tranches. Per
// class, the lock is the max-envelope of the open-ended active amount and the
// date-bound prior lock; the account lock is the max over classes. Walking that
// envelope over the future prior-unlock blocks yields a step function whose
// drops are the scheduled tranches — releasable-now is whatever the on-chain
// lock still holds above today's envelope (an unlock call away), and the final
// floor is open-ended while votes/delegations stay active. Partially
// overlapping durations collapse correctly because only the envelope's actual
// drops release anything.
export function voteLockTranches(lockAmount: bigint, classes: VoteClassState[], headBlock: number): LockTranche[] {
  if (lockAmount <= 0n) return []
  const boundAt = (block: number) => {
    let bound = 0n
    for (const c of classes) {
      const prior = block < c.priorUnlock ? c.priorBalance : 0n
      const v = c.activeAmount > prior ? c.activeAmount : prior
      if (v > bound) bound = v
    }
    return bound > lockAmount ? lockAmount : bound
  }
  const out: LockTranche[] = []
  let prev = boundAt(headBlock)
  if (lockAmount > prev) out.push({ state: 'releasable', amount: lockAmount - prev })
  const steps = [...new Set(classes.filter(c => c.priorBalance > 0n && c.priorUnlock > headBlock).map(c => c.priorUnlock))].sort((a, b) => a - b)
  for (const block of steps) {
    const after = boundAt(block)
    if (prev > after) { out.push({ state: 'scheduled', amount: prev - after, untilBlock: block }); prev = after }
  }
  if (prev > 0n) out.push({ state: 'active', amount: prev })
  return out
}

// GIGAHDX lock tranches: matured unstakes are releasable, pending ones release
// at their expiry block, and the rest is staked (open-ended until unstaked —
// then a 28-day unbond).
export function gigaUnstakeTranches(lockAmount: bigint, unstakes: { expiryBlock: number; payoutRaw: bigint }[], headBlock: number): LockTranche[] {
  if (lockAmount <= 0n) return []
  let releasable = 0n
  const byBlock = new Map<number, bigint>()
  for (const u of unstakes) {
    if (u.expiryBlock <= headBlock) releasable += u.payoutRaw
    else byBlock.set(u.expiryBlock, (byBlock.get(u.expiryBlock) ?? 0n) + u.payoutRaw)
  }
  const out: LockTranche[] = []
  let remaining = lockAmount
  const take = (amount: bigint) => { const a = amount < remaining ? amount : remaining; remaining -= a; return a }
  const now = take(releasable)
  if (now > 0n) out.push({ state: 'releasable', amount: now })
  for (const [block, amount] of [...byBlock.entries()].sort((x, y) => x[0] - y[0])) {
    if (remaining <= 0n) break
    out.push({ state: 'scheduled', amount: take(amount), untilBlock: block })
  }
  if (remaining > 0n) out.push({ state: 'active', amount: remaining })
  return out
}

// Vesting tranches: the vested-but-unclaimed part is releasable (vesting.claim);
// the rest releases linearly until the last schedule's end relay block.
export function vestingTranches(lockAmount: bigint, claimable: bigint, endRelayBlock: number): LockTranche[] {
  if (lockAmount <= 0n) return []
  const out: LockTranche[] = []
  const clamped = claimable > lockAmount ? lockAmount : claimable
  if (clamped > 0n) out.push({ state: 'releasable', amount: clamped })
  if (lockAmount > clamped) out.push({ state: 'scheduled', amount: lockAmount - clamped, untilBlock: endRelayBlock, linear: true })
  return out
}

// Inputs to the binding-timeline computation, one entry per lock source the
// account holds, everything already converted to millisecond timestamps.
export interface TimelineSource {
  source: string
  onchain: bigint                     // current Balances.Locks amount
  open: bigint                        // floor held open-ended (active votes/delegations, static locks)
  steps: { atMs: number; conditional?: boolean }[] // future times where this source's envelope drops
  env: (tMs: number) => bigint        // amount this source still needs locked at time t (act-now semantics)
  // env without the open-ended part — the DATED constraints only (conviction
  // priors under an active vote). Defaults to env when the source has no open
  // floor, else to nothing. Feeds the "not before <date>" on the open residual.
  envDated?: (tMs: number) => bigint
  linear?: boolean                    // envelope declines linearly (vesting)
  // The open floor is act-now-clearable (a still-cast vote on an ongoing poll
  // can be removed without a conviction lock). Soft floors never extend the
  // envelope — they only claim balance NOTHING dated or hard covers, so a vote
  // fully overlapped by its own conviction priors (or any other lock) is not
  // shown as open at all.
  soft?: boolean
}

// Cap per-account evaluation points — a pathological voter with dozens of
// distinct prior-unlock dates folds its tail into the last step.
const MAX_TIMELINE_STEPS = 24

// Decompose the account's frozen amount (max over lock envelopes) into
// time-ordered slices with cause attribution. Walking the max-envelope over
// every source's step points: a drop of the max releases balance, attributed
// to the source(s) that were binding and dropped; the final floor is open-ended.
export function buildBindingTimeline(sources: TimelineSource[], nowMs: number): TimelineSlice[] {
  const held = sources.filter(s => s.onchain > 0n)
  if (!held.length) return []
  const frozen = held.reduce((m, s) => (s.onchain > m ? s.onchain : m), 0n)
  // Soft floors (still-cast votes) never extend the envelope: their binding
  // contribution is their DATED part only.
  const capped = (s: TimelineSource, t: number) => {
    const raw = s.soft ? (s.envDated?.(t) ?? 0n) : s.env(t)
    return raw > s.onchain ? s.onchain : raw
  }
  const F = (t: number) => held.reduce((m, s) => { const v = capped(s, t); return v > m ? v : m }, 0n)

  const out: TimelineSlice[] = []
  const now = F(nowMs)
  // Whatever the hard envelope doesn't cover splits into the soft-open claim
  // (ongoing votes — indefinite while cast, but only the amount nothing else
  // covers) and the genuinely releasable rest.
  const softFloor = held.reduce((m, s) => {
    if (!s.soft) return m
    const v = s.open > s.onchain ? s.onchain : s.open
    return v > m ? v : m
  }, 0n)
  if (frozen > now) {
    const uncovered = frozen - now
    const softShown = softFloor - now > 0n ? (softFloor - now < uncovered ? softFloor - now : uncovered) : 0n
    const releasable = uncovered - softShown
    if (releasable > 0n) {
      // Releasable immediately: an unlock/claim call on the binding on-chain lock.
      const cause = held.filter(s => s.onchain === frozen).map(s => s.source).join('+')
      out.push({ state: 'releasable', cause, amount: releasable })
    }
    if (softShown > 0n) {
      const softCauses = held.filter(s => s.soft && (s.open > s.onchain ? s.onchain : s.open) === softFloor).map(s => s.source)
      out.push({ state: 'active', cause: softCauses.join('+') || 'vote', amount: softShown })
    }
  }
  const conditionalAt = new Set(held.flatMap(s => s.steps.filter(x => x.conditional).map(x => x.atMs)))
  let steps = [...new Set(held.flatMap(s => s.steps.map(x => x.atMs)).filter(t => t > nowMs))].sort((a, b) => a - b)
  if (steps.length > MAX_TIMELINE_STEPS) steps = [...steps.slice(0, MAX_TIMELINE_STEPS - 1), steps[steps.length - 1]]
  let prev = now
  let prevT = nowMs
  for (const t of steps) {
    const cur = F(t)
    if (prev > cur) {
      const before = held.filter(s => capped(s, prevT) === prev)
      const dropped = before.filter(s => capped(s, t) < prev)
      const causes = (dropped.length ? dropped : before)
      const cause = [...new Set(causes.map(s => s.source))].join('+')
      out.push({
        state: 'scheduled', cause, amount: prev - cur, untilMs: t,
        linear: causes.some(s => s.linear) || undefined,
        conditional: conditionalAt.has(t) || undefined,
      })
      prev = cur
    }
    prevT = t
  }
  if (prev > 0n) {
    const floors = held.filter(s => (s.open > s.onchain ? s.onchain : s.open) === prev)
    const cause = (floors.length ? [...new Set(floors.map(s => s.source))] : [held.reduce((a, b) => (capped(b, prevT) > capped(a, prevT) ? b : a)).source]).join('+')
    // Known minimum for the open residual: the latest dated step until which
    // DATED locks alone (conviction priors, unbonds, vesting) still hold at
    // least this amount — the balance cannot free before that date even if
    // every open-ended hold cleared right now.
    const datedEnv = (t: number) => held.reduce((m, s) => {
      const raw = s.envDated ? s.envDated(t) : (s.open === 0n ? s.env(t) : 0n)
      const v = raw > s.onchain ? s.onchain : raw
      return v > m ? v : m
    }, 0n)
    let notBefore: number | undefined
    let cursor = nowMs
    for (const t of steps) {
      if (datedEnv(cursor) >= prev) notBefore = t
      cursor = t
    }
    out.push({ state: 'active', cause, amount: prev, ...(notBefore != null ? { untilMs: notBefore } : {}) })
  }
  return out
}

const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')

function serializeTimeline(slices: TimelineSlice[]): string {
  if (!slices.length) return ''
  return JSON.stringify(slices.map(s => ({
    state: s.state,
    cause: s.cause,
    amount: s.amount.toString(),
    ...(s.untilMs != null ? { until: iso(s.untilMs) } : {}),
    ...(s.linear ? { linear: true } : {}),
    ...(s.conditional ? { conditional: true } : {}),
  })))
}

// Persisted tranche form: block numbers become estimated timestamps at snapshot
// time (6s blocks, same convention as the HDX dashboard) so readers never need
// a para-vs-relay block basis.
function serializeTranches(tranches: LockTranche[], blockToMs: (block: number) => number): string {
  if (!tranches.length) return ''
  return JSON.stringify(tranches.map(t => ({
    state: t.state,
    amount: t.amount.toString(),
    ...(t.untilBlock != null ? { until: iso(blockToMs(t.untilBlock)) } : {}),
    ...(t.linear ? { linear: true } : {}),
  })))
}

// Account id from a Blake2_128Concat/Twox64Concat-keyed map: trailing 32 bytes.
const accountFromKeyTail = (key: string) => '0x' + key.slice(-64)

interface StorageEntry { key: string; value: Uint8Array }

async function loadEntries(storagePrefix: string, maxPages = 40): Promise<StorageEntry[]> {
  const keys = await substrateAllKeys(storagePrefix, maxPages)
  if (!keys.length) return []
  const values = await substrateStorageBatch(keys)
  const out: StorageEntry[] = []
  for (let i = 0; i < keys.length; i++) {
    const raw = values[i]
    if (raw) out.push({ key: keys[i], value: hexToU8a(raw) })
  }
  return out
}

// Tokens.Locks / Tokens.Reserves key: …blake2_128concat(account) ++
// twox64concat(currencyId u32) — parsed from the key's end.
function tokenKeyParts(key: string): { accountId: string; assetId: number } {
  const assetId = u32At(hexToU8a('0x' + key.slice(-8)), 0)
  return { accountId: '0x' + key.slice(-8 - 16 - 64, -8 - 16), assetId }
}

export interface CollectLockBreakdownInput {
  nativeLockRows: LockRow[]
  vestingSchedules: VestingScheduleRaw[]
  relayHeight: number
  voteStates: Map<string, VoteClassState[]>
  pendingUnstakes: { accountId: string; expiryBlock: number; payoutRaw: bigint }[]
  headBlock: number
  headTsMs: number
}

// Assemble the full per-account component set: the shared hdxService data plus
// this module's own (small) storage enumerations.
export async function collectLockBreakdownRows(input: CollectLockBreakdownInput): Promise<BreakdownRow[]> {
  const [reserves, holds, tokenLocks, tokenReserves, identities, subs, proxies, announcements, multisigs, referenda, preimages] = await Promise.all([
    loadEntries(RESERVES_PREFIX),
    loadEntries(HOLDS_PREFIX),
    loadEntries(TOKEN_LOCKS_PREFIX),
    loadEntries(TOKEN_RESERVES_PREFIX),
    loadEntries(IDENTITY_OF_PREFIX),
    loadEntries(SUBS_OF_PREFIX),
    loadEntries(PROXIES_PREFIX),
    loadEntries(ANNOUNCEMENTS_PREFIX),
    loadEntries(MULTISIGS_PREFIX),
    loadEntries(REFERENDUM_INFO_PREFIX),
    loadEntries(PREIMAGE_STATUS_PREFIX),
  ])

  // Merge duplicate (account, asset, kind, source) contributions additively —
  // e.g. several multisig deposits by one depositor, or identity + subs.
  const merged = new Map<string, BreakdownRow>()
  const add = (accountId: string, assetId: number, kind: StoredRowKind, source: string, amount: bigint, claimable = 0n, detail = '') => {
    if (amount <= 0n) return
    const mapKey = `${accountId}|${assetId}|${kind}|${source}`
    const existing = merged.get(mapKey)
    if (existing) { existing.amount += amount; existing.claimable += claimable }
    else merged.set(mapKey, { accountId, assetId, kind, source, amount, claimable, detail })
  }

  const nowMs = input.headTsMs
  const paraToMs = (block: number) => input.headTsMs + (block - input.headBlock) * 6000
  const relayToMs = (block: number) => input.headTsMs + (block - input.relayHeight) * 6000
  const unvested = unvestedByAccountRaw(input.vestingSchedules, input.relayHeight)
  const vestingEnd = new Map<string, number>()
  for (const s of input.vestingSchedules) {
    const end = s.start + s.period * s.periodCount
    if (end > (vestingEnd.get(s.accountId) ?? 0)) vestingEnd.set(s.accountId, end)
  }
  const unstakesByAccount = new Map<string, { expiryBlock: number; payoutRaw: bigint }[]>()
  for (const u of input.pendingUnstakes) {
    const list = unstakesByAccount.get(u.accountId)
    if (list) list.push(u)
    else unstakesByAccount.set(u.accountId, [u])
  }
  const locksByAccount = new Map<string, LockRow[]>()
  for (const row of input.nativeLockRows) {
    const list = locksByAccount.get(row.accountId)
    if (list) list.push(row)
    else locksByAccount.set(row.accountId, [row])
  }

  for (const [accountId, rows] of locksByAccount) {
    const sources: TimelineSource[] = []
    for (const row of rows) {
      const source = LOCK_ID_SOURCES[row.id] ?? row.id
      let claimable = 0n
      let detail = ''
      if (row.id === 'ormlvest') {
        const remaining = unvested.get(accountId) ?? 0n
        claimable = row.amount - (remaining < row.amount ? remaining : row.amount)
        const endBlock = vestingEnd.get(accountId) ?? input.relayHeight
        detail = serializeTranches(vestingTranches(row.amount, claimable, endBlock), relayToMs)
        const endMs = relayToMs(endBlock)
        const stillVesting = row.amount - claimable
        sources.push({
          source, onchain: row.amount, open: 0n, linear: true,
          steps: endMs > nowMs && stillVesting > 0n ? [{ atMs: endMs }] : [],
          env: t => {
            if (stillVesting <= 0n || t >= endMs || endMs <= nowMs) return 0n
            if (t <= nowMs) return stillVesting
            return stillVesting * BigInt(Math.round(endMs - t)) / BigInt(Math.round(endMs - nowMs))
          },
        })
      } else if (row.id === 'pyconvot') {
        const classes = input.voteStates.get(accountId) ?? []
        detail = serializeTranches(voteLockTranches(row.amount, classes, input.headBlock), paraToMs)
        const classMs = classes.map(c => ({ active: c.activeAmount, priorMs: paraToMs(c.priorUnlock), priorBalance: c.priorBalance }))
        sources.push({
          source, onchain: row.amount, soft: true,
          open: classMs.reduce((m, c) => (c.active > m ? c.active : m), 0n),
          steps: classMs.filter(c => c.priorBalance > 0n && c.priorMs > nowMs).map(c => ({ atMs: c.priorMs })),
          env: t => classMs.reduce((m, c) => {
            const prior = t < c.priorMs ? c.priorBalance : 0n
            const v = c.active > prior ? c.active : prior
            return v > m ? v : m
          }, 0n),
          // The binding part: conviction priors are hard dates; the still-cast
          // votes themselves are act-now-clearable (soft) and only ever claim
          // balance nothing else covers.
          envDated: t => classMs.reduce((m, c) => {
            const prior = t < c.priorMs ? c.priorBalance : 0n
            return prior > m ? prior : m
          }, 0n),
        })
      } else if (row.id === 'ghdxlock') {
        const unstakes = unstakesByAccount.get(accountId) ?? []
        detail = serializeTranches(gigaUnstakeTranches(row.amount, unstakes, input.headBlock), paraToMs)
        const pending = unstakes.map(u => ({ atMs: paraToMs(u.expiryBlock), payout: u.payoutRaw }))
        const pendingTotal = pending.reduce((s, p) => s + p.payout, 0n)
        const staked = row.amount > pendingTotal ? row.amount - pendingTotal : 0n
        // Act-now semantics: the staked part could be liquid after one unbond
        // period if the owner unstaked right now — a conditional 28d step, not
        // an open-ended floor.
        const unbondMs = nowMs + GIGA_UNBONDING_BLOCKS * 6000
        sources.push({
          source, onchain: row.amount, open: 0n,
          steps: [
            ...pending.filter(p => p.atMs > nowMs).map(p => ({ atMs: p.atMs })),
            ...(staked > 0n ? [{ atMs: unbondMs, conditional: true }] : []),
          ],
          env: t => (t < unbondMs ? staked : 0n) + pending.reduce((s, p) => s + (p.atMs > t ? p.payout : 0n), 0n),
        })
      } else if (row.id === 'stk_stks') {
        // Hydration staking exits instantly — under act-now semantics it binds
        // nothing beyond the snapshot instant, so it lands in the "anytime"
        // (releasable) slice rather than an open-ended floor.
        sources.push({ source, onchain: row.amount, open: 0n, steps: [], env: () => 0n })
      } else {
        // Genuinely open-ended locks: democracy delegations (undelegate then a
        // conviction-length prior), orphaned elections, sufficiency, unknown ids.
        sources.push({ source, onchain: row.amount, open: row.amount, steps: [], env: () => row.amount })
      }
      add(accountId, 0, 'lock', source, row.amount, claimable, detail)
    }
    const timeline = buildBindingTimeline(sources, nowMs)
    if (timeline.length) {
      const frozen = timeline.reduce((s, t) => s + t.amount, 0n)
      add(accountId, 0, 'timeline', 'all', frozen, 0n, serializeTimeline(timeline))
    }
  }

  for (const e of reserves) {
    for (const r of decodeIdAmountVec(e.value, 24)) {
      add(accountFromKeyTail(e.key), 0, 'reserve', RESERVE_ID_SOURCES[r.id] ?? r.id, r.amount)
    }
  }
  for (const e of holds) {
    for (const h of decodeHoldVec(e.value)) {
      add(accountFromKeyTail(e.key), 0, 'hold', HOLD_PALLET_SOURCES[h.pallet] ?? `hold-${h.pallet}-${h.variant}`, h.amount)
    }
  }
  for (const e of tokenLocks) {
    const { accountId, assetId } = tokenKeyParts(e.key)
    for (const l of decodeIdAmountVec(e.value, 24)) add(accountId, assetId, 'lock', LOCK_ID_SOURCES[l.id] ?? l.id, l.amount)
  }
  for (const e of tokenReserves) {
    const { accountId, assetId } = tokenKeyParts(e.key)
    for (const r of decodeIdAmountVec(e.value, 24)) add(accountId, assetId, 'reserve', RESERVE_ID_SOURCES[r.id] ?? r.id, r.amount)
  }

  const decodeOrSkip = <T>(entry: StorageEntry, decode: (b: Uint8Array) => T, label: string): T | null => {
    try { return decode(entry.value) } catch (err) {
      console.error(`[locks] ${label} decode failed for ${entry.key.slice(0, 34)}…`, err)
      return null
    }
  }
  for (const e of identities) {
    const deposit = decodeOrSkip(e, decodeIdentityDeposit, 'identity')
    if (deposit != null) add(accountFromKeyTail(e.key), 0, 'deposit', 'identity', deposit)
  }
  for (const e of subs) {
    const deposit = decodeOrSkip(e, decodeSubsOfDeposit, 'subs')
    if (deposit != null) add(accountFromKeyTail(e.key), 0, 'deposit', 'identity', deposit)
  }
  for (const e of proxies) {
    const deposit = decodeOrSkip(e, decodeProxiesDeposit, 'proxies')
    if (deposit != null) add(accountFromKeyTail(e.key), 0, 'deposit', 'proxy', deposit)
  }
  for (const e of announcements) {
    const deposit = decodeOrSkip(e, decodeAnnouncementsDeposit, 'announcements')
    if (deposit != null) add(accountFromKeyTail(e.key), 0, 'deposit', 'proxy', deposit)
  }
  for (const e of multisigs) {
    const deposit = decodeOrSkip(e, decodeMultisigDeposit, 'multisig')
    if (deposit) add(deposit.depositor, 0, 'deposit', 'multisig', deposit.amount)
  }
  for (const e of referenda) {
    const deposits = decodeOrSkip(e, decodeReferendumDeposits, 'referenda')
    for (const d of deposits ?? []) add(d.who, 0, 'deposit', 'referenda', d.amount)
  }
  for (const e of preimages) {
    const deposit = decodeOrSkip(e, decodePreimageLegacyDeposit, 'preimage')
    if (deposit) add(deposit.who, 0, 'deposit', 'preimage', deposit.amount)
  }

  return [...merged.values()]
}

// Publish one snapshot generation: insert under a fresh partition, verify the
// row count round-trips, flip the state pointer, then drop older partitions —
// the same shape as the money-market account-value snapshots.
export async function persistLockSnapshot(
  client: ClickHouseClient,
  rows: BreakdownRow[],
  meta: { blockHeight: number; relayHeight: number },
): Promise<void> {
  // A gutted enumeration (RPC trouble) must never replace a good snapshot:
  // the chain has ~19k lock accounts, so a tiny row set means the read failed.
  if (rows.length < 1000) throw new Error(`lock breakdown suspiciously small (${rows.length} rows), keeping previous snapshot`)
  const snapshotId = String(Date.now())
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
  const checksum = createHash('sha256')
  const sorted = [...rows].sort((a, b) => a.accountId === b.accountId
    ? (a.assetId - b.assetId) || a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source)
    : a.accountId.localeCompare(b.accountId))
  for (const r of sorted) checksum.update(`${r.accountId}|${r.assetId}|${r.kind}|${r.source}|${r.amount}|${r.claimable}|${r.detail}\n`)
  const batchSize = 5_000
  for (let offset = 0; offset < sorted.length; offset += batchSize) {
    await client.insert({
      table: 'price_data.account_lock_snapshots',
      values: sorted.slice(offset, offset + batchSize).map(r => ({
        snapshot_id: snapshotId, account_id: r.accountId, asset_id: r.assetId,
        kind: r.kind, source: r.source,
        amount: r.amount.toString(), claimable: r.claimable.toString(),
        detail: r.detail,
        computed_at: now,
      })),
      format: 'JSONEachRow',
    })
  }
  const verify = await client.query({
    query: `SELECT count() AS c, uniqExact((account_id, asset_id, kind, source)) AS u
      FROM price_data.account_lock_snapshots WHERE snapshot_id={snapshotId:String}`,
    query_params: { snapshotId }, format: 'JSONEachRow',
  })
  const counts = (await verify.json<{ c: string; u: string }>())[0]
  if (Number(counts?.c) !== sorted.length || Number(counts?.u) !== sorted.length) {
    throw new Error(`incomplete lock breakdown snapshot ${counts?.c ?? 0}/${sorted.length}`)
  }
  await client.insert({
    table: 'price_data.account_lock_snapshot_state',
    values: [{
      snapshot_key: 'current', snapshot_id: snapshotId, row_count: sorted.length,
      block_height: meta.blockHeight, relay_height: meta.relayHeight,
      source_checksum: checksum.digest('hex'), computed_at: now,
    }],
    format: 'JSONEachRow',
  })
  const parts = await client.query({
    query: `SELECT DISTINCT partition FROM system.parts
      WHERE database='price_data' AND table='account_lock_snapshots' AND active AND partition!={snapshotId:String}`,
    query_params: { snapshotId }, format: 'JSONEachRow',
  })
  for (const row of await parts.json<{ partition: string }>()) {
    await client.command({
      query: `ALTER TABLE price_data.account_lock_snapshots DROP PARTITION {partition:String}`,
      query_params: { partition: row.partition },
    })
  }
}

// Read model for the account/tag balance endpoints: per display-relevant asset,
// the summed components for the requested account set plus the aggregate frozen
// amount (per-account max lock, then summed — locks overlap within an account
// but the maxima are additive across accounts).
export interface BalanceLockTranche { state: 'releasable' | 'scheduled' | 'active'; amount: string; until?: string; linear?: boolean }
export interface BalanceLockComponent { kind: BreakdownKind; source: string; amount: string; claimable?: string; tranches?: BalanceLockTranche[] }
// The account-set binding unlock timeline (see TimelineSlice): when how much of
// the frozen balance actually unlocks, and which lock causes it. `conditional`
// marks act-now durations (GIGAHDX staked → liquid 28d after unstaking now).
export interface BalanceUnlockSlice { state: 'releasable' | 'scheduled' | 'active'; cause: string; amount: string; until?: string; linear?: boolean; conditional?: boolean }
export interface AssetLockBreakdown { assetId: number; frozen: string; components: BalanceLockComponent[]; timeline?: BalanceUnlockSlice[] }

// Cap merged tranche lists (a tag can union many vesting end dates): keep the
// earliest releases distinct and fold the tail into the latest one.
const MAX_SCHEDULED_TRANCHES = 6

// Merge per-account binding timelines into one per asset (tags): releasable and
// open-ended slices add per cause; scheduled slices add per (release date,
// cause). Any frozen amount not covered by timeline rows stays open-ended.
export function mergeTimelines(details: string[], totalFrozen: bigint): BalanceUnlockSlice[] {
  const releasable = new Map<string, bigint>()
  const active = new Map<string, bigint>()
  const scheduled = new Map<string, { amount: bigint; linear: boolean; conditional: boolean }>()
  let covered = 0n
  for (const detail of details) {
    let parsed: { state: string; cause?: string; amount: string; until?: string; linear?: boolean; conditional?: boolean }[]
    try { parsed = JSON.parse(detail) } catch { continue }
    if (!Array.isArray(parsed)) continue
    for (const s of parsed) {
      const amount = BigInt(s.amount ?? '0')
      if (amount <= 0n) continue
      const cause = s.cause || 'other'
      covered += amount
      if (s.state === 'releasable') releasable.set(cause, (releasable.get(cause) ?? 0n) + amount)
      else if (s.state === 'scheduled' && s.until) {
        const key = `${s.until}|${cause}|${s.conditional ? 1 : 0}`
        const cur = scheduled.get(key) ?? { amount: 0n, linear: false, conditional: s.conditional === true }
        cur.amount += amount
        cur.linear = cur.linear || s.linear === true
        scheduled.set(key, cur)
      } else active.set(`${cause}|${s.until ?? ''}`, (active.get(`${cause}|${s.until ?? ''}`) ?? 0n) + amount)
    }
  }
  if (covered < totalFrozen) active.set('other|', (active.get('other|') ?? 0n) + (totalFrozen - covered))
  const byAmountDesc = (a: [string, bigint], b: [string, bigint]) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)
  const out: BalanceUnlockSlice[] = []
  for (const [cause, amount] of [...releasable.entries()].sort(byAmountDesc)) {
    out.push({ state: 'releasable', cause, amount: amount.toString() })
  }
  const dates = [...scheduled.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const kept = dates.slice(0, MAX_SCHEDULED_TRANCHES - 1)
  const tail = dates.slice(MAX_SCHEDULED_TRANCHES - 1)
  const keyParts = (key: string) => { const [until, cause] = key.split('|'); return { until, cause } }
  for (const [key, v] of kept) {
    const { until, cause } = keyParts(key)
    out.push({ state: 'scheduled', cause, amount: v.amount.toString(), until, ...(v.linear ? { linear: true } : {}), ...(v.conditional ? { conditional: true } : {}) })
  }
  if (tail.length) {
    const amount = tail.reduce((s, [, v]) => s + v.amount, 0n)
    const causes = [...new Set(tail.map(([k]) => keyParts(k).cause))].join('+')
    out.push({
      state: 'scheduled', cause: causes, amount: amount.toString(), until: keyParts(tail[tail.length - 1][0]).until,
      ...(tail.some(([, v]) => v.linear) ? { linear: true } : {}),
      ...(tail.every(([, v]) => v.conditional) ? { conditional: true } : {}),
    })
  }
  for (const [key, amount] of [...active.entries()].sort(byAmountDesc)) {
    const sep = key.indexOf('|')
    const cause = sep === -1 ? key : key.slice(0, sep)
    const until = sep === -1 ? '' : key.slice(sep + 1)
    out.push({ state: 'active', cause, amount: amount.toString(), ...(until ? { until } : {}) })
  }
  return out
}

// Merge per-account tranche lists into one per (asset, source): releasable and
// open-ended amounts add, scheduled amounts add per release date. Any component
// amount not covered by tranche rows stays open-ended rather than vanishing.
export function mergeTranches(details: string[], totalAmount: bigint): BalanceLockTranche[] {
  let releasable = 0n
  let active = 0n
  const scheduled = new Map<string, { amount: bigint; linear: boolean }>()
  let covered = 0n
  for (const detail of details) {
    let parsed: { state: string; amount: string; until?: string; linear?: boolean }[]
    try { parsed = JSON.parse(detail) } catch { continue }
    if (!Array.isArray(parsed)) continue
    for (const t of parsed) {
      const amount = BigInt(t.amount ?? '0')
      if (amount <= 0n) continue
      covered += amount
      if (t.state === 'releasable') releasable += amount
      else if (t.state === 'scheduled' && t.until) {
        const cur = scheduled.get(t.until) ?? { amount: 0n, linear: false }
        cur.amount += amount
        cur.linear = cur.linear || t.linear === true
        scheduled.set(t.until, cur)
      } else active += amount
    }
  }
  if (covered < totalAmount) active += totalAmount - covered
  const out: BalanceLockTranche[] = []
  if (releasable > 0n) out.push({ state: 'releasable', amount: releasable.toString() })
  const dates = [...scheduled.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const kept = dates.slice(0, MAX_SCHEDULED_TRANCHES - 1)
  const tail = dates.slice(MAX_SCHEDULED_TRANCHES - 1)
  for (const [until, v] of kept) out.push({ state: 'scheduled', amount: v.amount.toString(), until, ...(v.linear ? { linear: true } : {}) })
  if (tail.length) {
    const amount = tail.reduce((s, [, v]) => s + v.amount, 0n)
    const [lastUntil] = tail[tail.length - 1]
    out.push({ state: 'scheduled', amount: amount.toString(), until: lastUntil, ...(tail.some(([, v]) => v.linear) ? { linear: true } : {}) })
  }
  if (active > 0n) out.push({ state: 'active', amount: active.toString() })
  return out
}

export async function queryLockBreakdowns(client: ClickHouseClient, accountListSql: string): Promise<Map<number, AssetLockBreakdown>> {
  const active = `(SELECT argMax(snapshot_id, computed_at) FROM price_data.account_lock_snapshot_state WHERE snapshot_key='current')`
  const [componentsRes, frozenRes, detailRes] = await Promise.all([
    client.query({
      query: `
        SELECT asset_id, kind, source, toString(sum(amount)) AS amount, toString(sum(claimable)) AS claimable
        FROM price_data.account_lock_snapshots
        WHERE snapshot_id = ${active} AND account_id IN (${accountListSql}) AND kind != 'timeline'
        GROUP BY asset_id, kind, source`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
        SELECT asset_id, toString(sum(mx)) AS frozen FROM (
          SELECT account_id, asset_id, max(amount) AS mx
          FROM price_data.account_lock_snapshots
          WHERE snapshot_id = ${active} AND account_id IN (${accountListSql}) AND kind = 'lock'
          GROUP BY account_id, asset_id
        ) GROUP BY asset_id`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
        SELECT asset_id, kind, source, detail
        FROM price_data.account_lock_snapshots
        WHERE snapshot_id = ${active} AND account_id IN (${accountListSql}) AND kind IN ('lock', 'timeline') AND detail != ''`,
      format: 'JSONEachRow',
    }),
  ])
  const out = new Map<number, AssetLockBreakdown>()
  const entry = (assetId: number) => {
    const existing = out.get(assetId)
    if (existing) return existing
    const created: AssetLockBreakdown = { assetId, frozen: '0', components: [] }
    out.set(assetId, created)
    return created
  }
  const detailsBySource = new Map<string, string[]>()
  const timelineDetails = new Map<number, string[]>()
  for (const r of await detailRes.json<{ asset_id: string; kind: string; source: string; detail: string }>()) {
    if (r.kind === 'timeline') {
      const assetId = Number(r.asset_id)
      const list = timelineDetails.get(assetId)
      if (list) list.push(r.detail)
      else timelineDetails.set(assetId, [r.detail])
      continue
    }
    const key = `${r.asset_id}|${r.source}`
    const list = detailsBySource.get(key)
    if (list) list.push(r.detail)
    else detailsBySource.set(key, [r.detail])
  }
  for (const r of await componentsRes.json<{ asset_id: string; kind: BreakdownKind; source: string; amount: string; claimable: string }>()) {
    const details = r.kind === 'lock' ? detailsBySource.get(`${r.asset_id}|${r.source}`) : undefined
    const tranches = details?.length ? mergeTranches(details, BigInt(r.amount)) : undefined
    entry(Number(r.asset_id)).components.push({
      kind: r.kind, source: r.source, amount: r.amount,
      ...(r.claimable !== '0' ? { claimable: r.claimable } : {}),
      ...(tranches?.length ? { tranches } : {}),
    })
  }
  for (const r of await frozenRes.json<{ asset_id: string; frozen: string }>()) {
    entry(Number(r.asset_id)).frozen = r.frozen
  }
  for (const [assetId, details] of timelineDetails) {
    const e = entry(assetId)
    const timeline = mergeTimelines(details, BigInt(e.frozen))
    if (timeline.length) e.timeline = timeline
  }
  return out
}
