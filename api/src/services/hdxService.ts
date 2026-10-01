import type { ClickHouseClient } from '../db/client.ts'
import { blake2AsU8a } from '@polkadot/util-crypto'
import { u8aToHex, hexToU8a, u8aConcat } from '@polkadot/util'
import { rpc, substrateStorageBatch, substrateAllKeys } from './substrateRpc.ts'
import { storagePrefix, twox64Concat, u32At, u32Le, u128At } from './chainPrimitives.ts'
import { TREASURY_ACCOUNT } from './revenueStreams.ts'
import { decodeCompact } from './proxyMultisigService.ts'
import { collectLockBreakdownRows, gigaUnbondingBlocks, persistLockSnapshot, unvestedByAccountRaw, type LockRow, type VestingScheduleRaw } from './lockBreakdownService.ts'
import { cachedSwr } from './cache.ts'
import { NOMINAL_RELAY_BLOCK_MS, paraBlockMs } from './blockTime.ts'
import { allTags, economicModuleAccounts } from './tagService.ts'
import { accountRef, bindCteSql, boundAccountSql, ensurePrices, cutoffHeightForWindow, getGigaMarketStats, getGigaLiquidationLevels, type AccountRef, type GigaMarketReserveStat, type GigaLiquidations } from './explorerService.ts'
import { alignToGrid, carryForwardValues, fullChartGrid, MAX_HEIGHT, serveChartWindow, type ChartGrid, type ChartWindowRequest, type ChartWindowResponse } from './chartWindow.ts'
import { DAILY_GRAIN, grainBucketEndSec, keySeconds, makeGrain, MONTHLY_GRAIN, WEEKLY_MONDAY_GRAIN } from './historyGrain.ts'
import { MONDAY_ANCHOR_SEC } from './bucketLadder.ts'

export { gigaUnbondingBlocks }

// HDX-dashboard chain snapshots: balance locks by lock id, GIGAHDX pending
// unstakes, vesting schedules and conviction-voting prior locks — everything the
// unlock timeline needs. Enumerations run in a background refresh (the largest,
// Balances.Locks, is ~18k entries ≈ a few seconds of chunked reads); request
// handlers only read the in-memory snapshot.

let client: ClickHouseClient

const HDX_DECIMALS = 12n

const LOCKS_PREFIX = storagePrefix('Balances', 'Locks')
const PENDING_UNSTAKES_PREFIX = storagePrefix('GigaHdx', 'PendingUnstakes')
const VESTING_PREFIX = storagePrefix('Vesting', 'VestingSchedules')
const VOTING_FOR_PREFIX = storagePrefix('ConvictionVoting', 'VotingFor')
const RELAY_HEIGHT_KEY = storagePrefix('ParachainSystem', 'LastRelayChainBlockNumber')
const TWO_SEC_SWITCH_KEY = storagePrefix('Parameters', 'TwoSecBlocksSince')
// The three single keys behind the GIGAHDX exchange rate (see loadGigahdxRate).
// The pallet calls the staked total `TotalLocked`, not `TotalStaked` — a wrong
// name here is a key that simply does not exist, which reads as an empty value
// rather than an error, so the test pins the derived key itself.
const GIGA_TOTAL_LOCKED_KEY = storagePrefix('GigaHdx', 'TotalLocked')
const STHDX_ASSET_ID = 670
// Tokens.TotalIssuance is Twox64Concat-keyed on the SCALE (little-endian) asset id.
const STHDX_ISSUANCE_KEY = u8aToHex(u8aConcat(
  hexToU8a(storagePrefix('Tokens', 'TotalIssuance')), twox64Concat(u32Le(STHDX_ASSET_ID)),
))
const GIGA_POT_ACCOUNT = (() => {
  const p = u8aConcat(new TextEncoder().encode('modl'), new TextEncoder().encode('gigahdx!'))
  return u8aConcat(p, new Uint8Array(32 - p.length))
})()
const GIGA_POT_ACCOUNT_KEY = u8aToHex(u8aConcat(
  hexToU8a(storagePrefix('System', 'Account')), blake2AsU8a(GIGA_POT_ACCOUNT, 128), GIGA_POT_ACCOUNT,
))

