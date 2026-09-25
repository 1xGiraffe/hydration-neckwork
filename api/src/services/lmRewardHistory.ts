import type { ClickHouseClient } from '../db/client.ts'
import { canonicalPlan, type Bucketing } from './bucketLadder.ts'
import { cached } from './cache.ts'
import { LmMathError, loyaltyMultiplier, periodOf, userReward, type LoyaltyCurve } from './lmRewardMath.ts'
import { tagged } from './queryTag.ts'

// Unclaimed liquidity-mining rewards per bucket end: for every farm entry an
// account's deposits held at the end, what one `claim_rewards` would have paid
// against the chain state at that block — the loyalty-adjusted reward since
// entry less what the entry had claimed by then (lmRewardMath's arithmetic, the
// pallet's own). One definition for the LP-history surfaces (the explorer's
// /explorer/address/:a/liquidity-history and the Data API's
// /v1/accounts/{address}/liquidity/history) and the value chart's reward
// series, so a leaf: the client type and other leaves only.
//
// The reward is SETTLED, as the chain holds it: each yield farm at its last
// on-chain sync at or before the bucket end. A sync runs on every deposit, claim
// or withdrawal touching the farm (and emits YieldFarmAccRPVSUpdated, the only
// place accumulated_rpvs moves), so an active farm's rewards accrued since its
// last sync are not yet in it — never an estimate of them. Terminated farms pay
// nothing (claim_rewards refuses them).
//
// Sources, all key-prefix reads:
//  * which deposits the accounts held, when — the farmed Omnipool ownership
//    intervals (omnipool_position_owner_intervals, ownership_kind 'farmed') and
//    the XYK farm principal intervals (derivations reconstructions), account-first;
//  * each entry's constants and its claimed amount at capture blocks —
//    raw_lm_farm_entries (storage captured at every entry-creating block by
//    the raw indexer, src/raw/lmFarmEntries.ts), deposit-first;
//  * entry lifetimes and reward claims after a capture — lm_deposit_farm_events,
//    deposit-first;
//  * the farm's accumulated_rpvs and period at its last sync per bucket, and its
//    stop/resume/termination — lm_yield_farm_events, farm-first, with the relay
//    height of the sync block (block_relay_height): periods are relay blocks
//    divided by the global farm's blocks_per_period;
//  * the loyalty curve, reward currency and period length — farm_config_events.
//
// An entry held at a bucket end whose reward cannot be stated — its creation not
// captured yet, or a gap in its farm's inputs — is counted as incomplete for that
// bucket, never valued at zero.

export type LmHistoryPallet = 'omnipool' | 'xyk'

/** One farm entry's life, constants and claim record. */
export interface FarmEntryHistory {
  pallet: LmHistoryPallet
  depositId: string
  globalFarmId: number
  yieldFarmId: number
  /** The block whose SharesDeposited/SharesRedeposited created it. */
  enteredBlock: number
  /** The block it stopped existing (withdrawn / deposit destroyed); null while it exists. */
  closedBlock: number | null
  /** Storage constants from the creation capture; null when it was not captured. */
  constants: { valuedShares: bigint; rpvsEntry: bigint; enteredAt: number; stoppedAtCreation: number } | null
  /** accumulated_claimed_rewards at the end of each capture block in its life, ascending. */
  captures: Array<{ block: number; claimed: bigint }>
  /** RewardClaimed amounts in its life, ascending. */
  claims: Array<{ block: number; amount: bigint }>
}

/** A yield farm's reward state as a function of the block. */
export interface YieldFarmHistory {
  pallet: LmHistoryPallet
  globalFarmId: number
  yieldFarmId: number
  rewardAssetId: number
  loyaltyCurve: LoyaltyCurve | null
  blocksPerPeriod: number
  /**
   * The last sync at or before a block, or null when there is none (or it is
   * not known). Its `period` is the farm's updated_at after it.
   */
  lastSyncAtOrBefore(block: number, beforeEventIndex?: number): { block: number; rpvs: bigint; period: number } | null
  /** Resumes (block, event index, the period they set updated_at to), ascending. */
  resumes: Array<{ block: number; eventIndex: number; period: number }>
  /** The block it was terminated in; null while it is not. */
  terminatedBlock: number | null
}

/**
 * What one `claim_rewards(deposit, yield farm)` would have paid at the end of
 * `block`, settled (the farm at its last sync): loyalty(periods) · gross −
 * claimed, where gross = (rpvs − rpvs_entry) · valued_shares and periods =
 * yf.updated_at − entered_at − (the periods the farm spent stopped since the
 * entry). Null when it cannot be stated (not captured, a missing sync period,
 * arithmetic the runtime would refuse). The caller checks the entry was held.
 */
