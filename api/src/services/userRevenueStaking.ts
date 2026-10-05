// User Revenue — HDX staking (E1 staking_legacy / staking_forfeit), GIGAHDX
// voting rewards (E3 gigahdx_voting) and referrer commissions (E4
// referral_commissions). All HDX-denominated (asset 0).
//
// E1 books what the chain says a position is owed as it becomes owed: its
// GROSS reward, stake × Δ accumulated reward-per-stake (Staking.AccumulatedRpsUpdated),
// in the chain's own event order, floored once per stretch of constant stake as
// the pallet floors it when it settles a position. The payable percentage
// depends on governance-action points the index does not reconstruct, so the
// part the chain decides is NOT owed is booked negative at the claim that decides
// it (RewardsClaimed.slashedUnpaidRewards → staking_forfeit). The netting
// convention is the farm rewards' too; the asymmetry (farms never show a forfeit,
// legacy staking does) is deliberate and stated on the surfaces.
//
// E3 books each UserRewardRecorded at its referendum's RewardPoolAllocated block;
// what the allocation holds that no record names yet is unattributed
// ('voting-unrecorded') until its record lands (a record ingested later re-marks
// the allocation's hour).
//
// E4 books Referrals.Claimed.referrerRewards at the claim (no per-trade event
// exists); tradeRewards are fee rebates and excluded.

import type { ClickHouseClient } from '../db/client.ts'
import { hourIndexOfBlock, userRevenueRows as rows, type FoldWindow, type Ledger } from './userRevenueFold.ts'
import { FIXED_U128_ONE } from './userRevenueMath.ts'
import { UNATTRIBUTED_VIA } from './userRevenueStreams.ts'
import { LedgerMap } from './userRevenueLp.ts'

interface StakingEvent {
  block: number; event: number; kind: 'rps' | 'created' | 'added' | 'unstaked' | 'claimed'; who: string; position: string
  /** rps / stake / slashed unpaid, by kind. */
  value: bigint
  /** What the event realized for the position: a claim's paid, a stake-add's locked, an exit's paid; null when it says nothing. */
  realized: bigint | null
}

const STAKING_EVENT_NAMES = ['Staking.PositionCreated', 'Staking.StakeAdded', 'Staking.Unstaked', 'Staking.ForceUnstaked', 'Staking.RewardsClaimed']

async function loadStakingEvents(client: ClickHouseClient, lo: number, hi: number): Promise<StakingEvent[]> {
  const [rps, pos] = await Promise.all([
    rows<{ b: string; e: string; v: string }>(client, `
      SELECT block_height AS b, event_index AS e, argMax(JSONExtractString(args_json, 'accumulatedRps'), ingested_at) AS v
      FROM price_data.raw_events WHERE event_name = 'Staking.AccumulatedRpsUpdated' AND block_height > {lo:UInt32} AND block_height <= {hi:UInt32}
      GROUP BY b, e`, { lo, hi }, 'ur:staking-rps'),
    rows<{ b: string; e: string; n: string; args: string }>(client, `
      SELECT block_height AS b, event_index AS e, any(event_name) AS n, argMax(args_json, ingested_at) AS args
      FROM price_data.staking_activity WHERE event_name IN {names:Array(String)} AND block_height > {lo:UInt32} AND block_height <= {hi:UInt32}
      GROUP BY b, e`, { lo, hi, names: STAKING_EVENT_NAMES }, 'ur:staking-events'),
  ])
  const out: StakingEvent[] = rps.map(r => ({ block: Number(r.b), event: Number(r.e), kind: 'rps', who: '', position: '', value: BigInt(r.v || '0'), realized: null }))
  for (const r of pos) {
    const a = JSON.parse(r.args) as Record<string, string>
    const base = { block: Number(r.b), event: Number(r.e), who: String(a.who ?? '').toLowerCase(), position: String(a.positionId ?? '') }
    if (r.n === 'Staking.PositionCreated') out.push({ ...base, kind: 'created', value: BigInt(a.stake ?? '0'), realized: null })
    else if (r.n === 'Staking.StakeAdded') out.push({ ...base, kind: 'added', value: BigInt(a.totalStake ?? '0'), realized: BigInt(a.lockedRewards ?? '0') })
    // The first runtime's Unstaked paid the position's rewards itself (`rewards`) and dropped the unpaid rest with no event.
    else if (r.n === 'Staking.Unstaked') out.push({ ...base, kind: 'unstaked', value: 0n, realized: a.rewards != null ? BigInt(a.rewards) : null })
    else if (r.n === 'Staking.ForceUnstaked') out.push({ ...base, kind: 'unstaked', value: 0n, realized: null })
    else if (r.n === 'Staking.RewardsClaimed') out.push({ ...base, kind: 'claimed', value: BigInt(a.slashedUnpaidRewards ?? '0'), realized: BigInt(a.paidRewards ?? '0') })
  }
  return out.sort((a, b) => a.block - b.block || a.event - b.event)
}

