import type { ClickHouseClient } from '../db/client.ts'
import { blake2AsU8a, xxhashAsU8a } from '@polkadot/util-crypto'
import { u8aToHex, hexToU8a, u8aConcat } from '@polkadot/util'
import { substrateStorageBatch, substrateAllKeys } from './substrateRpc.ts'
import { decodeCompact } from './proxyMultisigService.ts'
import { collectLockBreakdownRows, gigaUnbondingBlocks, persistLockSnapshot, type LockRow } from './lockBreakdownService.ts'
import { cached } from './cache.ts'
import { NOMINAL_RELAY_BLOCK_MS, paraBlockMs } from './blockTime.ts'
import { allTags, economicModuleAccounts } from './tagService.ts'
import { accountRef, ensurePrices, cutoffHeightForWindow, getGigaMarketStats, getGigaLiquidationLevels, type AccountRef, type GigaMarketReserveStat, type GigaLiquidations } from './explorerService.ts'

export { gigaUnbondingBlocks }

// HDX-dashboard chain snapshots: balance locks by lock id, GIGAHDX pending
// unstakes, vesting schedules and conviction-voting prior locks — everything the
// unlock timeline needs. Enumerations run in a background refresh (the largest,
// Balances.Locks, is ~18k entries ≈ a few seconds of chunked reads); request
// handlers only read the in-memory snapshot.

let client: ClickHouseClient

const HDX_DECIMALS = 12n

const prefix = (p: string, s: string) => u8aToHex(u8aConcat(xxhashAsU8a(p, 128), xxhashAsU8a(s, 128)))
const LOCKS_PREFIX = prefix('Balances', 'Locks')
const PENDING_UNSTAKES_PREFIX = prefix('GigaHdx', 'PendingUnstakes')
const VESTING_PREFIX = prefix('Vesting', 'VestingSchedules')
const VOTING_FOR_PREFIX = prefix('ConvictionVoting', 'VotingFor')
const RELAY_HEIGHT_KEY = prefix('ParachainSystem', 'LastRelayChainBlockNumber')
const TWO_SEC_SWITCH_KEY = prefix('Parameters', 'TwoSecBlocksSince')
// The three single keys behind the GIGAHDX exchange rate (see loadGigahdxRate).
// The pallet calls the staked total `TotalLocked`, not `TotalStaked` — a wrong
// name here is a key that simply does not exist, which reads as an empty value
// rather than an error, so the test pins the derived key itself.
const GIGA_TOTAL_LOCKED_KEY = prefix('GigaHdx', 'TotalLocked')
const STHDX_ASSET_ID = 670
const STHDX_ISSUANCE_KEY = (() => {
  const id = new Uint8Array(4)
  new DataView(id.buffer).setUint32(0, STHDX_ASSET_ID, true)
  // Tokens.TotalIssuance is Twox64Concat-keyed on the asset id.
  return u8aToHex(u8aConcat(hexToU8a(prefix('Tokens', 'TotalIssuance')), xxhashAsU8a(id, 64), id))
})()
const GIGA_POT_ACCOUNT = (() => {
  const p = u8aConcat(new TextEncoder().encode('modl'), new TextEncoder().encode('gigahdx!'))
  return u8aConcat(p, new Uint8Array(32 - p.length))
})()
const GIGA_POT_ACCOUNT_KEY = u8aToHex(u8aConcat(
  hexToU8a(prefix('System', 'Account')), blake2AsU8a(GIGA_POT_ACCOUNT, 128), GIGA_POT_ACCOUNT,
))