export function entryClaimableAt(entry: FarmEntryHistory, farm: YieldFarmHistory, block: number): bigint | null {
  const c = entry.constants
  if (!c) return null
  if (farm.terminatedBlock != null && farm.terminatedBlock <= block) return 0n
  const sync = farm.lastSyncAtOrBefore(block)
  // Before any sync since the farm existed, nothing has accrued. A sync older
  // than the entry leaves the rpvs it entered at (the deposit synced the farm).
  const rpvs = sync && sync.block >= entry.enteredBlock ? sync.rpvs : c.rpvsEntry
  if (rpvs < c.rpvsEntry) return null
  // updated_at: the newest of the entry's own period (its deposit synced the farm
  // to it, silently when the farm was empty), the last sync, the last resume.
  let updatedAt = c.enteredAt
  if (sync && sync.period > updatedAt) updatedAt = sync.period
  let stoppedSince = 0
  for (const r of farm.resumes) {
    if (r.block < entry.enteredBlock || r.block > block) continue
    // resume_yield_farm: total_stopped += current − updated_at; updated_at = current.
    const before = farm.lastSyncAtOrBefore(r.block, r.eventIndex)
    const priorUpdated = Math.max(c.enteredAt, before && before.block >= entry.enteredBlock ? before.period : c.enteredAt)
    stoppedSince += r.period - priorUpdated
    if (r.period > updatedAt) updatedAt = r.period
  }
  const periods = updatedAt - c.enteredAt - stoppedSince
  if (periods < 0) return null
  let claimed: bigint | null = null
  let from = -1
  for (const cap of entry.captures) if (cap.block <= block) { claimed = cap.claimed; from = cap.block }
  if (claimed == null) return null
  for (const cl of entry.claims) if (cl.block > from && cl.block <= block) claimed += cl.amount
  try {
    return userReward(c.rpvsEntry, c.valuedShares, claimed, rpvs, loyaltyMultiplier(periods, farm.loyaltyCurve)).userRewards
  } catch (err) {
    if (err instanceof LmMathError) return null
    throw err
  }
}

/** Held at the end of `block`: created at or before it, not yet gone at its end. */
export const entryHeldAt = (e: FarmEntryHistory, block: number): boolean =>
  e.enteredBlock <= block && (e.closedBlock == null || e.closedBlock > block)

// ───────────────────────── assembly from rows (pure) ─────────────────────────

export interface DepositEventRow { pallet: string; deposit_id: string; yield_farm_id: number; global_farm_id: number; block_height: number; event_index: number; event_kind: string; amount_s: string }
export interface CaptureRow { pallet: string; deposit_id: string; yield_farm_id: number; global_farm_id: number; block_height: number; capture_status: string; is_event_entry: number; valued_s: string; rpvs_entry_s: string; claimed_s: string; entered_at_period: number; stopped_at_creation: number }

const big = (v: unknown): bigint => (/^\d+$/.test(String(v ?? '')) ? BigInt(String(v)) : 0n)

/**
 * Entry lives from the deposit events (deposited/redeposited open one;
 * withdrawn closes it; destroyed closes every entry of the deposit), matched to
 * the captures inside each life. A deposit can leave a farm and enter it again,
 * so one (deposit, yield farm) can have several lives.
 */
