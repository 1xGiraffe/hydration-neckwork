import type { ClickHouseClient } from '../db/client.ts'
import { xxhashAsU8a } from '@polkadot/util-crypto'
import { u8aToHex, hexToU8a, u8aConcat } from '@polkadot/util'
import { substrateStorageBatch, substrateAllKeys } from './substrateRpc.ts'
import { decodeCompact } from './proxyMultisigService.ts'
import { cached } from './cache.ts'
import { allTags, economicModuleAccounts } from './tagService.ts'
import { accountRef, ensurePrices, getGigaMarketStats, getGigaLiquidationLevels, type AccountRef, type GigaMarketReserveStat, type GigaLiquidations } from './explorerService.ts'

// HDX-dashboard chain snapshots: balance locks by lock id, GIGAHDX pending
// unstakes, vesting schedules and conviction-voting prior locks — everything the
// unlock timeline needs. Enumerations run in a background refresh (the largest,
// Balances.Locks, is ~18k entries ≈ a few seconds of chunked reads); request
// handlers only read the in-memory snapshot.

let client: ClickHouseClient
let hdxHolderLifetimeReady = false
export function setHdxHolderLifetimeReady(): void { hdxHolderLifetimeReady = true }

const HDX_DECIMALS = 12n
// GigaHdx unstakes mature 403,200 parachain blocks after the unstake block.
export const GIGA_UNBONDING_BLOCKS = 403_200

const prefix = (p: string, s: string) => u8aToHex(u8aConcat(xxhashAsU8a(p, 128), xxhashAsU8a(s, 128)))
const LOCKS_PREFIX = prefix('Balances', 'Locks')
const PENDING_UNSTAKES_PREFIX = prefix('GigaHdx', 'PendingUnstakes')
const VESTING_PREFIX = prefix('Vesting', 'VestingSchedules')
const VOTING_FOR_PREFIX = prefix('ConvictionVoting', 'VotingFor')
const RELAY_HEIGHT_KEY = prefix('ParachainSystem', 'LastRelayChainBlockNumber')

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
export interface PendingUnstake { accountId: string; startBlock: number; expiryBlock: number; payoutHdx: number }
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
}

let snapshot: HdxChainSnapshot | null = null

const toHdx = (raw: bigint) => Number(raw / 10n ** (HDX_DECIMALS - 4n)) / 1e4

// Balances.Locks value: Vec<{id: [u8;8], amount: u128, reasons: u8}>.
async function loadLocks(): Promise<{ lockTypes: LockTypeTotal[]; lockAccounts: Map<string, LockAccount>; voteLockByAccount: Map<string, number> } | null> {
  const keys = await substrateAllKeys(LOCKS_PREFIX)
  if (!keys.length) return null
  const values = await substrateStorageBatch(keys)
  if (!values.some(Boolean)) return null
  const byId = new Map<string, { accounts: number; total: bigint }>()
  const voteLockByAccount = new Map<string, number>()
  const lockAccounts = new Map<string, LockAccount>()
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
  return { lockTypes, lockAccounts, voteLockByAccount }
}

// GigaHdx.PendingUnstakes: double map Blake2_128Concat(account) →
// Twox64Concat(positionId u32) → payout u128. The position id is the unstake's
// parachain start block.
async function loadPendingUnstakes(): Promise<PendingUnstake[] | null> {
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
    out.push({ accountId, startBlock, expiryBlock: startBlock + GIGA_UNBONDING_BLOCKS, payoutHdx: toHdx(payout) })
  }
  return keys.length && !out.length ? null : out.sort((a, b) => a.expiryBlock - b.expiryBlock)
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
// Returns per-ACCOUNT (merged across classes): the latest scheduled prior
// unlock and whether any active vote/delegation keeps the lock open-ended.
async function loadVoteLocks(): Promise<Map<string, { maxUnlockBlock: number; hasActive: boolean }> | null> {
  const keys = await substrateAllKeys(VOTING_FOR_PREFIX)
  if (!keys.length) return null
  const values = await substrateStorageBatch(keys)
  if (!values.some(Boolean)) return null
  const byAccount = new Map<string, { maxUnlockBlock: number; hasActive: boolean }>()
  for (let ki = 0; ki < keys.length; ki++) {
    const raw = values[ki]
    if (!raw) continue
    // Key tail: twox64(8B) + account(32B) + twox64(8B) + class(u16) — account at [8..40).
    const tail = hexToU8a('0x' + keys[ki].slice(66))
    if (tail.length < 40) continue
    const accountId = u8aToHex(tail.slice(8, 40))
    const b = hexToU8a(raw)
    let unlockBlock = 0
    let hasActive = false
    try {
      if (b[0] === 0) { // Casting
        let [n, off] = decodeCompact(b, 1)
        if (n > 0) hasActive = true
        for (let i = 0; i < n; i++) {
          off += 4 // poll index
          const kind = b[off]; off += 1
          off += kind === 0 ? 17 : kind === 1 ? 32 : 48
        }
        off += 32 // delegations (votes, capital)
        if (u128At(b, off + 4) > 0n) unlockBlock = u32At(b, off)
      } else if (b[0] === 1) { // Delegating
        if (u128At(b, 1) > 0n) hasActive = true
        const off = 1 + 16 + 32 + 1 + 32
        if (u128At(b, off + 4) > 0n) unlockBlock = u32At(b, off)
      }
    } catch { continue }
    const e = byAccount.get(accountId) ?? { maxUnlockBlock: 0, hasActive: false }
    e.maxUnlockBlock = Math.max(e.maxUnlockBlock, unlockBlock)
    e.hasActive = e.hasActive || hasActive
    byAccount.set(accountId, e)
  }
  return byAccount
}

