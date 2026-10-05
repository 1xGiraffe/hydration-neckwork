// User Revenue — liquidity-mining farm rewards (B1 farm_rewards), Omnipool and
// XYK warehouses alike.
//
// The netting convention (userRevenueStreams.ts): what the chain says an entry
// is owed NOW is its vested CLAIMABLE (loyalty-adjusted, less what it claimed —
// lmRewardMath, the pallet's own arithmetic), so an entry's accrual over a
// stretch is Δclaimable + claimed in it. A termination zeroes the claimable and
// books −claimable at the termination block; the unvested remainder was never
// booked, so a withdrawal forfeits nothing here.
//
// The chain publishes a yield farm's accumulated_rpvs only at a sync
// (lm_yield_farm_events). Between two syncs the rpvs is interpolated in relay
// periods (userRevenueMath.interpolateRpvs) WHILE THE FARM WAS FUNDED: when the
// observed rise falls short of what the global farm's funded rate would have paid
// over the gap — min(yield_per_period, max_reward_per_period / Z) per period
// and share z, times the yield farm's multiplier, Z the global farm's
// multiplier-weighted valued shares — the pot ran dry inside it, and nothing is
// booked past the dry point. After a farm's newest sync nothing is booked (the
// settled state holds); the next sync re-marks the hours back to the previous
// one. Owners: the deposit's depositor (the farmed Omnipool ownership intervals,
// the XYK farm principal intervals; else the claimant of its claims).

import type { ClickHouseClient } from '../db/client.ts'
import { buildEntryHistories, relayBlockOf, type CaptureRow, type DepositEventRow, type FarmEntryHistory, type LmHistoryPallet } from './lmRewardHistory.ts'
import { LmMathError, loyaltyMultiplier, periodOf, userReward, type LoyaltyCurve } from './lmRewardMath.ts'
import { hourIndexOfBlock, userRevenueCompactRows as compactRows, userRevenueRows as rows, type FoldWindow, type Ledger } from './userRevenueFold.ts'
import { interpolateRpvs } from './userRevenueMath.ts'
import { LedgerMap } from './userRevenueLp.ts'

const FIXED = 10n ** 18n

interface Sync { block: number; event: number; rpvs: bigint; tvs: bigint; period: number }
interface FarmInfo {
  pallet: LmHistoryPallet
  globalFarmId: number
  yieldFarmId: number
  rewardAsset: number
  blocksPerPeriod: number
  curve: LoyaltyCurve | null
  syncs: Sync[]
  resumes: Array<{ block: number; event: number; period: number }>
  stops: number[]
  terminatedBlock: number | null
  multiplier: bigint
}
/**
 * A global farm's funded-rate configuration as a step function of the block:
 * created with (yield_per_period, max_reward_per_period), and every
 * GlobalFarmUpdated a new version from its block on. The update sets a new
 * yield_per_period and recomputes max_reward_per_period from the farm pot's free
 * balance at that block (pallet liquidity-mining `update_global_farm`), which no
 * event states and the balance observations do not carry for an ERC-20 reward —
 * so a version after an update has no stated cap (null) and the gaps it governs
 * get no dry-pot test (plain interpolation), never the creation cap.
 */
export interface GlobalVersion { block: number; yieldPerPeriod: bigint; maxRewardPerPeriod: bigint | null }
interface GlobalInfo { versions: GlobalVersion[]; blocksPerPeriod: number; rewardAsset: number }

export interface FarmBuild {
  ledgers: Ledger[]; unstated: number; dryGaps: number
  /** Hours whose accrual the fold could not measure (a claimable it could not state), per farm pot and reward asset. */
  markers?: FarmMarker[]
  /** Every entry alive at the window's last block, as anchor rows (the next month's opening; FARM_ANCHOR_POT). */
  closing: FarmAnchorRow[]
}

/**
 * The farm checkpoint in a month's anchor: one row per entry alive at the
 * anchor block — exposure_id `pallet:deposit:yieldFarm`, holder its last
 * claimant, units its accumulated claimed amount there (−1: not statable), aux
 * `globalFarm|enteredBlock|valuedShares|rpvsEntry|enteredAt|stoppedAtCreation`
 * (constants empty when not captured). A window that opens from it reads only the
 * deposit events and entry captures after the anchor block: an entry's claimable
 * needs its constants, its claimed amount and the claims since — never the
 * deposit's earlier history.
 */
export const FARM_ANCHOR_POT = 'farm'
export interface FarmAnchorRow { pot: string; holder: string; exposure_id: string; units: bigint; aux: string }
export interface FarmAnchor { rows: readonly FarmAnchorRow[]; block: number }