export function buildEntryHistories(events: DepositEventRow[], captures: CaptureRow[]): FarmEntryHistory[] {
  const out: FarmEntryHistory[] = []
  const open = new Map<string, FarmEntryHistory>()
  // The open entries' keys per deposit, so a DepositDestroyed closes its own
  // entries without scanning every open one.
  const openByDeposit = new Map<string, Set<string>>()
  const seen = new Set<string>()
  const sorted = [...events].sort((a, b) => Number(a.block_height) - Number(b.block_height) || Number(a.event_index) - Number(b.event_index))
  for (const e of sorted) {
    const pallet = e.pallet === 'xyk' ? 'xyk' : 'omnipool'
    const id = `${pallet}:${e.deposit_id}:${e.block_height}:${e.event_index}`
    if (seen.has(id)) continue
    seen.add(id)
    const depositKey = `${pallet}:${e.deposit_id}`
    const key = `${depositKey}:${e.yield_farm_id}`
    const block = Number(e.block_height)
    if (e.event_kind === 'deposited' || e.event_kind === 'redeposited') {
      const entry: FarmEntryHistory = { pallet, depositId: String(e.deposit_id), globalFarmId: Number(e.global_farm_id), yieldFarmId: Number(e.yield_farm_id), enteredBlock: block, closedBlock: null, constants: null, captures: [], claims: [] }
      open.set(key, entry)
      let keys = openByDeposit.get(depositKey)
      if (!keys) openByDeposit.set(depositKey, (keys = new Set()))
      keys.add(key)
      out.push(entry)
    } else if (e.event_kind === 'withdrawn') {
      const entry = open.get(key)
      if (entry) { entry.closedBlock = block; open.delete(key); openByDeposit.get(depositKey)?.delete(key) }
    } else if (e.event_kind === 'destroyed') {
      for (const k of openByDeposit.get(depositKey) ?? []) { const entry = open.get(k); if (entry) { entry.closedBlock = block; open.delete(k) } }
      openByDeposit.delete(depositKey)
    } else if (e.event_kind === 'claimed') {
      open.get(key)?.claims.push({ block, amount: big(e.amount_s) })
    }
  }
  const lives = new Map<string, FarmEntryHistory[]>()
  for (const entry of out) {
    const key = `${entry.pallet}:${entry.depositId}:${entry.yieldFarmId}`
    const list = lives.get(key) ?? []
    list.push(entry)
    lives.set(key, list)
  }
  const sortedCaptures = [...captures].sort((a, b) => Number(a.block_height) - Number(b.block_height))
  for (const c of sortedCaptures) {
    if (c.capture_status !== 'ok') continue
    const block = Number(c.block_height)
    const entry = lives.get(`${c.pallet === 'xyk' ? 'xyk' : 'omnipool'}:${c.deposit_id}:${c.yield_farm_id}`)
      ?.find(e => e.enteredBlock <= block && (e.closedBlock == null || e.closedBlock > block))
    if (!entry) continue
    if (entry.captures.length && entry.captures[entry.captures.length - 1].block === block) continue
    entry.captures.push({ block, claimed: big(c.claimed_s) })
    // The constants never change during a life: any capture in it states them.
    if (!entry.constants) entry.constants = { valuedShares: big(c.valued_s), rpvsEntry: big(c.rpvs_entry_s), enteredAt: Number(c.entered_at_period), stoppedAtCreation: Number(c.stopped_at_creation) }
  }
  // A life without its creation capture cannot date its claimed amount from the start.
  for (const entry of out) if (entry.constants && entry.captures[0]?.block !== entry.enteredBlock) entry.constants = null
  return out
}

// ───────────────────────── per-bucket series ─────────────────────────

/** A deposit the accounts economically held over [fromBlock, toBlock) (toBlock 0: still held). */
export interface FarmedHolding {
  pallet: LmHistoryPallet
  depositId: string
  /** The Omnipool position the deposit locks; null for XYK. */
  positionId: string | null
  /** The XYK LP share asset; null for Omnipool. */
  lpAssetId: number | null
  fromBlock: number
  toBlock: number
}

export interface FarmRewardItem {
  pallet: LmHistoryPallet
  depositId: string
  positionId: string | null
  lpAssetId: number | null
  globalFarmId: number
  yieldFarmId: number
  rewardAssetId: number
  /** Raw units of rewardAssetId one claim would have paid at the bucket end. */
  amount: bigint
}

export interface FarmRewardHistory {
  /** Per bucket 0..N: every farm entry held at its end with a stated reward. */
  itemsByBucket: FarmRewardItem[][]
  /** Per bucket, per pallet: entries held at its end whose reward could not be stated. */
  incompleteByBucket: Array<Record<LmHistoryPallet, number>>
  rewardAssetIds: number[]
}

/** The series over the bucket ends, pure. */
export function farmRewardSeries(
  holdings: FarmedHolding[], entries: FarmEntryHistory[], farms: Map<string, YieldFarmHistory>, bk: Pick<Bucketing, 'N' | 'endHeight'>,
): FarmRewardHistory {
  const byDeposit = new Map<string, FarmEntryHistory[]>()
  for (const e of entries) {
    const key = `${e.pallet}:${e.depositId}`
    const list = byDeposit.get(key) ?? []
    list.push(e)
    byDeposit.set(key, list)
  }
  const itemsByBucket: FarmRewardItem[][] = Array.from({ length: bk.N + 1 }, () => [])
  const incompleteByBucket = Array.from({ length: bk.N + 1 }, () => ({ omnipool: 0, xyk: 0 }))
  const rewardAssetIds = new Set<number>()
  for (let b = 0; b <= bk.N; b++) {
    const block = bk.endHeight(b)
    const counted = new Set<string>()
    for (const h of holdings) {
      if (!(h.fromBlock <= block && (h.toBlock === 0 || h.toBlock > block))) continue
      const depositKey = `${h.pallet}:${h.depositId}`
      if (counted.has(depositKey)) continue
      counted.add(depositKey)
      for (const e of byDeposit.get(depositKey) ?? []) {
        if (!entryHeldAt(e, block)) continue
        const farm = farms.get(`${e.pallet}:${e.yieldFarmId}`)
        const amount = farm ? entryClaimableAt(e, farm, block) : null
        if (amount == null || !farm) { incompleteByBucket[b][e.pallet]++; continue }
        rewardAssetIds.add(farm.rewardAssetId)
        itemsByBucket[b].push({ pallet: e.pallet, depositId: e.depositId, positionId: h.positionId, lpAssetId: h.lpAssetId, globalFarmId: e.globalFarmId, yieldFarmId: e.yieldFarmId, rewardAssetId: farm.rewardAssetId, amount })
      }
    }
  }
  return { itemsByBucket, incompleteByBucket, rewardAssetIds: [...rewardAssetIds] }
}