// ParachainSystem.LastRelayChainBlockNumber: plain u32 — the relay block the
// current parachain head was built against.
async function loadRelayHeight(): Promise<number | null> {
  const [raw] = await substrateStorageBatch([RELAY_HEIGHT_KEY])
  if (!raw) return null
  return u32At(hexToU8a(raw), 0)
}

async function refresh(): Promise<void> {
  const [locks, pending, vesting, votes, relayHeight] = await Promise.all([loadLocks(), loadPendingUnstakes(), loadVesting(), loadVoteLocks(), loadRelayHeight()])
  if (!locks || !pending || !vesting || !votes || relayHeight == null) {
    if (!snapshot) console.error('[hdx] chain snapshot incomplete, retrying next cycle')
    return // keep last good snapshot
  }
  // Classify each account's authoritative pyconvot lock amount exactly once.
  const voteLockAccounts: VoteLockAccount[] = []
  for (const [accountId, hdx] of locks.voteLockByAccount) {
    const v = votes.get(accountId)
    voteLockAccounts.push({ hdx, maxUnlockBlock: v?.maxUnlockBlock ?? 0, hasActive: v?.hasActive ?? false })
  }
  snapshot = {
    at: Date.now(),
    relayHeight,
    lockTypes: locks.lockTypes,
    lockAccounts: locks.lockAccounts,
    pendingUnstakes: pending,
    vestingSchedules: vesting,
    voteLockAccounts,
  }
}

const REFRESH_MS = 15 * 60_000
let refreshTimer: ReturnType<typeof setInterval> | null = null
let refreshInflight: Promise<void> | null = null

function runRefresh(label: 'initial load' | 'refresh'): Promise<void> {
  if (refreshInflight) return refreshInflight
  const request = refresh()
    .catch(err => console.error(`[hdx] ${label} failed`, err))
    .finally(() => {
      if (refreshInflight === request) refreshInflight = null
    })
  refreshInflight = request
  return request
}

export function initHdxService(c: ClickHouseClient): void {
  if (refreshTimer) return
  client = c
  void runRefresh('initial load')
  refreshTimer = setInterval(() => { void runRefresh('refresh') }, REFRESH_MS)
  refreshTimer.unref()
}