/** Anchored entries as histories: the claimed amount a capture at the anchor block. */
export function entriesFromAnchor(anchor: FarmAnchor): { entries: FarmEntryHistory[]; claimant: Map<string, string> } {
  const entries: FarmEntryHistory[] = []
  const claimant = new Map<string, string>()
  for (const r of anchor.rows) {
    if (r.pot !== FARM_ANCHOR_POT) continue
    const [pallet, depositId, y] = r.exposure_id.split(':')
    const [g, eb, vs, rpvs, ea, sc] = r.aux.split('|')
    const p: LmHistoryPallet = pallet === 'xyk' ? 'xyk' : 'omnipool'
    entries.push({
      pallet: p, depositId, globalFarmId: Number(g), yieldFarmId: Number(y), enteredBlock: Number(eb), closedBlock: null,
      constants: vs ? { valuedShares: BigInt(vs), rpvsEntry: BigInt(rpvs), enteredAt: Number(ea), stoppedAtCreation: Number(sc) } : null,
      captures: r.units >= 0n ? [{ block: anchor.block, claimed: r.units }] : [],
      claims: [],
    })
    if (r.holder) claimant.set(`${p}:${depositId}`, r.holder)
  }
  return { entries, claimant }
}

/** Applies the window's own deposit events and captures (after the anchor block) to the anchored entries. */
export function advanceAnchoredEntries(entries: FarmEntryHistory[], events: readonly DepositEventRow[], captures: readonly CaptureRow[], anchorBlock: number): void {
  const byKey = new Map<string, FarmEntryHistory>()
  const byDeposit = new Map<string, FarmEntryHistory[]>()
  for (const e of entries) {
    byKey.set(`${e.pallet}:${e.depositId}:${e.yieldFarmId}`, e)
    const dk = `${e.pallet}:${e.depositId}`
    const list = byDeposit.get(dk) ?? []
    list.push(e)
    byDeposit.set(dk, list)
  }
  const seen = new Set<string>()
  const sorted = [...events].sort((a, b) => Number(a.block_height) - Number(b.block_height) || Number(a.event_index) - Number(b.event_index))
  for (const ev of sorted) {
    const block = Number(ev.block_height)
    if (block <= anchorBlock) continue
    const pallet = palletOf(ev.pallet)
    const id = `${pallet}:${ev.deposit_id}:${block}:${ev.event_index}`
    if (seen.has(id)) continue
    seen.add(id)
    const e = byKey.get(`${pallet}:${ev.deposit_id}:${ev.yield_farm_id}`)
    const open = (x: FarmEntryHistory | undefined) => x != null && (x.closedBlock == null || x.closedBlock > block)
    if (ev.event_kind === 'withdrawn') { if (open(e)) e!.closedBlock = block }
    else if (ev.event_kind === 'destroyed') { for (const x of byDeposit.get(`${pallet}:${ev.deposit_id}`) ?? []) if (open(x)) x.closedBlock = block }
    else if (ev.event_kind === 'claimed') { if (open(e)) e!.claims.push({ block, amount: BigInt(ev.amount_s || '0') }) }
  }
  for (const c of [...captures].sort((a, b) => Number(a.block_height) - Number(b.block_height))) {
    if (c.capture_status !== 'ok') continue
    const block = Number(c.block_height)
    if (block <= anchorBlock) continue
    const e = byKey.get(`${palletOf(c.pallet)}:${c.deposit_id}:${c.yield_farm_id}`)
    if (!e || (e.closedBlock != null && e.closedBlock <= block)) continue
    if (e.captures.length && e.captures[e.captures.length - 1].block === block) continue
    e.captures.push({ block, claimed: BigInt(c.claimed_s || '0') })
  }
}

const palletOf = (p: string): LmHistoryPallet => (p === 'xyk' || p === 'xyk_lm' ? 'xyk' : 'omnipool')

function lastAtOrBefore<T extends { block: number }>(list: readonly T[], block: number): T | null {
  let lo = 0
  let hi = list.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].block <= block) { best = mid; lo = mid + 1 } else hi = mid - 1
  }
  return best >= 0 ? list[best] : null
}
function firstAfter<T extends { block: number }>(list: readonly T[], block: number): T | null {
  let lo = 0
  let hi = list.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].block > block) { best = mid; hi = mid - 1 } else lo = mid + 1
  }
  return best >= 0 ? list[best] : null
}

/** The global farm configuration version in force at `block` (the creation's before any update; null before creation). */
export function globalVersionAt(g: { versions: readonly GlobalVersion[] }, block: number): GlobalVersion | null {
  return lastAtOrBefore(g.versions, block)
}

