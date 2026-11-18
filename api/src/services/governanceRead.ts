import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { paraBlockMs } from './blockTime.ts'
import { paraBlockProjector } from './lockBreakdownService.ts'
import { CONVICTION_NAMES, convictionTenths, decodeVoteByte } from './convictionWeight.ts'
import {
  CONVICTION_STATE_FROM_BLOCK, classRequirement, convictionHistory, convictionSnapshotBlock, convictionStateOf,
  delegatorsOf, lockIdName, lockPeriods, otherLocksOf, spendableAfterRelease, stateAsOf, unlockPlan, voteAfterLock, voteBalance, voteLocksOf, voteTally,
  type AccountVote, type ClassVoting, type Delegations, type PollOutcome, type UnlockPlan,
} from './convictionState.ts'
import {
  allOpengovLifecycle, indexedHead, isAfter, isConcludingEvent, liveReferendumState, onChainTallyFrom, opengovPhase,
  progressFrom, referendumStatusFrom, referendumVoteHistory, tallyFromArgs, type ReferendumPallet, type ReferendumProgress,
  type VotePosition,
} from './governanceService.ts'
import { SLOT_ERAS } from './referendaTrackTable.ts'
import {
  PERBILL, convictionLockBlocks, curveThresholdPerbill, perbillOfRational, referendaTracks, sampleTrackCurves, spansSlotEras, trackAsOf, trackById,
  undecidingTimeoutBlocks, voteLockingPeriodBlocks, type TrackCurve, type TrackDef,
} from './referendaTracks.ts'
import { referendumTitleFor } from './referendumTitleService.ts'
import { accountRef, resolveRelatedAccounts, type AccountRef } from './explorerService.ts'
import { proxyInfoFor } from './proxyMultisigService.ts'
import { forumAuthorCounts } from './forumStore.ts'
import { treasuryFold } from './governanceTreasury.ts'
import { accountDeposits, type AccountDeposits } from './governanceDeposits.ts'
import { normalizeAddress } from './addressIdentity.ts'

// The governance read models behind the hub, the track pages, the calendar, the
// account Governance tab and the voting composer's "needs your vote" list.
//
// Every figure is chain-derived and per block: the lifecycle projection
// (referendum_lifecycle_events), the vote projections the referendum page already
// reads, and the conviction state MVs (022_governance_state.sql) through the
// in-memory snapshot in convictionState.ts. Nothing here reads the chain per request;
// the one live read is the running referendum's tally, which governanceService's
// liveReferendumState already bounds (a point read per running referendum, cached a
// block). Durations come from block counts and the chain's own nominal slot time,
// projected from the indexed head (paraBlockProjector), never an assumed 6 s or 12 s.

let client: ClickHouseClient
export function initGovernanceRead(c: ClickHouseClient): void { client = c }

const MAX_VOTES_PER_CLASS = 25

// ---- clock ----
//
// ONE projector for every future governance moment (deadlines, the calendar and its
// ICS feed, lock and unlock dates), exposed to the explorer as /governance/clock so
// the pages place their own countdowns on the same line: the head block's indexed
// time, advanced at the chain's MEASURED pace. The pace is the mean block time over
// the last week of indexed blocks (GOVERNANCE_RATE_WINDOW, never reaching back past
// the current slot era), refreshed hourly — the nominal slot time runs ~8% fast on
// Hydration (2.16 s measured against 2 s), which over a week-long decision period
// is half a day. A missing or implausible measurement falls back to the nominal.

interface Head { block: number; tsMs: number; msPerBlock: number; rate: BlockRate; toMs: (block: number) => number }

export interface BlockRate {
  msPerBlock: number
  nominalMsPerBlock: number
  source: 'measured' | 'nominal'
  /** The indexed blocks the mean was taken over (measured only). */
  window: { fromBlock: number; toBlock: number } | null
}

export const GOVERNANCE_RATE_WINDOW = 302_400
const MIN_RATE_WINDOW = 43_200
const CURRENT_SLOT_ERA_FROM = SLOT_ERAS[SLOT_ERAS.length - 1].fromBlock