export function stopHdxService(): void {
  if (!refreshTimer) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

// dashboard payload (ClickHouse aggregates + chain snapshot)

const HDX_BLOCKS_PER_DAY = 14_400 // 6s blocks

export interface HdxCohort { key: string; label: string; minPct: number; minHdx: number; accounts: number; totalHdx: number }
export interface HdxUnlockBucket { label: string; fromTs: string; toTs: string; gigahdx: number; vesting: number; vote: number }
export interface HdxDailyFlow { date: string; buyHdx: number; sellHdx: number; buyers: number; sellers: number }
export interface HdxMover { account: AccountRef; balanceHdx: number; boughtHdx: number; soldHdx: number; netHdx: number }

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
    activeVoteHdx: number
    stakingAnytimeHdx: number
    gigaPending: { count: number; totalHdx: number; nextUnlockTs: string | null }
  }
  flows: {
    daily: HdxDailyFlow[]
    dca: { buy: { orders: number; hdxPerDay: number }; sell: { orders: number; hdxPerDay: number } }
  }
  churn: { weekly: { weekStart: string; newHolders: number; exitedHolders: number }[] }
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
    const [prices, head, supply, flows, dca, churn, movers, gigaMarket] = await Promise.all([
      ensurePrices(), loadHead(), loadSupplyCohorts(), loadDailyFlows(), loadDcaFlows(), loadChurn(), loadTopMovers(),
      getGigaMarketStats().catch(() => null),
    ])
    const gigaLiquidations = await getGigaLiquidationLevels().catch(() => null)
    const px = prices.get(0)
    const snap = snapshot
    const blockTs = (block: number) => head.ts + (block - head.height) * 6000
    // Vesting schedules count relay blocks; extrapolate the snapshot's relay
    // height to the CH head timestamp (relay blocks are a solid 6s).
    const relayNow = snap ? snap.relayHeight + Math.round((head.ts - snap.at) / 6000) : 0

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
    if (snap) {
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
        const relayAt = (ts: number) => relayNow + Math.round((ts - now) / 6000)
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
        activeVoteHdx: undeterminedVoteHdx,
        stakingAnytimeHdx: folded.find(t => t.key === 'staking')?.totalHdx ?? 0,
        gigaPending: { count: snap?.pendingUnstakes.length ?? 0, totalHdx: gigaPendingTotal, nextUnlockTs: nextGiga ? iso(blockTs(nextGiga.expiryBlock)) : null },
      },
      flows: { daily: flows, dca },
      churn,
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
  const from = head.height - 60 * HDX_BLOCKS_PER_DAY
  const res = await client.query({
    query: `
      SELECT toDate(subtractSeconds(fromUnixTimestamp({headTs:UInt64}), ({head:UInt32} - block_height) * 6)) AS d,
        toFloat64(sum(native_volume_buy)) / 1e12 AS buy, toFloat64(sum(native_volume_sell)) / 1e12 AS sell,
        uniqExactIf(account, native_volume_buy > 0) AS buyers, uniqExactIf(account, native_volume_sell > 0) AS sellers
      FROM price_data.trade_volume_by_account
      WHERE asset_id = 0 AND block_height >= {from:UInt32} AND NOT startsWith(account, '0x6d6f646c')
      GROUP BY d ORDER BY d`,
    query_params: { headTs: Math.floor(head.ts / 1000), head: head.height, from },
    format: 'JSONEachRow',
  })
  return (await res.json<{ d: string; buy: number; sell: number; buyers: number; sellers: number }>())
    .map(r => ({ date: r.d, buyHdx: Number(r.buy), sellHdx: Number(r.sell), buyers: Number(r.buyers), sellers: Number(r.sellers) }))
}

// Active DCA orders touching HDX → realistic NEXT-24H buy/sell volume, not the
// naive instantaneous rate:
//  - executions/day uses the MEASURED block count of the last 24h (elastic
//    scaling makes real throughput ≠ 14,400 six-second blocks), and
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
  return cached(`explorer:hdx-churn:${hdxHolderLifetimeReady ? 'model' : 'raw'}`, 1_800_000, async () => {
    const res = await client.query({
      query: hdxHolderLifetimeReady ? `
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
        GROUP BY wk_new` : `
        WITH per_account AS (
          SELECT account_id,
            minIf(block_timestamp, toUInt256OrZero(total) > 0) AS first_nonzero,
            maxIf(block_timestamp, toUInt256OrZero(total) > 0) AS last_nonzero,
            argMax(toUInt256OrZero(total), block_height) AS current
          FROM price_data.raw_balance_observations WHERE asset_id = '0'
          GROUP BY account_id HAVING first_nonzero > 0
        )
        SELECT
          toStartOfWeek(first_nonzero) AS wk_new, count() AS n,
          0 AS is_exit
        FROM per_account WHERE first_nonzero >= now() - INTERVAL 12 WEEK GROUP BY wk_new
        UNION ALL
        SELECT toStartOfWeek(last_nonzero) AS wk_new, count() AS n, 1 AS is_exit
        FROM per_account WHERE current = 0 AND last_nonzero >= now() - INTERVAL 12 WEEK GROUP BY wk_new`,
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
  const from = head.height - 7 * HDX_BLOCKS_PER_DAY
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