// Full SCALE compact<u128> (vesting perPeriod can exceed the 4-byte form).
export function decodeCompactBig(b: Uint8Array, off: number): [bigint, number] {
  if (!Number.isInteger(off) || off < 0 || off >= b.length) {
    throw new RangeError('truncated SCALE compact integer')
  }
  const mode = b[off] & 3
  if (mode === 0) return [BigInt(b[off] >> 2), off + 1]
  if (mode === 1) {
    if (off + 2 > b.length) throw new RangeError('truncated SCALE compact integer')
    return [BigInt((b[off] | (b[off + 1] << 8)) >>> 2), off + 2]
  }
  if (mode === 2) {
    if (off + 4 > b.length) throw new RangeError('truncated SCALE compact integer')
    return [BigInt((b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 2), off + 4]
  }
  const len = (b[off] >> 2) + 4
  if (off + 1 + len > b.length) throw new RangeError('truncated SCALE compact integer')
  let n = 0n
  for (let i = len - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[off + 1 + i])
  return [n, off + 1 + len]
}

export interface LockTypeTotal { id: string; accounts: number; totalHdx: number }
export interface PendingUnstake { accountId: string; startBlock: number; expiryBlock: number; payoutHdx: number; payoutRaw: bigint }
// The orml-vesting schedule shape both this dashboard and the per-account lock
// breakdown decode; one declaration so the two cannot drift.
export type VestingScheduleAgg = VestingScheduleRaw
// Per-account lock overlap in raw planck: the largest non-vesting lock and the
// ormlvest amount (which goes stale between claims — see correctVestingLocks).
export interface LockAccount { maxNonVestRaw: bigint; vestLockRaw: bigint }
// One entry per account holding a pyconvot lock, classified so the vote-lock
// totals across "unlockable now" / scheduled / undetermined sum EXACTLY to the
// authoritative Balances.Locks pyconvot amount (per-entry prior locks overlap
// across classes and with active votes, so they must not be summed directly).
export interface VoteLockAccount { hdx: number; maxUnlockBlock: number; hasActive: boolean }

interface HdxChainSnapshot {
  at: number
  relayHeight: number                // relay block at snapshot time (vesting runs on relay blocks)
  lockTypes: LockTypeTotal[]
  lockAccounts: Map<string, LockAccount>
  pendingUnstakes: PendingUnstake[]
  vestingSchedules: VestingScheduleAgg[]
  voteLockAccounts: VoteLockAccount[]
  gigahdxHdxPerShare: number          // HDX backing one stHDX (see loadGigahdxRate)
  // One entry per account that has a binding unlock timeline. Empty when the
  // breakdown pass failed — the unlock series then falls back to per-source.
  timelines: TimelineSliceJson[][]
}

let snapshot: HdxChainSnapshot | null = null

const toHdx = (raw: bigint) => Number(raw / 10n ** (HDX_DECIMALS - 4n)) / 1e4
// An exact planck sum as the wire's HDX number: converted ONCE from its decimal
// string, so the figure is the double nearest the exact total — never a float sum
// of per-entry roundings (125 pending unstakes summed via toHdx lost 0.0066 HDX
// and printed as 18680902.217899997).
export const hdxNumberFromRaw = (raw: bigint): number => {
  const unit = 10n ** HDX_DECIMALS
  const neg = raw < 0n, a = neg ? -raw : raw
  return Number(`${neg ? '-' : ''}${a / unit}.${(a % unit).toString().padStart(Number(HDX_DECIMALS), '0')}`)
}

// The unlock series the dashboard charts. One key per lock kind that has its
// own schedule, plus `other` for everything else the binding timeline can
// attribute a drop to — `staking`, `democracy`, `elections`, `sufficiency`, and
// any lock id LOCK_ID_SOURCES does not map, which passes through verbatim.
// Those have no schedule of their own, but the envelope they hold is real: with
// nowhere to put them their slices were dropped, and the series stopped summing
// to the envelope it is an attribution of.
export type UnlockKey = 'gigahdx' | 'vesting' | 'vote' | 'other'
// A binding-timeline slice names the lock(s) that were holding the balance when
// the envelope dropped, joining ties with '+'. Attribute a tie to the DATED
// lock that actually gates the release: a conviction prior and a GIGAHDX unbond
// covering the same tokens both have to elapse, but it is the later-clearing
// dated one that decides when the balance moves, and `vote` is the one cause
// here that can also be cleared on demand. Splitting the amount across keys
// would invent a division the envelope does not have.
const UNLOCK_KEY_PRIORITY: UnlockKey[] = ['gigahdx', 'vesting', 'vote']
export function unlockKeyForCause(cause: string): UnlockKey {
  const parts = new Set(cause.split('+'))
  return UNLOCK_KEY_PRIORITY.find(k => parts.has(k)) ?? 'other'
}

// Persisted form of one binding-timeline slice (serializeTimeline in
// lockBreakdownService): amount in planck, `until` an ISO instant.
// `conditional` marks a step that only exists if the holder acts first — the
// ghdxlock source projects one for the still-STAKED portion ("if this holder
// unstaked now, it frees one cooldown from now"). No such unstake has been
// requested, so it is a hypothetical, not a pending unlock.
export interface TimelineSliceJson { state: string; cause: string; amount: string; until?: string; conditional?: boolean; linear?: boolean }
export interface UnlockSeries {
  now: Record<UnlockKey, number>          // already releasable (no date to wait for)
  buckets: Record<UnlockKey, number>[]    // one per time bucket, same order as `buckets`
  later: Record<UnlockKey, number>        // dated beyond the last bucket
  active: Record<UnlockKey, number>       // open-ended: no date until the holder acts
}

// Aggregate per-account BINDING timelines into the dashboard's unlock series.
//
// Locks overlap — they all bite the same free balance — so a lock's own
// schedule overstates what it releases: a matured GIGAHDX unbond frees nothing
// while an equal conviction prior still binds the same tokens. Summing each
// lock source independently double-counts exactly that. buildBindingTimeline
// already walks the max-envelope per account and attributes each drop to a
// cause, so aggregating ITS slices is what makes the chart show only unlocks
// that really result in an unlock.
export function unlockSeriesFromTimelines(
  timelines: TimelineSliceJson[][],
  buckets: { from: number; to: number }[],
  nowMs: number,
): UnlockSeries {
  const zero = (): Record<UnlockKey, number> => ({ gigahdx: 0, vesting: 0, vote: 0, other: 0 })
  const out: UnlockSeries = { now: zero(), buckets: buckets.map(() => zero()), later: zero(), active: zero() }
  const horizon = buckets.length ? buckets[buckets.length - 1].to : nowMs
  for (const slices of timelines) {
    // A LINEAR slice (vesting) releases continuously from the previous dated
    // step (or now) to its own date — the timeline stores it as one slice at
    // the END so overlap attribution stays exact, but charting it as a point
    // mass would pile a whole schedule into the final bucket. Track the
    // segment start as the walk's previous step and spread linear amounts
    // over their span, proportionally to each bucket's overlap.
    let segStart = nowMs
    for (const s of slices) {
      // Hypothetical steps are not upcoming unlocks: live, 573 conditional
      // GIGAHDX slices carried 502M HDX — 23x the entire pending pool — and
      // would have swamped the real series with stake nobody has moved.
      if (s.conditional) continue
      const key = unlockKeyForCause(s.cause)
      const hdx = toHdx(BigInt(s.amount))
      if (hdx <= 0) continue
      if (s.state === 'active') { out.active[key] += hdx; continue }
      // A releasable slice, and any dated one whose date has already passed,
      // needs no waiting — both belong in the "now" column.
      const ts = s.until ? Date.parse(s.until) : nowMs
      if (s.state === 'releasable' || ts <= nowMs) { out.now[key] += hdx; continue }
      const from = Math.max(nowMs, Math.min(segStart, ts))
      if (s.until) segStart = ts
      if (s.linear && ts - from > 0) {
        const span = ts - from
        for (const [i, b] of buckets.entries()) {
          const overlap = Math.min(b.to, ts) - Math.max(b.from, from)
          if (overlap > 0) out.buckets[i][key] += hdx * (overlap / span)
        }
        const tail = ts - Math.max(from, horizon)
        if (tail > 0) out.later[key] += hdx * (tail / span)
        continue
      }
      if (ts >= horizon) { out.later[key] += hdx; continue }
      const i = buckets.findIndex(b => ts >= b.from && ts < b.to)
      if (i >= 0) out.buckets[i][key] += hdx
      else out.later[key] += hdx
    }
  }
  return out
}

// Balances.Locks value: Vec<{id: [u8;8], amount: u128, reasons: u8}>. Keeps the
// raw per-account rows too — they feed the per-account breakdown snapshot.
async function loadLocks(): Promise<{ lockTypes: LockTypeTotal[]; lockAccounts: Map<string, LockAccount>; voteLockByAccount: Map<string, number>; rows: LockRow[] } | null> {
  const keys = await substrateAllKeys(LOCKS_PREFIX)
  if (!keys.length) return null
  const values = await substrateStorageBatch(keys)
  if (!values.some(Boolean)) return null
  const byId = new Map<string, { accounts: number; total: bigint }>()
  const voteLockByAccount = new Map<string, number>()
  const lockAccounts = new Map<string, LockAccount>()
  const rows: LockRow[] = []
  for (let ki = 0; ki < keys.length; ki++) {
    const raw = values[ki]
    if (!raw) continue
    const accountId = '0x' + keys[ki].slice(-64) // Blake2_128Concat tail
    const b = hexToU8a(raw)
    let [len, off] = decodeCompact(b, 0)
    let maxNonVest = 0n
    let vestLock = 0n
    for (let i = 0; i < len && off + 25 <= b.length; i++) {
      const id = Buffer.from(b.slice(off, off + 8)).toString('latin1').replace(/\0+$/, '')
      const amount = u128At(b, off + 8)
      off += 25
      rows.push({ accountId, id, amount })
      const e = byId.get(id) ?? { accounts: 0, total: 0n }
      e.accounts++
      e.total += amount
      byId.set(id, e)
      if (id === 'ormlvest') vestLock += amount
      else if (amount > maxNonVest) maxNonVest = amount
      if (id === 'pyconvot') voteLockByAccount.set(accountId, toHdx(amount))
    }
    lockAccounts.set(accountId, { maxNonVestRaw: maxNonVest, vestLockRaw: vestLock })
  }
  const lockTypes = [...byId.entries()]
    .map(([id, e]) => ({ id, accounts: e.accounts, totalHdx: toHdx(e.total) }))
    .sort((a, b) => b.totalHdx - a.totalHdx)
  return { lockTypes, lockAccounts, voteLockByAccount, rows }
}

// When a pending unstake matures — an exact port of
// `pallet_gigahdx::Pallet::cooldown_expires_at`.
//
// `GigaHdx.PendingUnstakes` stores only (account, startBlock) → amount. The
// maturity block is not stored anywhere: the runtime recomputes it on every
// `unlock`, so this has to reproduce that arithmetic rather than guess it.
//
// Three readings are wrong, and each looks plausible:
//   - `startBlock + CooldownPeriod` — right only for positions opened after the
//     switch. Runtime 440 tripled the constant (403,200 → 1,209,600) when slot
//     time went 6s → 2s, so applying today's value to an older position adds
//     806,400 phantom blocks.
//   - `startBlock + 403,200` (the old constant) — matures too early.
//   - the `expiresAt` recorded in the `GigaHdx.Unstaked` event — computed under
//     the old rule at request time, and STALE for any position straddling the
//     switch. It is the trap that looks most authoritative.
//
// What the runtime actually does is preserve the remaining WALL-CLOCK cooldown:
// the blocks still outstanding at the switch are tripled, because blocks now
// arrive three times as fast.
//
// `switchBlock` is `parameters.twoSecBlocksSince` (a storage value, not a
// metadata constant); `u32::MAX` is its unset sentinel, meaning no switch has
// happened and the plain cooldown applies.
//
// The pre-switch half of that arithmetic is a fixed historical fact — 28 days
// of 6s blocks — not a derivation of today's constant. Deriving it (as
// `cooldownBlocks / 3`) would hard-wire "the current value is exactly triple
// the old one", so a `GIGA_UNBONDING_BLOCKS` override or a later governance
// change to the cooldown would misdate every straddling position.
const PRE_TWO_SEC_COOLDOWN_BLOCKS = 403_200

export function cooldownExpiresAt(startBlock: number, switchBlock: number, cooldownBlocks: number): number {
  if (switchBlock === 0xFFFFFFFF || startBlock >= switchBlock) return startBlock + cooldownBlocks
  const oldExpiresAt = startBlock + PRE_TWO_SEC_COOLDOWN_BLOCKS
  if (oldExpiresAt <= switchBlock) return oldExpiresAt
  return switchBlock + (oldExpiresAt - switchBlock) * 3
}

export function withCooldownExpiries(
  positions: PendingUnstake[],
  switchBlock: number,
  cooldownBlocks: number,
): PendingUnstake[] {
  return positions
    .map(p => ({ ...p, expiryBlock: cooldownExpiresAt(p.startBlock, switchBlock, cooldownBlocks) }))
    // Straddling positions have their remainders tripled, so start order no
    // longer implies maturity order. Callers read the head as the next unlock.
    .sort((a, b) => a.expiryBlock - b.expiryBlock)
}

// `parameters.twoSecBlocksSince` — the block the 6s → 2s switch landed on.
// Unset reads as the u32::MAX sentinel, which cooldownExpiresAt handles.
async function loadTwoSecSwitchBlock(): Promise<number | null> {
  const [raw] = await substrateStorageBatch([TWO_SEC_SWITCH_KEY])
  if (!raw) return 0xFFFFFFFF // storage empty ⇒ the pallet's own default
  return u32At(hexToU8a(raw), 0)
}

// GigaHdx.PendingUnstakes: double map Blake2_128Concat(account) →
// Twox64Concat(positionId u32) → payout u128. The position id is the unstake's
// parachain start block.
async function loadPendingUnstakes(switchBlock: number): Promise<PendingUnstake[] | null> {
  const keys = await substrateAllKeys(PENDING_UNSTAKES_PREFIX)
  const values = await substrateStorageBatch(keys)
  const out: PendingUnstake[] = []
  for (let i = 0; i < keys.length; i++) {
    const raw = values[i]
    if (!raw) continue
    const k = keys[i]
    // key tail: blake2_128(16B) + account(32B) + twox64(8B) + positionId(4B LE)
    const tail = hexToU8a('0x' + k.slice(66))
    if (tail.length < 60) continue
    const accountId = u8aToHex(tail.slice(16, 48))
    const startBlock = u32At(tail, 56)
    const payout = u128At(hexToU8a(raw), 0)
    out.push({ accountId, startBlock, expiryBlock: 0, payoutHdx: toHdx(payout), payoutRaw: payout })
  }
  return keys.length && !out.length ? null : withCooldownExpiries(out, switchBlock, gigaUnbondingBlocks())
}

// Vesting.VestingSchedules: Vec<{start u32, period u32, periodCount u32,
// perPeriod Compact<u128>}> (orml-vesting). start/period count RELAY CHAIN
// blocks, not parachain blocks: Hydration configures the pallet with the relay
// block provider, so schedule progress must use the indexed relay height.
async function loadVesting(): Promise<VestingScheduleAgg[] | null> {
  const keys = await substrateAllKeys(VESTING_PREFIX)
  if (!keys.length) return null
  const values = await substrateStorageBatch(keys)
  if (!values.some(Boolean)) return null
  const schedules: VestingScheduleAgg[] = []
  for (let ki = 0; ki < keys.length; ki++) {
    const raw = values[ki]
    if (!raw) continue
    const accountId = '0x' + keys[ki].slice(-64) // Blake2_128Concat tail
    const b = hexToU8a(raw)
    try {
      let [n, off] = decodeCompact(b, 0)
      for (let i = 0; i < n; i++) {
        const start = u32At(b, off)
        const period = u32At(b, off + 4)
        const periodCount = u32At(b, off + 8)
        const [perPeriod, next] = decodeCompactBig(b, off + 12)
        off = next
        if (period > 0 && periodCount > 0 && perPeriod > 0n) schedules.push({ accountId, start, period, periodCount, perPeriod })
      }
    } catch { /* skip malformed */ }
  }
  return schedules
}

// The ormlvest lock amount only shrinks when vesting.claim runs, so for
// accounts that never claim it still contains HDX whose periods have already
// elapsed (vested, merely unclaimed). Recompute the vesting figures from the
// schedules at the current RELAY height (the pallet's block provider): only
// future periods count as locked. The per-account max (locks overlap on the
// same balance) uses the corrected vesting amount, capped by the actual lock
// in case a claim raced the snapshot.
export function correctVestingLocks(
  lockAccounts: Map<string, LockAccount>,
  schedules: VestingScheduleAgg[],
  relayHeight: number,
): { vestingAccounts: number; vestingHdx: number; vestedUnclaimedHdx: number; totalLockedHdx: number } {
  const unvestedByAccount = unvestedByAccountRaw(schedules, relayHeight)
  let vestingAccounts = 0
  let vestingRaw = 0n, vestedUnclaimedRaw = 0n, totalLockedRaw = 0n
  for (const [accountId, l] of lockAccounts) {
    const scheduled = unvestedByAccount.get(accountId) ?? 0n
    const unvested = scheduled < l.vestLockRaw ? scheduled : l.vestLockRaw
    if (unvested > 0n) { vestingAccounts++; vestingRaw += unvested }
    vestedUnclaimedRaw += l.vestLockRaw - unvested
    totalLockedRaw += l.maxNonVestRaw > unvested ? l.maxNonVestRaw : unvested
  }
  return {
    vestingAccounts,
    vestingHdx: toHdx(vestingRaw),
    vestedUnclaimedHdx: toHdx(vestedUnclaimedRaw),
    totalLockedHdx: toHdx(totalLockedRaw),
  }
}

// ConvictionVoting.VotingFor: Casting{votes: Vec<(poll u32, AccountVote)>,
// delegations{votes u128, capital u128}, prior(unlockAt u32, balance u128)} |
// Delegating{balance u128, target 32B, conviction u8, delegations, prior}.
// Returns per-ACCOUNT the per-CLASS lock state: the open-ended amount held by
// active votes/delegations, the date-bound prior lock, and whether anything is
// still actively voting. The dashboard merges these across classes; the
// per-account breakdown decomposes the pyconvot lock into duration tranches
// from the same data (see voteLockTranches).
export interface VoteClassState { activeAmount: bigint; hasActiveVotes: boolean; priorUnlock: number; priorBalance: bigint }
async function loadVoteLocks(): Promise<Map<string, VoteClassState[]> | null> {
  const keys = await substrateAllKeys(VOTING_FOR_PREFIX)
  if (!keys.length) return null
  const values = await substrateStorageBatch(keys)
  if (!values.some(Boolean)) return null
  const byAccount = new Map<string, VoteClassState[]>()
  for (let ki = 0; ki < keys.length; ki++) {
    const raw = values[ki]
    if (!raw) continue
    // Key tail: twox64(8B) + account(32B) + twox64(8B) + class(u16) — account at [8..40).
    const tail = hexToU8a('0x' + keys[ki].slice(66))
    if (tail.length < 40) continue
    const accountId = u8aToHex(tail.slice(8, 40))
    const b = hexToU8a(raw)
    const state: VoteClassState = { activeAmount: 0n, hasActiveVotes: false, priorUnlock: 0, priorBalance: 0n }
    try {
      if (b[0] === 0) { // Casting
        let [n, off] = decodeCompact(b, 1)
        if (n > 0) state.hasActiveVotes = true
        for (let i = 0; i < n; i++) {
          off += 4 // poll index
          const kind = b[off]; off += 1
          // The class lock covers the largest single vote (locks overlap within
          // a class); Split/SplitAbstain lock the sum of their parts.
          const amount = kind === 0 ? u128At(b, off + 1)
            : kind === 1 ? u128At(b, off) + u128At(b, off + 16)
            : u128At(b, off) + u128At(b, off + 16) + u128At(b, off + 32)
          if (amount > state.activeAmount) state.activeAmount = amount
          off += kind === 0 ? 17 : kind === 1 ? 32 : 48
        }
        off += 32 // delegations (votes, capital)
        if (u128At(b, off + 4) > 0n) { state.priorUnlock = u32At(b, off); state.priorBalance = u128At(b, off + 4) }
      } else if (b[0] === 1) { // Delegating
        const balance = u128At(b, 1)
        if (balance > 0n) { state.hasActiveVotes = true; state.activeAmount = balance }
        const off = 1 + 16 + 32 + 1 + 32
        if (u128At(b, off + 4) > 0n) { state.priorUnlock = u32At(b, off); state.priorBalance = u128At(b, off + 4) }
      } else continue
    } catch { continue }
    const list = byAccount.get(accountId)
    if (list) list.push(state)
    else byAccount.set(accountId, [state])
  }
  return byAccount
}

/**
 * HDX backing one stHDX (GIGAHDX), read from three single storage keys.
 *
 * Staked HDX is held in two places: `GigaHdx.TotalLocked`, and the gigahdx!
 * pot, which carries what has accrued to stakers but has not been folded into
 * the total yet. Both back the same receipts, so the rate is their sum over the
 * stHDX issuance — leaving the pot out prices stHDX ~0.26% low.
 *
 * Above 1 and rising: a receipt is worth more HDX the longer the pool earns.
 * (Quoted the other way round — GIGAHDX per HDX — it reads just under 1.)
 */
export async function loadGigahdxRate(at?: string): Promise<number | null> {
  const [staked, pot, issuance] = await substrateStorageBatch([
    GIGA_TOTAL_LOCKED_KEY, GIGA_POT_ACCOUNT_KEY, STHDX_ISSUANCE_KEY,
  ], at)
  if (!staked || !issuance) return null
  const issued = u128At(hexToU8a(issuance), 0)
  if (issued <= 0n) return null
  // AccountInfo: nonce/consumers/providers/sufficients (4 × u32), then free.
  const potFree = pot ? u128At(hexToU8a(pot), 16) : 0n
  const rate = Number(u128At(hexToU8a(staked), 0) + potFree) / Number(issued)
  // Floored at 1 exactly as the pallet's `exchange_rate()` floors it — a sub-1
  // reading is only reachable through privileged drains, and the chain does not
  // let that artefact into pricing math either. The upper bound is the sanity
  // check: the pool has never doubled, so anything past it is a bad decode.
  if (!Number.isFinite(rate) || rate >= 2) return null
  return Math.max(1, rate)
}

// How far back the staking rate's growth is read. Long enough to smooth the
// fee share's day-to-day swing, short enough to follow the treasury drip when it
// steps down (see GIGAHDX_BASE_MIN_DAYS for a young history).
const GIGAHDX_BASE_WINDOW_DAYS = 30
const GIGAHDX_BASE_MIN_DAYS = 7
// GIGAHDX staking launched here (2026-07-01); no rate exists before it.
const GIGAHDX_LAUNCH_BLOCK = 12_959_351

/**
 * What holding GIGAHDX (stHDX) earns by itself, before any voting reward: the
 * growth of its exchange rate (loadGigahdxRate) over the trailing
 * GIGAHDX_BASE_WINDOW_DAYS, annualised simple — the same reading the token yield
 * of every other yield-bearing token gets (positionYield's tokenAccrualAprs). The
 * rate lifts as the gigahdx! pot takes the treasury drip and its trade-fee share,
 * so this is the realised passive yield; the voting reward (gigarwd!) is paid out
 * per referendum and depends on how one votes, so it is not part of it.
 * A fraction per year; null when either end cannot be read (the archive node is
 * needed for the past one) or the window is too young.
 */
export function gigahdxBaseApr(client: ClickHouseClient): Promise<{ apr: number; days: number } | null> {
  return cachedSwr('explorer:gigahdx-base-apr', 3_600_000, 48 * 3_600_000, async () => {
    const res = await client.query({
      query: `WITH (SELECT max(block_height) FROM price_data.blocks) AS head
              SELECT b1.block_height AS h1, toUnixTimestamp(b1.block_timestamp) AS t1, b0.block_height AS h0, toUnixTimestamp(b0.block_timestamp) AS t0
              FROM (SELECT block_height, block_timestamp FROM price_data.blocks WHERE block_height = head) AS b1
              CROSS JOIN (
                SELECT block_height, block_timestamp FROM price_data.blocks
                WHERE block_timestamp >= (SELECT block_timestamp FROM price_data.blocks WHERE block_height = head) - INTERVAL {days:UInt32} DAY
                  AND block_height >= {launch:UInt32}
                ORDER BY block_height LIMIT 1
              ) AS b0`,
      query_params: { days: GIGAHDX_BASE_WINDOW_DAYS, launch: GIGAHDX_LAUNCH_BLOCK },
      format: 'JSONEachRow',
    })
    const [row] = await res.json<{ h1: number; t1: number; h0: number; t0: number }>()
    if (!row) return null
    const dt = Number(row.t1) - Number(row.t0)
    if (dt < GIGAHDX_BASE_MIN_DAYS * 86_400) return null
    const [hash1, hash0] = await Promise.all([rpc<string>('chain_getBlockHash', [Number(row.h1)]), rpc<string>('chain_getBlockHash', [Number(row.h0)])])
    if (!hash1 || !hash0) return null
    const [r1, r0] = await Promise.all([loadGigahdxRate(hash1), loadGigahdxRate(hash0)])
    if (r1 == null || r0 == null || !(r1 >= r0)) return null
    return { apr: (r1 / r0 - 1) * (365 * 86_400) / dt, days: dt / 86_400 }
  })
}

// ParachainSystem.LastRelayChainBlockNumber: plain u32 — the relay block the
// current parachain head was built against.
async function loadRelayHeight(): Promise<number | null> {
  const [raw] = await substrateStorageBatch([RELAY_HEIGHT_KEY])
  if (!raw) return null
  return u32At(hexToU8a(raw), 0)
}

async function refresh(): Promise<void> {
  const switchBlock = await loadTwoSecSwitchBlock()
  const [locks, pending, vesting, votes, relayHeight, gigahdxRate] = await Promise.all([
    loadLocks(),
    switchBlock == null ? Promise.resolve(null) : loadPendingUnstakes(switchBlock),
    loadVesting(), loadVoteLocks(), loadRelayHeight(), loadGigahdxRate(),
  ])
  if (!locks || !pending || !vesting || !votes || relayHeight == null || gigahdxRate == null) {
    if (!snapshot) console.error('[hdx] chain snapshot incomplete, retrying next cycle')
    return // keep last good snapshot
  }
  // Classify each account's authoritative pyconvot lock amount exactly once.
  const voteLockAccounts: VoteLockAccount[] = []
  for (const [accountId, hdx] of locks.voteLockByAccount) {
    const classes = votes.get(accountId) ?? []
    voteLockAccounts.push({
      hdx,
      maxUnlockBlock: classes.reduce((m, c) => Math.max(m, c.priorBalance > 0n ? c.priorUnlock : 0), 0),
      hasActive: classes.some(c => c.hasActiveVotes),
    })
  }
  // Per-account breakdown rows. The account/tag balance pages read these from
  // ClickHouse, and the dashboard's unlock series is aggregated from the
  // per-account BINDING timelines among them — a lock's own schedule overstates
  // what it frees when another lock covers the same tokens.
  //
  // Failures keep the previous published generation, and leave `timelines`
  // empty so the dashboard falls back to the per-source series below rather
  // than reporting no unlocks at all.
  let timelines: TimelineSliceJson[][] = []
  try {
    const [head, paraMs] = await Promise.all([loadHead(), paraBlockMs(client)])
    const rows = await collectLockBreakdownRows({
      nativeLockRows: locks.rows,
      vestingSchedules: vesting,
      relayHeight,
      voteStates: votes,
      pendingUnstakes: pending.map(p => ({ accountId: p.accountId, expiryBlock: p.expiryBlock, payoutRaw: p.payoutRaw })),
      headBlock: head.height,
      headTsMs: head.ts,
      paraBlockMs: paraMs,
    })
    timelines = rows
      .filter(r => r.kind === 'timeline' && r.detail)
      .map(r => { try { return JSON.parse(r.detail) as TimelineSliceJson[] } catch { return [] } })
      .filter(s => s.length > 0)
    const outcome = await persistLockSnapshot(client, rows, { blockHeight: head.height, relayHeight })
    console.info('[hdx] lock breakdown', { rows: rows.length, timelines: timelines.length, outcome })
  } catch (err) {
    console.error('[hdx] lock breakdown snapshot failed', err)
  }
  snapshot = {
    at: Date.now(),
    relayHeight,
    lockTypes: locks.lockTypes,
    lockAccounts: locks.lockAccounts,
    pendingUnstakes: pending,
    vestingSchedules: vesting,
    voteLockAccounts,
    gigahdxHdxPerShare: gigahdxRate,
    timelines,
  }
}

let refreshInflight: Promise<void> | null = null

// The coordinated background scheduler (backgroundRefresh.ts) owns the cadence
// and serializes this against the other node-full refreshers; here we only keep
// the single-flight guard so a re-entrant call collapses onto the in-flight run.
export function refreshHdxSnapshot(): Promise<void> {
  if (refreshInflight) return refreshInflight
  const request = refresh()
    .catch(err => console.error('[hdx] refresh failed', err))
    .finally(() => { if (refreshInflight === request) refreshInflight = null })
  refreshInflight = request
  return request
}

export function initHdxService(c: ClickHouseClient): void {
  client = c
}

// dashboard payload (ClickHouse aggregates + chain snapshot)

export interface HdxCohort { key: string; label: string; minPct: number; minHdx: number; accounts: number; totalHdx: number }
export interface HdxUnlockBucket { label: string; fromTs: string; toTs: string; gigahdx: number; vesting: number; vote: number; other: number }
export interface HdxDailyFlow { date: string; buyHdx: number; sellHdx: number; buyers: number; sellers: number }
export interface HdxMover { account: AccountRef; balanceHdx: number; boughtHdx: number; soldHdx: number; netHdx: number }

// Full-era weekly series behind the "Who holds HDX" and "Holder loyalty"
// charts. Classes: the Treasury account, protocol plumbing (module accounts
// and tagged pool/reserve accounts), Kraken custody (its tagged hot wallets),
// and everyone else ("users"). User tranches, the Lorenz curves and the HODL
// age bands rank ONLY the user class.
export interface HdxStructure {
  weeks: string[]                       // contiguous Mondays, whole balance-observation era
  ownership: {
    treasury: number[]; protocol: number[]; kraken: number[]
    top10: number[]; top11to100: number[]; top101to1000: number[]; rest: number[]
  }
  effectiveHolders: number[]            // 1 / HHI over user balances — "equivalent equal holders"
  hodl: { under3m: number[]; m3to12: number[]; y1to2: number[]; over2y: number[] } // user HDX by holder age
  // HDX of later allocation-realization mints counted into the treasury /
  // protocol bands from the series start (0 when none happened yet).
  backfilledAllocationHdx: number
  // Monthly full-era trend series (grid = last day of each month since the
  // balance-observation era began; null where a series hasn't started yet):
  // staking sinks and the liquid float they leave, the market's aggregate
  // cost basis vs price, whale share, Kraken custody, the treasury's
  // cumulative buyback, and participation (traders monthly, governance
  // capital quarterly on its own grid).
  trends: {
    months: string[]
    stakedClassic: (number | null)[]    // HDX under the classic staking pallet (cumulative)
    stakedGiga: (number | null)[]       // HDX under GIGAHDX (cumulative)
    liquidFloat: (number | null)[]      // user-held supply minus staked (both stay in user balances — staking locks, it doesn't transfer)
    realizedPrice: (number | null)[]    // aggregate cost basis of user-held HDX, USD
    marketPrice: (number | null)[]      // monthly close, USD
    top100Share: (number | null)[]      // top-100 user wallets' share of user-held supply, %
    krakenHdx: (number | null)[]        // tagged Kraken custody balance
    buybackHdx: (number | null)[]       // cumulative HDX the treasury bought via its DCA buybacks
    traders: (number | null)[]          // unique non-module accounts trading HDX that month
    gov: { quarters: string[]; capital: number[]; voters: number[] } // per-quarter max-vote capital + unique voters
  }
}

export interface HdxDashboard {
  price: number | null
  change24h: number | null
  supply: { totalHdx: number; protocolHdx: number; userHdx: number; holders: number }
  cohorts: HdxCohort[]
  locks: {
    types: { key: string; label: string; accounts: number; totalHdx: number }[]
    totalLockedHdx: number
    lockedPctOfUser: number
    // HDX whose vesting periods already elapsed but that no one claimed yet —
    // still under an ormlvest lock on-chain, excluded from the figures above.
    vestedUnclaimedHdx: number
    snapshotAt: string | null
  }
  unlocks: {
    buckets: HdxUnlockBucket[]
    laterHdx: Record<UnlockKey, number>
    unlockableNowHdx: number
    // Releasable right now, split by the lock that held it — the leading "now"
    // column. Sums to unlockableNowHdx.
    nowHdx: Record<UnlockKey, number>
    activeVoteHdx: number
    stakingAnytimeHdx: number
    gigaPending: {
      count: number; totalHdx: number; nextUnlockTs: string | null
      // Positions past their cooldown (claimable with an unlock call).
      maturedCount: number; maturedHdx: number
    }
  }
  flows: {
    daily: HdxDailyFlow[]
    dca: { buy: { orders: number; hdxPerDay: number }; sell: { orders: number; hdxPerDay: number } }
  }
  churn: { weekly: { weekStart: string; newHolders: number; exitedHolders: number }[] }
  structure: HdxStructure
  topMovers: { accumulators: HdxMover[]; distributors: HdxMover[] }
  // GIGAHDX money-market reserves (stHDX collateral, HOLLAR borrows); null
  // until the aToken anchor exists or when the market isn't deployed.
  gigaMarket: GigaMarketReserveStat[] | null
  // Per-borrower liquidation levels for the stHDX collateral (price = HDX
  // price at which the position hits HF 1). Null when there are no borrowers.
  gigaLiquidations: GigaLiquidations | null
}

const LOCK_LABELS: Record<string, { key: string; label: string }> = {
  pyconvot: { key: 'vote', label: 'Vote locks' },
  ghdxlock: { key: 'gigahdx', label: 'GIGAHDX (28d)' },
  stk_stks: { key: 'staking', label: 'Staking' },
  ormlvest: { key: 'vesting', label: 'Vesting' },
}

// Cohort thresholds are shares of TOTAL supply (not fixed HDX amounts), so they
// track issuance: Whale > 0.1%, Dolphin > 0.01%, Fish > 0.000001%, Shrimp rest.
const COHORTS = [
  { key: 'whale', label: 'Whale', minPct: 0.1 },
  { key: 'dolphin', label: 'Dolphin', minPct: 0.01 },
  { key: 'fish', label: 'Fish', minPct: 0.000001 },
  { key: 'shrimp', label: 'Shrimp', minPct: 0 },
]

export function nonNegativeUIntDifferenceSql(total: string, spent: string): string {
  // ClickHouse subtracts UInt256 values as Int256. Keep both if branches signed
  // so the expression has one concrete type rather than Variant(Int256, UInt256).
  return `if(${total} > ${spent}, toInt256(${total}) - toInt256(${spent}), toInt256(0))`
}

const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')

export async function getHdxDashboard(): Promise<HdxDashboard> {
  // SWR: the cold build is ~15-17s (loadStructure's rotation-link scan alone
  // reads ~19 GiB), so an expired entry must serve instantly and revalidate in
  // the background — a request must never block on the recompute.
  return cachedSwr('explorer:hdx-dashboard', 300_000, 48 * 3_600_000, async () => {
    const [prices, head, paraMs, supply, flows, dca, churn, structure, movers, gigaMarket] = await Promise.all([
      ensurePrices(), loadHead(), paraBlockMs(client), loadSupplyCohorts(), loadDailyFlows(), loadDcaFlows(), loadChurn(), loadStructure(), loadTopMovers(),
      getGigaMarketStats().catch(err => { console.warn('[hdx] GIGAHDX market stats unavailable; the dashboard omits them', err); return null }),
    ])
    // Needs the staking exchange rate to express levels as HDX prices; without
    // a snapshot there is none, and the chart is withheld rather than assumed.
    const gigaLiquidations = snapshot
      ? await getGigaLiquidationLevels(snapshot.gigahdxHdxPerShare)
        .catch(err => { console.warn('[hdx] GIGAHDX liquidation levels unavailable; the chart is withheld', err); return null })
      : null
    const px = prices.get(0)
    const snap = snapshot
    // PARACHAIN heights (GIGAHDX unstake expiries, conviction prior unlocks) at
    // the resolved parachain slot time — ~6s today, 2s planned.
    const blockTs = (block: number) => head.ts + (block - head.height) * paraMs
    // Vesting schedules count RELAY blocks — do not convert. Extrapolate the
    // snapshot's relay height to the CH head timestamp at Polkadot's own 6s
    // slot time, which Hydration's 2s migration does not touch.
    const relayNow = snap ? snap.relayHeight + Math.round((head.ts - snap.at) / NOMINAL_RELAY_BLOCK_MS) : 0

    // Unlock timeline: 8 weekly buckets, then monthly to +12 months; releases
    // beyond that (long vesting tails) land in `later`. Everything already
    // unlockable (matured unstakes, past prior locks) is a single headline number.
    const now = head.ts
    const edges: { label: string; from: number; to: number }[] = []
    for (let w = 0; w < 8; w++) edges.push({ label: `wk ${w + 1}`, from: now + w * 7 * 86400e3, to: now + (w + 1) * 7 * 86400e3 })
    for (let m = 2; m <= 12; m++) edges.push({ label: `mo ${m}`, from: now + (m - 1) * 30 * 86400e3 + 26 * 86400e3, to: now + m * 30 * 86400e3 + 26 * 86400e3 })
    // Normalize: monthly edges start where the weekly ones end (56d).
    let cursor = now + 56 * 86400e3
    for (let i = 8; i < edges.length; i++) { edges[i].from = cursor; edges[i].to = cursor + 30 * 86400e3; cursor = edges[i].to }
    const horizon = cursor
    const buckets = edges.map(e => ({ label: e.label, fromTs: iso(e.from), toTs: iso(e.to), from: e.from, to: e.to, gigahdx: 0, vesting: 0, vote: 0, other: 0 }))
    const later: Record<UnlockKey, number> = { gigahdx: 0, vesting: 0, vote: 0, other: 0 }
    let unlockableNow = 0
    const put = (type: UnlockKey, ts: number, hdx: number) => {
      if (hdx <= 0) return
      if (ts <= now) { unlockableNow += hdx; return }
      if (ts >= horizon) { later[type] += hdx; return }
      const b = buckets.find(x => ts >= x.from && ts < x.to)
      if (b) b[type] += hdx
    }
    let undeterminedVoteHdx = 0
    // What is releasable right now, split by the lock that was holding it.
    let nowByType: Record<UnlockKey, number> = { gigahdx: 0, vesting: 0, vote: 0, other: 0 }
    // Preferred path: aggregate the per-account BINDING timelines, so a balance
    // held by two overlapping locks is counted once and attributed to the one
    // that actually gates it. The per-source path below double-counts that and
    // survives only as a fallback for a failed breakdown pass.
    if (snap?.timelines.length) {
      const series = unlockSeriesFromTimelines(snap.timelines, edges, now)
      buckets.forEach((b, i) => {
        b.gigahdx = series.buckets[i].gigahdx
        b.vesting = series.buckets[i].vesting
        b.vote = series.buckets[i].vote
        b.other = series.buckets[i].other
      })
      later.gigahdx = series.later.gigahdx
      later.vesting = series.later.vesting
      later.vote = series.later.vote
      later.other = series.later.other
      nowByType = series.now
      unlockableNow = series.now.gigahdx + series.now.vesting + series.now.vote + series.now.other
      undeterminedVoteHdx = series.active.vote
    } else if (snap) {
      for (const p of snap.pendingUnstakes) put('gigahdx', blockTs(p.expiryBlock), p.payoutHdx)
      for (const v of snap.voteLockAccounts) {
        // Open-ended while the account still votes/delegates (conviction period
        // starts when the referendum ends) — reported separately, not scheduled.
        if (v.hasActive) { undeterminedVoteHdx += v.hdx; continue }
        put('vote', blockTs(v.maxUnlockBlock), v.hdx)
      }
      for (const s of snap.vestingSchedules) {
        // Linear release in RELAY blocks: per bucket, periods maturing within
        // it × perPeriod.
        const endBlock = s.start + s.period * s.periodCount
        if (endBlock <= relayNow) continue
        const perHdx = Number(s.perPeriod) / 1e12
        const periodsUpTo = (block: number) => Math.max(0, Math.min(s.periodCount, Math.floor((block - s.start) / s.period)))
        const doneNow = periodsUpTo(relayNow)
        // RELAY heights — do not convert (see relayNow above).
        const relayAt = (ts: number) => relayNow + Math.round((ts - now) / NOMINAL_RELAY_BLOCK_MS)
        let prev = doneNow
        for (const b of buckets) {
          const upto = periodsUpTo(relayAt(b.to))
          b.vesting += (upto - prev) * perHdx
          prev = upto
        }
        later.vesting += (s.periodCount - prev) * perHdx
      }
    }
    const gigaPendingTotal = hdxNumberFromRaw(snap?.pendingUnstakes.reduce((a, p) => a + p.payoutRaw, 0n) ?? 0n)
    const nextGiga = snap?.pendingUnstakes.find(p => blockTs(p.expiryBlock) > now)
    // Positions whose cooldown has elapsed: claimable with an unlock call. This
    // counts POSITIONS, so it stays a true statement about the pallet even
    // where another lock still covers the same tokens — the chart's "now"
    // column is the overlap-corrected view of what actually frees.
    const gigaMatured = snap?.pendingUnstakes.filter(p => blockTs(p.expiryBlock) <= now) ?? []

    const lockTypes = (snap?.lockTypes ?? [])
      .map(t => ({ ...(LOCK_LABELS[t.id] ?? { key: 'other', label: 'Other' }), accounts: t.accounts, totalHdx: t.totalHdx }))
    // Fold everything unlabeled into one "Other" row.
    const folded: { key: string; label: string; accounts: number; totalHdx: number }[] = []
    for (const t of lockTypes) {
      const existing = folded.find(f => f.key === t.key)
      if (existing) { existing.accounts += t.accounts; existing.totalHdx += t.totalHdx } else folded.push(t)
    }
    // Replace the raw ormlvest lock figures (stale between claims) with the
    // schedule-derived amounts still vesting at the current relay height.
    const vestCorr = snap ? correctVestingLocks(snap.lockAccounts, snap.vestingSchedules, relayNow) : null
    const vestRow = folded.find(f => f.key === 'vesting')
    if (vestRow && vestCorr) { vestRow.accounts = vestCorr.vestingAccounts; vestRow.totalHdx = vestCorr.vestingHdx }

    return {
      price: px?.price ?? null,
      change24h: px?.change24h ?? null,
      supply: { totalHdx: supply.totalHdx, protocolHdx: supply.protocolHdx, userHdx: supply.userHdx, holders: supply.holders },
      cohorts: supply.cohorts,
      locks: {
        types: folded,
        totalLockedHdx: vestCorr?.totalLockedHdx ?? 0,
        lockedPctOfUser: supply.userHdx > 0 && vestCorr ? vestCorr.totalLockedHdx / supply.userHdx * 100 : 0,
        vestedUnclaimedHdx: vestCorr?.vestedUnclaimedHdx ?? 0,
        snapshotAt: snap ? iso(snap.at) : null,
      },
      unlocks: {
        buckets: buckets.map(({ from: _f, to: _t, ...rest }) => rest),
        laterHdx: later,
        unlockableNowHdx: unlockableNow,
        nowHdx: nowByType,
        activeVoteHdx: undeterminedVoteHdx,
        stakingAnytimeHdx: folded.find(t => t.key === 'staking')?.totalHdx ?? 0,
        gigaPending: {
          count: snap?.pendingUnstakes.length ?? 0,
          totalHdx: gigaPendingTotal,
          nextUnlockTs: nextGiga ? iso(blockTs(nextGiga.expiryBlock)) : null,
          maturedCount: gigaMatured.length,
          maturedHdx: hdxNumberFromRaw(gigaMatured.reduce((a, p) => a + p.payoutRaw, 0n)),
        },
      },
      flows: { daily: flows, dca },
      churn,
      structure,
      topMovers: movers,
      gigaMarket,
      gigaLiquidations,
    }
  })
}

async function loadHead(): Promise<{ height: number; ts: number }> {
  const res = await client.query({ query: `SELECT max(block_height) AS h, toUnixTimestamp(max(block_timestamp)) AS t FROM price_data.blocks`, format: 'JSONEachRow' })
  const row = (await res.json<{ h: number; t: number }>())[0]
  return { height: row?.h ?? 0, ts: (row?.t ?? 0) * 1000 }
}

async function loadSupplyCohorts(): Promise<HdxDashboard['supply'] & { cohorts: HdxCohort[] }> {
  // The percentage thresholds resolve against the current total supply, so the
  // cutoffs are computed in-query from the same aggregate they filter.
  const bands = COHORTS.map((c, i) => {
    const lo = `total * ${c.minPct / 100}`
    const hi = i > 0 ? `total * ${COHORTS[i - 1].minPct / 100}` : null
    const cond = `NOT startsWith(account_id, '0x6d6f646c') AND bal > ${lo}${hi ? ` AND bal <= ${hi}` : ''}`
    return `countIf(${cond}) AS ${c.key}_n, sumIf(bal, ${cond}) AS ${c.key}_s`
  }).join(',\n        ')
  // `holders` is the explorer's one holder definition (HoldersPage in
  // explorerService): accounts with a positive balance, an account's bound
  // EVM-side pot folded onto it — so the figure here is the asset page's and
  // the directory's, and the cohorts band the same folded accounts.
  const res = await client.query({
    query: `
      WITH bind AS (
        ${bindCteSql()}
      ),
      h AS (
        SELECT ${boundAccountSql('l')} AS account_id, toFloat64(sum(l.bal)) / 1e12 AS bal
        FROM (
          SELECT account_id, toUInt256OrZero(argMaxMerge(total_state)) AS bal
          FROM price_data.account_asset_latest_balances WHERE asset_id = '0'
          GROUP BY account_id
        ) l
        LEFT JOIN bind b ON b.eth_id = l.account_id
        GROUP BY account_id HAVING bal > 0
      ),
      (SELECT sum(bal) FROM h) AS total
      SELECT
        count() AS holders, any(total) AS total_supply,
        sumIf(bal, startsWith(account_id, '0x6d6f646c')) AS protocol,
        ${bands}
      FROM h`,
    format: 'JSONEachRow',
  })
  const r = (await res.json<Record<string, number>>())[0] ?? {}
  const total = Number(r.total_supply ?? 0)
  const cohorts = COHORTS.map(c => ({
    ...c,
    minHdx: total * c.minPct / 100,
    accounts: Number(r[`${c.key}_n`] ?? 0),
    totalHdx: Number(r[`${c.key}_s`] ?? 0),
  }))
  return {
    totalHdx: total,
    protocolHdx: Number(r.protocol ?? 0),
    userHdx: total - Number(r.protocol ?? 0),
    holders: Number(r.holders ?? 0),
    cohorts,
  }
}

async function loadDailyFlows(): Promise<HdxDailyFlow[]> {
  const head = await loadHead()
  // The last 60 days by wall clock, from the first block inside them (a fixed
  // block-count offset misses them: ~6s today, 2s planned) — so the first day is
  // partial, as it always was — on the day grid up to the indexed head.
  const from = await cutoffHeightForWindow(60 * 24, head.height)
  const headSec = Math.floor(head.ts / 1000)
  const days = DAILY_GRAIN.grid(headSec - 60 * 86_400, headSec)
  const g: ChartGrid = { ...fullChartGrid(DAILY_GRAIN, days), fromHeight: from, toHeight: MAX_HEIGHT }
  const s = await flowsSeries(g)
  return days.map((date, i) => ({ date, buyHdx: s.buy[i], sellHdx: s.sell[i], buyers: s.buyers[i], sellers: s.sellers[i] }))
}

// Active DCA orders touching HDX → realistic NEXT-24H buy/sell volume, not the
// naive instantaneous rate:
//  - executions/day uses the MEASURED block count of the last 24h — elastic
//    scaling makes real throughput differ from a day's worth of nominal slots
//    (14,400 at today's ~6s, 43,200 at the planned 2s), and the measurement
//    carries the migration for free — and
//  - each schedule is capped by its REMAINING budget (total − spent), so a
//    whale order minutes from exhaustion can't inflate the daily figure by an
//    order of magnitude. Open-ended budgets (total_amount = 0) are uncapped.
// Per-execution HDX is exact when the order is denominated in HDX; otherwise
// it's the average of that schedule's actual executions.
//
// Runtime 443's DCA intents are the same flow through a different pallet, so they
// are measured the same way and summed into the same two figures — the card
// answers "how much HDX do ongoing DCA orders move", and which pallet schedules
// an order is not part of that question. They are a separate query rather than a
// branch inside this one: an intent's executions live in intent_events, its
// budget in `budget`, and it is always fixed-input (buy-side DCA was removed in
// runtime 440), so nothing but the arithmetic is shared.
async function loadDcaFlows(): Promise<HdxDashboard['flows']['dca']> {
  const [schedules, intents] = await Promise.all([loadDcaScheduleFlows(), loadDcaIntentFlows()])
  const side = (sell: boolean) => {
    const a = schedules.find(x => x.sell === sell), b = intents.find(x => x.sell === sell)
    return { orders: (a?.orders ?? 0) + (b?.orders ?? 0), hdxPerDay: (a?.hdxPerDay ?? 0) + (b?.hdxPerDay ?? 0) }
  }
  return { buy: side(false), sell: side(true) }
}

interface DcaFlowSide { sell: boolean; orders: number; hdxPerDay: number }

async function loadDcaScheduleFlows(): Promise<DcaFlowSide[]> {
  const total = 'toUInt256OrZero(s.total_amount)'
  const spent = 'ifNull(e.sum_in, toUInt256(0))'
  const remaining = nonNegativeUIntDifferenceSql(total, spent)
  const res = await client.query({
    query: `
      WITH done AS (SELECT DISTINCT id FROM price_data.dca_events
                    -- Migrated/MigrationCancelled end a schedule too (runtime 443).
                    -- A migrated one continues as a DCA intent, which the intent
                    -- query below counts, so omitting them here would book the
                    -- same order's flow twice.
                    WHERE event_name IN ('DCA.Completed', 'DCA.Terminated', 'DCA.Migrated', 'DCA.MigrationCancelled')),
      -- FINAL on both replayable sources: these count and sum rows, so a
      -- re-inserted raw range would otherwise inflate the executions done and the
      -- amount filled, which collapses the remaining budget and with it the cap,
      -- and duplicate a schedule into two orders.
      execstats AS (SELECT id, count() AS executions,
                           sum(toUInt256OrZero(amount_in)) AS sum_in,
                           sum(toUInt256OrZero(amount_out)) AS sum_out
                    FROM price_data.dca_events FINAL WHERE event_name = 'DCA.TradeExecuted' GROUP BY id),
      bpd AS (SELECT count() AS blocks FROM price_data.raw_blocks WHERE block_timestamp > now() - INTERVAL 24 HOUR)
      SELECT s.asset_in = 0 AS is_sell, count() AS orders,
        sum(
          least(
            (SELECT blocks FROM bpd) / s.period,
            if(${total} > 0,
               toFloat64(${remaining})
                 / nullIf(if(e.executions > 0, toFloat64(e.sum_in) / e.executions, toFloat64OrZero(s.amount_per)), 0),
               1e15)
          ) * multiIf(
            s.asset_out = 0 AND s.direction = 'Buy', toFloat64OrZero(s.amount_per),
            s.asset_in = 0 AND s.direction = 'Sell', toFloat64OrZero(s.amount_per),
            s.asset_out = 0, if(e.executions > 0, toFloat64(e.sum_out) / e.executions, 0),
            if(e.executions > 0, toFloat64(e.sum_in) / e.executions, 0))
        ) / 1e12 AS hdx_per_day
      FROM price_data.dca_schedules s FINAL
      LEFT ANTI JOIN done ON done.id = s.id
      LEFT JOIN execstats e ON e.id = s.id
      WHERE s.asset_in = 0 OR s.asset_out = 0
      GROUP BY is_sell`,
    format: 'JSONEachRow',
  })
  return dcaFlowSides(await res.json<DcaFlowRow>())
}

type DcaFlowRow = { is_sell: number; orders: number; hdx_per_day: number }
function dcaFlowSides(rows: DcaFlowRow[]): DcaFlowSide[] {
  return rows.map(r => ({ sell: Boolean(Number(r.is_sell)), orders: Number(r.orders), hdxPerDay: Number(r.hdx_per_day) }))
}

// The DCA-intent twin of the query above, same two caps (measured blocks per day
// over the order's period, and what its remaining budget can still fund) and the
// same per-execution HDX rule — exact on the HDX leg when the order is
// denominated in HDX, the order's own average execution otherwise.
//
// Two intent-only details: an empty `budget` is the pallet's rolling re-reserve,
// which is the uncapped open-ended order `total_amount = 0` spells for a
// schedule; and a DCA intent is always fixed-input, so `amount_in` is the
// per-trade amount on the sell side and the output has to be averaged from its
// executions on the buy side.
async function loadDcaIntentFlows(): Promise<DcaFlowSide[]> {
  const res = await client.query({
    query: `
      WITH done AS (SELECT DISTINCT intent_id FROM price_data.intent_events
                    WHERE event_name IN ('Intent.IntentCanceled', 'Intent.IntentExpired', 'Intent.DcaCompleted')),
      execstats AS (SELECT intent_id, count() AS executions,
                           sum(toUInt256OrZero(amount_in)) AS sum_in,
                           sum(toUInt256OrZero(amount_out)) AS sum_out
                    FROM price_data.intent_events FINAL
                    WHERE event_name = 'Intent.DcaTradeExecuted' GROUP BY intent_id),
      bpd AS (SELECT count() AS blocks FROM price_data.raw_blocks WHERE block_timestamp > now() - INTERVAL 24 HOUR),
      live AS (SELECT intent_id, asset_in, asset_out, amount_in, budget, period
               FROM price_data.intent_orders FINAL
               WHERE kind = 'dca' AND (asset_in = 0 OR asset_out = 0))
      SELECT s.asset_in = 0 AS is_sell, count() AS orders,
        sum(
          least(
            (SELECT blocks FROM bpd) / nullIf(s.period, 0),
            if(toUInt256OrZero(s.budget) > 0,
               toFloat64(${nonNegativeUIntDifferenceSql('toUInt256OrZero(s.budget)', 'ifNull(e.sum_in, toUInt256(0))')})
                 / nullIf(if(e.executions > 0, toFloat64(e.sum_in) / e.executions, toFloat64OrZero(s.amount_in)), 0),
               1e15)
          ) * if(s.asset_in = 0,
                 toFloat64OrZero(s.amount_in),
                 if(e.executions > 0, toFloat64(e.sum_out) / e.executions, 0))
        ) / 1e12 AS hdx_per_day
      FROM live s
      LEFT ANTI JOIN done ON done.intent_id = s.intent_id
      LEFT JOIN execstats e ON e.intent_id = s.intent_id
      GROUP BY is_sell`,
    format: 'JSONEachRow',
  })
  return dcaFlowSides(await res.json<DcaFlowRow>())
}

// The churn chart's weeks start on Sunday (toStartOfWeek's default mode), as
// they always have.
const SUNDAY_WEEK_GRAIN = makeGrain(7 * 86_400, undefined, 3 * 86_400)

async function loadChurn(): Promise<HdxDashboard['churn']> {
  return cachedSwr(`explorer:hdx-churn:model`, 1_800_000, 48 * 3_600_000, async () => {
    // The last 12 weeks, from exactly 12 weeks ago: the first week is partial.
    const fromSec = nowSec() - 12 * 7 * 86_400
    const weeks = SUNDAY_WEEK_GRAIN.grid(fromSec, nowSec())
    const g: ChartGrid = { ...fullChartGrid(SUNDAY_WEEK_GRAIN, weeks), fromSec }
    const s = await churnSeries(g)
    return { weekly: weeks.map((weekStart, i) => ({ weekStart, newHolders: s.newHolders[i], exitedHolders: s.exitedHolders[i] })) }
  })
}

// ── Weekly holder structure (ownership history + HODL age bands) ─────────────

// Balance observations before this Monday cover only ~26 accounts and include a
// genesis distribution pot recorded 1e12× too high; from here the observation
// era is comprehensive (21k+ accounts appear in this week). The structure
// series starts here rather than presenting the sparse prefix as history.
export const HDX_BALANCE_SERIES_START = '2022-07-04'

// The exchange's custody hot wallets, which are one custodian balance rather
// than holder decentralization, so they get their own class.
//
// Deliberately the 'kraken' tag ALONE. 'hdx-kraken-lp' — the wallet running the
// HDX market-making inventory — used to be merged in here on the grounds that
// it is the same custodian, which made the /hdx "Kraken custody" card read
// ~4.1M above the /tag/kraken page for the same name with nothing disclosing
// the difference. A figure that cannot be reconciled with the tag it is named
// after costs more than the extra precision was worth; the LP wallet now falls
// into the user class like any other holder.
const KRAKEN_TAG_IDS = ['kraken']
// Non-modl accounts that are still protocol plumbing: AMM pool accounts and
// money-market reserve contracts. HDX inside them is pooled/custodial, not a
// holder's wallet balance. Module (modl) accounts match by prefix instead.
const POOL_TAG_IDS = ['xyk-pools', 'stableswap-pools', 'lbp-pools', 'money-market']

const tagAccountsSql = (ids: string[]) =>
  `(SELECT groupArray(account_id) FROM price_data.account_tags FINAL WHERE label_id IN (${ids.map(t => `'${t}'`).join(',')}) AND deleted = 0)`

export interface HdxStructureWeekRow {
  week: string
  treasury: number; protocol: number; kraken: number
  user_total: number
  top10: number; top100: number; top1000: number
  hhi: number
  age_0_3m: number; age_3_12m: number; age_1_2y: number; age_2y: number
}

// Assemble the payload's per-week arrays from the SQL rows. Pure so the
// effective-holder arithmetic and the rest-tranche derivation are unit-testable.
export function buildHdxStructure(rows: HdxStructureWeekRow[]): Pick<HdxStructure, 'weeks' | 'ownership' | 'effectiveHolders' | 'hodl'> {
  return {
    weeks: rows.map(r => r.week),
    ownership: {
      treasury: rows.map(r => r.treasury),
      protocol: rows.map(r => r.protocol),
      kraken: rows.map(r => r.kraken),
      top10: rows.map(r => r.top10),
      top11to100: rows.map(r => r.top100),
      top101to1000: rows.map(r => r.top1000),
      rest: rows.map(r => Math.max(0, r.user_total - r.top10 - r.top100 - r.top1000)),
    },
    effectiveHolders: rows.map(r => (r.hhi > 0 ? Math.round(1 / r.hhi) : 0)),
    hodl: {
      under3m: rows.map(r => r.age_0_3m),
      m3to12: rows.map(r => r.age_3_12m),
      y1to2: rows.map(r => r.age_1_2y),
      over2y: rows.map(r => r.age_2y),
    },
  }
}

// A rotation link: fresh wallet `b` was born of dying wallet `a`'s funds
// (b's first balance is ≥90% funded by a within b's birth week, and a's
// balance hit zero within a fortnight). `aFirstnz` is a's first-nonzero week.
export interface HdxRotationLinkRow { b: string; a: string; aFirstnz: string }

// Resolve rotation chains to their root: serial rotators (a → b → c) pass the
// ORIGINAL wallet's first-nonzero week all the way down, so a move between own
// wallets never resets the holding age. Cycles (defensive — the fresh-wallet
// birth condition shouldn't allow them) fall back to the direct parent.
export function resolveRotationAnchors(rows: HdxRotationLinkRow[]): { accounts: string[]; anchors: string[] } {
  const parent = new Map(rows.map(r => [r.b, r]))
  const anchorOf = (acc: string, seen: Set<string>): string | null => {
    const link = parent.get(acc)
    if (!link || seen.has(acc)) return null
    seen.add(acc)
    return anchorOf(link.a, seen) ?? link.aFirstnz
  }
  const accounts: string[] = [], anchors: string[] = []
  for (const b of parent.keys()) {
    const anchor = anchorOf(b, new Set())
    if (anchor) { accounts.push(b); anchors.push(anchor) }
  }
  return { accounts, anchors }
}

// Align month-keyed rows onto the trend grid: absent months are null, so a
// chart line starts where its data does instead of at a fabricated zero.
export function alignMonthly(months: string[], rows: { m: string; v: number }[]): (number | null)[] {
  const byM = new Map(rows.map(r => [r.m, r.v]))
  return months.map(m => byM.get(m) ?? null)
}

// Forward-fill a CUMULATIVE series' gaps: a month with no activity emits no
// row, but the running total still stands. Leading nulls stay null (the
// series hasn't started).
export function carryForward(values: (number | null)[]): (number | null)[] {
  let prev: number | null = null
  return values.map(v => (v != null ? (prev = v) : prev))
}

// `ts` (unix seconds) dates the mint within its week; without it the mint is
// taken at its week's Monday, which is exact for a weekly grid.
export interface HdxAllocationMintRow { week: string; cls: string; hdx: number; ts?: number }

// Allocation-realization mints (single Balances.Deposit of ≥ 10M HDX — organic
// deposits like fee payouts and drips are orders of magnitude smaller) are the
// on-chain moment a pre-committed allocation (growth pot, completed vesting)
// starts to float. Economically that supply existed all along, so the
// ownership history counts each mint in its recipient's band from the series
// start instead of showing a supply cliff at the realization block. Only
// treasury/protocol recipients are backfilled: retro-adding to a user-class
// wallet would fabricate its past top-N ranking, and those mints are ~10M HDX
// — invisible at chart scale. Returns the total HDX it backfilled.
export function backfillAllocationMints(
  ownership: HdxStructure['ownership'],
  weeks: string[],
  mints: HdxAllocationMintRow[],
): number {
  return backfillAllocationMintsAt(ownership, weeks.map(w => keySeconds(w) + 7 * 86_400), mints, weeks[0])
}

/**
 * The same on any grid: `ends` are the bucket ends (a bucket states the balance
 * standing at its end), and a mint counts in every bucket ending at or before
 * it — the balance there does not hold it yet. Mints in or before the SERIES'
 * first week (not a zoom window's) are already inside the observed balances.
 */
export function backfillAllocationMintsAt(
  ownership: HdxStructure['ownership'],
  ends: number[],
  mints: HdxAllocationMintRow[],
  seriesStartWeek: string = HDX_BALANCE_SERIES_START,
): number {
  let total = 0
  for (const m of mints) {
    if (m.cls !== 'treasury' && m.cls !== 'protocol') continue
    if (!(m.hdx > 0) || m.week <= seriesStartWeek) continue
    const band = ownership[m.cls]
    const at = m.ts ?? keySeconds(m.week)
    for (let i = 0; i < ends.length && ends[i] <= at; i++) band[i] += m.hdx
    total += m.hdx
  }
  return total
}

// ── Holder structure on any grid ─────────────────────────────────────────────
//
// ONE builder states the holder structure — ownership classes, user top-N
// tranches, HHI and holder-age bands — at each bucket END of a ChartGrid. The
// dashboard runs it over the whole-history Monday-week grid; a chart zoom runs it
// over the window's ladder grid (chartWindow.ts), down to an hour. The coarse
// weekly series is therefore the fine series sampled at Mondays, and the two
// agree wherever their bucket ends coincide.
//
// Per account the builder takes the balance standing when the grid opens (the
// carry-in) and the closing balance of every bucket with an observation after
// it, carried forward through quiet buckets. Two sources state those closes:
//   - `weekly`: account_balance_weekly, whose argMax is each Monday week's LAST
//     observation — exact for any Monday-aligned grid whose step is whole weeks
//     (the dashboard's, and a zoom resolving to 7 days or more).
//   - `hourly`: account_balance_hourly for everything else. The opening is the
//     last weekly close before the window's own Monday, overtaken by any hourly
//     row between that Monday and the window start; weekly and hourly closes are
//     the same observation at every Monday (verified: 0 of 103,006 accounts
//     differ for the week of 2026-09-14).
//
// Most accounts do not move inside a zoom window, so they are not expanded onto
// its grid: an account whose every in-window close equals its opening is
// STATIC and is aggregated once (class sums, sum of squares, its top-1000 user
// balances, user HDX per holding-age anchor); only MOVERS are expanded bucket by
// bucket. mergeHdxStructureRows adds the static part back into every bucket and
// ranks the top-N over the union — exact, because a static balance is the same
// in every bucket, so each bucket's top 1,000 is drawn from the static top 1,000
// and that bucket's mover balances. Balances stay raw integers (UInt256) to the
// payload; HHI is the one ratio.
//
// Holding age is measured at the Monday of the bucket's last instant — the grain
// the coarse series has always used (its ages are counted at each week's
// Monday), so an age band changes at a week boundary on every grid.

const WEEK_SEC = 7 * 86_400
const HDX_SERIES_START_SEC = keySeconds(HDX_BALANCE_SERIES_START)
// The monthly trend grid starts with the series' first calendar month.
const HDX_TREND_START_SEC = keySeconds('2022-07-01')
const nowSec = () => Math.floor(Date.now() / 1000)

export type HdxStructureSource = 'weekly' | 'hourly'
export type HdxStructureScope = 'all' | 'kraken'

/** Bucket ends of a regular grid, and the Monday each bucket's holding ages are counted at. */
export function structureRefs(g: ChartGrid): string[] {
  return g.keys.map(k => WEEKLY_MONDAY_GRAIN.keyOf(grainBucketEndSec(g.grain, k) - 1))
}

/** A grid the weekly closes state exactly: Monday-aligned, whole weeks per bucket. */
export function isWeeklyAligned(g: ChartGrid): boolean {
  return g.grain.stepSec % WEEK_SEC === 0 && (g.fromSec - MONDAY_ANCHOR_SEC) % WEEK_SEC === 0
}

const kraKenTagSql = KRAKEN_TAG_IDS.map(t => `'${t}'`).join(',')

/**
 * The structure's rows: `i` = 0 is the static part, `i` = 1…n the movers of
 * bucket n. Parameters: `from` (the grid's start), `w0` (its Monday), `end`
 * (exclusive end of its last bucket), `step`, `n`, `refs` (structureRefs) and the
 * rotation anchors. A `kraken` scope restricts every read to the tagged custody
 * wallets by primary key — the Kraken band alone, at a sliver of the cost.
 */
export function hdxStructureSql(source: HdxStructureSource, scope: HdxStructureScope = 'all'): string {
  const scoped = scope === 'kraken'
    ? ` AND account_id IN (SELECT account_id FROM price_data.account_tags FINAL WHERE label_id IN (${kraKenTagSql}) AND deleted = 0)`
    : ''
  // A weekly close is the state at `c`, the Monday after its week. Weeks starting
  // at or after the grid's end state nothing it shows: a first-nonzero week that
  // late reads as "under 3 months" either way.
  const weeklyRows = `
          SELECT account_id, week_start, toDateTime(week_start) + ${WEEK_SEC} AS c, argMaxMerge(balance_state) AS wbal
          FROM price_data.account_balance_weekly
          WHERE asset_id = '0' AND week_start < toDate(toDateTime({end:UInt32}))${scoped}
          GROUP BY account_id, week_start`
  // bi: 0 = at or before the grid opens (opening candidates), 1…n = the bucket
  // whose span holds the close, -1 = a weekly close the hourly rows supersede
  // (kept only for its first-nonzero week).
  const weeklyBucket = source === 'weekly'
    ? `if(c <= toDateTime({from:UInt32}), toInt64(0), intDiv(toInt64(toUnixTimestamp(c)) - 1 - {from:UInt32}, {step:UInt32}) + 1)`
    : `if(c <= toDateTime({w0:UInt32}), toInt64(0), toInt64(-1))`
  const parts = [`
        SELECT account_id, ${weeklyBucket} AS bi, max(c) AS cl, argMax(wbal, c) AS bal,
          minIf(week_start, toUInt256OrZero(wbal) > 0) AS nz, countIf(toUInt256OrZero(wbal) > 0) AS nzn
        FROM (${weeklyRows})
        GROUP BY account_id, bi`]
  if (source === 'hourly') {
    parts.push(`
        SELECT account_id,
          if(interval_start < toDateTime({from:UInt32}), toInt64(0), intDiv(toInt64(toUnixTimestamp(interval_start)) - {from:UInt32}, {step:UInt32}) + 1) AS bi,
          max(interval_start) + 3600 AS cl, argMax(hbal, interval_start) AS bal, toDate('1970-01-01') AS nz, toUInt64(0) AS nzn
        FROM (
          SELECT account_id, interval_start, argMaxMerge(balance_state) AS hbal
          FROM price_data.account_balance_hourly
          WHERE asset_id = '0' AND interval_start >= toDateTime({w0:UInt32}) AND interval_start < toDateTime({end:UInt32})${scoped}
          GROUP BY account_id, interval_start)
        GROUP BY account_id, bi`)
  }
  return `
    WITH
    ${tagAccountsSql(KRAKEN_TAG_IDS)} AS kraken_accts,
    ${tagAccountsSql(POOL_TAG_IDS)} AS pool_accts
    SELECT i,
      toString(sumIf(bal, cls = 'treasury')) AS treasury,
      toString(sumIf(bal, cls = 'protocol')) AS protocol,
      toString(sumIf(bal, cls = 'kraken')) AS kraken,
      toString(sumIf(bal, cls = 'user')) AS user_total,
      toString(sumIf(bal * bal, cls = 'user')) AS sq,
      arrayMap(x -> toString(toInt256(0) - x), groupArraySortedIf(1000)(toInt256(0) - toInt256(bal), cls = 'user')) AS top,
      -- band edges at week multiples (13/52/104 weeks): anchors and refs are Mondays
      toString(sumIf(bal, cls = 'user' AND i > 0 AND dateDiff('day', anchor, ref) < 91)) AS a0,
      toString(sumIf(bal, cls = 'user' AND i > 0 AND dateDiff('day', anchor, ref) >= 91 AND dateDiff('day', anchor, ref) < 364)) AS a1,
      toString(sumIf(bal, cls = 'user' AND i > 0 AND dateDiff('day', anchor, ref) >= 364 AND dateDiff('day', anchor, ref) < 728)) AS a2,
      toString(sumIf(bal, cls = 'user' AND i > 0 AND dateDiff('day', anchor, ref) >= 728)) AS a3,
      sumMapIf([anchor], [bal], cls = 'user' AND i = 0) AS st_age,
      arrayMap(x -> toString(x), st_age.1) AS st_anchor,
      arrayMap(x -> toString(x), st_age.2) AS st_sum
    FROM (
      SELECT cls, anchor, i, if(i = 0, toDate('1970-01-01'), {refs:Array(Date)}[i]) AS ref, bal
      FROM (
        SELECT cls, anchor, seg.1.1 AS lo, seg.2 AS hi, toUInt256(seg.1.2) AS bal
        FROM (
          SELECT cls, anchor,
            arrayExists(p -> p.2 != b0, pts) AS mover,
            -- a mover's balance holds from each close up to the next one; the
            -- opening holds from bucket 1 (an in-bucket-1 close overtakes it)
            if(mover, arrayConcat([(toInt64(1), b0)], pts), [(toInt64(0), b0)]) AS segs,
            if(mover, arrayPushBack(arrayPopFront(arrayMap(p -> p.1, segs)), toInt64({n:UInt32}) + 1), [toInt64(1)]) AS nexts
          FROM (
            SELECT account_id,
              toUInt256OrZero(argMaxIf(bal, cl, bi = 0)) AS b0,
              arraySort(p -> p.1, groupArrayIf((bi, toUInt256OrZero(bal)), bi > 0)) AS pts,
              multiIf(
                account_id = '${TREASURY_ACCOUNT}', 'treasury',
                startsWith(account_id, '0x6d6f646c') OR has(pool_accts, account_id), 'protocol',
                has(kraken_accts, account_id), 'kraken',
                'user') AS cls,
              -- holding age from the account's first nonzero weekly close OR its
              -- rotation chain's root, whichever is older (resolveRotationAnchors)
              least(if(sum(nzn) = 0, toDate('2100-01-01'), minIf(nz, nzn > 0)),
                transform(account_id, {rotAccs:Array(String)}, {rotAnchors:Array(Date)}, toDate('2100-01-01'))) AS anchor
            FROM (${parts.join('\n        UNION ALL')})
            GROUP BY account_id
          )
        )
        ARRAY JOIN arrayZip(segs, nexts) AS seg
        WHERE seg.1.2 > 0
      )
      ARRAY JOIN range(lo, hi) AS i
    )
    GROUP BY i
    ORDER BY i`
}

export interface HdxStructureSqlRow {
  i: number | string
  treasury: string; protocol: string; kraken: string; user_total: string; sq: string
  top: string[]
  a0: string; a1: string; a2: string; a3: string
  st_anchor: string[]; st_sum: string[]
}

/** One bucket's structure, raw planck. */
export interface HdxStructureBucket {
  treasury: bigint; protocol: bigint; kraken: bigint; user: bigint
  top10: bigint; top11to100: bigint; top101to1000: bigint
  sq: bigint
  /** User HDX held under 3 months, 3–12 months, 1–2 years, over 2 years. */
  ages: [bigint, bigint, bigint, bigint]
}

const DAY_SEC = 86_400

/**
 * Add the static part back into every bucket and rank the user top-N over the
 * union (see the builder's comment). `refs[i]` is bucket i's age Monday.
 */
export function mergeHdxStructureRows(refs: string[], rows: HdxStructureSqlRow[]): HdxStructureBucket[] {
  const byI = new Map(rows.map(r => [Number(r.i), r]))
  const st = byI.get(0)
  const big = (s: string | undefined) => (s ? BigInt(s) : 0n)
  const stTop = (st?.top ?? []).map(x => BigInt(x))
  const stAges = (st?.st_anchor ?? []).map((a, j) => ({ day: keySeconds(a) / DAY_SEC, raw: BigInt(st!.st_sum[j]) }))
  const band = (days: number) => (days < 91 ? 0 : days < 364 ? 1 : days < 728 ? 2 : 3)
  return refs.map((ref, idx) => {
    const m = byI.get(idx + 1)
    // Both lists arrive largest first; merge the heads.
    const mvTop = (m?.top ?? []).map(x => BigInt(x))
    const top: bigint[] = []
    for (let a = 0, b = 0; top.length < 1000 && (a < stTop.length || b < mvTop.length);) {
      if (b >= mvTop.length || (a < stTop.length && stTop[a] >= mvTop[b])) top.push(stTop[a++])
      else top.push(mvTop[b++])
    }
    const sum = (from: number, to: number) => top.slice(from, to).reduce((s, v) => s + v, 0n)
    const ages: [bigint, bigint, bigint, bigint] = [big(m?.a0), big(m?.a1), big(m?.a2), big(m?.a3)]
    const refDay = keySeconds(ref) / DAY_SEC
    for (const a of stAges) ages[band(refDay - a.day)] += a.raw
    return {
      treasury: big(st?.treasury) + big(m?.treasury),
      protocol: big(st?.protocol) + big(m?.protocol),
      kraken: big(st?.kraken) + big(m?.kraken),
      user: big(st?.user_total) + big(m?.user_total),
      top10: sum(0, 10), top11to100: sum(10, 100), top101to1000: sum(100, 1000),
      sq: big(st?.sq) + big(m?.sq),
      ages,
    }
  })
}

// Rotation links resolve BEFORE the structure query — the holding-age bands
// need the inherited anchors as parameters, so a move between own wallets counts
// as continuous holding instead of resetting to "under 3m". The link scan reads
// ~19 GiB, so it runs once per hour for the dashboard and every zoom window
// alike, never per window.
async function loadRotationAnchors(): Promise<{ accounts: string[]; anchors: string[] }> {
  return cachedSwr('explorer:hdx-rotation-anchors', 3_600_000, 48 * 3_600_000, async () => {
    // USER accounts only (no modl, no pool/Kraken custody), balances as sorted
    // per-account (week, balance) arrays.
    const linkRes = await client.query({
      query: `
        WITH
        ${tagAccountsSql(KRAKEN_TAG_IDS)} AS kraken_accts,
        ${tagAccountsSql([...KRAKEN_TAG_IDS, ...POOL_TAG_IDS])} AS special_accts,
        kraken_forwarders AS (
          SELECT DISTINCT from_account FROM price_data.transfer_activity
          WHERE asset_id = 0 AND has(kraken_accts, to_account)
        ),
        obs AS (
          SELECT account_id, week_start AS w,
            toFloat64(toUInt256OrZero(argMaxMerge(balance_state))) / 1e12 AS bal
          FROM price_data.account_balance_weekly
          WHERE asset_id = '0' AND NOT startsWith(account_id, '0x6d6f646c')
          GROUP BY account_id, w
        ),
        seq AS (
          SELECT account_id,
            arraySort(groupArray(w)) AS ws,
            arraySort((b, ww) -> ww, groupArray(bal), groupArray(w)) AS bs
          FROM obs
          WHERE NOT has(special_accts, account_id)
          GROUP BY account_id
        ),
        births AS (
          SELECT account_id,
            arrayFilter((ww, bb) -> bb > 0, ws, bs)[1] AS nzw,
            arrayFilter(bb -> bb > 0, bs)[1] AS first_close
          FROM seq
          WHERE length(arrayFilter(bb -> bb > 0, bs)) > 0
        ),
        exits AS (
          SELECT account_id, groupArray(t.1) AS ews
          FROM (SELECT account_id, ws, arrayMap(b -> b > 0, bs) AS nzs FROM seq)
          ARRAY JOIN arrayFilter(x -> x.2 = 1, arrayZip(ws,
            arrayMap(i -> if(NOT nzs[i] AND i > 1 AND nzs[i - 1], 1, 0), arrayEnumerate(ws)))) AS t
          GROUP BY account_id
        )
        SELECT x.b AS b, x.a AS a, toString(bi2.nzw) AS a_firstnz
        FROM (
          -- the largest funder; two that sent the same amount (measured: one
          -- pair, to the planck) are ordered by id so the pick is the same on
          -- every rebuild rather than whichever thread finished first
          SELECT b, argMax(a, (amt, a)) AS a
          FROM (
            -- all funding from a within b's birth week, summed: a rotation
            -- often arrives as several transfers, none alone ≥90% of the close
            SELECT b, a, sum(amt_row) / 1e12 AS amt, any(first_close) AS first_close
            FROM (
              -- account_transfer_activity is a ReplacingMergeTree keyed
              -- (account, block_height, event_index): a replayed range holds a
              -- transfer twice until its parts merge, and summed as-is it would
              -- count double toward the 90% threshold. The rows are folded onto
              -- that key AFTER the joins — births and exits carry one row per
              -- account, so the joins multiply nothing and only the transfers
              -- that survive them are grouped, a sliver of the ~20 GiB scan a
              -- FINAL or a pre-join fold would have to sort.
              SELECT ta.to_account AS b, ta.account AS a, ta.block_height AS h, ta.event_index AS ei,
                any(toFloat64OrZero(ta.amount)) AS amt_row, any(bi.first_close) AS first_close
              FROM price_data.account_transfer_activity ta
              INNER JOIN births bi ON bi.account_id = ta.to_account
              INNER JOIN exits e ON e.account_id = ta.account
              WHERE ta.asset_id = 0 AND ta.from_account = ta.account AND ta.to_account != ta.account
                AND toMonday(ta.block_timestamp) BETWEEN bi.nzw - 7 AND bi.nzw
                AND arrayExists(x -> x >= toMonday(ta.block_timestamp) AND x <= toMonday(ta.block_timestamp) + 14, e.ews)
                AND ta.to_account NOT IN (SELECT from_account FROM kraken_forwarders)
              GROUP BY b, a, h, ei
            )
            GROUP BY b, a
            HAVING amt >= 0.9 * first_close
          )
          GROUP BY b
        ) x
        INNER JOIN births bi2 ON bi2.account_id = x.a`,
      format: 'JSONEachRow',
    })
    const linkRows = (await linkRes.json<{ b: string; a: string; a_firstnz: string }>())
      .map(r => ({ b: String(r.b), a: String(r.a), aFirstnz: String(r.a_firstnz) }))
    const rot = resolveRotationAnchors(linkRows)
    // transform() needs non-empty constant arrays — a sentinel keeps the shape.
    return { accounts: ['0x__none__', ...rot.accounts], anchors: ['2100-01-01', ...rot.anchors] }
  })
}

const NO_ROTATION = { accounts: ['0x__none__'], anchors: ['2100-01-01'] }

/**
 * The structure over a regular grid (a whole-week grid reads the weekly closes,
 * anything else the hourly ones). The Kraken scope needs no rotation anchors:
 * its accounts are never in the user class the ages rank.
 */
export async function structureBuckets(g: ChartGrid, scope: HdxStructureScope = 'all'): Promise<HdxStructureBucket[]> {
  if (g.grain.monthly) throw new RangeError('the holder structure needs a fixed-step grid')
  const source: HdxStructureSource = isWeeklyAligned(g) ? 'weekly' : 'hourly'
  // The hourly source reads every hourly HDX row from the grid's Monday to its
  // end, and a bucket of a week or more is only ever asked for over a span the
  // row budget cannot hold (HDX_STRUCTURE_HOURLY_ROW_BUDGET): the ~25 GB read a
  // 45-day step over a year would be. structureWindowFloor moves such a grid
  // onto whole weeks before it gets here; a grid that still arrives is refused.
  if (source === 'hourly' && g.grain.stepSec >= WEEK_SEC && scope === 'all') {
    throw new RangeError(`an hourly-source holder structure cannot bucket by ${g.grain.stepSec / DAY_SEC} days: coarsen the grid to whole weeks first`)
  }
  const refs = structureRefs(g)
  const rot = scope === 'all' ? await loadRotationAnchors() : NO_ROTATION
  const res = await client.query({
    query: hdxStructureSql(source, scope),
    query_params: {
      from: g.fromSec, w0: keySeconds(WEEKLY_MONDAY_GRAIN.keyOf(g.fromSec)), end: g.endSec,
      step: g.grain.stepSec, n: g.keys.length, refs, rotAccs: rot.accounts, rotAnchors: rot.anchors,
    },
    format: 'JSONEachRow',
  })
  return mergeHdxStructureRows(refs, await res.json<HdxStructureSqlRow>())
}

// A zoom window on the hourly source reads every hourly HDX row from its Monday
// to its end, and since the balance snapshots began (June 2026) that is a
// restated row for every account every day, ~100k rows and ~140 MiB a day. Past
// this many rows a window is served on the weekly closes instead (a 7-day step)
// rather than run a multi-GiB read; before the snapshots any span fits.
//
// Headroom: at the budget the structure query peaks near 2.5 GB against the
// api's 4 GB per-query cap (API_CLICKHOUSE_SETTINGS.max_memory_usage), so the
// budget is the memory bound, not a latency taste. Peak memory grows with the
// rows; re-measure query_log's memory_usage before raising it past ~1.7M, where
// the extrapolation meets the cap.
export const HDX_STRUCTURE_HOURLY_ROW_BUDGET = 1_100_000

async function hourlyRowsFor(g: ChartGrid): Promise<number> {
  const w0 = keySeconds(WEEKLY_MONDAY_GRAIN.keyOf(g.fromSec))
  return cachedSwr(`explorer:hdx:hourly-rows:${w0}:${g.endSec}`, 600_000, 600_000, async () => {
    const res = await client.query({
      query: `SELECT count() AS n FROM price_data.account_balance_hourly
              WHERE asset_id = '0' AND interval_start >= toDateTime({w0:UInt32}) AND interval_start < toDateTime({end:UInt32})`,
      query_params: { w0, end: g.endSec },
      format: 'JSONEachRow',
    })
    return Number((await res.json<{ n: number | string }>())[0]?.n ?? 0)
  })
}

/**
 * The whole-week step at or above `stepSec`: the ladder's own rung where it has
 * one (10 days → 14), else the next multiple of a week (a 30-day rung → 5 weeks,
 * 45 → 7, 60 → 9, 90 → 13, 180 → 26). Never fewer buckets' worth of span than
 * the step asked for, so a window stays inside its point budget.
 */
export function wholeWeekStepAtLeast(stepSec: number): number {
  return Math.ceil(stepSec / WEEK_SEC) * WEEK_SEC
}

/**
 * The step a structure window must coarsen to, or null when its grid is
 * affordable as resolved. A step of a week or more that is not whole weeks (the
 * 10-day rung over multi-year spans, the 30-day-and-up rungs a small point
 * budget resolves to) moves to whole weeks, whose buckets the weekly closes
 * state exactly; every such window is a span the hourly source could not hold
 * within budget, so it never stays hourly. Below a week the hourly rows are
 * counted against the budget and a window past it moves to single weeks.
 */
async function structureWindowFloor(g: ChartGrid): Promise<number | null> {
  if (isWeeklyAligned(g)) return null
  if (g.grain.stepSec >= WEEK_SEC) return wholeWeekStepAtLeast(g.grain.stepSec)
  return (await hourlyRowsFor(g)) > HDX_STRUCTURE_HOURLY_ROW_BUDGET ? WEEK_SEC : null
}

// The dashboard's structure grids: Monday weeks from the series start, and
// calendar months from its first month.
function hdxWeekGrid(): ChartGrid {
  return fullChartGrid(WEEKLY_MONDAY_GRAIN, WEEKLY_MONDAY_GRAIN.grid(HDX_SERIES_START_SEC, nowSec()))
}
function hdxMonthGrid(): ChartGrid {
  return fullChartGrid(MONTHLY_GRAIN, MONTHLY_GRAIN.grid(HDX_TREND_START_SEC, nowSec()))
}

/**
 * Where each month samples a Monday-week series: the week holding the month's
 * last day, whose close is that month's balance-derived figure (the grain the
 * monthly trends were built on), or the newest week for a month still running.
 */
export function monthWeekIndex(months: string[], weeks: string[]): number[] {
  const at = new Map(weeks.map((w, i) => [w, i]))
  return months.map(m => {
    const lastDay = grainBucketEndSec(MONTHLY_GRAIN, m) - DAY_SEC
    return at.get(WEEKLY_MONDAY_GRAIN.keyOf(lastDay)) ?? weeks.length - 1
  })
}

const hdxRaw = (s: string | number | bigint | null | undefined): number => hdxNumberFromRaw(BigInt(s ?? 0))
const wholeHdx = (raw: bigint): number => Math.round(hdxNumberFromRaw(raw))
const round2 = (v: number) => Math.round(v * 100) / 100

/** Top-100 user wallets' share of user-held supply, %, two decimals — null without user supply. */
function top100Share(b: HdxStructureBucket): number | null {
  return b.user > 0n ? round2(Number(b.top10 + b.top11to100) / Number(b.user) * 100) : null
}

// Allocation-realization mints, classified like every other balance (see
// backfillAllocationMints). The 10M-HDX floor is a 20-character raw amount. The
// scan reads raw_events (~61 GiB), so it is cached for the dashboard and every
// zoom window alike.
async function loadAllocationMints(): Promise<HdxAllocationMintRow[]> {
  return cachedSwr('explorer:hdx-allocation-mints', 3_600_000, 48 * 3_600_000, async () => {
    const res = await client.query({
      query: `
        WITH
        ${tagAccountsSql(KRAKEN_TAG_IDS)} AS kraken_accts,
        ${tagAccountsSql(POOL_TAG_IDS)} AS pool_accts
        SELECT toString(toMonday(block_timestamp)) AS week, toUnixTimestamp(block_timestamp) AS ts,
          multiIf(
            who = '${TREASURY_ACCOUNT}', 'treasury',
            startsWith(who, '0x6d6f646c') OR has(pool_accts, who), 'protocol',
            has(kraken_accts, who), 'kraken',
            'user') AS cls,
          toFloat64(JSONExtractString(args_json, 'amount')) / 1e12 AS hdx
        FROM price_data.raw_events
        WHERE event_name = 'Balances.Deposit'
          AND length(JSONExtractString(args_json, 'amount')) >= 20
          AND (JSONExtractString(args_json, 'who') AS who) != ''
        ORDER BY block_height, event_index`,
      format: 'JSONEachRow',
    })
    return (await res.json<{ week: string; ts: number; cls: string; hdx: number }>())
      .map(r => ({ week: String(r.week), ts: Number(r.ts), cls: String(r.cls), hdx: Number(r.hdx) }))
  })
}

// Staking sinks, cumulative. Classic staking uses its lock; the GIGAHDX band is
// the pallet's TotalLocked, which is exactly Σ Staked.amount + Σ
// YieldRealized.amount − Σ Unstaked.payout (the flow sum gigahdx_stake_events
// documents; equal to storage at the head). A migration DOUBLE-EMITS
// GigaHdx.Staked next to MigratedFromLegacy, and so does a cancelled unstake next
// to UnstakeCancelled, so only Staked is summed — counting either twin
// overcounts — while the matching classic ForceUnstaked drains the classic side,
// so the migration reads as a handoff between the two bands, not new stake.
// YieldRealized moves the gigahdx! pot's yield into the staker's lock, and the
// Unstaked payout later releases it with the rest, so leaving it out drifts the
// band low by every realization. Integer planck throughout.
export const GIGAHDX_LOCKED_DELTA_SQL = `sumIf(toInt256OrZero(JSONExtractString(args_json, 'amount')), event_name IN ('GigaHdx.Staked', 'GigaHdx.YieldRealized'))
            - sumIf(toInt256OrZero(JSONExtractString(args_json, 'payout')), event_name = 'GigaHdx.Unstaked')`
const CLASSIC_STAKED_DELTA_SQL = `sumIf(toInt256OrZero(JSONExtractString(args_json, 'stake')), event_name IN ('Staking.PositionCreated', 'Staking.StakeAdded'))
            - sumIf(toInt256OrZero(JSONExtractString(args_json, 'unlockedStake')), event_name = 'Staking.Unstaked')
            - sumIf(toInt256OrZero(JSONExtractString(args_json, 'stake')), event_name = 'Staking.ForceUnstaked')`

// Rows at or after the grid's end are never read; the block bound only prunes.
const hdxGridParams = (g: ChartGrid) => ({ from: g.fromSec, end: g.endSec, lo: g.fromHeight, hi: g.toHeight })

/** Staked HDX at each bucket end: a running total, so every earlier row folds into bucket 0. */
export function hdxStakedSql(g: ChartGrid): string {
  return `
    SELECT k, toString(sum(cd) OVER (ORDER BY k)) AS classic, toString(sum(gd) OVER (ORDER BY k)) AS giga
    FROM (
      SELECT ${g.grain.keySql('block_timestamp')} AS k,
        ${CLASSIC_STAKED_DELTA_SQL} AS cd,
        ${GIGAHDX_LOCKED_DELTA_SQL} AS gd
      FROM price_data.staking_activity FINAL
      WHERE block_timestamp < toDateTime({end:UInt32}) AND block_height <= {hi:UInt32}
      GROUP BY k)
    ORDER BY k`
}

async function stakedSeries(g: ChartGrid): Promise<{ classic: (number | null)[]; giga: (number | null)[] }> {
  const res = await client.query({ query: hdxStakedSql(g), query_params: hdxGridParams(g), format: 'JSONEachRow' })
  const rows = await res.json<{ k: string; classic: string; giga: string }>()
  const band = (pick: (r: { classic: string; giga: string }) => string) =>
    carryForwardValues(alignToGrid(g.keys, rows.map(r => ({ k: r.k, v: wholeHdx(BigInt(pick(r))) }))))
  return { classic: band(r => r.classic), giga: band(r => r.giga) }
}

/** HDX's close per bucket: day candles on a day-multiple grain, hour candles below. A flow, so only the grid's own candles. */
export function hdxPriceSql(g: ChartGrid): string {
  const table = g.grain.stepSec % DAY_SEC === 0 ? 'ohlc_1d' : 'ohlc_1h'
  return `
    SELECT k, toFloat64(argMax(c, t)) AS v
    FROM (
      SELECT interval_start AS t, ${g.grain.keySql('interval_start')} AS k, argMaxMerge(close_state) AS c
      FROM price_data.${table}
      WHERE asset_id = 0 AND interval_start >= toDateTime({from:UInt32}) AND interval_start < toDateTime({end:UInt32})
      GROUP BY interval_start)
    GROUP BY k ORDER BY k`
}

async function priceSeries(g: ChartGrid): Promise<(number | null)[]> {
  const res = await client.query({ query: hdxPriceSql(g), query_params: hdxGridParams(g), format: 'JSONEachRow' })
  return alignToGrid(g.keys, (await res.json<{ k: string; v: number }>()).map(r => ({ k: r.k, v: Number(r.v) })))
}

/**
 * Cumulative HDX the treasury bought through its own buy-side DCA schedules
 * (revenue recycled into HDX — schedule 30104 et al.), at each bucket end.
 */
export function hdxBuybackSql(g: ChartGrid): string {
  return `
    SELECT k, toString(sum(raw) OVER (ORDER BY k)) AS v
    FROM (
      SELECT ${g.grain.keySql('e.block_timestamp')} AS k, sum(toUInt256OrZero(e.amount_out)) AS raw
      FROM price_data.dca_events e FINAL
      INNER JOIN (
        -- FINAL for the same reason the execution side carries it: dca_schedules
        -- is ReplacingMergeTree(block_height), so an unresolved replacement both
        -- matches this filter on a superseded row and, being an INNER JOIN key,
        -- multiplies every execution it pairs with — inflating the cumulative
        -- buyback series rather than merely duplicating a row.
        SELECT id FROM price_data.dca_schedules FINAL
        WHERE who = '${TREASURY_ACCOUNT}' AND asset_out = 0 AND asset_in != 0
      ) s ON e.id = s.id
      WHERE e.event_name = 'DCA.TradeExecuted' AND e.block_timestamp < toDateTime({end:UInt32}) AND e.block_height <= {hi:UInt32}
      GROUP BY k)
    ORDER BY k`
}

async function buybackSeries(g: ChartGrid): Promise<(number | null)[]> {
  const res = await client.query({ query: hdxBuybackSql(g), query_params: hdxGridParams(g), format: 'JSONEachRow' })
  return carryForwardValues(alignToGrid(g.keys, (await res.json<{ k: string; v: string }>()).map(r => ({ k: r.k, v: wholeHdx(BigInt(r.v)) }))))
}

/**
 * Aggregate cost basis (realized price) of user-held HDX at each Monday week's
 * close. Account-level accounting: balance increases are bought at that week's
 * close (weeks before the price era at the first observed close), decreases
 * release cost proportionally; arrayFold carries (cost history, prev balance,
 * cost). The cost is BOOKED weekly — that is its grain, and a zoom shows it
 * carried forward between week closes rather than inventing a finer basis.
 * Summed as per-account deltas at the weeks they changed, then run forward, so
 * the aggregate needs no per-cut expansion; the balance side is integer planck.
 */
export function hdxRealizedWeeklySql(): string {
  return `
    WITH
    ${tagAccountsSql([...KRAKEN_TAG_IDS, ...POOL_TAG_IDS])} AS special_accts,
    -- Weekly HDX close, FORWARD-FILLED onto the contiguous Monday grid
    -- through the current week. A ClickHouse map subscript on a missing key
    -- returns the value type's default, and 0.0 is indistinguishable from a
    -- real price: an account that increased its balance in a week with no
    -- asset-0 candle would book that tranche at a $0 cost basis, which
    -- arrayFold then carries forward for the rest of its history. The
    -- price_era guard below only covers weeks BEFORE the first candle, not
    -- a gap inside the era, so the gap has to be closed here.
    (SELECT mapFromArrays(grid, arrayFill(x -> x > 0., arrayMap(g -> m[g], grid))) FROM (
      SELECT mapFromArrays(groupArray(w), groupArray(toFloat64(px))) AS m,
        min(w) AS minw, greatest(max(w), toStartOfWeek(today(), 1)) AS maxw,
        arrayMap(i -> minw + toIntervalDay(7 * i), range(toUInt32(intDiv(dateDiff('day', minw, maxw), 7)) + 1)) AS grid
      FROM (
        SELECT toStartOfWeek(interval_start, 1) AS w, argMaxMerge(close_state) AS px
        FROM price_data.ohlc_1d WHERE asset_id = 0 GROUP BY w
      )
    )) AS pmap,
    -- assumeNotNull: a Nullable scalar here would poison the arrayFold
    -- accumulator type (lambda returns Nullable, accumulator is not)
    assumeNotNull((SELECT min(toStartOfWeek(interval_start, 1)) FROM price_data.ohlc_1d WHERE asset_id = 0)) AS price_era,
    assumeNotNull((SELECT toFloat64(argMaxMerge(close_state)) FROM price_data.ohlc_1d WHERE asset_id = 0
      AND toStartOfWeek(interval_start, 1) = (SELECT min(toStartOfWeek(interval_start, 1)) FROM price_data.ohlc_1d WHERE asset_id = 0))) AS seed_px
    SELECT toString(w) AS w, toString(sum(sum(dbal)) OVER (ORDER BY w)) AS bal, toString(sum(sum(dcost)) OVER (ORDER BY w)) AS cost
    FROM (
      SELECT t.1 AS w, t.2 AS dbal, t.3 AS dcost
      FROM (
        SELECT ws, bsI,
          arrayFold((acc, t) -> tuple(
              arrayPushBack(acc.1,
                if(t.2 >= acc.2,
                   acc.3 + ((t.2 - acc.2) / 1e12) * if(t.1 < price_era, seed_px, pmap[t.1]),
                   acc.3 * if(acc.2 > 0., t.2 / acc.2, 0.))),
              t.2,
              if(t.2 >= acc.2,
                 acc.3 + ((t.2 - acc.2) / 1e12) * if(t.1 < price_era, seed_px, pmap[t.1]),
                 acc.3 * if(acc.2 > 0., t.2 / acc.2, 0.))
            ), arrayZip(ws, bsF), tuple(emptyArrayFloat64(), 0., 0.)).1 AS costs
        FROM (
          SELECT account_id,
            arraySort(groupArray(w)) AS ws,
            arraySort((b, ww) -> ww, groupArray(balF), groupArray(w)) AS bsF,
            arraySort((b, ww) -> ww, groupArray(balI), groupArray(w)) AS bsI
          FROM (
            SELECT account_id, week_start AS w, argMaxMerge(balance_state) AS b0,
              toFloat64(toUInt256OrZero(b0)) AS balF, toInt256(toUInt256OrZero(b0)) AS balI
            FROM price_data.account_balance_weekly
            WHERE asset_id = '0' AND NOT startsWith(account_id, '0x6d6f646c')
              AND NOT has(special_accts, account_id)
            GROUP BY account_id, week_start
          ) GROUP BY account_id
        )
      )
      -- The cost deltas are taken and summed in Decimal256: a genesis pot recorded
      -- 1e12x too high carries an ~8e18 USD cost for a few weeks, and a Float64
      -- delta against it (or a running Float64 sum through it) rounds every
      -- other account's cost to its 1,024-unit ulp — 0.3% off the aggregate.
      ARRAY JOIN arrayMap(j -> (ws[j], bsI[j] - if(j = 1, toInt256(0), bsI[j - 1]),
        toDecimal256(costs[j], 6) - if(j = 1, toDecimal256(0, 6), toDecimal256(costs[j - 1], 6))), arrayEnumerate(ws)) AS t
    )
    GROUP BY w ORDER BY w`
}

/** Realized price at each week close ('YYYY-MM-DD' Monday → USD), 8 decimals. */
async function loadRealizedWeekly(): Promise<Map<string, number>> {
  return cachedSwr('explorer:hdx-realized-weekly', 3_600_000, 48 * 3_600_000, async () => {
    const res = await client.query({ query: hdxRealizedWeeklySql(), format: 'JSONEachRow' })
    const out = new Map<string, number>()
    for (const r of await res.json<{ w: string; bal: string; cost: string }>()) {
      const bal = BigInt(r.bal)
      if (bal > 0n) out.set(String(r.w), Math.round(Number(r.cost) / hdxNumberFromRaw(bal) * 1e8) / 1e8)
    }
    return out
  })
}

/**
 * The realized price at each bucket end, at its booking grain: the value of the
 * newest week whose close is at or before the end, carried forward.
 */
export function realizedAtEnds(weekly: Map<string, number>, ends: number[]): (number | null)[] {
  const weeks = [...weekly.keys()].sort()
  const closes = weeks.map(w => keySeconds(w) + WEEK_SEC)
  let j = -1
  return ends.map(e => {
    while (j + 1 < closes.length && closes[j + 1] <= e) j++
    return j >= 0 ? weekly.get(weeks[j])! : null
  })
}

/**
 * The structure as the dashboard ships it (HDX numbers) from builder buckets.
 * Allocation mints are counted in their band at every bucket ending at or before
 * the mint (backfillAllocationMints).
 */
function ownershipOf(g: ChartGrid, b: HdxStructureBucket[], mints: HdxAllocationMintRow[]) {
  const rows: HdxStructureWeekRow[] = b.map((x, i) => ({
    week: g.keys[i],
    treasury: hdxRaw(x.treasury), protocol: hdxRaw(x.protocol), kraken: hdxRaw(x.kraken),
    user_total: hdxRaw(x.user),
    top10: hdxRaw(x.top10), top100: hdxRaw(x.top11to100), top1000: hdxRaw(x.top101to1000),
    hhi: x.user > 0n ? Number(x.sq) / (Number(x.user) * Number(x.user)) : 0,
    age_0_3m: hdxRaw(x.ages[0]), age_3_12m: hdxRaw(x.ages[1]), age_1_2y: hdxRaw(x.ages[2]), age_2y: hdxRaw(x.ages[3]),
  }))
  const base = buildHdxStructure(rows)
  const backfilled = backfillAllocationMintsAt(base.ownership, g.keys.map(k => grainBucketEndSec(g.grain, k)), mints)
  return { base, backfilled }
}

async function loadStructure(): Promise<HdxStructure> {
  return cachedSwr('explorer:hdx-structure:model:2', 3_600_000, 48 * 3_600_000, async () => {
    const wg = hdxWeekGrid()
    const mg = hdxMonthGrid()
    // The structure runs ALONE before the lighter queries fire in parallel: a
    // fully concurrent cold burst can brush ClickHouse's 20s execution cap.
    const buckets = await structureBuckets(wg)
    // Unique non-module accounts trading HDX per month.
    const tradersQuery = client.query({
      query: `
        SELECT toString(toStartOfMonth(b.block_timestamp)) AS m, uniqExact(t.account) AS v
        FROM price_data.trade_volume_by_account t
        INNER JOIN price_data.blocks b ON t.block_height = b.block_height
        WHERE t.asset_id = 0 AND NOT startsWith(t.account, '0x6d6f646c')
        GROUP BY m ORDER BY m`,
      format: 'JSONEachRow',
    })
    // Capital active in governance per quarter: per voter the LARGEST single
    // vote (the lock that capital carries), summed — naive turnout re-counts
    // the same capital on every referendum (3× supply). Spans Democracy and
    // OpenGov via the (pallet, ref_index) key.
    const govQuery = client.query({
      query: `
        SELECT toString(g.q) AS q, round(sum(g.max_cap) / 1e12, 0) AS capital, uniqExact(g.who) AS voters
        FROM (
          SELECT q, who, max(cap) AS max_cap FROM (
            SELECT toStartOfQuarter(block_timestamp) AS q, who, (pallet, ref_index) AS ref,
              argMax(if(vote_kind = 'Standard', toFloat64OrZero(balance),
                toFloat64OrZero(aye) + toFloat64OrZero(nay) + toFloat64OrZero(abstain)),
                (block_height, ifNull(extrinsic_index, 0))) AS cap
            FROM price_data.governance_vote_calls WHERE success = 1 AND vote_kind != ''
            GROUP BY q, who, ref
          ) GROUP BY q, who
        ) AS g GROUP BY g.q ORDER BY g.q`,
      format: 'JSONEachRow',
    })
    const [mints, stakedMonthly, stakedWeekly, buybackHdx, marketPrice, realizedWeekly, tradersRes, govRes] = await Promise.all([
      loadAllocationMints(), stakedSeries(mg), stakedSeries(wg), buybackSeries(mg), priceSeries(mg), loadRealizedWeekly(),
      tradersQuery, govQuery,
    ])
    const { base, backfilled: backfilledAllocationHdx } = ownershipOf(wg, buckets, mints)
    const tradersRows = (await tradersRes.json<{ m: string; v: number }>()).map(r => ({ m: String(r.m), v: Number(r.v) }))
    const govRows = (await govRes.json<{ q: string; capital: number; voters: number }>())
      .map(r => ({ q: String(r.q), capital: Number(r.capital), voters: Number(r.voters) }))

    // The monthly trend grid spans the balance era to the current month. Staked,
    // buyback and price are stated at each month's end; the balance-derived
    // trends (user supply, top-100 share, Kraken custody, cost basis) at the
    // close of the week holding the month's last day — the weekly structure
    // sampled — and the liquid float subtracts the stake standing at that SAME
    // close, so both of its terms are one instant.
    const months = mg.keys
    const at = monthWeekIndex(months, wg.keys)
    const weekEnds = wg.keys.map(k => grainBucketEndSec(wg.grain, k))
    const realizedByWeek = realizedAtEnds(realizedWeekly, weekEnds)
    return {
      ...base,
      backfilledAllocationHdx,
      trends: {
        months,
        stakedClassic: stakedMonthly.classic,
        stakedGiga: stakedMonthly.giga,
        liquidFloat: at.map(i => liquidFloatAt(buckets[i], stakedWeekly.classic[i], stakedWeekly.giga[i])),
        realizedPrice: at.map(i => realizedByWeek[i]),
        marketPrice,
        top100Share: at.map(i => top100Share(buckets[i])),
        krakenHdx: at.map(i => wholeHdx(buckets[i].kraken)),
        buybackHdx,
        traders: alignMonthly(months, tradersRows),
        gov: { quarters: govRows.map(r => r.q), capital: govRows.map(r => r.capital), voters: govRows.map(r => r.voters) },
      },
    }
  })
}

/** User-held supply less the stake standing at the same instant, whole HDX; null without user supply. */
function liquidFloatAt(b: HdxStructureBucket, classic: number | null, giga: number | null): number | null {
  return b.user > 0n ? wholeHdx(b.user) - (classic ?? 0) - (giga ?? 0) : null
}

// ── buys vs sells, holder churn: one builder each ───────────────────────────

/**
 * HDX bought and sold by non-module accounts per bucket, and how many distinct
 * accounts did each. Volume sums the PRINCIPAL side only: an OTC fill books both
 * of its accounts (see `counterparty` in src/db/schema.ts), and adding the
 * maker's mirrored row to the taker's would report the same HDX twice. The
 * buyer/seller COUNTS stay over both sides, because an OTC maker whose resting
 * order was hit really was a seller. The volume table has no timestamp, so the
 * block's own time dates each row. Read FINAL — one row per (asset, block,
 * account), replaced on a replayed range — bounded by the grid's block range.
 */
export function hdxFlowsSql(g: ChartGrid): string {
  return `
    SELECT ${g.grain.keySql('b.block_timestamp')} AS k,
      toString(sumIf(t.native_volume_buy, t.counterparty = 0)) AS buy,
      toString(sumIf(t.native_volume_sell, t.counterparty = 0)) AS sell,
      uniqExactIf(t.account, t.native_volume_buy > 0) AS buyers, uniqExactIf(t.account, t.native_volume_sell > 0) AS sellers
    FROM price_data.trade_volume_by_account AS t FINAL
    INNER JOIN price_data.blocks AS b ON b.block_height = t.block_height
    WHERE t.asset_id = 0 AND t.block_height >= {lo:UInt32} AND t.block_height <= {hi:UInt32}
      AND NOT startsWith(t.account, '0x6d6f646c')
      AND b.block_height >= {lo:UInt32} AND b.block_height <= {hi:UInt32}
      AND b.block_timestamp >= toDateTime({from:UInt32}) AND b.block_timestamp < toDateTime({end:UInt32})
    GROUP BY k ORDER BY k`
}

/** A flow: a bucket without trades inside the indexed range is a real zero. */
async function flowsSeries(g: ChartGrid): Promise<{ buy: number[]; sell: number[]; buyers: number[]; sellers: number[] }> {
  const res = await client.query({ query: hdxFlowsSql(g), query_params: hdxGridParams(g), format: 'JSONEachRow' })
  const index = new Map(g.keys.map((k, i) => [k, i]))
  const zero = () => new Array<number>(g.keys.length).fill(0)
  const out = { buy: zero(), sell: zero(), buyers: zero(), sellers: zero() }
  for (const r of await res.json<{ k: string; buy: string; sell: string; buyers: number; sellers: number }>()) {
    const i = index.get(r.k)
    if (i == null) continue
    out.buy[i] = hdxRaw(r.buy)
    out.sell[i] = hdxRaw(r.sell)
    out.buyers[i] = Number(r.buyers)
    out.sellers[i] = Number(r.sellers)
  }
  return out
}

/**
 * New and exited holders per bucket: an account is new in the bucket of its
 * first nonzero HDX balance, and exited in the bucket of its last nonzero one if
 * it holds none today (an account that left and came back is not an exit).
 */
export function hdxChurnSql(g: ChartGrid): string {
  return `
    WITH lifetime AS (
      SELECT account_id,
        minMerge(first_nonzero_state) AS first_nonzero,
        maxMerge(last_nonzero_state) AS last_nonzero
      FROM price_data.hdx_holder_lifetime
      GROUP BY account_id
    ), current_balances AS (
      SELECT account_id, toUInt256OrZero(argMaxMerge(total_state)) AS current
      FROM price_data.account_asset_latest_balances
      WHERE asset_id = '0'
      GROUP BY account_id
    )
    SELECT ${g.grain.keySql('first_nonzero')} AS k, count() AS n, 0 AS is_exit
    FROM lifetime
    WHERE first_nonzero >= toDateTime({from:UInt32}) AND first_nonzero < toDateTime({end:UInt32})
    GROUP BY k
    UNION ALL
    SELECT ${g.grain.keySql('last_nonzero')} AS k, count() AS n, 1 AS is_exit
    FROM lifetime
    LEFT JOIN current_balances USING account_id
    WHERE ifNull(current, toUInt256(0)) = 0
      AND last_nonzero >= toDateTime({from:UInt32}) AND last_nonzero < toDateTime({end:UInt32})
    GROUP BY k`
}

async function churnSeries(g: ChartGrid): Promise<{ newHolders: number[]; exitedHolders: number[] }> {
  const res = await client.query({ query: hdxChurnSql(g), query_params: hdxGridParams(g), format: 'JSONEachRow' })
  const index = new Map(g.keys.map((k, i) => [k, i]))
  const newHolders = new Array<number>(g.keys.length).fill(0)
  const exitedHolders = new Array<number>(g.keys.length).fill(0)
  for (const r of await res.json<{ k: string; n: number; is_exit: number }>()) {
    const i = index.get(r.k)
    if (i == null) continue
    if (Number(r.is_exit)) exitedHolders[i] += Number(r.n)
    else newHolders[i] += Number(r.n)
  }
  return { newHolders, exitedHolders }
}

// ── chart-zoom windows ──────────────────────────────────────────────────────

/** Every zoomable /hdx chart, by the id the window route takes. */
export const HDX_WINDOW_CHARTS = [
  'ownership', 'loyalty', 'staked', 'float', 'priceCost', 'buyback', 'top100', 'kraken', 'flows', 'churn',
] as const
export type HdxWindowChart = typeof HDX_WINDOW_CHARTS[number]

type WindowSeries = Record<string, (number | null)[]>

/** At most `slots` calls inside at once; the rest wait their turn in order. */
function concurrencyGate(slots: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  const release = () => {
    active--
    waiting.shift()?.()
  }
  return async fn => {
    if (active >= slots) await new Promise<void>(resolve => waiting.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

// The structure of one window grid is shared by every structure chart zoomed to
// it (ownership, loyalty, top-100, float): one query per grid, briefly cached.
//
// Distinct grids share nothing, and a full-scope structure window is the
// explorer's heaviest request-time read (up to ~2.5 GB per query on the hourly
// source), so at most two run at once; further windows queue in order. The
// dashboard build (loadStructure, hourly, single-flight) does not take a slot:
// it is one query an hour and must not wait behind zooms. The Kraken scope is
// a primary-key read over a handful of wallets and does not take one either.
const structureWindowSlots = concurrencyGate(2)

function windowStructure(g: ChartGrid, scope: HdxStructureScope = 'all'): Promise<HdxStructureBucket[]> {
  return cachedSwr(`explorer:hdx:window-structure:${scope}:${g.grain.stepSec}:${g.fromSec}:${g.endSec}`, 60_000, 60_000,
    () => (scope === 'all' ? structureWindowSlots(() => structureBuckets(g, scope)) : structureBuckets(g, scope)))
}

const WINDOW_BUILDERS: Record<HdxWindowChart, (g: ChartGrid) => Promise<WindowSeries>> = {
  ownership: async g => {
    const [b, mints] = await Promise.all([windowStructure(g), loadAllocationMints()])
    return { ...ownershipOf(g, b, mints).base.ownership }
  },
  loyalty: async g => ({ ...ownershipOf(g, await windowStructure(g), []).base.hodl }),
  staked: stakedSeries,
  float: async g => {
    const [b, staked] = await Promise.all([windowStructure(g), stakedSeries(g)])
    return { float: b.map((x, i) => liquidFloatAt(x, staked.classic[i], staked.giga[i])) }
  },
  priceCost: async g => {
    const [market, weekly] = await Promise.all([priceSeries(g), loadRealizedWeekly()])
    return { market, realized: realizedAtEnds(weekly, g.keys.map(k => grainBucketEndSec(g.grain, k))) }
  },
  buyback: async g => ({ buyback: await buybackSeries(g) }),
  top100: async g => ({ top100: (await windowStructure(g)).map(top100Share) }),
  kraken: async g => ({ kraken: (await windowStructure(g, 'kraken')).map(x => wholeHdx(x.kraken)) }),
  flows: flowsSeries,
  churn: churnSeries,
}

// The charts built on the holder structure: their windows coarsen to whole weeks
// when the hourly source would be too heavy (HDX_STRUCTURE_HOURLY_ROW_BUDGET).
const STRUCTURE_CHARTS = new Set<HdxWindowChart>(['ownership', 'loyalty', 'float', 'top100'])

/**
 * One /hdx chart rebuilt over a zoom window on the finest ladder grain that fits
 * `points` (never below an hour), by the same builder the dashboard's series uses.
 */
export function getHdxChartWindow(chart: HdxWindowChart, req: ChartWindowRequest): Promise<ChartWindowResponse> {
  const startSec = chart === 'staked' || chart === 'priceCost' || chart === 'buyback' ? HDX_TREND_START_SEC : HDX_SERIES_START_SEC
  return serveChartWindow(client, 'hdx', chart, req, {
    startSec,
    coarsen: STRUCTURE_CHARTS.has(chart) ? structureWindowFloor : undefined,
  }, WINDOW_BUILDERS[chart])
}

// Module (modl) accounts are pallet plumbing and stay out of the movers list —
// EXCEPT the ones the tag registry names as real economic actors (Treasury,
// HSM, fee pots). The Treasury's DCA program alone can be the top accumulator.
export function moverAccountFilterSql(taggedModuleAccounts: string[]): string {
  const base = `NOT startsWith(account, '0x6d6f646c')`
  if (!taggedModuleAccounts.length) return base
  return `(${base} OR account IN (${taggedModuleAccounts.map(a => `'${a}'`).join(',')}))`
}

async function loadTopMovers(): Promise<HdxDashboard['topMovers']> {
  const head = await loadHead()
  // Wall-clock 7d window (a fixed block-count offset undersizes it: ~6s today, 2s planned).
  const from = await cutoffHeightForWindow(7 * 24, head.height)
  const taggedModl = economicModuleAccounts(allTags())
  const res = await client.query({
    query: `
      SELECT account, toFloat64(sum(native_volume_buy)) / 1e12 AS bought, toFloat64(sum(native_volume_sell)) / 1e12 AS sold
      FROM price_data.trade_volume_by_account
      WHERE asset_id = 0 AND block_height >= {from:UInt32} AND ${moverAccountFilterSql(taggedModl)}
      GROUP BY account HAVING bought + sold > 0`,
    query_params: { from },
    format: 'JSONEachRow',
  })
  const rows = (await res.json<{ account: string; bought: number; sold: number }>())
    .map(r => ({ account: r.account, boughtHdx: Number(r.bought), soldHdx: Number(r.sold), netHdx: Number(r.bought) - Number(r.sold) }))
  const accumulators = rows.filter(r => r.netHdx > 0).sort((a, b) => b.netHdx - a.netHdx).slice(0, 8)
  const distributors = rows.filter(r => r.netHdx < 0).sort((a, b) => a.netHdx - b.netHdx).slice(0, 8)
  // Current HDX balance of each listed mover (one point-lookup for the ≤16 ids).
  const ids = [...new Set([...accumulators, ...distributors].map(r => r.account))]
  const balByAccount = new Map<string, number>()
  if (ids.length) {
    const balRes = await client.query({
      query: `SELECT account_id, toFloat64(argMaxMerge(total_state)) / 1e12 AS bal
              FROM price_data.account_asset_latest_balances
              WHERE asset_id = '0' AND account_id IN ({ids:Array(String)})
              GROUP BY account_id`,
      query_params: { ids }, format: 'JSONEachRow',
    })
    for (const r of await balRes.json<{ account_id: string; bal: number }>()) balByAccount.set(r.account_id, Number(r.bal))
  }
  const mover = (r: typeof rows[number]): HdxMover => ({ account: accountRef(r.account), balanceHdx: balByAccount.get(r.account) ?? 0, boughtHdx: r.boughtHdx, soldHdx: r.soldHdx, netHdx: r.netHdx })
  return { accumulators: accumulators.map(mover), distributors: distributors.map(mover) }
}