/** The measured pace from two indexed block times, or null when it cannot be trusted. Pure. */
export function measuredRate(fromBlock: number, fromMs: number, toBlock: number, toMs: number, nominalMs: number): number | null {
  const blocks = toBlock - fromBlock
  if (!(blocks >= MIN_RATE_WINDOW) || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null
  const ms = (toMs - fromMs) / blocks
  // Out of band (a stall, a gap in the index): the nominal is the safer line.
  if (ms < nominalMs * 0.8 || ms > nominalMs * 1.5) return null
  return Math.round(ms * 10) / 10
}

async function blockRate(headBlock: number): Promise<BlockRate> {
  const nominalMsPerBlock = await paraBlockMs(client)
  return cached('governance:read:block-rate', 3_600_000, async () => {
    const fromBlock = Math.max(headBlock - GOVERNANCE_RATE_WINDOW, CURRENT_SLOT_ERA_FROM)
    try {
      const res = await client.query({
        query: `SELECT block_height AS b, toUnixTimestamp64Milli(toDateTime64(block_timestamp, 3)) AS t
                FROM price_data.blocks WHERE block_height IN {blocks:Array(UInt32)}`,
        query_params: { blocks: [fromBlock, headBlock] }, format: 'JSONEachRow',
      })
      const rows = new Map((await res.json<{ b: number; t: number | string }>()).map(r => [Number(r.b), Number(r.t)]))
      const ms = measuredRate(fromBlock, rows.get(fromBlock) ?? NaN, headBlock, rows.get(headBlock) ?? NaN, nominalMsPerBlock)
      if (ms != null) return { msPerBlock: ms, nominalMsPerBlock, source: 'measured' as const, window: { fromBlock, toBlock: headBlock } }
    } catch (err) {
      console.warn('[governance] block-rate measurement failed; projecting at the nominal slot time', err)
    }
    return { msPerBlock: nominalMsPerBlock, nominalMsPerBlock, source: 'nominal' as const, window: null }
  })
}

async function head(): Promise<Head> {
  return cached('governance:read:head', 1_500, async () => {
    const res = await client.query({
      query: 'SELECT block_height AS b, toUnixTimestamp(block_timestamp) AS t FROM price_data.blocks ORDER BY block_height DESC LIMIT 1',
      format: 'JSONEachRow',
    })
    const r = (await res.json<{ b: number; t: number }>())[0]
    const block = Number(r?.b ?? (await indexedHead()))
    const tsMs = Number(r?.t ?? Date.now() / 1000) * 1000
    const rate = await blockRate(block)
    return { block, tsMs, msPerBlock: rate.msPerBlock, rate, toMs: paraBlockProjector(tsMs, block, rate.msPerBlock) }
  })
}

/** The governance projector's anchor and pace, for the explorer to place its own countdowns identically. */
export interface GovernanceClock { headBlock: number; headTs: string; msPerBlock: number; nominalMsPerBlock: number; source: BlockRate['source']; window: BlockRate['window'] }

export async function getGovernanceClock(): Promise<GovernanceClock> {
  const h = await head()
  return { headBlock: h.block, headTs: new Date(h.tsMs).toISOString(), msPerBlock: h.msPerBlock, nominalMsPerBlock: h.rate.nominalMsPerBlock, source: h.rate.source, window: h.rate.window }
}

/** A block, with the moment it happened (exact) or is projected to (estimate). */
export interface BlockMoment { block: number; ts: string; exact: boolean }

/**
 * A block's moment: its indexed timestamp when it is at or below the head (from
 * `exactTs`, or the `past` lookup filled by blockTimes), else projected forward from
 * the head at the nominal slot time. A past block is never projected backward — the
 * slot time changed over history, so a backward projection would misdate it.
 */
function momentOf(h: Head, block: number, exactTs?: string | null, past?: ReadonlyMap<number, string>): BlockMoment {
  if (exactTs) return { block, ts: isoOf(exactTs), exact: true }
  const known = past?.get(block)
  if (known) return { block, ts: isoOf(known), exact: true }
  return { block, ts: new Date(h.toMs(block)).toISOString(), exact: false }
}

/** Indexed timestamps of past blocks (a primary-key lookup on `blocks`). */
async function blockTimes(blocks: Iterable<number>, h: Head): Promise<Map<number, string>> {
  const wanted = [...new Set([...blocks].filter(b => Number.isInteger(b) && b > 0 && b <= h.block))]
  const out = new Map<number, string>()
  if (!wanted.length) return out
  const res = await client.query({
    query: 'SELECT block_height AS b, toString(block_timestamp) AS t FROM price_data.blocks WHERE block_height IN {blocks:Array(UInt32)}',
    query_params: { blocks: wanted }, format: 'JSONEachRow',
  })
  for (const r of await res.json<{ b: number; t: string }>()) out.set(Number(r.b), r.t)
  return out
}

function isoOf(chTs: string): string {
  const t = Date.parse(chTs.includes('T') ? chTs : `${chTs.replace(' ', 'T')}Z`)
  return Number.isFinite(t) ? new Date(t).toISOString() : chTs
}

// ---- the OpenGov directory, with outcomes ----

export interface OpengovRef {
  index: number
  track: number | null
  status: string
  submitted: { block: number; ts: string } | null
  phase: ReturnType<typeof opengovPhase>
  concluded: { event: string; block: number; ts: string } | null
  outcome: PollOutcome
  /** The block the poll ends if nothing changes (running only; an estimate). */
  expectedEnd: number | null
  finalTally: { ayes: string; nays: string; support: string | null } | null
  decisionDepositPlaced: boolean
}

/** Every OpenGov referendum's state and outcome, from the lifecycle table (a few thousand rows, cached a block). */
export async function opengovReferenda(): Promise<Map<number, OpengovRef>> {
  return cached('governance:read:opengov', 6_000, async () => {
    const lifecycle = await allOpengovLifecycle()
    const out = new Map<number, OpengovRef>()
    for (const [index, rows] of lifecycle) {
      const submitted = rows.find(r => r.event_name === 'Referenda.Submitted') ?? null
      let track: number | null = null
      try { const t = submitted ? (JSON.parse(submitted.args_json) as { track?: unknown }).track : null; track = typeof t === 'number' ? t : null } catch { track = null }
      const concludedRow = [...rows].reverse().find(r => isConcludingEvent(r.event_name)) ?? null
      const phase = opengovPhase(rows)
      const def = track != null ? trackById(track) : null
      let outcome: PollOutcome
      let expectedEnd: number | null = null
      if (concludedRow) {
        const e = concludedRow.event_name
        outcome = e === 'Referenda.Confirmed' || e === 'Referenda.Approved'
          ? { state: 'completed', end: concludedRow.block_height, approved: true }
          : e === 'Referenda.Rejected'
            ? { state: 'completed', end: concludedRow.block_height, approved: false }
            : { state: 'none' }
      } else {
        if (phase && def) {
          expectedEnd = phase.confirmStartBlock != null ? phase.confirmStartBlock + def.confirmPeriod
            : phase.decisionStartBlock != null ? phase.decisionStartBlock + def.decisionPeriod
              : phase.submittedBlock + def.preparePeriod + def.decisionPeriod
        }
        outcome = { state: 'ongoing', expectedEnd }
      }
      out.set(index, {
        index,
        track,
        status: referendumStatusFrom('opengov', rows.map(r => r.event_name)),
        submitted: submitted ? { block: submitted.block_height, ts: isoOf(submitted.ts) } : null,
        phase,
        concluded: concludedRow ? { event: concludedRow.event_name, block: concludedRow.block_height, ts: isoOf(concludedRow.ts) } : null,
        outcome,
        expectedEnd,
        finalTally: concludedRow ? tallyFromArgs(concludedRow.args_json) : null,
        decisionDepositPlaced: rows.some(r => r.event_name === 'Referenda.DecisionDepositPlaced'),
      })
    }
    return out
  })
}

function outcomeLookup(refs: Map<number, OpengovRef>): (poll: number) => PollOutcome {
  return poll => refs.get(poll)?.outcome ?? { state: 'unknown' }
}

// ---- tracks ----

export interface ConvictionLockInfo {
  conviction: number
  name: string
  multiplierTenths: number
  lockPeriods: number
  lockBlocks: number
  /** lockBlocks at the chain's nominal slot time, in days. */
  lockDays: number
}

export interface GovernanceTrackInfo {
  id: number
  name: string
  maxDeciding: number
  decisionDeposit: string
  preparePeriod: number
  decisionPeriod: number
  confirmPeriod: number
  minEnactmentPeriod: number
  minApproval: TrackCurve
  minSupport: TrackCurve
  /** 101 samples over the decision period: x (Perbill of the period), block offset, approval and support thresholds (Perbill). */
  curve: { x: number; block: number; approval: number; support: number }[]
  /** Referenda deciding or confirming now (the pallet admits at most maxDeciding). */
  deciding: number
  live: { index: number; title: string | null; status: string }[]
  recent: { index: number; title: string | null; status: string; concludedAt: { block: number; ts: string } | null }[]
  outcomes: { approved: number; rejected: number; cancelled: number; timedOut: number; killed: number; ongoing: number }
  /** approved / (approved + rejected): the referenda the electorate decided; null before any. */
  passRate: number | null
}

export interface GovernanceTracks {
  voteLockingPeriod: number
  msPerBlock: number
  undecidingTimeout: number
  maxVotesPerClass: number
  convictions: ConvictionLockInfo[]
  tracks: GovernanceTrackInfo[]
}

export async function getGovernanceTracks(): Promise<GovernanceTracks> {
  const out = await cached('governance:read:tracks', 60_000, async () => {
    const [refs, h] = await Promise.all([opengovReferenda(), head()])
    const period = voteLockingPeriodBlocks()
    const dayBlocks = 86_400_000 / h.msPerBlock
    const convictions: ConvictionLockInfo[] = CONVICTION_NAMES.map((name, conviction) => {
      const lockBlocks = convictionLockBlocks(conviction, period)
      return {
        conviction, name, multiplierTenths: Number(convictionTenths(conviction)), lockPeriods: lockPeriods(conviction),
        lockBlocks, lockDays: Math.round(lockBlocks / dayBlocks * 100) / 100,
      }
    })
    const byTrack = new Map<number, OpengovRef[]>()
    for (const r of refs.values()) if (r.track != null) (byTrack.get(r.track) ?? byTrack.set(r.track, []).get(r.track)!).push(r)
    const tracks = referendaTracks().map(t => trackInfo(t, byTrack.get(t.id) ?? []))
    return { voteLockingPeriod: period, msPerBlock: h.msPerBlock, undecidingTimeout: undecidingTimeoutBlocks(), maxVotesPerClass: MAX_VOTES_PER_CLASS, convictions, tracks }
  })
  // Titles are laid over the cached tracks at read time, so a hidden description
  // drops its title as soon as the forum snapshot does (referendumTitleService).
  const titled = <T extends { index: number; title: string | null }>(r: T): T => ({ ...r, title: referendumTitleFor('opengov', r.index) })
  return { ...out, tracks: out.tracks.map(t => ({ ...t, live: t.live.map(titled), recent: t.recent.map(titled) })) }
}

function trackInfo(t: TrackDef, refs: OpengovRef[]): GovernanceTrackInfo {
  const outcomes = { approved: 0, rejected: 0, cancelled: 0, timedOut: 0, killed: 0, ongoing: 0 }
  for (const r of refs) {
    const e = r.concluded?.event
    if (!e) outcomes.ongoing++
    else if (e === 'Referenda.Confirmed' || e === 'Referenda.Approved') outcomes.approved++
    else if (e === 'Referenda.Rejected') outcomes.rejected++
    else if (e === 'Referenda.Cancelled') outcomes.cancelled++
    else if (e === 'Referenda.TimedOut') outcomes.timedOut++
    else if (e === 'Referenda.Killed') outcomes.killed++
  }
  const decided = outcomes.approved + outcomes.rejected
  const live = refs.filter(r => !r.concluded).sort((a, b) => b.index - a.index)
  const recent = refs.filter(r => r.concluded).sort((a, b) => (b.concluded!.block - a.concluded!.block) || (b.index - a.index)).slice(0, 10)
  return {
    id: t.id, name: t.name, maxDeciding: t.maxDeciding, decisionDeposit: t.decisionDeposit,
    preparePeriod: t.preparePeriod, decisionPeriod: t.decisionPeriod, confirmPeriod: t.confirmPeriod, minEnactmentPeriod: t.minEnactmentPeriod,
    minApproval: t.minApproval, minSupport: t.minSupport,
    curve: sampleTrackCurves(t),
    deciding: live.filter(r => r.phase && r.phase.decisionStartBlock != null).length,
    live: live.map(r => ({ index: r.index, title: referendumTitleFor('opengov', r.index), status: r.status })),
    recent: recent.map(r => ({ index: r.index, title: referendumTitleFor('opengov', r.index), status: r.status, concludedAt: r.concluded ? { block: r.concluded.block, ts: r.concluded.ts } : null })),
    outcomes,
    passRate: decided ? outcomes.approved / decided : null,
  }
}

// ---- tally trajectory ----

export interface TallyPoint { block: number; ts: string | null; ayes: string; nays: string; support: string; approval: number | null }

export interface TallyHistory {
  pallet: ReferendumPallet
  index: number
  track: { id: number; name: string } | null
  submittedBlock: number | null
  decisionStartBlock: number | null
  decisionPeriod: number | null
  confirmStartBlock: number | null
  concludedBlock: number | null
  points: TallyPoint[]
  /** The chain's own tally the trajectory is anchored to: the concluding event's (final), the live storage read (live), else none. */
  chain: { ayes: string; nays: string; support: string | null; source: 'final' | 'live'; block: number | null } | null
  /** chain − reconstructed last point (signed, planck). Never smoothed into the points. */
  residual: { ayes: string; nays: string; support: string | null } | null
  /** |residual ayes| + |residual nays| over the chain's ayes + nays. */
  residualShare: number | null
  /** False when the residual exceeds 0.5% of the turnout: the curve is drawn without the trajectory, and `reason` says why. */
  trajectoryReliable: boolean
  reason: string | null
  /** Delegated power was attributed from the voters' observed VotingFor; false before block 15,622,703, where it stays in the residual. */
  delegationsAttributed: boolean
  /** Active issuance at the live read (support's denominator); null once concluded (not indexed). */
  electorate: string | null
  /** The track's thresholds at absolute blocks over the decision period (empty before deciding), under the runtime in force at the conclusion. */
  thresholds: { block: number; approval: number; support: number }[]
  /** The decision ran across a slot-era boundary (the period constants changed inside it): the curve is approximate. */
  periodsApproximate: boolean
  projection: ReferendumProgress['projection']
}

const RELIABLE_RESIDUAL_SHARE = 0.005

/**
 * One vote's contribution as the tally counts it, from a projection row (the same
 * decoding the referendum page applies).
 */
function voteOf(row: { kind: string; vote_byte: number; balance: string; aye: string; nay: string; abstain: string }): AccountVote | null {
  const n = (s: string) => (/^\d+$/.test(s ?? '') ? BigInt(s) : 0n)
  if (row.kind === 'Split') return { kind: 'Split', aye: n(row.aye), nay: n(row.nay) }
  if (row.kind === 'SplitAbstain') return { kind: 'SplitAbstain', aye: n(row.aye), nay: n(row.nay), abstain: n(row.abstain) }
  const d = decodeVoteByte(Number(row.vote_byte))
  if (d.convictionIndex > 6) return null
  return { kind: 'Standard', aye: d.side === 'Aye', conviction: d.convictionIndex, balance: n(row.balance) }
}

/**
 * The tally after each block that moved it, replayed from the indexed votes and
 * withdrawals: per account the last vote at or before the block stands unless a
 * withdrawal came after it. Actions replay in chain order — block, extrinsic, then
 * event index within an extrinsic (a batch removing a vote and casting another) — and
 * a withdrawal with no event index of its own counts as coming before the votes of its
 * extrinsic, exactly as the referendum page orders them (`isAfter`). Delegated power rides on a standing Standard vote exactly
 * as the pallet adds it — the voter's own VotingFor `delegations` for the poll's class,
 * as of the block. Pure: everything it needs is in its arguments.
 */
export function reconstructTally(
  votes: { who: string; block: number; ext: number | null; ord?: number | null; ts: string | null; vote: AccountVote }[],
  removals: { who: string; at: VotePosition }[],
  delegationsAt: ((who: string, block: number) => Delegations | null) | null,
  extraBlocks: { block: number; ts: string | null }[] = [],
): { block: number; ts: string | null; ayes: bigint; nays: bigint; support: bigint }[] {
  type Ev = { block: number; ext: number; ord: number; ts: string | null; kind: 'vote' | 'remove' | 'tick'; who: string; vote?: AccountVote }
  const evs: Ev[] = [
    ...votes.map(v => ({ block: v.block, ext: v.ext ?? -1, ord: v.ord ?? -1, ts: v.ts, kind: 'vote' as const, who: v.who, vote: v.vote })),
    ...removals.map(r => ({ block: r.at.blockHeight, ext: r.at.extrinsicIndex ?? -1, ord: r.at.eventIndex ?? -2, ts: null, kind: 'remove' as const, who: r.who })),
    ...extraBlocks.map(b => ({ block: b.block, ext: Number.MAX_SAFE_INTEGER, ord: 0, ts: b.ts, kind: 'tick' as const, who: '' })),
  ].sort((a, b) => a.block - b.block || a.ext - b.ext || a.ord - b.ord)
  const standing = new Map<string, AccountVote>()
  const out: { block: number; ts: string | null; ayes: bigint; nays: bigint; support: bigint }[] = []
  let i = 0
  while (i < evs.length) {
    const block = evs[i].block
    let ts: string | null = null
    for (; i < evs.length && evs[i].block === block; i++) {
      const e = evs[i]
      ts = ts ?? e.ts
      if (e.kind === 'vote' && e.vote) standing.set(e.who, e.vote)
      else if (e.kind === 'remove') standing.delete(e.who)
    }
    let ayes = 0n, nays = 0n, support = 0n
    for (const [who, vote] of standing) {
      const t = voteTally(vote, vote.kind === 'Standard' && delegationsAt ? delegationsAt(who, block) ?? undefined : undefined)
      ayes += t.ayes; nays += t.nays; support += t.support
    }
    const last = out[out.length - 1]
    if (last && last.ayes === ayes && last.nays === nays && last.support === support) continue
    out.push({ block, ts, ayes, nays, support })
  }
  return out
}

export async function getTallyHistory(pallet: ReferendumPallet, index: number): Promise<TallyHistory | null> {
  const history = await referendumVoteHistory(pallet, index)
  if (!history) return null
  const concluded = history.concludedAt != null
  return cached(`governance:read:tally-history:${pallet}:${index}:${concluded ? 'final' : history.headBlock}`, concluded ? 600_000 : 6_000, async () => {
    const lifecycle = history.lifecycle
    const submitted = lifecycle.find(r => r.event_name === 'Referenda.Submitted' || r.event_name === 'Democracy.Started') ?? null
    let trackId: number | null = null
    try { const t = submitted ? (JSON.parse(submitted.args_json) as { track?: unknown }).track : null; trackId = typeof t === 'number' ? t : null } catch { trackId = null }
    const concludedBlock = history.concludedAt?.blockHeight ?? null
    // The track as the runtime at the referendum's conclusion (or now) defined it:
    // periods in the 12 s and 6 s slot eras were a sixth and a third of today's.
    const currentTrack = pallet === 'opengov' && trackId != null ? trackById(trackId) : null
    const track = currentTrack ? trackAsOf(currentTrack, concludedBlock ?? Number.MAX_SAFE_INTEGER) : null
    const phase = pallet === 'opengov' ? opengovPhase(lifecycle) : null
    const decisionStart = lifecycle.find(r => r.event_name === 'Referenda.DecisionStarted')?.block_height ?? null
    const confirmStart = [...lifecycle].reverse().find(r => r.event_name === 'Referenda.ConfirmStarted')?.block_height ?? null

    // Votes as the tally counts them; withdrawals after the close are unlocks, not withdrawals.
    const votes = history.votes.flatMap(row => {
      const vote = voteOf(row)
      const who = (row.who ?? '').toLowerCase()
      return vote && who ? [{ who, block: Number(row.block_height), ext: row.extrinsic_index, ord: Number(row.event_index), ts: row.ts ? isoOf(row.ts) : null, vote }] : []
    })
    const removals = history.removals.filter(r => history.concludedAt == null || isAfter(history.concludedAt, r.at))

    // Delegated power: the standing Standard voters' own VotingFor for the class, as of
    // each block. Observations begin at the seed block; a window starting earlier keeps
    // its delegations in the residual, stated.
    const windowStart = lifecycle[0]?.block_height ?? 0
    const windowEnd = concludedBlock ?? history.headBlock ?? lifecycle[lifecycle.length - 1]?.block_height ?? 0
    const delegationsAttributed = pallet === 'opengov' && trackId != null && windowStart >= CONVICTION_STATE_FROM_BLOCK
    let delegationsAt: ((who: string, block: number) => Delegations | null) | null = null
    const extraBlocks: { block: number; ts: string | null }[] = []
    if (delegationsAttributed) {
      const standardVoters = [...new Set(votes.filter(v => v.vote.kind === 'Standard').map(v => v.who))]
      const hist = await convictionHistory(standardVoters, windowEnd)
      const classOf = (classes: ClassVoting[] | null) => classes?.find(c => c.cls === trackId) ?? null
      delegationsAt = (who, block) => {
        const c = classOf(stateAsOf(hist.get(who), block)?.classes ?? null)
        return c?.kind === 'casting' ? c.delegations : null
      }
      // A delegation that moves while the vote stands moves the tally at its own block.
      for (const [, rows] of hist) {
        let prev: string | null = null
        for (const row of rows) {
          const c = classOf(row.classes)
          const key = c?.kind === 'casting' ? `${c.delegations.votes}:${c.delegations.capital}` : ''
          if (row.block > windowStart && row.block <= windowEnd && key !== prev) extraBlocks.push({ block: row.block, ts: null })
          prev = key
        }
      }
    }
    const steps = reconstructTally(votes, removals, delegationsAt, extraBlocks)
    const h = await head()
    const pointTimes = await blockTimes(steps.filter(st => !st.ts).map(st => st.block), h)
    const points: TallyPoint[] = steps.map(s => ({
      block: s.block,
      ts: s.ts ?? pointTimes.get(s.block) ?? null,
      ayes: s.ayes.toString(), nays: s.nays.toString(), support: s.support.toString(),
      approval: perbillOfRational(s.ayes, s.ayes + s.nays),
    }))

    // The anchor: the concluding event's tally, else the live storage tally.
    const onChain = onChainTallyFrom(lifecycle)
    const live = !concluded && pallet === 'opengov' && phase && track ? await liveReferendumState(index) : null
    const chain = onChain?.final
      ? { ayes: onChain.ayes, nays: onChain.nays, support: onChain.support, source: 'final' as const, block: onChain.blockHeight }
      : live ? { ayes: live.ayes, nays: live.nays, support: live.support, source: 'live' as const, block: history.headBlock } : null
    const last = steps[steps.length - 1] ?? { ayes: 0n, nays: 0n, support: 0n }
    let residual: TallyHistory['residual'] = null
    let residualShare: number | null = null
    if (chain) {
      const ra = BigInt(chain.ayes) - last.ayes, rn = BigInt(chain.nays) - last.nays
      const rs = chain.support != null ? BigInt(chain.support) - last.support : null
      residual = { ayes: ra.toString(), nays: rn.toString(), support: rs == null ? null : rs.toString() }
      const turnout = BigInt(chain.ayes) + BigInt(chain.nays)
      const abs = (x: bigint) => (x < 0n ? -x : x)
      residualShare = turnout > 0n ? Number((abs(ra) + abs(rn)) * 1_000_000n / turnout) / 1_000_000 : (ra === 0n && rn === 0n ? 0 : null)
    }
    const trajectoryReliable = residualShare != null && residualShare <= RELIABLE_RESIDUAL_SHARE
    const reason = !chain ? 'no chain tally to anchor to'
      : trajectoryReliable ? null
        : `reconstructed votes leave ${(100 * (residualShare ?? 1)).toFixed(2)}% of the chain's turnout unexplained${delegationsAttributed ? '' : ' (delegations before block 15,622,703 are not observed)'}`

    // A decision that ran across a slot-era boundary was judged under two runtimes'
    // periods; its curve is drawn under the concluding one and flagged.
    const periodsApproximate = track != null && spansSlotEras(decisionStart ?? submitted?.block_height ?? 0, concludedBlock ?? history.headBlock ?? Number.MAX_SAFE_INTEGER)
    const thresholds = track && decisionStart != null
      ? sampleTrackCurves(track).map(s => ({ block: decisionStart + s.block, approval: s.approval, support: s.support }))
      : []
    const progress = phase && track && history.headBlock != null
      ? progressFrom(phase, track, history.headBlock, live, { ayes: last.ayes.toString(), nays: last.nays.toString(), support: last.support.toString() })
      : null
    return {
      pallet, index,
      track: track ? { id: track.id, name: track.name } : trackId != null ? { id: trackId, name: `track ${trackId}` } : null,
      submittedBlock: submitted?.block_height ?? null,
      decisionStartBlock: decisionStart,
      decisionPeriod: track?.decisionPeriod ?? null,
      confirmStartBlock: concluded ? confirmStart : phase?.confirmStartBlock ?? null,
      concludedBlock,
      points,
      chain,
      residual,
      residualShare,
      trajectoryReliable,
      reason,
      delegationsAttributed,
      electorate: live?.electorate ?? null,
      thresholds,
      periodsApproximate,
      projection: progress?.projection ?? null,
    }
  })
}

// ---- an account's governance ----

export interface GovernanceVoteRow {
  account: string
  cls: number
  trackName: string | null
  poll: number
  referendum: { index: number; title: string | null; status: string } | null
  vote: { kind: AccountVote['kind']; side: 'Aye' | 'Nay' | 'Split' | 'SplitAbstain'; conviction: number | null; convictionName: string | null; balance: string; aye: string; nay: string; abstain: string }
  /** What the vote adds to the tally (conviction-weighted; delegated power not included). */
  weighted: { ayes: string; nays: string; support: string }
  lockedNow: string
  afterEnd: { kind: string; amount: string; until: BlockMoment | null; estimate: boolean }
  finished: boolean
  /** Removing it while its poll is ongoing forfeits the staking/GIGAHDX rewards it would earn. */
  removalForfeitsRewards: boolean
}

export interface GovernanceClassRow {
  account: string
  cls: number
  trackName: string | null
  kind: 'casting' | 'delegating'
  votes: number
  maxVotes: number
  prior: { amount: string; until: BlockMoment | null; expired: boolean } | null
  delegationsIn: { votes: string; capital: string }
  delegating: { target: AccountRef; balance: string; conviction: number; convictionName: string } | null
  /** The class's lock requirement now, before any action. */
  requiredNow: string
}

export interface AccountGovernanceLocks {
  account: string
  locked: string
  unlockableAsIs: string
  unlockableNow: string
  unlockableCollect: string
  openEnded: string
  /** `spendable`: what the step makes spendable, given the account's other locks (null when they are unknown). */
  schedule: { at: BlockMoment; freeable: string; spendable: string | null }[]
  nextUnlock: { at: BlockMoment; amount: string } | null
  staker: { staking: string; gigahdx: string } | null
  /**
   * The account's other Balances locks (staking, GIGAHDX, vesting, …), from the same
   * observation as `locked`. Balances freezes the MAX of all locks, so HDX one of
   * these holds stays frozen when the vote lock releases. Null when not readable.
   */
  otherLocks: { id: string; name: string; amount: string }[] | null
  /** HDX each course makes spendable (the `unlockable*` releases net of the other locks); null when the other locks are unknown. */
  spendableAsIs: string | null
  spendableNow: string | null
  spendableCollect: string | null
  /** The block of the newest lock observation; the state is unchanged from it up to the response's `asOfBlock`. */
  lockObservedAt: number | null
  /** Unlock figures are computed from indexed state; the composer confirms them by dry-run. */
  estimate: true
}

export interface AccountGovernance {
  account: AccountRef
  related: string[]
  asOfBlock: number | null
  votes: GovernanceVoteRow[]
  classes: GovernanceClassRow[]
  locks: AccountGovernanceLocks[]
  delegations: {
    in: { from: AccountRef; to: string; cls: number; trackName: string | null; balance: string; conviction: number; convictionName: string }[]
    out: { from: string; to: AccountRef; cls: number; trackName: string | null; balance: string; conviction: number; convictionName: string }[]
  }
  proxies: {
    /** Accounts this account can act for (it is their proxy). */
    canActFor: GovProxyRow[]
    /** Accounts that can act for this account (its proxies). */
    actedForBy: GovProxyRow[]
    pure: { creator: AccountRef; proxyType: string; blockHeight: number } | null
  }
  /**
   * Referenda this account voted on: polls its observed VotingFor ever held (every
   * dispatch path — direct, proxy, multisig, batch, permit — from `observedFrom` on)
   * united with its direct vote calls (all history). A wrapped vote cast before
   * `observedFrom` and removed before it is the one case neither source sees.
   */
  history: {
    referendaVoted: number
    lastVote: BlockMoment | null
    /**
     * The newest Standard OpenGov vote the account cast (what "same as last time" copies),
     * even if it has since been removed from chain state: from the observed VotingFor
     * changes and the direct vote calls, whichever is newer. Null when none is indexed.
     */
    lastStandardVote: { index: number; aye: boolean; conviction: number; balance: string; at: BlockMoment } | null
    source: 'voting-state+direct-calls'
    observedFrom: number
  }
  forum: { posts: number; comments: number }
  /** HDX the account (and its related accounts) holds in referendum and preimage deposits (governanceDeposits.ts). */
  deposits: AccountDeposits
  /** GigaHdxRewards.PendingRewards is not indexed; the composer reads it at compose time. */
  gigahdxPendingRewards: null
}

const VOTING_PROXY_TYPES = new Set(['Any', 'Governance'])

/**
 * One proxy relation of an account's governance read. Only an Any or a Governance proxy
 * with no delay can vote (the runtime's ProxyType filter); `blocked` says why another
 * cannot ('type', else 'delay': a delayed proxy must announce and wait, which the
 * explorer does not do), and `holder` is the related account id (the account or its
 * EVM twin) the relation belongs to, so a signer is never offered its twin's.
 */
export interface GovProxyRow { account: AccountRef; proxyType: string; delay: number; canVote: boolean; blocked: 'delay' | 'type' | null; holder: string }

export function govProxyRow(p: { accountId: string; proxyType: string; delay: number }, holder: string, ref: (id: string) => AccountRef): GovProxyRow {
  const blocked = !VOTING_PROXY_TYPES.has(p.proxyType) ? 'type' : p.delay > 0 ? 'delay' : null
  return { account: ref(p.accountId), proxyType: p.proxyType, delay: p.delay, canVote: blocked == null, blocked, holder }
}

/** Each related account's relations, tagged with it, those that can vote first. */
function proxyRowsOf(related: string[], pick: (info: NonNullable<ReturnType<typeof proxyInfoFor>>) => { accountId: string; proxyType: string; delay: number }[], ref: (id: string) => AccountRef): GovProxyRow[] {
  const rows = related.flatMap(holder => { const info = proxyInfoFor([holder]); return info ? pick(info).map(p => govProxyRow(p, holder, ref)) : [] })
  return [...rows.filter(r => r.canVote), ...rows.filter(r => !r.canVote)]
}

/** The staked HDX a losing vote's lock is capped by: the larger of the legacy-staking and GIGAHDX locks. */
const stakeCapOf = (l: ReturnType<typeof voteLocksOf>): bigint => (l ? (l.staking > l.gigahdx ? l.staking : l.gigahdx) : 0n)

/**
 * One account's conviction-lock plan as it stands at `atBlock` (its unlock schedule
 * lists the steps after that block), or null when it holds no voting state and no
 * conviction lock. The ONE place the Governance tab and the unlock alert build it.
 */
function lockPlanAt(acc: string, atBlock: number, outcomeOf: (poll: number) => PollOutcome, period: number, otherLocked = 0n): UnlockPlan | null {
  const cvs = convictionStateOf(acc)?.classes ?? []
  const l = voteLocksOf(acc)
  if (!cvs.length && !(l && l.conviction > 0n)) return null
  return unlockPlan(cvs, l?.conviction ?? 0n, atBlock, outcomeOf, period, stakeCapOf(l), otherLocked)
}

export async function getAccountGovernance(address: string): Promise<AccountGovernance | null> {
  const resolved = await resolveRelatedAccounts(address)
  if (!resolved) return null
  const related = [...resolved.related]
  const snapBlock = convictionSnapshotBlock()
  return cached(`governance:read:account:${resolved.norm.accountId}:${snapBlock}`, 6_000, async () => {
    const [refs, h, others] = await Promise.all([opengovReferenda(), head(), otherLocksOf(related)])
    const outcomeOf = outcomeLookup(refs)
    const period = voteLockingPeriodBlocks()
    const trackName = (cls: number) => trackById(cls)?.name ?? null
    // Past lock ends (expired priors and votes) are dated by their indexed blocks.
    const pastBlocks: number[] = []
    for (const acc of related) for (const c of convictionStateOf(acc)?.classes ?? []) {
      if (c.prior.until > 0) pastBlocks.push(c.prior.until)
      if (c.kind === 'casting') for (const { poll, vote } of c.votes) {
        const after = voteAfterLock(vote, outcomeOf(poll), period, 0n)
        if (after.untilBlock != null) pastBlocks.push(after.untilBlock)
      }
    }
    const past = await blockTimes(pastBlocks, h)
    const votes: GovernanceVoteRow[] = []
    const classes: GovernanceClassRow[] = []
    const locks: AccountGovernanceLocks[] = []
    const out: AccountGovernance['delegations']['out'] = []
    const inbound: AccountGovernance['delegations']['in'] = []
    for (const acc of related) {
      const state = convictionStateOf(acc)
      const l = voteLocksOf(acc)
      const stakeCap = stakeCapOf(l)
      const cvs = state?.classes ?? []
      for (const c of cvs) {
        if (c.kind === 'delegating') {
          out.push({ from: acc, to: accountRef(c.target), cls: c.cls, trackName: trackName(c.cls), balance: c.balance.toString(), conviction: c.conviction, convictionName: CONVICTION_NAMES[c.conviction] })
        } else {
          for (const { poll, vote } of c.votes) {
            const outcome = outcomeOf(poll)
            const ref = refs.get(poll)
            const after = voteAfterLock(vote, outcome, period, stakeCap)
            const t = voteTally(vote)
            votes.push({
              account: acc, cls: c.cls, trackName: trackName(c.cls), poll,
              referendum: ref ? { index: poll, title: referendumTitleFor('opengov', poll), status: ref.status } : null,
              vote: {
                kind: vote.kind,
                side: vote.kind === 'Standard' ? (vote.aye ? 'Aye' : 'Nay') : vote.kind,
                conviction: vote.kind === 'Standard' ? vote.conviction : null,
                convictionName: vote.kind === 'Standard' ? CONVICTION_NAMES[vote.conviction] : null,
                balance: voteBalance(vote).toString(),
                aye: vote.kind === 'Standard' ? (vote.aye ? vote.balance.toString() : '0') : vote.aye.toString(),
                nay: vote.kind === 'Standard' ? (vote.aye ? '0' : vote.balance.toString()) : vote.nay.toString(),
                abstain: vote.kind === 'SplitAbstain' ? vote.abstain.toString() : '0',
              },
              weighted: { ayes: t.ayes.toString(), nays: t.nays.toString(), support: t.support.toString() },
              lockedNow: voteBalance(vote).toString(),
              afterEnd: { kind: after.kind, amount: after.amount.toString(), until: after.untilBlock == null ? null : momentOf(h, after.untilBlock, null, past), estimate: after.estimate },
              finished: outcome.state === 'completed' || outcome.state === 'none',
              removalForfeitsRewards: outcome.state === 'ongoing',
            })
          }
        }
        classes.push({
          account: acc, cls: c.cls, trackName: trackName(c.cls), kind: c.kind,
          votes: c.kind === 'casting' ? c.votes.length : 0, maxVotes: MAX_VOTES_PER_CLASS,
          prior: c.prior.amount > 0n ? { amount: c.prior.amount.toString(), until: c.prior.until > 0 ? momentOf(h, c.prior.until, null, past) : null, expired: c.prior.until <= h.block } : null,
          delegationsIn: { votes: c.delegations.votes.toString(), capital: c.delegations.capital.toString() },
          delegating: c.kind === 'delegating' ? { target: accountRef(c.target), balance: c.balance.toString(), conviction: c.conviction, convictionName: CONVICTION_NAMES[c.conviction] } : null,
          requiredNow: classRequirement(c, h.block, 'as-is', outcomeOf, period, stakeCap).toString(),
        })
      }
      for (const d of delegatorsOf(acc)) {
        inbound.push({ from: accountRef(d.accountId), to: acc, cls: d.cls, trackName: trackName(d.cls), balance: d.balance.toString(), conviction: d.conviction, convictionName: CONVICTION_NAMES[d.conviction] })
      }
      // No lock observation at all: the account holds no lock of any kind.
      const other = others.has(acc) ? others.get(acc)! : l ? null : []
      const otherMax = (other ?? []).reduce((m, o) => (o.amount > m ? o.amount : m), 0n)
      const plan = lockPlanAt(acc, h.block, outcomeOf, period, otherMax)
      if (plan) {
        const known = other != null
        const schedule = plan.schedule.map(s => ({
          at: momentOf(h, s.block), freeable: s.freeable.toString(),
          spendable: known ? spendableAfterRelease(plan.locked, s.freeable, otherMax).toString() : null,
        }))
        const nextStep = plan.schedule.find(s => s.freeable > plan.unlockableNow)
        locks.push({
          account: acc,
          locked: plan.locked.toString(),
          unlockableAsIs: plan.unlockableAsIs.toString(),
          unlockableNow: plan.unlockableNow.toString(),
          unlockableCollect: plan.unlockableCollect.toString(),
          openEnded: plan.openEnded.toString(),
          schedule,
          nextUnlock: nextStep ? { at: momentOf(h, nextStep.block), amount: (nextStep.freeable - plan.unlockableNow).toString() } : null,
          staker: l && (l.staking > 0n || l.gigahdx > 0n) ? { staking: l.staking.toString(), gigahdx: l.gigahdx.toString() } : null,
          otherLocks: known ? other!.map(o => ({ id: o.id, name: lockIdName(o.id), amount: o.amount.toString() })) : null,
          spendableAsIs: known ? plan.spendableAsIs.toString() : null,
          spendableNow: known ? plan.spendableNow.toString() : null,
          spendableCollect: known ? plan.spendableCollect.toString() : null,
          lockObservedAt: l?.block ?? null,
          estimate: true,
        })
      }
    }
    votes.sort((a, b) => b.poll - a.poll || a.cls - b.cls)

    const proxies = proxyInfoFor(related)

    // Referenda voted on: every poll the account's observed VotingFor ever held — which
    // captures votes however they were dispatched (direct, proxy, multisig, batch,
    // gasless permit), from the seed read at block 15,622,703 on — united with the
    // direct vote calls, which reach back before the observations began.
    const voted = new Map<string, number>() // 'pallet:index' → newest block it was voted at
    const markVote = (key: string, block: number) => { if (block > (voted.get(key) ?? -1)) voted.set(key, block) }
    const callsRes = await client.query({
      query: `SELECT pallet, ref_index, max(block_height) AS b
              FROM price_data.governance_vote_calls_by_voter
              WHERE voter IN {voters:Array(String)} AND success = 1
                AND call_name IN ('ConvictionVoting.vote', 'Democracy.vote')
              GROUP BY pallet, ref_index`,
      query_params: { voters: related }, format: 'JSONEachRow',
    })
    for (const r of await callsRes.json<{ pallet: string; ref_index: number; b: number }>()) markVote(`${r.pallet}:${r.ref_index}`, Number(r.b))
    let lastStd: { block: number; index: number; aye: boolean; conviction: number; balance: bigint } | null = null
    const markStandard = (block: number, index: number, aye: boolean, conviction: number, balance: bigint) => {
      if (!lastStd || block > lastStd.block || (block === lastStd.block && index > lastStd.index)) lastStd = { block, index, aye, conviction, balance }
    }
    const lastCallRes = await client.query({
      query: `SELECT ref_index, block_height AS b, vote_byte, balance
              FROM price_data.governance_vote_calls_by_voter
              WHERE voter IN {voters:Array(String)} AND success = 1
                AND call_name = 'ConvictionVoting.vote' AND vote_kind = 'Standard'
              ORDER BY block_height DESC LIMIT 1`,
      query_params: { voters: related }, format: 'JSONEachRow',
    })
    for (const r of await lastCallRes.json<{ ref_index: number; b: number; vote_byte: number; balance: string }>()) {
      if (/^\d+$/.test(r.balance)) markStandard(Number(r.b), Number(r.ref_index), Number(r.vote_byte) >= 128, Number(r.vote_byte) & 0x7f, BigInt(r.balance))
    }
    for (const [, rows] of await convictionHistory(related, h.block)) {
      let prev = new Map<number, string>()
      for (const row of rows) {
        const cur = new Map<number, string>()
        for (const c of row.classes ?? []) if (c.kind === 'casting') for (const { poll, vote } of c.votes) {
          const shape = JSON.stringify(vote, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
          cur.set(poll, shape)
          // A poll that appears, or whose vote changes, was voted at this block.
          if (prev.get(poll) !== shape) {
            markVote(`opengov:${poll}`, row.block)
            if (vote.kind === 'Standard') markStandard(row.block, poll, vote.aye, vote.conviction, vote.balance)
          }
        }
        prev = cur
      }
    }
    const lastVoteBlock = voted.size ? Math.max(...voted.values()) : null
    const lastStdFinal = lastStd as { block: number; index: number; aye: boolean; conviction: number; balance: bigint } | null
    const lastVoteTimes = lastVoteBlock != null || lastStdFinal
      ? await blockTimes([...(lastVoteBlock != null ? [lastVoteBlock] : []), ...(lastStdFinal ? [lastStdFinal.block] : [])], h)
      : new Map<number, string>()
    const forum = related.reduce((acc, id) => {
      const c = forumAuthorCounts(id)
      return c ? { posts: acc.posts + c.posts, comments: acc.comments + c.comments } : acc
    }, { posts: 0, comments: 0 })

    return {
      account: accountRef(resolved.norm.accountId),
      related,
      asOfBlock: snapBlock,
      votes,
      classes,
      locks,
      delegations: { in: inbound, out },
      proxies: {
        canActFor: proxyRowsOf(related, info => info.delegatorOf, accountRef),
        actedForBy: proxyRowsOf(related, info => info.delegates, accountRef),
        pure: proxies?.isPure ? { creator: accountRef(proxies.isPure.creator), proxyType: proxies.isPure.proxyType, blockHeight: proxies.isPure.blockHeight } : null,
      },
      history: {
        referendaVoted: voted.size,
        lastVote: lastVoteBlock != null ? momentOf(h, lastVoteBlock, null, lastVoteTimes) : null,
        lastStandardVote: lastStdFinal ? {
          index: lastStdFinal.index, aye: lastStdFinal.aye, conviction: Math.min(6, lastStdFinal.conviction),
          balance: lastStdFinal.balance.toString(), at: momentOf(h, lastStdFinal.block, null, lastVoteTimes),
        } : null,
        source: 'voting-state+direct-calls',
        observedFrom: CONVICTION_STATE_FROM_BLOCK,
      },
      forum,
      deposits: await accountDeposits(related),
      gigahdxPendingRewards: null,
    }
  })
}

// ---- needs your vote ----

export interface NeedsVoteReferendum {
  index: number
  title: string | null
  track: { id: number; name: string } | null
  status: string
  /** The next deadline: the decision or confirmation end, or the undeciding timeout while preparing without a deposit. */
  ends: { kind: 'decision-end' | 'confirm-end' | 'timeout' | 'prepare-end'; at: BlockMoment } | null
}

export interface NeedsVote {
  asOfBlock: number | null
  referenda: NeedsVoteReferendum[]
  accounts: {
    input: string
    accountId: string | null
    needsVote: number[]
    voted: { index: number; side: string; conviction: number | null; balance: string }[]
    delegated: { index: number; cls: number; target: AccountRef }[]
  }[]
}

// ---- a group's governance (a tag's or a list tag's members) ----

/** One running referendum a group's members vote on: their current votes on it, combined. */
export interface MembersRunningVote {
  index: number
  title: string | null
  status: string
  trackName: string | null
  /** Members with a vote on it. */
  voters: number
  /** HDX behind the votes, by side (a split vote counts in each part). */
  aye: string
  nay: string
  abstain: string
  /** Conviction-weighted, as the tally counts them (support: capital toward turnout). */
  weighted: { ayes: string; nays: string; support: string }
}

/**
 * What a group of accounts holds in governance right now, summed over its members from
 * the conviction-state snapshot: the HDX the conviction lock holds and when it comes
 * back, who votes or delegates, and the running referenda the members vote on. The
 * vote history itself is the group's votes feed (getScopedVotes / getScopedVotesByReferendum).
 */
export interface MembersGovernance {
  asOfBlock: number | null
  members: number
  /** Members with a current vote on any referendum (running or not yet removed). */
  voting: number
  /** Members delegating at least one track. */
  delegating: number
  locks: {
    /** Members holding a conviction-voting lock. */
    holders: number
    locked: string
    /** Frees now once expired votes are removed (the Unlock button's course). */
    unlockableNow: string
    /** Held until running votes or delegations end (no date yet). */
    openEnded: string
    /** The earliest next release among the members, and what it frees. */
    nextUnlock: { at: BlockMoment; amount: string } | null
  }
  running: MembersRunningVote[]
  /** Delegation targets outside or inside the group, by delegate. */
  delegationsOut: { to: AccountRef; members: number; tracks: number; balance: string }[]
  forum: { posts: number; comments: number }
}

/** The members' governance summed, in raw integers (foldMembersGovernance's output). */
export interface MembersGovernanceFold {
  members: number
  voting: number
  delegating: number
  holders: number
  locked: bigint
  unlockableNow: bigint
  openEnded: bigint
  next: { block: number; amount: bigint } | null
  running: Map<number, { voters: number; aye: bigint; nay: bigint; abstain: bigint; ayes: bigint; nays: bigint; support: bigint }>
  delegationsOut: Map<string, { members: number; tracks: number; balance: bigint }>
  posts: number
  comments: number
}

/**
 * Sums a group's governance from each member's voting state and lock plan. A running
 * vote is one whose poll is `ongoing`; a member's delegated HDX counts once per
 * delegate (the largest balance it delegates there: the same HDX backs every track).
 */
export function foldMembersGovernance(
  members: Iterable<string>,
  deps: {
    classesOf: (acc: string) => ClassVoting[]
    planOf: (acc: string) => UnlockPlan | null
    outcomeOf: (poll: number) => PollOutcome
    forumOf: (acc: string) => { posts: number; comments: number } | null
  },
): MembersGovernanceFold {
  const fold: MembersGovernanceFold = {
    members: 0, voting: 0, delegating: 0, holders: 0, locked: 0n, unlockableNow: 0n, openEnded: 0n, next: null,
    running: new Map(), delegationsOut: new Map(), posts: 0, comments: 0,
  }
  for (const acc of new Set(members)) {
    fold.members++
    const cvs = deps.classesOf(acc)
    if (cvs.some(c => c.kind === 'casting' && c.votes.length)) fold.voting++
    if (cvs.some(c => c.kind === 'delegating')) fold.delegating++
    const delegated = new Map<string, { tracks: number; balance: bigint }>()
    for (const c of cvs) {
      if (c.kind === 'delegating') {
        const d = delegated.get(c.target) ?? { tracks: 0, balance: 0n }
        d.tracks++
        if (c.balance > d.balance) d.balance = c.balance
        delegated.set(c.target, d)
        continue
      }
      for (const { poll, vote } of c.votes) {
        if (deps.outcomeOf(poll).state !== 'ongoing') continue
        const r = fold.running.get(poll) ?? { voters: 0, aye: 0n, nay: 0n, abstain: 0n, ayes: 0n, nays: 0n, support: 0n }
        // A member votes once per poll (a poll belongs to one track).
        r.voters++
        if (vote.kind === 'Standard') { if (vote.aye) r.aye += vote.balance; else r.nay += vote.balance }
        else { r.aye += vote.aye; r.nay += vote.nay; if (vote.kind === 'SplitAbstain') r.abstain += vote.abstain }
        const t = voteTally(vote)
        r.ayes += t.ayes; r.nays += t.nays; r.support += t.support
        fold.running.set(poll, r)
      }
    }
    for (const [target, d] of delegated) {
      const o = fold.delegationsOut.get(target) ?? { members: 0, tracks: 0, balance: 0n }
      o.members++; o.tracks += d.tracks; o.balance += d.balance
      fold.delegationsOut.set(target, o)
    }
    const plan = deps.planOf(acc)
    if (plan && plan.locked > 0n) {
      fold.holders++
      fold.locked += plan.locked; fold.unlockableNow += plan.unlockableNow; fold.openEnded += plan.openEnded
      const step = plan.schedule.find(s => s.freeable > plan.unlockableNow)
      if (step) {
        const amount = step.freeable - plan.unlockableNow
        if (!fold.next || step.block < fold.next.block) fold.next = { block: step.block, amount }
        else if (step.block === fold.next.block) fold.next.amount += amount
      }
    }
    const f = deps.forumOf(acc)
    if (f) { fold.posts += f.posts; fold.comments += f.comments }
  }
  return fold
}

export async function getMembersGovernance(members: string[], scope: string): Promise<MembersGovernance> {
  const snapBlock = convictionSnapshotBlock()
  return cached(`governance:read:members:${scope}:${snapBlock}`, 6_000, async () => {
    const [refs, h] = await Promise.all([opengovReferenda(), head()])
    const outcomeOf = outcomeLookup(refs)
    const period = voteLockingPeriodBlocks()
    const f = foldMembersGovernance(members, {
      classesOf: acc => convictionStateOf(acc)?.classes ?? [],
      planOf: acc => lockPlanAt(acc, h.block, outcomeOf, period),
      outcomeOf,
      forumOf: forumAuthorCounts,
    })
    const desc = (a: bigint, b: bigint) => (b > a ? 1 : b < a ? -1 : 0)
    return {
      asOfBlock: snapBlock,
      members: f.members,
      voting: f.voting, delegating: f.delegating,
      locks: {
        holders: f.holders, locked: f.locked.toString(), unlockableNow: f.unlockableNow.toString(), openEnded: f.openEnded.toString(),
        nextUnlock: f.next ? { at: momentOf(h, f.next.block), amount: f.next.amount.toString() } : null,
      },
      running: [...f.running.entries()].sort((a, b) => b[0] - a[0]).map(([index, r]) => {
        const ref = refs.get(index)
        return {
          index, title: referendumTitleFor('opengov', index), status: ref?.status ?? 'unknown',
          trackName: ref?.track != null ? trackById(ref.track)?.name ?? null : null,
          voters: r.voters, aye: r.aye.toString(), nay: r.nay.toString(), abstain: r.abstain.toString(),
          weighted: { ayes: r.ayes.toString(), nays: r.nays.toString(), support: r.support.toString() },
        }
      }),
      delegationsOut: [...f.delegationsOut.entries()].sort((a, b) => desc(a[1].balance, b[1].balance))
        .map(([to, d]) => ({ to: accountRef(to), members: d.members, tracks: d.tracks, balance: d.balance.toString() })),
      forum: { posts: f.posts, comments: f.comments },
    }
  })
}

export const NEEDS_VOTE_MAX_ACCOUNTS = 20

function nextDeadline(r: OpengovRef, h: Head): NeedsVoteReferendum['ends'] {
  const def = r.track != null ? trackById(r.track) : null
  if (!r.phase || !def) return null
  if (r.phase.confirmStartBlock != null) return { kind: 'confirm-end', at: momentOf(h, r.phase.confirmStartBlock + def.confirmPeriod) }
  if (r.phase.decisionStartBlock != null) return { kind: 'decision-end', at: momentOf(h, r.phase.decisionStartBlock + def.decisionPeriod) }
  if (!r.phase.decisionDepositPlaced) return { kind: 'timeout', at: momentOf(h, r.phase.submittedBlock + undecidingTimeoutBlocks()) }
  return { kind: 'prepare-end', at: momentOf(h, r.phase.submittedBlock + def.preparePeriod) }
}

export async function getNeedsVote(inputs: string[]): Promise<NeedsVote> {
  const [refs, h] = await Promise.all([opengovReferenda(), head()])
  const live = [...refs.values()].filter(r => r.outcome.state === 'ongoing').sort((a, b) => a.index - b.index)
  const referenda: NeedsVoteReferendum[] = live.map(r => {
    const def = r.track != null ? trackById(r.track) : null
    return {
      index: r.index,
      title: referendumTitleFor('opengov', r.index),
      track: r.track == null ? null : { id: r.track, name: def?.name ?? `track ${r.track}` },
      status: r.status,
      ends: nextDeadline(r, h),
    }
  }).sort((a, b) => (a.ends?.at.block ?? Infinity) - (b.ends?.at.block ?? Infinity))
  const accounts: NeedsVote['accounts'] = []
  for (const input of inputs.slice(0, NEEDS_VOTE_MAX_ACCOUNTS)) {
    // Keyed by the normalized account, so the many spellings of one account (SS58 under
    // any prefix, hex, an H160) share one entry and garbage input never makes one.
    const norm = normalizeAddress(input)
    const resolved = norm?.accountId
      ? await cached(`governance:read:related:${norm.accountId}`, 60_000, () => resolveRelatedAccounts(input)).catch(() => null)
      : null
    const ids = resolved ? [...resolved.related] : norm?.accountId ? [norm.accountId] : []
    const voted: NeedsVote['accounts'][number]['voted'] = []
    const delegated: NeedsVote['accounts'][number]['delegated'] = []
    const covered = new Set<number>()
    for (const id of ids) {
      for (const c of convictionStateOf(id)?.classes ?? []) {
        if (c.kind === 'casting') {
          for (const { poll, vote } of c.votes) {
            if (!live.some(r => r.index === poll)) continue
            covered.add(poll)
            voted.push({ index: poll, side: vote.kind === 'Standard' ? (vote.aye ? 'Aye' : 'Nay') : vote.kind, conviction: vote.kind === 'Standard' ? vote.conviction : null, balance: voteBalance(vote).toString() })
          }
        } else {
          for (const r of live) if (r.track === c.cls) { covered.add(r.index); delegated.push({ index: r.index, cls: c.cls, target: accountRef(c.target) }) }
        }
      }
    }
    const accountId = resolved?.norm.accountId ?? norm?.accountId ?? null
    accounts.push({
      input,
      accountId,
      // An input that names no account needs nothing: it is reported, not guessed at.
      needsVote: accountId ? live.filter(r => !covered.has(r.index)).map(r => r.index) : [],
      voted: voted.sort((a, b) => a.index - b.index),
      delegated,
    })
  }
  return { asOfBlock: convictionSnapshotBlock(), referenda, accounts }
}

// ---- the governance alerts' reads ----
//
// The `gov-unvoted` and `gov-unlockable` notification kinds (notifications/
// governanceLane.ts) read the SAME definitions the pages do: the deadline is
// needs-vote's `nextDeadline`, "has a vote" is `getNeedsVote`, and an unlock step is
// the Governance tab's schedule (`lockPlanAt`). Nothing here reads the chain.

/** A live referendum whose next deadline is its decision or confirmation end, dated as needs-vote dates it. */
export interface LiveDeadline {
  index: number
  kind: 'decision-end' | 'confirm-end'
  /** The deadline block. */
  block: number
  /** The block this deadline has applied from: DecisionStarted for a decision end, ConfirmStarted for a confirmation end. */
  since: number
  /** While confirming, the decision end the referendum had before ConfirmStarted (null when it is not known). */
  decision: { block: number; since: number } | null
}

/**
 * Every live OpenGov referendum deciding or confirming, with its next deadline, and
 * the governance clock's pace (ms per block) for turning a lead time into blocks. A
 * preparing referendum (its next deadline a prepare end or the undeciding timeout)
 * is not ending, so it is not listed.
 */
export async function liveReferendumDeadlines(): Promise<{ msPerBlock: number; deadlines: LiveDeadline[] }> {
  const [refs, h] = await Promise.all([opengovReferenda(), head()])
  const deadlines: LiveDeadline[] = []
  for (const r of refs.values()) {
    if (r.outcome.state !== 'ongoing' || !r.phase) continue
    const ends = nextDeadline(r, h)
    if (ends?.kind === 'decision-end' && r.phase.decisionStartBlock != null) {
      deadlines.push({ index: r.index, kind: ends.kind, block: ends.at.block, since: r.phase.decisionStartBlock, decision: null })
    } else if (ends?.kind === 'confirm-end' && r.phase.confirmStartBlock != null) {
      const decisionStart = r.phase.decisionStartBlock
      const before = decisionStart != null ? nextDeadline({ ...r, phase: { ...r.phase, confirmStartBlock: null } }, h) : null
      deadlines.push({
        index: r.index, kind: ends.kind, block: ends.at.block, since: r.phase.confirmStartBlock,
        decision: before?.kind === 'decision-end' && decisionStart != null ? { block: before.at.block, since: decisionStart } : null,
      })
    }
  }
  return { msPerBlock: h.msPerBlock, deadlines: deadlines.sort((a, b) => a.index - b.index) }
}

/** One account's (it or a related account's) conviction-lock unlock steps after a block. */
export interface UnlockSteps {
  /** The account whose lock it is: the input or an account related to it (a bound EVM account, its substrate form). */
  accountId: string
  /** What the Governance tab's 'unlock' course frees at `atBlock`, before any step. */
  freeableAt: bigint
  /** Each later block at which more becomes freeable, with the cumulative amount from then on. */
  steps: { block: number; freeable: bigint }[]
}

/**
 * The unlock schedule of an address and its related accounts, as the Governance tab
 * builds it but computed AT `atBlock` — so a step the head has already passed is
 * still listed when `atBlock` is below it. Null when the address names no account.
 */
export async function accountUnlockSteps(address: string, atBlock: number): Promise<UnlockSteps[] | null> {
  const norm = normalizeAddress(address)
  if (!norm?.accountId) return null
  const resolved = await cached(`governance:read:related:${norm.accountId}`, 60_000, () => resolveRelatedAccounts(address)).catch(() => null)
  const ids = resolved ? [...resolved.related] : [norm.accountId]
  const outcomeOf = outcomeLookup(await opengovReferenda())
  const period = voteLockingPeriodBlocks()
  const out: UnlockSteps[] = []
  for (const acc of ids) {
    const plan = lockPlanAt(acc, atBlock, outcomeOf, period)
    if (plan) out.push({ accountId: acc, freeableAt: plan.unlockableNow, steps: plan.schedule })
  }
  return out
}

// ---- calendar ----

export type CalendarKind = 'prepare-end' | 'timeout' | 'decision-end' | 'confirm-end' | 'concluded' | 'enactment' | 'spend-valid' | 'spend-expire'

export interface CalendarEvent {
  kind: CalendarKind
  at: BlockMoment
  referendum: { index: number; title: string | null; track: { id: number; name: string } | null; status: string } | null
  spend: { index: number; amount: string; assetKind: string | null; beneficiary: string | null } | null
  /** For 'concluded': the event that concluded it (Confirmed, Rejected, …). */
  detail: string | null
}

export interface GovernanceCalendar { from: string; to: string; asOfBlock: number; events: CalendarEvent[] }

export async function getGovernanceCalendar(fromMs: number, toMs: number): Promise<GovernanceCalendar> {
  const h = await head()
  return cached(`governance:read:calendar:${fromMs}:${toMs}:${h.block}`, 6_000, async () => {
    const refs = await opengovReferenda()
    const events: CalendarEvent[] = []
    const refInfo = (r: OpengovRef) => ({
      index: r.index, title: referendumTitleFor('opengov', r.index),
      track: r.track == null ? null : { id: r.track, name: trackById(r.track)?.name ?? `track ${r.track}` }, status: r.status,
    })
    const inWindow = (m: BlockMoment) => { const t = Date.parse(m.ts); return t >= fromMs && t <= toMs }
    const push = (e: CalendarEvent) => { if (inWindow(e.at)) events.push(e) }
    for (const r of refs.values()) {
      const def = r.track != null ? trackById(r.track) : null
      if (r.concluded) {
        push({ kind: 'concluded', at: momentOf(h, r.concluded.block, r.concluded.ts), referendum: refInfo(r), spend: null, detail: r.concluded.event })
        continue
      }
      if (!r.phase || !def) continue
      if (r.phase.decisionStartBlock == null) {
        push({ kind: 'prepare-end', at: momentOf(h, r.phase.submittedBlock + def.preparePeriod), referendum: refInfo(r), spend: null, detail: null })
        if (!r.phase.decisionDepositPlaced) push({ kind: 'timeout', at: momentOf(h, r.phase.submittedBlock + undecidingTimeoutBlocks()), referendum: refInfo(r), spend: null, detail: null })
      } else {
        push({ kind: 'decision-end', at: momentOf(h, r.phase.decisionStartBlock + def.decisionPeriod), referendum: refInfo(r), spend: null, detail: null })
      }
      if (r.phase.confirmStartBlock != null) push({ kind: 'confirm-end', at: momentOf(h, r.phase.confirmStartBlock + def.confirmPeriod), referendum: refInfo(r), spend: null, detail: null })
    }
    for (const e of await enactments(refs)) {
      const r = refs.get(e.index)
      push({ kind: 'enactment', at: momentOf(h, e.block, e.ts), referendum: r ? refInfo(r) : null, spend: null, detail: e.outcome })
    }
    const { spends } = await treasuryFold()
    const past = await blockTimes(spends.flatMap(s => [s.validFrom ?? 0, s.expireAt ?? 0]), h)
    for (const s of spends) {
      if (s.state === 'voided') continue
      const spend = { index: s.index, amount: s.amount, assetKind: null, beneficiary: s.beneficiary }
      if (s.validFrom != null) push({ kind: 'spend-valid', at: momentOf(h, s.validFrom, null, past), referendum: null, spend, detail: s.state })
      // Its claim window's end matters only until it is paid (a payout re-dates it in storage).
      if (s.expireAt != null && !s.paidAt) push({ kind: 'spend-expire', at: momentOf(h, s.expireAt, null, past), referendum: null, spend, detail: s.state })
    }
    events.sort((a, b) => a.at.block - b.at.block || a.kind.localeCompare(b.kind))
    return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), asOfBlock: h.block, events }
  })
}