export interface SyncPoint { block: number; eventIndex: number; rpvs: bigint; period: number }

/**
 * A farm's lastSyncAtOrBefore over known sync points (ascending): the newest
 * point before (block, beforeEventIndex) — at or before the block when no event
 * index is given — or null when there is none.
 */
export function syncLookup(points: SyncPoint[]): YieldFarmHistory['lastSyncAtOrBefore'] {
  return (block, beforeEventIndex) => {
    let lo = 0, hi = points.length - 1, best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const p = points[mid]
      const before = p.block < block || (p.block === block && (beforeEventIndex == null || p.eventIndex < beforeEventIndex))
      if (before) { best = mid; lo = mid + 1 } else hi = mid - 1
    }
    return best >= 0 ? { block: points[best].block, rpvs: points[best].rpvs, period: points[best].period } : null
  }
}

// ───────────────────────── loader ─────────────────────────

async function select<T>(client: ClickHouseClient, query: string, params: Record<string, unknown>): Promise<T[]> {
  const res = await client.query(tagged({ query, query_params: params, format: 'JSONEachRow' as const }))
  return res.json<T>()
}

const substrateAccounts = (accounts: string[]): string[] =>
  [...new Set(accounts.map(a => a.toLowerCase()))].filter(a => /^0x[0-9a-f]{64}$/.test(a))

const EMPTY = (n: number): FarmRewardHistory => ({ itemsByBucket: Array.from({ length: n + 1 }, () => []), incompleteByBucket: Array.from({ length: n + 1 }, () => ({ omnipool: 0, xyk: 0 })), rewardAssetIds: [] })

/** The farmed deposits the accounts held over the range (account-first). */
export async function loadFarmedHoldings(client: ClickHouseClient, accounts: string[], bk: Bucketing): Promise<FarmedHolding[]> {
  const accs = substrateAccounts(accounts)
  if (!accs.length) return []
  const minb = bk.floorHeight
  const maxb = bk.endHeight(bk.N)
  const [omni, xyk] = await Promise.all([
    select<{ position_id: string; deposit_id: string; valid_from_block: number; valid_to_block: number }>(client, `-- lm:farmed-omnipool-intervals
        SELECT position_id, deposit_id, valid_from_block, valid_to_block
        FROM price_data.omnipool_position_owner_intervals FINAL
        WHERE account_id IN {accs:Array(String)} AND ownership_kind = 'farmed'
          AND valid_from_block <= ${maxb} AND (valid_to_block = 0 OR valid_to_block >= ${minb})`, { accs }),
    select<{ deposit_id: string; lp_asset_id: number; valid_from_block: number; valid_to_block: number }>(client, `-- lm:farmed-xyk-intervals
        SELECT deposit_id, lp_asset_id, valid_from_block, valid_to_block
        FROM price_data.xyk_farm_principal_intervals FINAL
        WHERE account_id IN {accs:Array(String)}
          AND valid_from_block <= ${maxb} AND (valid_to_block = 0 OR valid_to_block >= ${minb})`, { accs }),
  ])
  return [
    ...omni.filter(r => /^\d+$/.test(String(r.deposit_id))).map(r => ({ pallet: 'omnipool' as const, depositId: String(r.deposit_id), positionId: String(r.position_id), lpAssetId: null, fromBlock: Number(r.valid_from_block), toBlock: Number(r.valid_to_block) })),
    ...xyk.filter(r => /^\d+$/.test(String(r.deposit_id))).map(r => ({ pallet: 'xyk' as const, depositId: String(r.deposit_id), positionId: null, lpAssetId: Number(r.lp_asset_id), fromBlock: Number(r.valid_from_block), toBlock: Number(r.valid_to_block) })),
  ]
}

interface FarmConfig { rewardAssetId: number; blocksPerPeriod: number; loyaltyCurve: LoyaltyCurve | null }