/**
 * B1 over the window. With the month's farm checkpoint (`anchor`) only the
 * deposit events and captures after its block are read; without one (the first
 * month, or an anchor written before the checkpoint existed) every alive
 * deposit's whole history is.
 */
/** The `unmeasured:<reason>` of farm hours with no stated claimable to difference (FactSink.mark, stream farm_rewards). */
export const FARM_UNSTATED_REASON = 'farm-unstated'
/** The `unmeasured:<reason>` of an entry whose FARM has no stated state in the window (no configuration or sync indexed). */
export const FARM_STATE_UNKNOWN_REASON = 'farm-state-unknown'
/** The marker's asset when not even the global farm names the reward asset (u32::MAX: never a registry id). */
export const FARM_UNKNOWN_REWARD_ASSET = 4_294_967_295

/**
 * The window hours (inclusive range) an entry is open in: from the hour of its entry block (0 when entered before
 * the window) to the hour of its closing block (the last hour while it stays open); null when it is open in none.
 */
export function entryOpenHours(w: Pick<FoldWindow, 'openBlock' | 'lastBlock' | 'hours' | 'hourBlocks'>, enteredBlock: number, closedBlock: number | null): [number, number] | null {
  const from = Math.max(0, hourIndexOfBlock(w as FoldWindow, enteredBlock))
  const to = closedBlock == null ? w.hours - 1 : Math.min(w.hours - 1, hourIndexOfBlock(w as FoldWindow, closedBlock))
  return from < w.hours && to >= 0 && from <= to ? [from, to] : null
}
export interface FarmMarker { h: number; pot: string; asset: number; reason: string }