/**
 * Approved referenda's enactments: the dispatched ones from the named-dispatch table
 * (exact), and the ones still waiting from the scheduler's own `Scheduled{when}` in
 * the confirming block (the pallet files the enactment there).
 */
async function enactments(refs: Map<number, OpengovRef>): Promise<{ index: number; block: number; ts: string | null; outcome: string }[]> {
  return cached('governance:read:enactments', 30_000, async () => {
    const { referendumEnactmentTaskId } = await import('./governanceService.ts')
    const approved = [...refs.values()].filter(r => r.concluded && (r.concluded.event === 'Referenda.Confirmed' || r.concluded.event === 'Referenda.Approved'))
    const byTask = new Map(approved.map(r => [referendumEnactmentTaskId(r.index), r.index]))
    const res = await client.query({
      query: `SELECT task_id, event_name, block_height, toString(block_timestamp) AS ts FROM price_data.scheduler_named_dispatches FINAL`,
      format: 'JSONEachRow',
    })
    const done = new Map<number, { block: number; ts: string; outcome: string }>()
    for (const row of await res.json<{ task_id: string; event_name: string; block_height: number; ts: string }>()) {
      const index = byTask.get(row.task_id)
      if (index != null) done.set(index, { block: Number(row.block_height), ts: row.ts, outcome: row.event_name === 'Scheduler.CallUnavailable' ? 'unavailable' : 'dispatched' })
    }
    const out: { index: number; block: number; ts: string | null; outcome: string }[] = [...done].map(([index, d]) => ({ index, block: d.block, ts: d.ts, outcome: d.outcome }))
    const pending = approved.filter(r => !done.has(r.index))
    if (pending.length) {
      const blocks = pending.map(r => r.concluded!.block)
      const sres = await client.query({
        query: `SELECT block_height, JSONExtractUInt(args_json, 'when') AS w FROM price_data.raw_events
                WHERE block_height IN {blocks:Array(UInt32)} AND event_name = 'Scheduler.Scheduled'`,
        query_params: { blocks }, format: 'JSONEachRow',
      })
      const scheduled = new Map<number, number[]>()
      for (const row of await sres.json<{ block_height: number; w: number }>()) {
        const list = scheduled.get(Number(row.block_height)) ?? []
        list.push(Number(row.w))
        scheduled.set(Number(row.block_height), list)
      }
      for (const r of pending) {
        // Exactly one task filed in the confirming block is the enactment; anything
        // else is ambiguous and left out rather than guessed.
        const whens = (scheduled.get(r.concluded!.block) ?? []).filter(w => w > r.concluded!.block)
        if (whens.length === 1) out.push({ index: r.index, block: whens[0], ts: null, outcome: 'scheduled' })
      }
    }
    return out
  })
}

/**
 * The governance clock's dating of a set of blocks, for the other governance read
 * models (deposits, the treasury): a past block by its indexed timestamp, a future one
 * projected from the head at the measured pace — the same rule as every date here.
 */
export async function governanceMoments(blocks: Iterable<number>): Promise<{ headBlock: number; at: (block: number, exactTs?: string | null) => BlockMoment }> {
  const h = await head()
  const past = await blockTimes(blocks, h)
  return { headBlock: h.block, at: (block, exactTs) => momentOf(h, block, exactTs, past) }
}

// Exported for tests.
export const __test = { voteOf, nextDeadline, isoOf }
export { curveThresholdPerbill, PERBILL }