function parseCurve(raw: unknown): LoyaltyCurve | null {
  if (raw == null || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const pct = String(c.initialRewardPercentage ?? '')
  const scale = Number(c.scaleCoef)
  if (!/^\d+$/.test(pct) || !Number.isSafeInteger(scale)) return null
  return { initialRewardPercentage: BigInt(pct), scaleCoef: scale }
}

/**
 * The farms' creation parameters from farm_config_events (global_farm_id-first):
 * the reward currency and period length (GlobalFarmCreated), the loyalty curve
 * (YieldFarmCreated; null = none, loyalty 1). A farm whose creation is not
 * indexed has no config and its entries are stated as incomplete.
 */
async function loadFarmConfigs(client: ClickHouseClient, farms: Array<{ pallet: LmHistoryPallet; globalFarmId: number; yieldFarmId: number }>): Promise<Map<string, FarmConfig>> {
  const out = new Map<string, FarmConfig>()
  if (!farms.length) return out
  const rows = await select<{ pallet: string; event_name: string; global_farm_id: number; yield_farm_id: number | null; args_json: string }>(client, `-- lm:farm-configs
      SELECT pallet, event_name, global_farm_id, yield_farm_id, args_json
      FROM price_data.farm_config_events FINAL
      WHERE global_farm_id IN {gfs:Array(UInt32)} AND event_name IN ('GlobalFarmCreated', 'YieldFarmCreated')`, { gfs: [...new Set(farms.map(f => f.globalFarmId))] })
  const global = new Map<string, { rewardAssetId: number; blocksPerPeriod: number }>()
  const curves = new Map<string, LoyaltyCurve | null>()
  for (const r of rows) {
    const pallet = r.pallet === 'xyk_lm' ? 'xyk' : 'omnipool'
    let args: Record<string, unknown>
    try { args = JSON.parse(r.args_json) } catch { continue }
    if (r.event_name === 'GlobalFarmCreated') {
      const bpp = Number(args.blocksPerPeriod)
      const reward = Number(args.rewardCurrency)
      if (Number.isSafeInteger(bpp) && bpp > 0 && Number.isSafeInteger(reward)) global.set(`${pallet}:${r.global_farm_id}`, { rewardAssetId: reward, blocksPerPeriod: bpp })
    } else if (r.yield_farm_id != null) {
      curves.set(`${pallet}:${r.yield_farm_id}`, parseCurve(args.loyaltyCurve))
    }
  }
  for (const f of farms) {
    const g = global.get(`${f.pallet}:${f.globalFarmId}`)
    const key = `${f.pallet}:${f.yieldFarmId}`
    if (g && curves.has(key)) out.set(key, { ...g, loyaltyCurve: curves.get(key) ?? null })
  }
  return out
}

// The relay height a sync saw: its own block's, or — in Initialization, where a
// scheduled call runs before ParachainSystem sets this block's validation data —
// the previous block's.
export const relayBlockOf = (block: number, phase: string): number => (phase === 'Initialization' ? block - 1 : block)

// A block's relay parent never changes once it is indexed, so every one read is
// kept for the life of the process (per client, so two clients never share one),
// up to RELAY_MEMO_MAX blocks — past it the memo starts over rather than grows.
// A block not indexed yet is not memoized: it is asked again next time.
const RELAY_MEMO_MAX = 500_000
const relayMemo = new WeakMap<object, Map<number, number>>()

/** block_relay_height for the blocks the rows read their relay number from (primary key, memoized). */
async function loadRelayHeights(client: ClickHouseClient, rows: Array<{ block: number; phase: string }>): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const memo = relayMemo.get(client) ?? relayMemo.set(client, new Map()).get(client)!
  const hs: number[] = []
  for (const h of new Set(rows.map(r => relayBlockOf(r.block, r.phase)))) {
    const known = memo.get(h)
    if (known != null) out.set(h, known)
    else hs.push(h)
  }
  if (!hs.length) return out
  const res = await select<{ block_height: number; relay: number }>(client, `-- lm:relay-heights
      SELECT block_height, max(relay_parent_number) AS relay FROM price_data.block_relay_height
      WHERE block_height IN {hs:Array(UInt32)} GROUP BY block_height`, { hs })
  if (memo.size + res.length > RELAY_MEMO_MAX) memo.clear()
  for (const r of res) {
    out.set(Number(r.block_height), Number(r.relay))
    memo.set(Number(r.block_height), Number(r.relay))
  }
  return out
}

type SyncRow = { pallet: string; yield_farm_id: number; b: number; blk: number; idx: number; ph: string; rpvs: string }
type StateRow = { pallet: string; yield_farm_id: number; block_height: number; event_index: number; phase: string; event_kind: string }
type FarmRef = { pallet: LmHistoryPallet; yieldFarmId: number }

const farmWhere = `(pallet, yield_farm_id) IN arrayZip({farmPallets:Array(String)}, {farmIds:Array(UInt32)})`
const farmParamsOf = (farms: readonly FarmRef[]) => ({ farmPallets: farms.map(f => f.pallet as string), farmIds: farms.map(f => f.yieldFarmId) })

/** How long a canonical fold whose last boundary is past the finality hour is kept (mmIncentiveHistory's programme-index rule). */
const FARM_CANON_TTL_MS = 10 * 60_000
const canonTtl = (cb: Bucketing): number => (Date.now() / 1000 - cb.endSec(cb.N) < 3_600 ? 60_000 : FARM_CANON_TTL_MS)