export async function buildFarmRewards(client: ClickHouseClient, w: FoldWindow, anchor: FarmAnchor | null = null): Promise<FarmBuild> {
  const out = new LedgerMap(w.hours)
  // Deposits alive in the window: an event inside it, or created before it and not destroyed by its start —
  // selected server-side (thousands of deposits would overflow a query parameter). From a checkpoint: every row
  // after the anchor block (the anchored entries are the rest).
  const alive = anchor
    ? 'block_height > {from:UInt32}'
    : `(pallet, deposit_id) IN (
      SELECT pallet, deposit_id FROM price_data.lm_deposit_farm_events
      WHERE block_height <= {hi:UInt32}
      GROUP BY pallet, deposit_id
      HAVING max(block_height) > {lo:UInt32} OR countIf(event_kind = 'destroyed') = 0)`
  const params = { lo: w.openBlock, hi: w.lastBlock, from: anchor?.block ?? 0 }
  const [events, captures] = await Promise.all([
    rows<DepositEventRow & { who: string }>(client, `
      SELECT pallet, deposit_id, yield_farm_id, global_farm_id, block_height, event_index, event_kind, toString(amount) AS amount_s, any(who) AS who
      FROM price_data.lm_deposit_farm_events
      WHERE ${alive} AND block_height <= {hi:UInt32}
      GROUP BY pallet, deposit_id, yield_farm_id, global_farm_id, block_height, event_index, event_kind, amount`,
    params, 'ur:farm-events'),
    rows<CaptureRow>(client, `
      SELECT pallet, deposit_id, yield_farm_id, global_farm_id, block_height, argMax(capture_status, ingested_at) AS capture_status,
             argMax(is_event_entry, ingested_at) AS is_event_entry,
             toString(argMax(valued_shares, ingested_at)) AS valued_s, toString(argMax(rpvs_entry, ingested_at)) AS rpvs_entry_s,
             toString(argMax(claimed_raw, ingested_at)) AS claimed_s, argMax(entered_at_period, ingested_at) AS entered_at_period,
             argMax(stopped_at_creation, ingested_at) AS stopped_at_creation
      FROM price_data.raw_lm_farm_entries
      WHERE ${alive} AND block_height <= {hi:UInt32}
      GROUP BY pallet, deposit_id, yield_farm_id, global_farm_id, block_height, event_index`,
    params, 'ur:farm-captures'),
  ])
  const anchored = anchor ? entriesFromAnchor(anchor) : { entries: [], claimant: new Map<string, string>() }
  if (anchor) advanceAnchoredEntries(anchored.entries, events, captures, anchor.block)
  if (!events.length && !anchored.entries.length) return { ledgers: [], unstated: 0, dryGaps: 0, closing: [] }
  const allEntries = [...anchored.entries, ...buildEntryHistories(events, captures)]
  const entries = allEntries.filter(e => e.closedBlock == null || e.closedBlock > w.openBlock)
  // A deposit's claimant (the owner of last resort): the newest claim's signer, carried by the checkpoint.
  const claimant = new Map<string, string>(anchored.claimant)
  for (const e of [...events].sort((a, b) => Number(a.block_height) - Number(b.block_height) || Number(a.event_index) - Number(b.event_index))) {
    if (e.event_kind === 'claimed' && e.who) claimant.set(`${palletOf(e.pallet)}:${e.deposit_id}`, String(e.who).toLowerCase())
  }

  // ── farms: configuration, syncs, state events ──
  const farmKeys = new Map<string, { pallet: LmHistoryPallet; g: number; y: number }>()
  for (const e of entries) farmKeys.set(`${e.pallet}:${e.yieldFarmId}`, { pallet: e.pallet, g: e.globalFarmId, y: e.yieldFarmId })
  if (!farmKeys.size) return { ledgers: [], unstated: 0, dryGaps: 0, closing: closingRows(allEntries, w.lastBlock, claimant, () => null) }
  const config = await rows<{ pallet: string; n: string; g: string; y: string | null; b: string; e: string; args: string }>(client, `
    SELECT pallet, event_name AS n, global_farm_id AS g, yield_farm_id AS y, block_height AS b, event_index AS e, argMax(args_json, ingested_at) AS args
    FROM price_data.farm_config_events GROUP BY pallet, n, g, y, b, e ORDER BY b, e`, {}, 'ur:farm-config')
  const globals = new Map<string, GlobalInfo>()
  const curves = new Map<string, LoyaltyCurve | null>()
  const multipliers = new Map<string, Array<{ block: number; m: bigint }>>()
  for (const r of config) {
    const pallet = palletOf(r.pallet)
    let a: Record<string, unknown>
    try { a = JSON.parse(r.args) } catch { continue }
    const gk = `${pallet}:${r.g}`
    if (r.n === 'GlobalFarmCreated') {
      globals.set(gk, {
        versions: [{ block: Number(r.b), yieldPerPeriod: BigInt(String(a.yieldPerPeriod ?? '0')), maxRewardPerPeriod: BigInt(String(a.maxRewardPerPeriod ?? '0')) }],
        blocksPerPeriod: Number(a.blocksPerPeriod ?? 0), rewardAsset: Number(a.rewardCurrency ?? -1),
      })
    } else if (r.n === 'GlobalFarmUpdated') {
      const g = globals.get(gk)
      if (g && a.yieldPerPeriod != null) g.versions.push({ block: Number(r.b), yieldPerPeriod: BigInt(String(a.yieldPerPeriod)), maxRewardPerPeriod: null })
    } else if ((r.n === 'YieldFarmCreated' || r.n === 'YieldFarmUpdated') && r.y != null) {
      const yk = `${pallet}:${r.y}`
      if (r.n === 'YieldFarmCreated') {
        const c = a.loyaltyCurve as Record<string, unknown> | null | undefined
        curves.set(yk, c && /^\d+$/.test(String(c.initialRewardPercentage ?? '')) ? { initialRewardPercentage: BigInt(String(c.initialRewardPercentage)), scaleCoef: Number(c.scaleCoef) } : null)
      }
      if (a.multiplier != null) {
        const list = multipliers.get(yk) ?? []
        list.push({ block: Number(r.b), m: BigInt(String(a.multiplier)) })
        multipliers.set(yk, list)
      }
    }
  }
  // Every sync of the farms' GLOBAL farms around the window (a global farm's Z needs its every yield farm),
  // with the last before and the first after it, and every state event.
  const globalIds = [...new Set([...farmKeys.values()].map(f => `${f.pallet}:${f.g}`))]
  const syncRows = await compactRows(client, `
    SELECT pallet, yield_farm_id, global_farm_id, block_height, event_index, argMax(phase, ingested_at), argMax(event_kind, ingested_at),
           toString(argMax(accumulated_rpvs, ingested_at)), toString(argMax(total_valued_shares, ingested_at))
    FROM price_data.lm_yield_farm_events
    WHERE (pallet, global_farm_id) IN arrayZip({gp:Array(String)}, {gi:Array(UInt32)})
      AND (event_kind != 'sync' OR (block_height > {lo:UInt32} AND block_height <= {hi:UInt32})
           OR (pallet, yield_farm_id, block_height) IN (
             SELECT pallet, yield_farm_id, max(block_height) FROM price_data.lm_yield_farm_events
             WHERE event_kind = 'sync' AND block_height <= {lo:UInt32} GROUP BY pallet, yield_farm_id
             UNION ALL
             SELECT pallet, yield_farm_id, min(block_height) FROM price_data.lm_yield_farm_events
             WHERE event_kind = 'sync' AND block_height > {hi:UInt32} GROUP BY pallet, yield_farm_id))
    GROUP BY pallet, yield_farm_id, global_farm_id, block_height, event_index
    ORDER BY block_height, event_index`,
  { gp: globalIds.map(k => k.split(':')[0]), gi: globalIds.map(k => Number(k.split(':')[1])), lo: w.openBlock, hi: w.lastBlock }, 'ur:farm-syncs')
  // Relay periods: every sync / state block (its own, or the parent's in Initialization) and every hour end.
  const relayBlocks = new Set<number>()
  for (const r of syncRows) relayBlocks.add(relayBlockOf(Number(r[3]), r[5]))
  for (const hb of w.hourBlocks) relayBlocks.add(hb.last)
  relayBlocks.add(w.openBlock)
  const relay = new Map<number, number>()
  const rb = [...relayBlocks]
  for (let i = 0; i < rb.length; i += 8_000) {
    const got = await rows<{ b: string; r: string }>(client, `
      SELECT block_height AS b, max(relay_parent_number) AS r FROM price_data.block_relay_height
      WHERE block_height IN {bs:Array(UInt32)} GROUP BY b`, { bs: rb.slice(i, i + 8_000) }, 'ur:farm-relay')
    for (const g of got) relay.set(Number(g.b), Number(g.r))
  }
  const farms = new Map<string, FarmInfo>()
  const byGlobal = new Map<string, FarmInfo[]>()
  for (const r of syncRows) {
    const pallet = palletOf(r[0])
    const yk = `${pallet}:${r[1]}`
    const gk = `${pallet}:${r[2]}`
    const g = globals.get(gk)
    if (!g || g.blocksPerPeriod <= 0) continue
    let f = farms.get(yk)
    if (!f) {
      f = {
        pallet, globalFarmId: Number(r[2]), yieldFarmId: Number(r[1]), rewardAsset: g.rewardAsset, blocksPerPeriod: g.blocksPerPeriod,
        curve: curves.get(yk) ?? null, syncs: [], resumes: [], stops: [], terminatedBlock: null, multiplier: FIXED,
      }
      farms.set(yk, f)
      const list = byGlobal.get(gk) ?? []
      list.push(f)
      byGlobal.set(gk, list)
    }
    const block = Number(r[3])
    const rl = relay.get(relayBlockOf(block, r[5]))
    const period = rl == null ? -1 : periodOf(rl, g.blocksPerPeriod)
    const kind = r[6]
    if (kind === 'sync') f.syncs.push({ block, event: Number(r[4]), rpvs: BigInt(r[7]), tvs: BigInt(r[8]), period })
    else if (kind === 'resumed') f.resumes.push({ block, event: Number(r[4]), period })
    else if (kind === 'stopped') f.stops.push(block)
    else if (kind === 'terminated') f.terminatedBlock = f.terminatedBlock == null ? block : Math.min(f.terminatedBlock, block)
  }
  const multiplierAt = (yk: string, block: number): bigint => lastAtOrBefore(multipliers.get(yk) ?? [], block)?.m ?? FIXED

  // The funded rate of a yield farm over a gap starting at `block`: Δrpvs per period, or null when it cannot be stated.
  let dryGaps = 0
  const rateMemo = new Map<string, bigint | null>()
  const expectedRate = (f: FarmInfo, block: number): bigint | null => {
    const mk = `${f.pallet}:${f.yieldFarmId}@${block}`
    if (rateMemo.has(mk)) return rateMemo.get(mk)!
    const v = expectedRateOf(f, block)
    rateMemo.set(mk, v)
    return v
  }
  const expectedRateOf = (f: FarmInfo, block: number): bigint | null => {
    const g = globals.get(`${f.pallet}:${f.globalFarmId}`)
    if (!g) return null
    // The configuration in force at the gap's start, never a later update's.
    const v = globalVersionAt(g, block)
    if (!v || v.maxRewardPerPeriod == null) return null
    let z = 0n
    for (const other of byGlobal.get(`${f.pallet}:${f.globalFarmId}`) ?? []) {
      const s = lastAtOrBefore(other.syncs, block)
      if (s) z += (s.tvs * multiplierAt(`${other.pallet}:${other.yieldFarmId}`, block)) / FIXED
    }
    if (z <= 0n) return null
    const capped = (v.maxRewardPerPeriod * FIXED) / z
    const rpz = v.yieldPerPeriod < capped ? v.yieldPerPeriod : capped
    return (rpz * multiplierAt(`${f.pallet}:${f.yieldFarmId}`, block)) / FIXED
  }

  // Per entry: the claimed amount as a step function of the block (its captures, then its claims after each), for a binary search.
  const claimedSteps = new Map<FarmEntryHistory, Array<{ block: number; claimed: bigint }>>()
  const claimedAt = (e: FarmEntryHistory, block: number): bigint | null => {
    let steps = claimedSteps.get(e)
    if (!steps) {
      steps = []
      // A capture is the END-of-block claimed amount (it includes its block's claims); a claim after it adds.
      const capAt = new Map(e.captures.map(c => [c.block, c.claimed]))
      const claimAt = new Map<number, bigint>()
      for (const cl of e.claims) claimAt.set(cl.block, (claimAt.get(cl.block) ?? 0n) + cl.amount)
      const blocks = [...new Set([...capAt.keys(), ...claimAt.keys()])].sort((a, b) => a - b)
      let current: bigint | null = null
      for (const b of blocks) {
        const cap = capAt.get(b)
        if (cap != null) current = cap
        else if (current != null) current += claimAt.get(b) ?? 0n
        if (current != null) steps.push({ block: b, claimed: current })
      }
      claimedSteps.set(e, steps)
    }
    return lastAtOrBefore(steps, block)?.claimed ?? null
  }
  const stopBlocks = new Map<FarmInfo, Array<{ block: number }>>()
  for (const f of farms.values()) stopBlocks.set(f, [...f.stops].sort((a, b) => a - b).map(block => ({ block })))
  const stoppedBetween = (f: FarmInfo, lo: number, hi: number): boolean => {
    const s = firstAfter(stopBlocks.get(f) ?? [], lo)
    return s != null && s.block <= hi
  }

  /** What one claim_rewards would pay at the end of `block`, the farm's rpvs interpolated to it; null when not statable. */
  // The farm-level part of a claim at a block — its last sync, and the rpvs and updated_at interpolated
  // to the block — is the same for every entry that entered before that sync: computed once per (farm, block).
  const farmPointMemo = new Map<FarmInfo, Map<number, { s0: Sync; rpvs: bigint; updatedAt: number } | null>>()
  const farmPoint = (f: FarmInfo, block: number) => {
    let m = farmPointMemo.get(f)
    if (!m) { m = new Map(); farmPointMemo.set(f, m) }
    if (m.has(block)) return m.get(block)!
    const s0 = lastAtOrBefore(f.syncs, block)
    let v: { s0: Sync; rpvs: bigint; updatedAt: number } | null = null
    if (s0) v = { s0, ...interpolatedFrom(f, { period: s0.period, rpvs: s0.rpvs, block: s0.block }, block) }
    m.set(block, v)
    return v
  }
  /** rpvs and updated_at at `block` from a starting point s0 (a sync, or an entry's own entry point), interpolated to the next sync while funded. */
  const interpolatedFrom = (f: FarmInfo, s0: { period: number; rpvs: bigint; block: number }, block: number): { rpvs: bigint; updatedAt: number } => {
    const relayHere = relay.get(block)
    const s1 = firstAfter(f.syncs, block)
    const stoppedInGap = f.stops.length > 0 && stoppedBetween(f, s0.block, block)
    let rpvs = s0.rpvs
    let updatedAt = s0.period
    if (s0.period >= 0 && s1 && s1.period >= 0 && relayHere != null && !stoppedInGap && (f.terminatedBlock == null || f.terminatedBlock > s1.block)) {
      const p = periodOf(relayHere, f.blocksPerPeriod)
      if (p > s0.period) {
        const rate = expectedRate(f, s0.block)
        rpvs = interpolateRpvs({ period: s0.period, rpvs: s0.rpvs }, { period: s1.period, rpvs: s1.rpvs }, p, rate)
        updatedAt = Math.max(updatedAt, Math.min(p, s1.period))
      }
    }
    return { rpvs, updatedAt }
  }

  /** What one claim_rewards would pay at the end of `block`, the farm's rpvs interpolated to it; null when not statable. */
  const claimableAt = (e: FarmEntryHistory, f: FarmInfo, block: number): bigint | null => {
    const c = e.constants
    if (!c) return null
    if (e.enteredBlock > block || (e.closedBlock != null && e.closedBlock <= block)) return 0n
    if (f.terminatedBlock != null && f.terminatedBlock <= block) return 0n
    const fp = farmPoint(f, block)
    let rpvs: bigint
    let updatedAt: number
    if (fp && fp.s0.block >= e.enteredBlock) {
      if (fp.s0.period < 0) return null
      rpvs = fp.rpvs
      updatedAt = Math.max(c.enteredAt, fp.updatedAt)
    } else {
      // An entry that entered after the last sync starts from its own rpvs and period.
      const v = interpolatedFrom(f, { period: c.enteredAt, rpvs: c.rpvsEntry, block: e.enteredBlock }, block)
      rpvs = v.rpvs
      updatedAt = Math.max(c.enteredAt, v.updatedAt)
    }
    if (rpvs < c.rpvsEntry) return null
    let stoppedSince = 0
    for (const r of f.resumes) {
      if (r.block < e.enteredBlock || r.block > block) continue
      const before = lastAtOrBefore(f.syncs.filter(s => s.block < r.block || (s.block === r.block && s.event < r.event)), r.block)
      const prior = Math.max(c.enteredAt, before && before.block >= e.enteredBlock ? before.period : c.enteredAt)
      stoppedSince += r.period - prior
      if (r.period > updatedAt) updatedAt = r.period
    }
    const periods = updatedAt - c.enteredAt - stoppedSince
    if (periods < 0) return null
    const claimed = claimedAt(e, block)
    if (claimed == null) return null
    try {
      return userReward(c.rpvsEntry, c.valuedShares, claimed, rpvs, loyaltyMultiplier(periods, f.curve)).userRewards
    } catch (err) {
      if (err instanceof LmMathError) return null
      throw err
    }
  }
  // Dry gaps, counted once per (farm, gap start) for the report.
  for (const f of farms.values()) {
    for (let i = 1; i < f.syncs.length; i++) {
      const s0 = f.syncs[i - 1]
      const s1 = f.syncs[i]
      if (s1.block <= w.openBlock || s0.block > w.lastBlock || s0.period < 0 || s1.period <= s0.period) continue
      const rate = expectedRate(f, s0.block)
      if (rate != null && s1.rpvs - s0.rpvs < rate * BigInt(s1.period - s0.period)) dryGaps++
    }
  }

  // ── owners ──
  const ownerRows = await rows<{ d: string; acct: string; fb: string; tb: string; k: string }>(client, `
    SELECT deposit_id AS d, account_id AS acct, valid_from_block AS fb, valid_to_block AS tb, 'omnipool' AS k
    FROM price_data.omnipool_position_owner_intervals FINAL
    WHERE ownership_kind = 'farmed' AND valid_from_block <= {hi:UInt32} AND (valid_to_block = 0 OR valid_to_block > {lo:UInt32})
    UNION ALL
    SELECT deposit_id AS d, account_id AS acct, valid_from_block AS fb, valid_to_block AS tb, 'xyk' AS k
    FROM price_data.xyk_farm_principal_intervals FINAL
    WHERE valid_from_block <= {hi:UInt32} AND (valid_to_block = 0 OR valid_to_block > {lo:UInt32})`,
  { lo: w.openBlock, hi: w.lastBlock }, 'ur:farm-owners')
  const owners = new Map<string, Array<{ from: number; to: number; acct: string }>>()
  for (const r of ownerRows) {
    const k = `${r.k}:${r.d}`
    const list = owners.get(k) ?? []
    list.push({ from: Number(r.fb), to: Number(r.tb) || Number.MAX_SAFE_INTEGER, acct: r.acct.toLowerCase() })
    owners.set(k, list)
  }
  const ownerAt = (pallet: LmHistoryPallet, deposit: string, block: number): string => {
    for (const iv of owners.get(`${pallet}:${deposit}`) ?? []) if (iv.from <= block && block < iv.to) return iv.acct
    return claimant.get(`${pallet}:${deposit}`) ?? ''
  }

  // ── per entry, per hour: Δclaimable + claimed ──
  let unstated = 0
  const markers = new Map<string, FarmMarker>()
  const markHours = (pot: string, asset: number, from: number, to: number) => {
    for (let h = Math.max(0, from); h <= Math.min(to, w.hours - 1); h++) markers.set(`${h}|${pot}|${asset}`, { h, pot, asset, reason: FARM_UNSTATED_REASON })
  }
  for (const e of entries) {
    const f = farms.get(`${e.pallet}:${e.yieldFarmId}`)
    if (!f) {
      // No state for the entry's farm (its global farm's configuration or every sync missing): its rewards cannot
      // be stated, so the hours it is open are MARKED unmeasured — a stated gap, never a silent 0 — under the global
      // farm's reward asset when that much is known.
      unstated++
      const open = entryOpenHours(w, e.enteredBlock, e.closedBlock)
      const g = globals.get(`${e.pallet}:${e.globalFarmId}`)
      const asset = g && g.rewardAsset >= 0 ? g.rewardAsset : FARM_UNKNOWN_REWARD_ASSET
      const pot = `farm:${e.pallet}:${e.yieldFarmId}`
      if (open) for (let h = open[0]; h <= open[1]; h++) markers.set(`${h}|${pot}|${asset}`, { h, pot, asset, reason: FARM_STATE_UNKNOWN_REASON })
      continue
    }
    const pot = `farm:${e.pallet}:${e.yieldFarmId}`
    let prev = claimableAt(e, f, w.openBlock)
    if (prev == null) prev = e.enteredBlock > w.openBlock ? 0n : null
    const claimsByHour = new Map<number, bigint>()
    for (const cl of e.claims) {
      const h = hourIndexOfBlock(w, cl.block)
      if (h >= 0 && h < w.hours) claimsByHour.set(h, (claimsByHour.get(h) ?? 0n) + cl.amount)
    }
    const res = farmEntryAccruals(w.hours, prev, {
      notYet: h => e.enteredBlock > w.hourBlocks[h].last,
      closedBefore: h => e.closedBlock != null && e.closedBlock <= (h > 0 ? w.hourBlocks[h - 1].last : w.openBlock),
      claimable: h => claimableAt(e, f, w.hourBlocks[h].last),
      claimed: h => claimsByHour.get(h) ?? 0n,
    })
    unstated += res.unstated
    for (const [from, to] of res.unmeasured) markHours(pot, f.rewardAsset, from, to)
    const rowsOf = new Map<string, bigint[]>()
    for (const [h, accrual] of res.accrual) {
      const owner = ownerAt(e.pallet, e.depositId, w.hourBlocks[h].last)
      let row = rowsOf.get(owner)
      if (!row) { row = new Array<bigint>(w.hours).fill(0n); rowsOf.set(owner, row) }
      row[h] += accrual
    }
    for (const [owner, row] of rowsOf) out.addRow(owner, 'farm_rewards', pot, '', f.rewardAsset, null, 'accrual', row)
  }
  return { ledgers: out.ledgers(), unstated, dryGaps, markers: [...markers.values()], closing: closingRows(allEntries, w.lastBlock, claimant, claimedAt) }
}