/**
 * A position: its stake and reward checkpoint, what the current stretch has booked, and over its life the gross
 * booked and what the chain realized or forfeited (the first runtime's silent forfeit at exit is their difference).
 */
interface Position { who: string; stake: bigint; cp: bigint; booked: bigint; lifeGross: bigint; lifeSettled: bigint }

export interface StakingBuild { ledgers: Ledger[]; closing: Array<{ position: string; who: string; stake: bigint; cp: bigint; lifeGross: bigint; lifeSettled: bigint }>; rps: bigint }

/** The month's opening anchor rows of the staking pots ('staking' per position: stake, aux = its rps checkpoint; 'staking:rps': the accumulated rps). */
export interface StakingAnchor { rows: ReadonlyArray<{ pot: string; holder: string; exposure_id: string; units: bigint; aux: string }>; block: number }

/**
 * E1 over the window: gross per position per hour, forfeits at their claims.
 * Opens from the month's anchor (positions and the accumulated rps at its block)
 * and replays only the events after it; without one, from the first event.
 */
export async function buildLegacyStaking(client: ClickHouseClient, w: FoldWindow, anchor: StakingAnchor | null = null): Promise<StakingBuild> {
  const out = new LedgerMap(w.hours)
  const positions = new Map<string, Position>()
  let rps = 0n
  const owedOf = (p: Position) => (p.stake > 0n && rps > p.cp ? (p.stake * (rps - p.cp)) / FIXED_U128_ONE : 0n)
  if (anchor) {
    for (const r of anchor.rows) if (r.pot === 'staking:rps') rps = r.units
    for (const r of anchor.rows) {
      if (r.pot !== 'staking') continue
      const [cp, gross, settled] = r.aux.split('|')
      const p: Position = { who: r.holder, stake: r.units, cp: BigInt(cp || '0'), booked: 0n, lifeGross: BigInt(gross || '0'), lifeSettled: BigInt(settled || '0') }
      // The anchor's life gross already holds this stretch's part owed at the anchor.
      p.booked = owedOf(p)
      positions.set(r.exposure_id, p)
    }
  }
  const events = await loadStakingEvents(client, anchor?.block ?? 0, w.lastBlock)
  // A stretch of constant stake is settled (floored) once: booked is what was already booked of it. Before the
  // window (h < 0) a settlement books nothing and only carries the position's life gross.
  const settle = (p: Position, h: number) => {
    const owed = owedOf(p)
    if (owed !== p.booked) {
      if (h >= 0) out.add(p.who, 'staking_legacy', 'staking', '', 0, null, 'accrual', h, owed - p.booked)
      p.lifeGross += owed - p.booked
    }
    p.booked = owed
  }
  let h = -1
  // Entering the window: every open stretch's part owed before it was an earlier window's.
  const start = () => {
    if (h >= 0) return
    for (const p of positions.values()) settle(p, -1)
    h = 0
  }
  // At each hour end every position books its accrual so far (cumulative, floored per stretch).
  const closeHoursUpTo = (target: number) => {
    while (h < target) {
      for (const p of positions.values()) if (p.stake > 0n) settle(p, h)
      h++
    }
  }
  for (const ev of events) {
    const eh = hourIndexOfBlock(w, ev.block)
    if (eh >= w.hours) break
    const inWindow = eh >= 0
    if (inWindow) { start(); closeHoursUpTo(eh) }
    if (ev.kind === 'rps') { rps = ev.value; continue }
    let p = positions.get(ev.position)
    if (ev.kind === 'created') {
      p = { who: ev.who, stake: ev.value, cp: rps, booked: 0n, lifeGross: 0n, lifeSettled: 0n }
      positions.set(ev.position, p)
      continue
    }
    if (!p) continue
    if (ev.who) p.who = ev.who
    if (ev.kind === 'claimed') {
      if (inWindow && ev.value > 0n) out.add(p.who, 'staking_forfeit', 'staking', '', 0, null, 'event', eh, -ev.value)
      p.lifeSettled += ev.value + (ev.realized ?? 0n)
      continue
    }
    // A stake change settles the stretch before it (the pallet's own floor) and opens a new one.
    settle(p, inWindow ? eh : -1)
    if (ev.kind === 'added') p.lifeSettled += ev.realized ?? 0n
    if (ev.kind === 'unstaked' && ev.realized != null) {
      // The first runtime's exit paid the rewards itself (`rewards`) and dropped the unpaid rest without an
      // event: the life's gross less everything settled and paid is that forfeit, at this block.
      const forfeit = p.lifeGross - p.lifeSettled - ev.realized
      if (inWindow && forfeit > 0n) out.add(p.who, 'staking_forfeit', 'staking', '', 0, null, 'event', eh, -forfeit)
    }
    p.stake = ev.kind === 'added' ? ev.value : 0n
    p.cp = rps
    p.booked = 0n
    if (p.stake === 0n) positions.delete(ev.position)
  }
  start()
  closeHoursUpTo(w.hours)
  return {
    ledgers: out.ledgers(),
    closing: [...positions.entries()].map(([position, p]) => ({ position, who: p.who, stake: p.stake, cp: p.cp, lifeGross: p.lifeGross, lifeSettled: p.lifeSettled })),
    rps,
  }
}