/** The farms' last sync per bucket of `bk` (b = -1: the last before the range), folded on that grid. */
function farmSyncsOnGrid(client: ClickHouseClient, farms: readonly FarmRef[] | null, bk: Bucketing): Promise<SyncRow[]> {
  return select<SyncRow>(client, `-- lm:farm-syncs-by-bucket
        SELECT pallet, yield_farm_id, ${bk.ofHeightCarry('block_height')} AS b,
          argMax(block_height, (block_height, event_index)) AS blk,
          argMax(event_index, (block_height, event_index)) AS idx,
          argMax(phase, (block_height, event_index)) AS ph,
          toString(argMax(accumulated_rpvs, (block_height, event_index))) AS rpvs
        FROM price_data.lm_yield_farm_events FINAL
        WHERE ${farms ? `${farmWhere} AND ` : ''}event_kind = 'sync' AND block_height <= ${bk.endHeight(bk.N)}
        GROUP BY pallet, yield_farm_id, b`, farms ? farmParamsOf(farms) : {})
}

/**
 * The farms' sync points for one account grid — per bucket, the last sync at or
 * before its end (the bucket's own, else carried; syncLookup asks nothing else of
 * a bucket). Farm-first and the same for every account on one grid: on a
 * canonical grid (bucketLadder canonicalPlan) every farm is folded once and
 * cached on the grid, each account bucket reading the canonical bucket ending at
 * the same instant and height, and the last bucket (ending at the head) adding
 * the syncs since the lattice boundary below it; any other grid folds its own
 * farms on its own (the exact fallback).
 */
async function loadFarmSyncs(client: ClickHouseClient, farms: readonly FarmRef[], bk: Bucketing): Promise<SyncRow[]> {
  const plan = canonicalPlan(bk)
  if (!plan) return farmSyncsOnGrid(client, farms, bk)
  const cb = plan.grid.bk
  const canon = await cached(`lm:farm-syncs:canon:${plan.grid.key}`, canonTtl(cb), async () => {
    const byFarm = new Map<string, Map<number, SyncRow>>()
    for (const r of await farmSyncsOnGrid(client, null, cb)) {
      const k = `${r.pallet}:${Number(r.yield_farm_id)}`
      ;(byFarm.get(k) ?? byFarm.set(k, new Map()).get(k)!).set(Number(r.b), r)
    }
    // Forward-filled: the last sync at or before each canonical end.
    const out = new Map<string, (SyncRow | undefined)[]>()
    for (const [k, perBucket] of byFarm) {
      const series: (SyncRow | undefined)[] = new Array(cb.N + 1)
      let last = perBucket.get(-1)
      for (let i = 0; i <= cb.N; i++) { last = perBucket.get(i) ?? last; series[i] = last }
      out.set(k, series)
    }
    return out
  })
  const tail = plan.tail ? await select<SyncRow>(client, `-- lm:farm-syncs-tail
        SELECT pallet, yield_farm_id, toInt32(${plan.tail.b}) AS b,
          argMax(block_height, (block_height, event_index)) AS blk,
          argMax(event_index, (block_height, event_index)) AS idx,
          argMax(phase, (block_height, event_index)) AS ph,
          toString(argMax(accumulated_rpvs, (block_height, event_index))) AS rpvs
        FROM price_data.lm_yield_farm_events FINAL
        WHERE ${farmWhere} AND event_kind = 'sync' AND block_height >= ${plan.tail.fromHeight} AND block_height <= ${plan.tail.toHeight}
        GROUP BY pallet, yield_farm_id`, farmParamsOf(farms)) : []
  const rows: SyncRow[] = []
  for (const f of farms) {
    const k = `${f.pallet}:${f.yieldFarmId}`
    const series = canon.get(k)
    for (let b = 0; b <= bk.N; b++) {
      const i = plan.grid.map[b]
      const v = plan.tail && b === plan.tail.b
        ? tail.find(r => r.pallet === f.pallet && Number(r.yield_farm_id) === f.yieldFarmId) ?? series?.[plan.tail.prev]
        : i == null ? undefined : series?.[i]
      if (v) rows.push({ ...v, b })
    }
  }
  return rows
}

/**
 * The farms' stop/resume/termination events up to the grid's last end: rare
 * (dozens on chain), so on a canonical grid every farm's are read once and cached
 * on the grid, with the head bucket's tail read beside them; any other grid reads
 * its own farms'.
 */