/**
 * One farm entry's accrual per hour under the netting convention (Δclaimable + claimed), from the claimable stated at
 * the window's opening (`opening`; null when it cannot be stated) and at each hour's end. An hour whose claimable
 * cannot be stated carries its claims to the next stated hour, which books the whole stretch. A stretch with NO
 * stated claimable to difference from — from an unstatable opening to the first stated hour, and from the last stated
 * hour to a window end that is unstatable too (the next window opens on it) — is UNMEASURED: returned as hour ranges
 * (inclusive), its claims dropped with it, never booked as 0 and never folded into a later hour.
 */
export function farmEntryAccruals(hours: number, opening: bigint | null, at: {
  notYet(h: number): boolean; closedBefore(h: number): boolean; claimable(h: number): bigint | null; claimed(h: number): bigint
}): { accrual: Map<number, bigint>; unmeasured: Array<[number, number]>; unstated: number } {
  const accrual = new Map<number, bigint>()
  const unmeasured: Array<[number, number]> = []
  let unstated = 0
  let prev = opening
  let pending = 0n
  let lastStated = -1
  let last: bigint | null | undefined
  for (let h = 0; h < hours; h++) {
    if (at.notYet(h)) continue
    if (at.closedBefore(h) && prev === 0n && !pending) { last = 0n; break }
    const now = at.claimable(h)
    last = now
    pending += at.claimed(h)
    if (now == null) { unstated++; continue }
    if (prev == null) {
      unmeasured.push([0, h])
      pending = 0n
    } else {
      const a = now - prev + pending
      pending = 0n
      if (a !== 0n) accrual.set(h, a)
    }
    prev = now
    lastStated = h
  }
  if (prev == null) unmeasured.push([0, hours - 1])
  else if (last === null && lastStated < hours - 1) unmeasured.push([lastStated + 1, hours - 1])
  return { accrual, unmeasured, unstated }
}

/** The checkpoint rows for every entry alive at `block`. */
function closingRows(
  entries: readonly FarmEntryHistory[], block: number, claimant: ReadonlyMap<string, string>,
  claimedAt: (e: FarmEntryHistory, block: number) => bigint | null,
): FarmAnchorRow[] {
  const out: FarmAnchorRow[] = []
  for (const e of entries) {
    if (e.enteredBlock > block || (e.closedBlock != null && e.closedBlock <= block)) continue
    const c = e.constants
    out.push({
      pot: FARM_ANCHOR_POT, holder: claimant.get(`${e.pallet}:${e.depositId}`) ?? '', exposure_id: `${e.pallet}:${e.depositId}:${e.yieldFarmId}`,
      units: claimedAt(e, block) ?? -1n,
      aux: [e.globalFarmId, e.enteredBlock, c?.valuedShares ?? '', c?.rpvsEntry ?? '', c?.enteredAt ?? '', c?.stoppedAtCreation ?? ''].join('|'),
    })
  }
  return out
}