const u32At = (b: Uint8Array, off: number) => (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0
function u128At(b: Uint8Array, off: number): bigint {
  let n = 0n
  for (let i = 15; i >= 0; i--) n = (n << 8n) | BigInt(b[off + i])
  return n
}
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
export interface VestingScheduleAgg { accountId: string; start: number; period: number; periodCount: number; perPeriod: bigint }
// Per-account lock overlap: the largest non-vesting lock and the raw ormlvest
// amount (which goes stale between claims — see correctVestingLocks).
export interface LockAccount { maxNonVestHdx: number; vestLockHdx: number }
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

// The unlock series the dashboard charts. One key per lock kind that has its
// own schedule; `staking` and the deposit-shaped sources have none.
export type UnlockKey = 'gigahdx' | 'vesting' | 'vote'
// A binding-timeline slice names the lock(s) that were holding the balance when
// the envelope dropped, joining ties with '+'. Attribute a tie to the DATED
// lock that actually gates the release: a conviction prior and a GIGAHDX unbond
// covering the same tokens both have to elapse, but it is the later-clearing
// dated one that decides when the balance moves, and `vote` is the one cause
// here that can also be cleared on demand. Splitting the amount across keys
// would invent a division the envelope does not have.
const UNLOCK_KEY_PRIORITY: UnlockKey[] = ['gigahdx', 'vesting', 'vote']
export function unlockKeyForCause(cause: string): UnlockKey | null {
  const parts = new Set(cause.split('+'))
  return UNLOCK_KEY_PRIORITY.find(k => parts.has(k)) ?? null
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
  const zero = (): Record<UnlockKey, number> => ({ gigahdx: 0, vesting: 0, vote: 0 })
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
      if (!key) continue
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
    lockAccounts.set(accountId, { maxNonVestHdx: toHdx(maxNonVest), vestLockHdx: toHdx(vestLock) })
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
export function cooldownExpiresAt(startBlock: number, switchBlock: number, cooldownBlocks: number): number {
  if (switchBlock === 0xFFFFFFFF || startBlock >= switchBlock) return startBlock + cooldownBlocks
  const oldExpiresAt = startBlock + Math.floor(cooldownBlocks / 3)
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
  const unvestedByAccount = new Map<string, number>()
  for (const s of schedules) {
    const elapsed = Math.max(0, Math.min(s.periodCount, Math.floor((relayHeight - s.start) / s.period)))
    const remaining = BigInt(s.periodCount - elapsed) * s.perPeriod
    if (remaining > 0n) unvestedByAccount.set(s.accountId, (unvestedByAccount.get(s.accountId) ?? 0) + toHdx(remaining))
  }
  let vestingAccounts = 0, vestingHdx = 0, vestedUnclaimedHdx = 0, totalLockedHdx = 0
  for (const [accountId, l] of lockAccounts) {
    const unvested = Math.min(unvestedByAccount.get(accountId) ?? 0, l.vestLockHdx)
    if (unvested > 0) { vestingAccounts++; vestingHdx += unvested }
    vestedUnclaimedHdx += l.vestLockHdx - unvested
    totalLockedHdx += Math.max(l.maxNonVestHdx, unvested)
  }
  return { vestingAccounts, vestingHdx, vestedUnclaimedHdx, totalLockedHdx }
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
export async function loadGigahdxRate(): Promise<number | null> {
  const [staked, pot, issuance] = await substrateStorageBatch([
    GIGA_TOTAL_LOCKED_KEY, GIGA_POT_ACCOUNT_KEY, STHDX_ISSUANCE_KEY,
  ])
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
export interface HdxUnlockBucket { label: string; fromTs: string; toTs: string; gigahdx: number; vesting: number; vote: number }
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
    laterHdx: { gigahdx: number; vesting: number; vote: number }
    unlockableNowHdx: number
    // Releasable right now, split by the lock that held it — the leading "now"
    // column. Sums to unlockableNowHdx.
    nowHdx: { gigahdx: number; vesting: number; vote: number }
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
  return cached('explorer:hdx-dashboard', 300_000, async () => {
    const [prices, head, paraMs, supply, flows, dca, churn, structure, movers, gigaMarket] = await Promise.all([
      ensurePrices(), loadHead(), paraBlockMs(client), loadSupplyCohorts(), loadDailyFlows(), loadDcaFlows(), loadChurn(), loadStructure(), loadTopMovers(),
      getGigaMarketStats().catch(() => null),
    ])
    // Needs the staking exchange rate to express levels as HDX prices; without
    // a snapshot there is none, and the chart is withheld rather than assumed.
    const gigaLiquidations = snapshot
      ? await getGigaLiquidationLevels(snapshot.gigahdxHdxPerShare).catch(() => null)
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
    const buckets = edges.map(e => ({ label: e.label, fromTs: iso(e.from), toTs: iso(e.to), from: e.from, to: e.to, gigahdx: 0, vesting: 0, vote: 0 }))
    const later = { gigahdx: 0, vesting: 0, vote: 0 }
    let unlockableNow = 0
    const put = (type: 'gigahdx' | 'vesting' | 'vote', ts: number, hdx: number) => {
      if (hdx <= 0) return
      if (ts <= now) { unlockableNow += hdx; return }
      if (ts >= horizon) { later[type] += hdx; return }
      const b = buckets.find(x => ts >= x.from && ts < x.to)
      if (b) b[type] += hdx
    }
    let undeterminedVoteHdx = 0
    // What is releasable right now, split by the lock that was holding it.
    let nowByType = { gigahdx: 0, vesting: 0, vote: 0 }
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
      })
      later.gigahdx = series.later.gigahdx
      later.vesting = series.later.vesting
      later.vote = series.later.vote
      nowByType = series.now
      unlockableNow = series.now.gigahdx + series.now.vesting + series.now.vote
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
    const gigaPendingTotal = snap?.pendingUnstakes.reduce((a, p) => a + p.payoutHdx, 0) ?? 0
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
          maturedHdx: gigaMatured.reduce((a, p) => a + p.payoutHdx, 0),
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
  const res = await client.query({
    query: `
      WITH h AS (
        SELECT account_id, toFloat64(argMaxMerge(total_state)) / 1e12 AS bal
        FROM price_data.account_asset_latest_balances WHERE asset_id = '0'
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
  // Wall-clock 60d window; the volume table has no timestamp, so join blocks for
  // the real per-block date instead of extrapolating from a fixed block time
  // (which a fixed block-count offset misses: ~6s today, 2s planned).
  const from = await cutoffHeightForWindow(60 * 24, head.height)
  const res = await client.query({
    query: `
      SELECT toDate(b.block_timestamp) AS d,
        toFloat64(sum(t.native_volume_buy)) / 1e12 AS buy, toFloat64(sum(t.native_volume_sell)) / 1e12 AS sell,
        uniqExactIf(t.account, t.native_volume_buy > 0) AS buyers, uniqExactIf(t.account, t.native_volume_sell > 0) AS sellers
      FROM price_data.trade_volume_by_account t
      INNER JOIN price_data.blocks b ON b.block_height = t.block_height
      WHERE t.asset_id = 0 AND t.block_height >= {from:UInt32} AND NOT startsWith(t.account, '0x6d6f646c')
      GROUP BY d ORDER BY d`,
    query_params: { from },
    format: 'JSONEachRow',
  })
  return (await res.json<{ d: string; buy: number; sell: number; buyers: number; sellers: number }>())
    .map(r => ({ date: r.d, buyHdx: Number(r.buy), sellHdx: Number(r.sell), buyers: Number(r.buyers), sellers: Number(r.sellers) }))
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
async function loadDcaFlows(): Promise<HdxDashboard['flows']['dca']> {
  const total = 'toUInt256OrZero(s.total_amount)'
  const spent = 'ifNull(e.sum_in, toUInt256(0))'
  const remaining = nonNegativeUIntDifferenceSql(total, spent)
  const res = await client.query({
    query: `
      WITH done AS (SELECT DISTINCT id FROM price_data.dca_events WHERE event_name IN ('DCA.Completed', 'DCA.Terminated')),
      execstats AS (SELECT id, count() AS executions,
                           sum(toUInt256OrZero(amount_in)) AS sum_in,
                           sum(toUInt256OrZero(amount_out)) AS sum_out
                    FROM price_data.dca_events WHERE event_name = 'DCA.TradeExecuted' GROUP BY id),
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
      FROM price_data.dca_schedules s
      LEFT ANTI JOIN done ON done.id = s.id
      LEFT JOIN execstats e ON e.id = s.id
      WHERE s.asset_in = 0 OR s.asset_out = 0
      GROUP BY is_sell`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ is_sell: number; orders: number; hdx_per_day: number }>()
  const pick = (sell: boolean) => {
    const r = rows.find(x => Boolean(Number(x.is_sell)) === sell)
    return { orders: Number(r?.orders ?? 0), hdxPerDay: Number(r?.hdx_per_day ?? 0) }
  }
  return { buy: pick(false), sell: pick(true) }
}

async function loadChurn(): Promise<HdxDashboard['churn']> {
  return cached(`explorer:hdx-churn:model`, 1_800_000, async () => {
    const res = await client.query({
      query: `
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
        SELECT toStartOfWeek(first_nonzero) AS wk_new, count() AS n, 0 AS is_exit
        FROM lifetime
        WHERE first_nonzero >= now() - INTERVAL 12 WEEK
        GROUP BY wk_new
        UNION ALL
        SELECT toStartOfWeek(last_nonzero) AS wk_new, count() AS n, 1 AS is_exit
        FROM lifetime
        LEFT JOIN current_balances USING account_id
        WHERE ifNull(current, toUInt256(0)) = 0
          AND last_nonzero >= now() - INTERVAL 12 WEEK
        GROUP BY wk_new`,
      format: 'JSONEachRow',
    })
    const byWeek = new Map<string, { newHolders: number; exitedHolders: number }>()
    for (const r of await res.json<{ wk_new: string; n: number; is_exit: number }>()) {
      const e = byWeek.get(r.wk_new) ?? { newHolders: 0, exitedHolders: 0 }
      if (Number(r.is_exit)) e.exitedHolders += Number(r.n); else e.newHolders += Number(r.n)
      byWeek.set(r.wk_new, e)
    }
    return { weekly: [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([weekStart, v]) => ({ weekStart, ...v })) }
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
const TREASURY_ACCOUNT = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'

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

export interface HdxAllocationMintRow { week: string; cls: string; hdx: number }

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
  let total = 0
  for (const m of mints) {
    if (m.cls !== 'treasury' && m.cls !== 'protocol') continue
    if (!(m.hdx > 0) || m.week <= weeks[0]) continue // already inside the observed balances
    const band = ownership[m.cls]
    for (let i = 0; i < weeks.length && weeks[i] < m.week; i++) band[i] += m.hdx
    total += m.hdx
  }
  return total
}

// Weekly closing HDX balance per account, forward-filled onto the full Monday
// grid (an account keeps its last observed close until the next observation),
// then aggregated per week into ownership classes, user top-N tranches, HHI
// and holder-age bands. ~11M dense rows, ~5s — computed once per cache TTL.
// account_balance_weekly's balance_state argMax picks each week's LAST
// observation, so a within-week round trip collapses to its closing state.
async function loadStructure(): Promise<HdxStructure> {
  return cached('explorer:hdx-structure:model:2', 3_600_000, async () => {
    // USER accounts only (no modl, no pool/Kraken custody), balances as sorted
    // per-account (week, balance) arrays — the base for links and Lorenz.
    // Consumers must declare `special_accts` in their WITH clause.
    const userSeqCtes = `
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
      )`
    // Rotation links resolve BEFORE the main query — the HODL age bands need
    // the inherited anchors as parameters. A move between own wallets then
    // counts as continuous holding instead of resetting to "under 3m".
    const linkRes = await client.query({
      query: `
        WITH
        ${tagAccountsSql(KRAKEN_TAG_IDS)} AS kraken_accts,
        ${tagAccountsSql([...KRAKEN_TAG_IDS, ...POOL_TAG_IDS])} AS special_accts,
        kraken_forwarders AS (
          SELECT DISTINCT from_account FROM price_data.transfer_activity
          WHERE asset_id = 0 AND has(kraken_accts, to_account)
        ),
        ${userSeqCtes},
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
          SELECT b, argMax(a, amt) AS a
          FROM (
            -- all funding from a within b's birth week, summed: a rotation
            -- often arrives as several transfers, none alone ≥90% of the close
            SELECT ta.to_account AS b, ta.account AS a,
              sum(toFloat64OrZero(ta.amount)) / 1e12 AS amt
            FROM price_data.account_transfer_activity ta
            INNER JOIN births bi ON bi.account_id = ta.to_account
            INNER JOIN exits e ON e.account_id = ta.account
            WHERE ta.asset_id = 0 AND ta.from_account = ta.account AND ta.to_account != ta.account
              AND toMonday(ta.block_timestamp) BETWEEN bi.nzw - 7 AND bi.nzw
              AND arrayExists(x -> x >= toMonday(ta.block_timestamp) AND x <= toMonday(ta.block_timestamp) + 14, e.ews)
              AND ta.to_account NOT IN (SELECT from_account FROM kraken_forwarders)
            GROUP BY b, a
            HAVING amt >= 0.9 * any(bi.first_close)
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
    const rotAccs = ['0x__none__', ...rot.accounts]
    const rotAnchors = ['2100-01-01', ...rot.anchors]
    // The dense-fill query runs ALONE before the lighter two fire in parallel:
    // a fully concurrent cold burst can brush ClickHouse's 20s execution cap.
    const structureRes = await client.query({
      query: `
        WITH
        (SELECT toMonday(max(block_timestamp)) FROM price_data.blocks) AS wmax,
        ${tagAccountsSql(KRAKEN_TAG_IDS)} AS kraken_accts,
        ${tagAccountsSql(POOL_TAG_IDS)} AS pool_accts,
        obs AS (
          SELECT account_id, week_start AS w,
            toFloat64(toUInt256OrZero(argMaxMerge(balance_state))) / 1e12 AS bal
          FROM price_data.account_balance_weekly
          WHERE asset_id = '0'
          GROUP BY account_id, w
        ),
        seq AS (
          SELECT account_id,
            arraySort(groupArray(w)) AS ws,
            arraySort((b, ww) -> ww, groupArray(bal), groupArray(w)) AS bs,
            arrayFilter((ww, b) -> b > 0, ws, bs) AS nzws
          FROM obs GROUP BY account_id
        ),
        filled AS (
          SELECT account_id,
            if(length(nzws) > 0, nzws[1], toDate('2100-01-01')) AS firstnz,
            arrayMap(j -> ws[1] + 7 * toInt32(j), range(toUInt64((wmax - ws[1]) / 7) + 1)) AS gw,
            arrayFill(x -> x >= 0,
              arrayMap(p -> if(p > 0, bs[p], -1.),
                arrayMap(j -> indexOf(ws, ws[1] + 7 * toInt32(j)), range(toUInt64((wmax - ws[1]) / 7) + 1)))) AS fb
          FROM seq
        ),
        sel AS (
          SELECT
            multiIf(
              account_id = '${TREASURY_ACCOUNT}', 'treasury',
              startsWith(account_id, '0x6d6f646c') OR has(pool_accts, account_id), 'protocol',
              has(kraken_accts, account_id), 'kraken',
              'user') AS cls,
            t.1 AS week, t.2 AS bal,
            -- holding age from the account's own first balance OR its rotation
            -- chain's root (whichever is older) — see resolveRotationAnchors
            dateDiff('day', least(firstnz,
              transform(account_id, {rotAccs:Array(String)}, {rotAnchors:Array(Date)}, toDate('2100-01-01'))), t.1) AS age_days
          FROM filled
          ARRAY JOIN arrayZip(gw, fb) AS t
          WHERE t.2 > 0 AND t.1 >= toDate({start:String})
        )
        SELECT toString(week) AS week,
          treasury, protocol, kraken, user_total,
          top10, top100, top1000,
          if(user_total > 0, hhi_raw / (user_total * user_total), 0) AS hhi,
          age_0_3m, age_3_12m, age_1_2y, age_2y
        FROM (
          SELECT week,
            sumIf(bal, cls = 'treasury') AS treasury,
            sumIf(bal, cls = 'protocol') AS protocol,
            sumIf(bal, cls = 'kraken') AS kraken,
            sumIf(bal, cls = 'user') AS user_total,
            arraySort(x -> -x, groupArrayIf(bal, cls = 'user')) AS ub,
            arraySum(arraySlice(ub, 1, 10)) AS top10,
            arraySum(arraySlice(ub, 11, 90)) AS top100,
            arraySum(arraySlice(ub, 101, 900)) AS top1000,
            arraySum(arrayMap(x -> x * x, ub)) AS hhi_raw,
            -- band edges at week multiples (13/52/104 weeks): every date here
            -- is a Monday, so age is always a whole number of weeks
            sumIf(bal, cls = 'user' AND age_days < 91) AS age_0_3m,
            sumIf(bal, cls = 'user' AND age_days >= 91 AND age_days < 364) AS age_3_12m,
            sumIf(bal, cls = 'user' AND age_days >= 364 AND age_days < 728) AS age_1_2y,
            sumIf(bal, cls = 'user' AND age_days >= 728) AS age_2y
          FROM sel GROUP BY week
        ) ORDER BY week`,
      query_params: { start: HDX_BALANCE_SERIES_START, rotAccs, rotAnchors },
      format: 'JSONEachRow',
    })
    // Allocation-realization mints, classified like every other balance (see
    // backfillAllocationMints). The 10M-HDX floor is a 20-character raw amount.
    const mintQuery = client.query({
      query: `
        WITH
        ${tagAccountsSql(KRAKEN_TAG_IDS)} AS kraken_accts,
        ${tagAccountsSql(POOL_TAG_IDS)} AS pool_accts
        SELECT toString(toMonday(block_timestamp)) AS week,
          multiIf(
            who = '${TREASURY_ACCOUNT}', 'treasury',
            startsWith(who, '0x6d6f646c') OR has(pool_accts, who), 'protocol',
            has(kraken_accts, who), 'kraken',
            'user') AS cls,
          sum(toFloat64(JSONExtractString(args_json, 'amount')) / 1e12) AS hdx
        FROM price_data.raw_events
        WHERE event_name = 'Balances.Deposit'
          AND length(JSONExtractString(args_json, 'amount')) >= 20
          AND (JSONExtractString(args_json, 'who') AS who) != ''
        GROUP BY week, cls ORDER BY week`,
      format: 'JSONEachRow',
    })
    // ── Monthly trend queries (all validated against live data; each < 1s) ──
    const monthsSql = `arrayMap(i -> toLastDayOfMonth(addMonths(toDate('2022-07-01'), i)),
      range(toUInt64(dateDiff('month', toDate('2022-07-01'), today()) + 1)))`
    // Staking sinks, cumulative per month. Classic staking uses its lock; the
    // GigaHdx migration DOUBLE-EMITS GigaHdx.Staked next to MigratedFromLegacy,
    // so only Staked is summed (counting both overcounts by ~1B) while the
    // matching classic ForceUnstaked drains the classic side — the migration
    // then reads as a handoff between the two bands, not new stake.
    const stakedQuery = client.query({
      query: `
        SELECT toString(m) AS m,
          round(sum(classic_delta) OVER (ORDER BY m) / 1e12, 0) AS classic,
          round(sum(giga_delta) OVER (ORDER BY m) / 1e12, 0) AS giga
        FROM (
          SELECT toStartOfMonth(block_timestamp) AS m,
            sumIf(toFloat64OrZero(JSONExtractString(args_json, 'stake')), event_name IN ('Staking.PositionCreated', 'Staking.StakeAdded'))
            - sumIf(toFloat64OrZero(JSONExtractString(args_json, 'unlockedStake')), event_name = 'Staking.Unstaked')
            - sumIf(toFloat64OrZero(JSONExtractString(args_json, 'stake')), event_name = 'Staking.ForceUnstaked') AS classic_delta,
            sumIf(toFloat64OrZero(JSONExtractString(args_json, 'amount')), event_name IN ('GigaHdx.Staked', 'GigaHdx.UnstakeCancelled'))
            - sumIf(toFloat64OrZero(JSONExtractString(args_json, 'payout')), event_name = 'GigaHdx.Unstaked') AS giga_delta
          FROM price_data.staking_activity
          GROUP BY m
        ) ORDER BY m`,
      format: 'JSONEachRow',
    })
    // Tagged Kraken custody balance as of each month end.
    const krakenQuery = client.query({
      query: `
        SELECT toString(toStartOfMonth(cut)) AS m, round(sum(bal) / 1e12, 0) AS v
        FROM (
          SELECT cut, account_id, argMaxIf(balf, week_start, week_start <= cut) AS bal
          FROM (
            SELECT account_id, week_start, toFloat64(toUInt256OrZero(argMaxMerge(balance_state))) AS balf
            FROM price_data.account_balance_weekly
            WHERE asset_id = '0' AND week_start >= toDate({start:String})
              AND account_id IN (SELECT account_id FROM price_data.account_tags FINAL
                                 WHERE label_id IN (${KRAKEN_TAG_IDS.map(t => `'${t}'`).join(',')}) AND deleted = 0)
            GROUP BY account_id, week_start
          )
          ARRAY JOIN ${monthsSql} AS cut
          GROUP BY cut, account_id
        ) GROUP BY m ORDER BY m`,
      query_params: { start: HDX_BALANCE_SERIES_START },
      format: 'JSONEachRow',
    })
    // Cumulative HDX the treasury bought through its own buy-side DCA
    // schedules (revenue recycled into HDX — schedule 30104 et al.).
    const buybackQuery = client.query({
      query: `
        SELECT toString(m) AS m, round(sum(hdx) OVER (ORDER BY m), 0) AS v
        FROM (
          SELECT toStartOfMonth(e.block_timestamp) AS m, sum(toFloat64OrZero(e.amount_out)) / 1e12 AS hdx
          FROM price_data.dca_events e FINAL
          INNER JOIN (
            SELECT id FROM price_data.dca_schedules
            WHERE who = '${TREASURY_ACCOUNT}' AND asset_out = 0 AND asset_in != 0
          ) s ON e.id = s.id
          WHERE e.event_name = 'DCA.TradeExecuted'
          GROUP BY m
        ) ORDER BY m`,
      format: 'JSONEachRow',
    })
    // Monthly close, USD (ohlc_1d is keyed (asset_id, interval_start)).
    const priceQuery = client.query({
      query: `
        SELECT toString(toStartOfMonth(interval_start)) AS m, toFloat64(argMaxMerge(close_state)) AS v
        FROM price_data.ohlc_1d WHERE asset_id = 0 GROUP BY m ORDER BY m`,
      format: 'JSONEachRow',
    })
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
        SELECT toString(q) AS q, round(sum(max_cap) / 1e12, 0) AS capital, uniqExact(who) AS voters
        FROM (
          SELECT q, who, max(cap) AS max_cap FROM (
            SELECT toStartOfQuarter(block_timestamp) AS q, who, (pallet, ref_index) AS ref,
              argMax(if(vote_kind = 'Standard', toFloat64OrZero(balance),
                toFloat64OrZero(aye) + toFloat64OrZero(nay) + toFloat64OrZero(abstain)),
                (block_height, ifNull(extrinsic_index, 0))) AS cap
            FROM price_data.governance_vote_calls WHERE success = 1 AND vote_kind != ''
            GROUP BY q, who, ref
          ) GROUP BY q, who
        ) GROUP BY q ORDER BY q`,
      format: 'JSONEachRow',
    })
    // Aggregate cost basis (realized price) of user-held HDX, plus user supply
    // and the top-100 share, as of each month end. Account-level accounting:
    // balance increases are bought at that week's close (weeks before the
    // price era at the first observed close), decreases release cost
    // proportionally. arrayFold carries (cost history, prev balance, cost).
    const realizedQuery = client.query({
      query: `
        WITH
        ${tagAccountsSql([...KRAKEN_TAG_IDS, ...POOL_TAG_IDS])} AS special_accts,
        (SELECT mapFromArrays(groupArray(w), groupArray(toFloat64(px))) FROM (
          SELECT toStartOfWeek(interval_start, 1) AS w, argMaxMerge(close_state) AS px
          FROM price_data.ohlc_1d WHERE asset_id = 0 GROUP BY w
        )) AS pmap,
        -- assumeNotNull: a Nullable scalar here would poison the arrayFold
        -- accumulator type (lambda returns Nullable, accumulator is not)
        assumeNotNull((SELECT min(toStartOfWeek(interval_start, 1)) FROM price_data.ohlc_1d WHERE asset_id = 0)) AS price_era,
        assumeNotNull((SELECT toFloat64(argMaxMerge(close_state)) FROM price_data.ohlc_1d WHERE asset_id = 0
          AND toStartOfWeek(interval_start, 1) = (SELECT min(toStartOfWeek(interval_start, 1)) FROM price_data.ohlc_1d WHERE asset_id = 0))) AS seed_px
        SELECT toString(toStartOfMonth(cut)) AS m,
          round(sum(bal_asof) / 1e12, 0) AS user_supply,
          round(sum(cost_asof) / sum(bal_asof / 1e12), 8) AS realized_price,
          round(arraySum(arraySlice(arrayReverseSort(groupArray(bal_asof)), 1, 100)) / sum(bal_asof) * 100, 2) AS top100_share
        FROM (
          SELECT cut,
            arrayLastIndex(x -> x <= cut, ws) AS idx,
            if(idx = 0, 0., bsF[idx]) AS bal_asof,
            if(idx = 0, 0., costs[idx]) AS cost_asof
          FROM (
            SELECT account_id, ws, bsF,
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
                arraySort((b, ww) -> ww, groupArray(balF), groupArray(w)) AS bsF
              FROM (
                SELECT account_id, week_start AS w,
                  toFloat64(toUInt256OrZero(argMaxMerge(balance_state))) AS balF
                FROM price_data.account_balance_weekly
                WHERE asset_id = '0' AND NOT startsWith(account_id, '0x6d6f646c')
                  AND NOT has(special_accts, account_id)
                GROUP BY account_id, week_start
              ) GROUP BY account_id
            )
          )
          ARRAY JOIN ${monthsSql} AS cut
        )
        WHERE bal_asof > 0 OR cost_asof > 0
        GROUP BY m HAVING sum(bal_asof) > 0 ORDER BY m`,
      format: 'JSONEachRow',
    })
    const [mintRes, stakedRes, krakenRes, buybackRes, priceRes, tradersRes, govRes, realizedRes] = await Promise.all([
      mintQuery, stakedQuery, krakenQuery, buybackQuery, priceQuery, tradersQuery, govQuery, realizedQuery,
    ])
    const rows = (await structureRes.json<Record<string, unknown>>()).map(r => {
      const num = (k: string) => Number(r[k] ?? 0)
      return {
        week: String(r.week),
        treasury: num('treasury'), protocol: num('protocol'), kraken: num('kraken'),
        user_total: num('user_total'),
        top10: num('top10'), top100: num('top100'), top1000: num('top1000'),
        hhi: num('hhi'),
        age_0_3m: num('age_0_3m'), age_3_12m: num('age_3_12m'), age_1_2y: num('age_1_2y'), age_2y: num('age_2y'),
      }
    })
    const mintRows = (await mintRes.json<{ week: string; cls: string; hdx: number }>())
      .map(r => ({ week: String(r.week), cls: String(r.cls), hdx: Number(r.hdx) }))
    const base = buildHdxStructure(rows)
    const backfilledAllocationHdx = backfillAllocationMints(base.ownership, base.weeks, mintRows)

    // Assemble the monthly trend grid. The grid spans the balance era to the
    // current month; every series aligns by month key, cumulative series carry
    // their running total across silent months.
    const mv = async (res: { json<T>(): Promise<T[]> }) =>
      (await res.json<{ m: string; v: number }>()).map(r => ({ m: String(r.m), v: Number(r.v) }))
    const stakedRows = (await stakedRes.json<{ m: string; classic: number; giga: number }>())
      .map(r => ({ m: String(r.m), classic: Number(r.classic), giga: Number(r.giga) }))
    const realizedRows = (await realizedRes.json<{ m: string; user_supply: number; realized_price: number; top100_share: number }>())
      .map(r => ({ m: String(r.m), user_supply: Number(r.user_supply), realized_price: Number(r.realized_price), top100_share: Number(r.top100_share) }))
    const govRows = (await govRes.json<{ q: string; capital: number; voters: number }>())
      .map(r => ({ q: String(r.q), capital: Number(r.capital), voters: Number(r.voters) }))
    const [krakenRows, buybackRows, priceRows, tradersRows] = await Promise.all([mv(krakenRes), mv(buybackRes), mv(priceRes), mv(tradersRes)])
    const months = realizedRows.map(r => r.m)
    const stakedClassic = carryForward(alignMonthly(months, stakedRows.map(r => ({ m: r.m, v: r.classic }))))
    const stakedGiga = carryForward(alignMonthly(months, stakedRows.map(r => ({ m: r.m, v: r.giga }))))
    const userSupply = alignMonthly(months, realizedRows.map(r => ({ m: r.m, v: r.user_supply })))
    return {
      ...base,
      backfilledAllocationHdx,
      trends: {
        months,
        stakedClassic,
        stakedGiga,
        liquidFloat: months.map((_, i) =>
          userSupply[i] != null ? userSupply[i]! - (stakedClassic[i] ?? 0) - (stakedGiga[i] ?? 0) : null),
        realizedPrice: alignMonthly(months, realizedRows.map(r => ({ m: r.m, v: r.realized_price }))),
        marketPrice: alignMonthly(months, priceRows),
        top100Share: alignMonthly(months, realizedRows.map(r => ({ m: r.m, v: r.top100_share }))),
        krakenHdx: alignMonthly(months, krakenRows),
        buybackHdx: carryForward(alignMonthly(months, buybackRows)),
        traders: alignMonthly(months, tradersRows),
        gov: { quarters: govRows.map(r => r.q), capital: govRows.map(r => r.capital), voters: govRows.map(r => r.voters) },
      },
    }
  })
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