async function loadFarmStates(client: ClickHouseClient, farms: readonly FarmRef[], bk: Bucketing): Promise<StateRow[]> {
  const read = (tag: string, where: string, params: Record<string, unknown>) => select<StateRow>(client, `-- ${tag}
        SELECT pallet, yield_farm_id, block_height, event_index, phase, event_kind
        FROM price_data.lm_yield_farm_events FINAL
        WHERE ${where}event_kind != 'sync' AND block_height <= {to:UInt32}`, params)
  const plan = canonicalPlan(bk)
  if (!plan) return read('lm:farm-states', `${farmWhere} AND `, { ...farmParamsOf(farms), to: bk.endHeight(bk.N) })
  const cb = plan.grid.bk
  const cbEnd = cb.endHeight(cb.N)
  const all = await cached(`lm:farm-states:canon:${plan.grid.key}`, canonTtl(cb), () => read('lm:farm-states', '', { to: cbEnd }))
  const toHeight = bk.endHeight(bk.N)
  const tail = toHeight > cbEnd
    ? await read('lm:farm-states-tail', `${farmWhere} AND block_height > {from:UInt32} AND `, { ...farmParamsOf(farms), from: cbEnd, to: toHeight })
    : []
  const wanted = new Set(farms.map(f => `${f.pallet}:${f.yieldFarmId}`))
  return [...all, ...tail].filter(r => wanted.has(`${r.pallet}:${Number(r.yield_farm_id)}`) && Number(r.block_height) <= toHeight)
}

/**
 * Every farmed entry's claimable reward per bucket end for the accounts (see
 * the header). Bounded: the accounts' intervals, their deposits' captures and
 * events, and per farm one row per bucket (its last sync by then) plus its
 * rare state events; relay heights by primary key for those blocks only, each
 * read chained straight onto the read that names its blocks.
 */