/** E3: per referendum allocation, the recorded voter rewards at the allocation block; the rest unattributed until recorded. */
export async function buildGigahdxVoting(client: ClickHouseClient, w: FoldWindow): Promise<Ledger[]> {
  const out = new LedgerMap(w.hours)
  const allocations = await rows<{ ref: string; b: string; total: string }>(client, `
    SELECT ref_index AS ref, argMax(block_height, ingested_at) AS b, argMax(total_reward, ingested_at) AS total
    FROM price_data.gigahdx_reward_allocations
    WHERE block_height > {lo:UInt32} AND block_height <= {hi:UInt32}
    GROUP BY ref_index, block_height, event_index`, { lo: w.openBlock, hi: w.lastBlock }, 'ur:voting-alloc')
  if (!allocations.length) return []
  const refs = [...new Set(allocations.map(a => Number(a.ref)))]
  // The per-voter records (gigahdx_reward_records, the UserRewardRecorded projection), wherever they landed.
  const records = await rows<{ ref: string; who: string; amt: string }>(client, `
    SELECT ref_index AS ref, who, toString(sum(toUInt256OrZero(reward))) AS amt
    FROM (SELECT ref_index, block_height, event_index, argMax(who, ingested_at) AS who, argMax(reward, ingested_at) AS reward
          FROM price_data.gigahdx_reward_records WHERE ref_index IN {refs:Array(UInt64)}
          GROUP BY ref_index, block_height, event_index)
    GROUP BY ref, who ORDER BY ref, who`, { refs }, 'ur:voting-records')
  const byRef = new Map<number, Array<{ who: string; amt: bigint }>>()
  for (const r of records) {
    const list = byRef.get(Number(r.ref)) ?? []
    list.push({ who: r.who, amt: BigInt(r.amt) })
    byRef.set(Number(r.ref), list)
  }
  for (const a of allocations) {
    const h = hourIndexOfBlock(w, Number(a.b))
    const pot = `gigahdx-voting:${a.ref}`
    let booked = 0n
    for (const r of byRef.get(Number(a.ref)) ?? []) {
      out.add(r.who, 'gigahdx_voting', pot, '', 0, null, 'event', h, r.amt)
      booked += r.amt
    }
    const rest = BigInt(a.total || '0') - booked
    if (rest !== 0n) out.add('', 'gigahdx_voting', pot, UNATTRIBUTED_VIA.votingUnrecorded, 0, null, 'event', h, rest)
  }
  return out.ledgers()
}

/** E4: referrer commissions at the claim. */
export async function buildReferralCommissions(client: ClickHouseClient, w: FoldWindow): Promise<Ledger[]> {
  const out = new LedgerMap(w.hours)
  const got = await rows<{ b: string; who: string; amt: string }>(client, `
    SELECT block_height AS b, lower(JSONExtractString(args, 'who')) AS who, JSONExtractString(args, 'referrerRewards') AS amt
    FROM (SELECT block_height, event_index, argMax(args_json, ingested_at) AS args FROM price_data.referral_claim_activity
          WHERE event_name = 'Referrals.Claimed' AND block_height > {lo:UInt32} AND block_height <= {hi:UInt32}
          GROUP BY block_height, event_index)`, { lo: w.openBlock, hi: w.lastBlock }, 'ur:referrals')
  for (const r of got) {
    const amt = BigInt(r.amt || '0')
    if (amt > 0n) out.add(r.who, 'referral_commissions', 'referrals', '', 0, null, 'event', hourIndexOfBlock(w, Number(r.b)), amt)
  }
  return out.ledgers()
}