export async function loadFarmRewardHistory(client: ClickHouseClient, accounts: string[], bk: Bucketing): Promise<FarmRewardHistory> {
  const holdings = await loadFarmedHoldings(client, accounts, bk)
  if (!holdings.length) return EMPTY(bk.N)
  const maxb = bk.endHeight(bk.N)
  const deposits = [...new Set(holdings.map(h => `${h.pallet}:${h.depositId}`))].map(k => { const [pallet, id] = k.split(':'); return [pallet, id] as [string, string] })

  // Two flat arrays zipped in SQL: @clickhouse/client cannot bind an
  // Array(Tuple(…)) parameter (it serialises nested JS arrays as [[…]]).
  const depParams = { depPallets: deposits.map(d => d[0]), depIds: deposits.map(d => d[1]) }
  // The farm reads need the entries' farms, which the deposit events alone
  // name, so they start on the events without waiting for the captures.
  const capturesP = select<CaptureRow>(client, `-- lm:entry-captures
        SELECT pallet, deposit_id, yield_farm_id, global_farm_id, block_height, capture_status, is_event_entry,
          toString(valued_shares) AS valued_s, toString(rpvs_entry) AS rpvs_entry_s, toString(claimed_raw) AS claimed_s,
          entered_at_period, stopped_at_creation
        FROM price_data.raw_lm_farm_entries FINAL
        WHERE (pallet, deposit_id) IN arrayZip({depPallets:Array(String)}, {depIds:Array(String)}) AND block_height <= ${maxb}`, depParams)
  let events: DepositEventRow[]
  try {
    events = await select<DepositEventRow>(client, `-- lm:deposit-events
        SELECT pallet, deposit_id, yield_farm_id, global_farm_id, block_height, event_index, event_kind, toString(amount) AS amount_s
        FROM price_data.lm_deposit_farm_events FINAL
        WHERE (pallet, deposit_id) IN arrayZip({depPallets:Array(String)}, {depIds:Array(String)}) AND block_height <= ${maxb}`, depParams)
  } catch (err) {
    capturesP.catch(() => {})
    throw err
  }
  // buildEntryHistories opens a life on exactly these events, so they name every
  // entry's farm (a yield farm's global farm never changes).
  const farmKeys = new Map<string, { pallet: LmHistoryPallet; globalFarmId: number; yieldFarmId: number }>()
  for (const e of events) {
    if (e.event_kind !== 'deposited' && e.event_kind !== 'redeposited') continue
    const pallet: LmHistoryPallet = e.pallet === 'xyk' ? 'xyk' : 'omnipool'
    farmKeys.set(`${pallet}:${Number(e.yield_farm_id)}`, { pallet, globalFarmId: Number(e.global_farm_id), yieldFarmId: Number(e.yield_farm_id) })
  }
  if (!farmKeys.size) { capturesP.catch(() => {}); return EMPTY(bk.N) }
  const farmList = [...farmKeys.values()]

  // Per (farm, bucket): the last sync in the bucket (b = -1: the last before the
  // range), so the forward-filled series is "the last sync at or before each end".
  // Each relay-height read is chained onto the read naming its blocks, so it
  // waits for that read alone, not for the slowest of the three.
  type PreResume = { r: StateRow; pre: { blk: number; idx: number; ph: string; rpvs: string; n: string } | null }
  const [captures, syncPart, statePart, configs] = await Promise.all([
    capturesP,
    loadFarmSyncs(client, farmList, bk)
      .then(async rows => ({ rows, relay: await loadRelayHeights(client, rows.map(s => ({ block: Number(s.blk), phase: s.ph }))) })),
    loadFarmStates(client, farmList, bk)
      .then(async rows => {
        // A resume needs the farm's last sync strictly before it, which the bucket
        // grouping does not keep: one point read per resume (none on chain yet).
        const preResume: PreResume[] = await Promise.all(rows.filter(r => r.event_kind === 'resumed').map(r => select<NonNullable<PreResume['pre']>>(client, `-- lm:farm-sync-before-resume
            SELECT argMax(block_height, (block_height, event_index)) AS blk, argMax(event_index, (block_height, event_index)) AS idx,
              argMax(phase, (block_height, event_index)) AS ph, toString(argMax(accumulated_rpvs, (block_height, event_index))) AS rpvs, count() AS n
            FROM price_data.lm_yield_farm_events FINAL
            WHERE pallet = {p:String} AND yield_farm_id = {yf:UInt32} AND event_kind = 'sync'
              AND (block_height < {blk:UInt32} OR (block_height = {blk:UInt32} AND event_index < {idx:UInt32}))`, { p: r.pallet, yf: Number(r.yield_farm_id), blk: Number(r.block_height), idx: Number(r.event_index) })
          .then(pre => ({ r, pre: Number(pre[0]?.n ?? 0) > 0 ? pre[0] : null }))))
        const blocks = rows.map(r => ({ block: Number(r.block_height), phase: r.phase }))
        for (const { pre } of preResume) if (pre) blocks.push({ block: Number(pre.blk), phase: pre.ph })
        return { rows, preResume, relay: await loadRelayHeights(client, blocks) }
      }),
    loadFarmConfigs(client, farmList),
  ])
  const entries = buildEntryHistories(events, captures)
  const syncRes = syncPart.rows
  const stateRes = statePart.rows
  const preResume = statePart.preResume
  const relay = new Map([...syncPart.relay, ...statePart.relay])

  const farms = new Map<string, YieldFarmHistory>()
  for (const f of farmList) {
    const key = `${f.pallet}:${f.yieldFarmId}`
    const cfg = configs.get(key)
    if (!cfg) continue
    const periodAt = (block: number, phase: string): number | null => {
      const r = relay.get(relayBlockOf(block, phase))
      return r == null ? null : periodOf(r, cfg.blocksPerPeriod)
    }
    let complete = true
    const points: SyncPoint[] = syncRes
      .filter(s => s.pallet === f.pallet && Number(s.yield_farm_id) === f.yieldFarmId)
      .map(s => {
        const period = periodAt(Number(s.blk), s.ph)
        if (period == null) complete = false
        return { block: Number(s.blk), eventIndex: Number(s.idx), rpvs: big(s.rpvs), period: period ?? 0 }
      })
      .sort((a, b) => a.block - b.block || a.eventIndex - b.eventIndex)
    const states = stateRes.filter(s => s.pallet === f.pallet && Number(s.yield_farm_id) === f.yieldFarmId)
    const resumes: YieldFarmHistory['resumes'] = []
    for (const s of states.filter(x => x.event_kind === 'resumed')) {
      const period = periodAt(Number(s.block_height), s.phase)
      if (period == null) { complete = false; continue }
      resumes.push({ block: Number(s.block_height), eventIndex: Number(s.event_index), period })
    }
    // The syncs just before each resume join the lookup so a resume sees its own
    // predecessor even when the bucket grouping kept a later sync of that bucket.
    for (const { r, pre } of preResume) {
      if (r.pallet !== f.pallet || Number(r.yield_farm_id) !== f.yieldFarmId || !pre) continue
      const period = periodAt(Number(pre.blk), pre.ph)
      if (period == null) { complete = false; continue }
      if (!points.some(p => p.block === Number(pre.blk) && p.eventIndex === Number(pre.idx))) points.push({ block: Number(pre.blk), eventIndex: Number(pre.idx), rpvs: big(pre.rpvs), period })
    }
    points.sort((a, b) => a.block - b.block || a.eventIndex - b.eventIndex)
    resumes.sort((a, b) => a.block - b.block || a.eventIndex - b.eventIndex)
    if (!complete) continue // a sync whose period is unknown: the farm's rewards cannot be stated
    const terminated = states.filter(x => x.event_kind === 'terminated').map(x => Number(x.block_height))
    farms.set(key, {
      pallet: f.pallet, globalFarmId: f.globalFarmId, yieldFarmId: f.yieldFarmId,
      rewardAssetId: cfg.rewardAssetId, loyaltyCurve: cfg.loyaltyCurve, blocksPerPeriod: cfg.blocksPerPeriod,
      // Exact at every bucket end (each bucket's last sync, carried) and before
      // every resume (its predecessor was added above) — the only blocks asked.
      lastSyncAtOrBefore: syncLookup(points),
      resumes,
      terminatedBlock: terminated.length ? Math.min(...terminated) : null,
    })
  }
  return farmRewardSeries(holdings, entries, farms, bk)
}
