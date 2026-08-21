import { blake2AsU8a } from '@polkadot/util-crypto'
import { compactToU8a, stringToU8a, u8aConcat, u8aToHex } from '@polkadot/util'
import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { convictionName, decodeVoteByte, weightedVotePower } from './convictionWeight.ts'
import { assetDescriptor } from './explorerAssets.ts'
import { accountRef, ensurePrices, nestedRemovalRefs, nestedVoteInfos, removalRefsFromPermitData, voteFromPermitData, type AccountRef, type AssetRef } from './explorerService.ts'
import { referendumTitles } from './referendumTitleService.ts'
import { pendingNodeApi } from './pendingHeadService.ts'
import { curveCrossingX, curveThresholdPerbill, PERBILL, perbillOfRational, trackById, undecidingTimeoutBlocks, type TrackDef } from './referendaTracks.ts'

// Governance referendum detail.
//
// Hydration has voted through two pallets and both index from 0 — Democracy
// (refIndex 0-206) and OpenGov/Referenda (pollIndex 0-369) — so a referendum is
// only ever identified by the PAIR (pallet, index). Indexing by number alone would
// merge two unrelated referenda.
export type ReferendumPallet = 'opengov' | 'democracy'

export const REFERENDUM_PALLETS: ReferendumPallet[] = ['opengov', 'democracy']

const HDX_ASSET_ID = 0

// First block that emitted ConvictionVoting.Voted. Vote CALLS predate it by ~534k
// blocks, so referenda decided before this point are only visible through the calls.
const CONVICTION_VOTED_FIRST_BLOCK = 7_175_436

export { convictionName, convictionTenths, decodeVoteByte, weightedVotePower } from './convictionWeight.ts'

export type VoteKind = 'Standard' | 'Split' | 'SplitAbstain'

export interface ReferendumVoter {
  account: AccountRef | null
  kind: VoteKind
  // Aye/Nay for a Standard vote; Split votes back both sides at once and carry no
  // conviction, so they are their own side rather than being forced into one.
  side: 'Aye' | 'Nay' | 'Split' | 'SplitAbstain'
  conviction: string | null
  convictionIndex: number | null
  balance: string
  ayeBalance: string
  nayBalance: string
  abstainBalance: string
  // Conviction-weighted power, planck. Split/SplitAbstain carry no conviction, which the
  // pallets read as Conviction::None — so each leg weighs 0.1x, not its plain balance.
  weightedAye: string
  weightedNay: string
  weighted: string
  valueUsd: number | null
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  removed: boolean
}

export interface ReferendumTally { ayes: string; nays: string; support: string | null }

// The chain's own tally, lifted off a lifecycle event, carrying the provenance that
// decides whether it is still true.
//
// `final` marks a tally from a CONCLUDING event — the referendum's last word, and the
// figure to present. While a referendum is still running the only tally-bearing event
// is Referenda.DecisionStarted, whose tally is a snapshot taken as the decision period
// opened; every vote cast afterwards is missing from it. The pallet keeps the live
// tally in Referenda.ReferendumInfoFor storage, which is not indexed, so a running
// referendum has no current chain tally at all and the consumer must fall back to what
// the indexed votes add up to rather than show a figure that has stopped moving.
export interface OnChainTally extends ReferendumTally {
  final: boolean
  blockHeight: number
  timestamp: string
}

export interface ReferendumDetail {
  pallet: ReferendumPallet
  index: number
  title: string | null
  // Who signed the submit extrinsic (OpenGov only; Democracy proposals were
  // tabled from a queue and name no single submitter).
  proposer: AccountRef | null
  subsquareUrl: string
  track: number | null
  proposalHash: string | null
  // The proposal's actual call, decoded from its preimage by the referendum-proposals
  // service (SCALE bytes need runtime metadata, which only the indexer has). Null when
  // the preimage has not been decoded yet — the page then shows the hash alone rather
  // than implying the referendum has no proposal.
  proposalCall: { pallet: string; callName: string; args: unknown; encoded: string | null; byteLength: number; decodeError: string | null } | null
  status: string
  submittedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
  concludedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
  asset: AssetRef
  // The chain's own tally from the lifecycle event, already conviction-weighted and
  // inclusive of delegated power. Authoritative only where `final` says so — see
  // OnChainTally.
  //
  // Only OpenGov has one. Referenda.DecisionStarted carries a `tally`, as do the
  // concluding Confirmed/Rejected/Cancelled/TimedOut; ConfirmStarted does NOT (all 337
  // of them on this chain carry none). The Democracy pallet carries none on any event
  // (Started{refIndex,threshold}, Passed{refIndex}, NotPassed{refIndex},
  // Cancelled{refIndex}, Executed{refIndex,result}) and keeps its Tally only inside
  // Democracy::ReferendumInfoOf while the referendum is Ongoing, replacing it with
  // Finished{approved,end} at the close. So this is null for every Democracy referendum
  // and the consumer must present `directTally` as what it is.
  onChainTally: OnChainTally | null
  // What the indexed per-account votes add up to: the chain's DIRECT tally, excluding
  // delegated power. Verified account-by-account against Democracy::VotingOf at the last
  // block before the close — for referendum 61 the 22 counted votes reproduce the chain's
  // own non-delegated ayes (14669791677216312056) exactly, and the whole remaining gap to
  // the chain tally (142267191677216312056) is the inbound delegation of four voters.
  //
  // This is the only current figure a RUNNING referendum has, because the chain
  // publishes no tally event while it runs (see OnChainTally).
  directTally: {
    ayes: string
    nays: string
    rawAyes: string
    rawNays: string
    // Pre-conviction capital backing the referendum, the same quantity the pallet
    // calls `support`: aye capital plus abstain capital, nays excluded.
    support: string
    ayeVoters: number
    nayVoters: number
    splitVoters: number
    voters: number
  }
  // onChainTally minus directTally, and only where the chain tally is FINAL. Delegated
  // voting power produces no Voted event of its own, so it can only ever show up as
  // this residual — reported rather than silently folded into a voter's own weight.
  indirectTally: ReferendumTally | null
  voters: ReferendumVoter[]
  votesShown: number
  votesTotal: number
  // Every lifecycle event, in block order — the referendum's own history, from
  // submission through deposits and phase changes to the deposit refunds that
  // trail the conclusion. Already loaded to derive `status`; here it is shown.
  timeline: ReferendumTimelineEntry[]
  // The track's parameters (OpenGov only; Democracy predates tracks). Present
  // for concluded referenda too — the name belongs in the header regardless.
  trackInfo: ReferendumTrackRef | null
  // The pallet's CURRENT tally, read live from Referenda.ReferendumInfoFor —
  // the figure the lifecycle events cannot carry while the referendum runs (see
  // OnChainTally). Conviction-weighted and inclusive of delegated power, like
  // the final tally. Null when the referendum is concluded (the concluding
  // event's tally is the last word), the storage read is unavailable, or the
  // pallet is Democracy.
  liveTally: LiveReferendumTally | null
  // Where the referendum stands in its track's lifecycle and when each phase
  // ends, for the progress strip. Null once concluded (and for Democracy).
  progress: ReferendumProgress | null
}

export interface ReferendumTimelineEntry {
  event: string
  blockHeight: number
  extrinsicIndex: number | null
  timestamp: string
  // Only on the enactment entry, and only when the event said which it was: whether the
  // approved call ran (`ok`), ran and errored (`failed`), or was never available to run
  // (`unavailable`). Absent everywhere else, including on an enactment event whose result
  // could not be read — an unreadable result is not a failed one.
  outcome?: ReferendumEnactmentOutcome
}

export type ReferendumEnactmentOutcome = 'ok' | 'failed' | 'unavailable'

export interface ReferendumTrackRef {
  id: number
  name: string
  // Parachain blocks, straight from the runtime constant. The UI turns them
  // into durations with the nominal slot time, never a pinned seconds-per-block.
  preparePeriod: number
  decisionPeriod: number
  confirmPeriod: number
  minEnactmentPeriod: number
  decisionDeposit: string
}

export interface LiveReferendumTally {
  ayes: string
  nays: string
  support: string
  // balances.totalIssuance at the same read — the denominator the pallet's own
  // support curve divides by. Null if that read failed independently.
  electorate: string | null
}

// One gauge of the two OpenGov thresholds: where the referendum stands against
// the track curve at this moment of the decision period. Perbill (1e9 = 100%).
export interface ReferendumGauge {
  // Null when no figure exists to compare (no live tally and no indexed votes).
  currentPerbill: number | null
  thresholdPerbill: number
  passing: boolean | null
  // What `currentPerbill` was computed from. 'chain' is ReferendumInfoFor's own
  // tally; 'attributed' is the indexed direct votes, which miss delegated power.
  source: 'chain' | 'attributed' | null
}

export interface ReferendumProgress {
  phase: 'preparing' | 'deciding' | 'confirming'
  decisionDepositPlaced: boolean
  submittedBlock: number
  decisionStartBlock: number | null
  // decisionStart + the track's decisionPeriod: when deciding stops — approval
  // by then or rejection. A confirmation straddling this boundary runs on.
  decisionEndBlock: number | null
  confirmStartBlock: number | null
  confirmEndBlock: number | null
  // Preparing only: the earliest block deciding can begin (submitted +
  // preparePeriod; an occupied track can hold it longer), and the block the
  // pallet times the referendum out if the decision deposit never arrives.
  earliestDecisionBlock: number | null
  timeoutBlock: number | null
  approval: ReferendumGauge | null
  support: ReferendumGauge | null
  // Where the referendum is HEADED, not just where it stands: OpenGov's bars
  // decay over the decision period, so trailing them today is the healthy
  // normal. 'passing' clears both bars now; 'on-track' will clear them by
  // `confirmableAtBlock` if the tally holds; 'short' cannot clear them by the
  // period's end without new votes.
  projection: {
    state: 'passing' | 'on-track' | 'short'
    confirmableAtBlock: number | null
  } | null
}

let client: ClickHouseClient
export function initGovernanceService(c: ClickHouseClient): void { client = c }

const SUBSQUARE_BASE_URL = (process.env.SUBSQUARE_BASE_URL ?? 'https://hydration.subsquare.io').replace(/\/+$/, '')

export function subsquareUrl(pallet: ReferendumPallet, index: number): string {
  return `${SUBSQUARE_BASE_URL}${pallet === 'democracy' ? '/democracy/referenda' : '/referenda'}/${index}`
}

export function parseReferendumPallet(value: unknown): ReferendumPallet | null {
  return value === 'opengov' || value === 'democracy' ? value : null
}

// OpenGov lifecycle -> a single status word. Ordered most-final first so a
// referendum that was confirmed and later refunded still reads as approved.
const OPENGOV_STATUS: [string, string][] = [
  ['Referenda.Killed', 'killed'],
  ['Referenda.Cancelled', 'cancelled'],
  ['Referenda.TimedOut', 'timed out'],
  ['Referenda.Rejected', 'rejected'],
  ['Referenda.Approved', 'approved'],
  ['Referenda.Confirmed', 'approved'],
  ['Referenda.ConfirmStarted', 'confirming'],
  ['Referenda.DecisionStarted', 'deciding'],
  ['Referenda.Submitted', 'submitted'],
]
const DEMOCRACY_STATUS: [string, string][] = [
  ['Democracy.Vetoed', 'vetoed'],
  ['Democracy.Cancelled', 'cancelled'],
  ['Democracy.Executed', 'executed'],
  ['Democracy.NotPassed', 'not passed'],
  ['Democracy.Passed', 'passed'],
  ['Democracy.Started', 'started'],
]

export function referendumStatusFrom(pallet: ReferendumPallet, eventNames: string[]): string {
  const seen = new Set(eventNames)
  for (const [event, status] of pallet === 'opengov' ? OPENGOV_STATUS : DEMOCRACY_STATUS) {
    if (seen.has(event)) return status
  }
  return 'unknown'
}

// The event that ENDS the vote. Democracy.Executed is deliberately absent: it is the
// enactment, which fires `delay` blocks after Democracy.Passed (600 blocks for
// referendum 0, 43,200 for referendum 1). Treating it as the conclusion dated the
// referendum to its enactment and stretched the withdrawal window past the close, where
// a remove_vote is only a voter unlocking their balance.
const CONCLUDING_EVENTS = new Set([
  'Referenda.Confirmed', 'Referenda.Approved', 'Referenda.Rejected', 'Referenda.Cancelled',
  'Referenda.TimedOut', 'Referenda.Killed',
  'Democracy.Passed', 'Democracy.NotPassed', 'Democracy.Cancelled', 'Democracy.Vetoed',
])

export function isConcludingEvent(eventName: string): boolean {
  return CONCLUDING_EVENTS.has(eventName)
}

interface LifecycleRow {
  event_name: string
  block_height: number
  extrinsic_index: number | null
  ts: string
  args_json: string
}

// Every lifecycle event for one referendum, from the referendum-first projection
// `referendum_lifecycle_events`.
//
// The referendum is an event argument, so selecting it out of `raw_events` meant matching
// the pallet by name prefix — which, unlike an IN list, the set(200) skip index on
// `event_name` cannot use — and then decoding the index out of args_json on every row the
// scan reached, decompressing the whole table's ZSTD(6) payload to find a few hundred
// matches: 36.3M rows and 1.47 GiB for one cold page, and 1.38 TiB across three days.
// The projection stores the decoded pallet/index and is keyed by them first, so the same
// answer is a point lookup over three granules.
async function loadLifecycle(pallet: ReferendumPallet, index: number): Promise<LifecycleRow[]> {
  const res = await client.query({
    query: `SELECT event_name, block_height, extrinsic_index, toString(block_timestamp) AS ts, args_json
            FROM price_data.referendum_lifecycle_events FINAL
            WHERE pallet = {pallet:String} AND ref_index = {idx:UInt32}
            ORDER BY block_height, event_index`,
    query_params: { pallet, idx: index },
    format: 'JSONEachRow',
  })
  return res.json<LifecycleRow>()
}

// ---- enactment ----

// The scheduler name pallet_referenda gives an approved referendum's enactment:
// `blake2_256(SCALE((ASSEMBLY_ID, "enactment", index)))`, with ASSEMBLY_ID = *b"assembly".
// SCALE of that tuple is the eight ASSEMBLY_ID bytes verbatim ([u8; 8] is fixed-width, so it
// carries no length prefix), then compact-prefixed "enactment", then the index as a
// little-endian u32.
//
// The hash only runs one way, which is why the enactment cannot be projected out of
// raw_events the way the lifecycle events are: a Scheduler event names its task and nothing
// else, so no materialized view can decide which referendum it belongs to. The page computes
// the name it wants instead and reads scheduler_named_dispatches by it.
export function referendumEnactmentTaskId(index: number): string {
  const tag = stringToU8a('enactment')
  const idx = new Uint8Array(4)
  new DataView(idx.buffer).setUint32(0, index, true)
  return u8aToHex(blake2AsU8a(u8aConcat(stringToU8a('assembly'), compactToU8a(tag.length), tag, idx), 256))
}

interface EnactmentRow {
  event_name: string
  block_height: number
  event_index: number
  extrinsic_index: number | null
  ts: string
  args_json: string
}

// Which of the three things happened to the scheduled call. Null when the event did not say:
// a Scheduler.Dispatched always carries a `result`, so an absent or unparseable one is a data
// fault to surface as "unknown", never to round down to a failure.
export function enactmentOutcomeFrom(eventName: string, argsJson: string): ReferendumEnactmentOutcome | null {
  if (eventName === 'Scheduler.CallUnavailable') return 'unavailable'
  try {
    const kind = (JSON.parse(argsJson) as { result?: { __kind?: unknown } }).result?.__kind
    return kind === 'Ok' ? 'ok' : typeof kind === 'string' ? 'failed' : null
  } catch { return null }
}

// The enactment outcome for one OpenGov referendum. A point lookup on the table's ORDER BY
// prefix, so FINAL collapses this task's rows and nothing else. A name is scheduled once and
// consumed on dispatch, so the first row is the enactment.
async function loadEnactment(index: number): Promise<EnactmentRow | null> {
  const res = await client.query({
    query: `SELECT event_name, block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, args_json
            FROM price_data.scheduler_named_dispatches FINAL
            WHERE task_id = {task:String}
            ORDER BY block_height, event_index`,
    query_params: { task: referendumEnactmentTaskId(index) },
    format: 'JSONEachRow',
  })
  return (await res.json<EnactmentRow>())[0] ?? null
}

// The lifecycle rows and the enactment as one list in block order.
//
// A merge rather than an append: the enactment sits between a referendum's conclusion and the
// deposit refunds that trail it, which can be far later. Referendum 33 was confirmed at
// 7,050,930, its call was already unavailable at 7,051,030, and its submission deposit only
// came back at 7,262,897 — appending would have dated the enactment after that. The sort is
// stable, so same-block lifecycle rows keep the event_index order the query returned them in.
export function referendumTimelineFrom(
  lifecycle: Pick<LifecycleRow, 'event_name' | 'block_height' | 'extrinsic_index' | 'ts'>[],
  enactment: EnactmentRow | null,
): ReferendumTimelineEntry[] {
  const entries: ReferendumTimelineEntry[] = lifecycle.map(row => ({
    event: row.event_name, blockHeight: row.block_height, extrinsicIndex: row.extrinsic_index, timestamp: row.ts,
  }))
  if (enactment) {
    const outcome = enactmentOutcomeFrom(enactment.event_name, enactment.args_json)
    entries.push({
      event: enactment.event_name,
      blockHeight: enactment.block_height,
      extrinsicIndex: enactment.extrinsic_index,
      timestamp: enactment.ts,
      ...(outcome ? { outcome } : {}),
    })
  }
  return entries.sort((a, b) => a.blockHeight - b.blockHeight)
}

export function tallyFromArgs(argsJson: string): ReferendumTally | null {
  try {
    const tally = (JSON.parse(argsJson) as { tally?: Record<string, unknown> }).tally
    if (!tally) return null
    const str = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? v : null)
    const ayes = str(tally.ayes), nays = str(tally.nays)
    if (ayes == null || nays == null) return null
    return { ayes, nays, support: str(tally.support) }
  } catch { return null }
}

// The freshest tally the chain itself published, and whether it is the last word.
//
// Reads backwards to the most recent event that carried a tally, then asks what kind
// of event that was. A concluding event's tally is final; a Referenda.DecisionStarted
// tally is a snapshot of the moment the decision period opened, which every later vote
// moves past. Presenting the snapshot as the tally is what showed OpenGov 370 at
// 19211236354479984589 ayes while thirty indexed votes already stood at
// 789522038578859970114.
export function onChainTallyFrom(rows: Pick<LifecycleRow, 'event_name' | 'block_height' | 'ts' | 'args_json'>[]): OnChainTally | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const tally = tallyFromArgs(rows[i].args_json)
    if (!tally) continue
    return { ...tally, final: isConcludingEvent(rows[i].event_name), blockHeight: rows[i].block_height, timestamp: rows[i].ts }
  }
  return null
}

// Which lifecycle phase a still-running OpenGov referendum is in, from its
// event history alone. Null once any concluding event exists (or before the
// Submitted row is indexed): a concluded referendum has no phase to report.
//
// Confirmation can abort — support dipping below the curve mid-confirm emits
// Referenda.ConfirmAborted and the referendum falls back to deciding — and then
// begin again, so "confirming" means the LAST ConfirmStarted with no
// ConfirmAborted after it, not any ConfirmStarted at all.
export function opengovPhase(rows: Pick<LifecycleRow, 'event_name' | 'block_height'>[]): {
  phase: 'preparing' | 'deciding' | 'confirming'
  submittedBlock: number
  decisionStartBlock: number | null
  confirmStartBlock: number | null
  decisionDepositPlaced: boolean
} | null {
  if (rows.some(row => isConcludingEvent(row.event_name))) return null
  const submitted = rows.find(row => row.event_name === 'Referenda.Submitted')
  if (!submitted) return null
  let decisionStartBlock: number | null = null
  let confirmStartBlock: number | null = null
  let decisionDepositPlaced = false
  for (const row of rows) {
    if (row.event_name === 'Referenda.DecisionStarted') decisionStartBlock ??= row.block_height
    else if (row.event_name === 'Referenda.DecisionDepositPlaced') decisionDepositPlaced = true
    else if (row.event_name === 'Referenda.ConfirmStarted') confirmStartBlock = row.block_height
    else if (row.event_name === 'Referenda.ConfirmAborted') confirmStartBlock = null
  }
  return {
    phase: confirmStartBlock != null ? 'confirming' : decisionStartBlock != null ? 'deciding' : 'preparing',
    submittedBlock: submitted.block_height,
    decisionStartBlock,
    confirmStartBlock,
    decisionDepositPlaced,
  }
}

// The live tally out of Referenda.ReferendumInfoFor, plus the total issuance its
// support share divides by. This is the ONE figure a running referendum has that
// the indexed events cannot supply (see OnChainTally) — conviction-weighted,
// delegation included, current as of the read.
//
// A single storage read against the pending layer's already-connected node,
// held for the same window as the running-referendum detail cache and requested
// only for referenda with no concluding event — at most the few a track-capped
// chain can have deciding at once, so this stays a bounded point read, not
// request-time RPC fan-out. Null (never a guess) when the pending layer is
// down, the referendum is not Ongoing on chain, or the shape surprises.
async function liveReferendumState(index: number): Promise<LiveReferendumTally | null> {
  return cached(`explorer:referendum:live:${index}`, RUNNING_TTL_MS, async () => {
    const api = pendingNodeApi()
    if (!api) return null
    try {
      const info = (await api.query.referenda.referendumInfoFor(index)).toJSON() as
        { ongoing?: { tally?: { ayes?: unknown; nays?: unknown; support?: unknown } } } | null
      const tally = info?.ongoing?.tally
      if (!tally) return null
      // polkadot.js JSON renders u128s above 2^53 as 0x-hex, smaller ones as numbers.
      const planck = (value: unknown): string | null => {
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
        if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value).toString()
        return null
      }
      const ayes = planck(tally.ayes), nays = planck(tally.nays), support = planck(tally.support)
      if (ayes == null || nays == null || support == null) return null
      // The support curve divides by ACTIVE issuance (pallet_conviction_voting
      // tallies against Currency::active_issuance = total − inactive), not total.
      // On this chain the inactive share is ~2.18B of 6.42B HDX, so using total
      // understated every support figure by a third.
      const electorate = await Promise.all([api.query.balances.totalIssuance(), api.query.balances.inactiveIssuance()])
        .then(([total, inactive]) => {
          const t = planck(total.toJSON()), i = planck(inactive.toJSON())
          return t == null ? null : (BigInt(t) - BigInt(i ?? '0')).toString()
        })
        .catch(() => null)
      return { ayes, nays, support, electorate }
    } catch {
      return null
    }
  })
}

// The two Subsquare-style gauges and the phase-boundary blocks, computed from
// the lifecycle, the track constants and the head block. The threshold curves
// take x = the elapsed fraction of the decision period; before deciding starts
// there is no x and the gauges stay null.
export function progressFrom(
  phaseInfo: NonNullable<ReturnType<typeof opengovPhase>>,
  track: TrackDef,
  headBlock: number,
  live: LiveReferendumTally | null,
  direct: Pick<ReferendumDetail['directTally'], 'ayes' | 'nays' | 'support'>,
): ReferendumProgress {
  const { phase, submittedBlock, decisionStartBlock, confirmStartBlock, decisionDepositPlaced } = phaseInfo
  let approval: ReferendumGauge | null = null
  let support: ReferendumGauge | null = null
  if (decisionStartBlock != null && track.decisionPeriod > 0) {
    const x = Math.round(Math.min(Math.max(headBlock - decisionStartBlock, 0), track.decisionPeriod) / track.decisionPeriod * PERBILL)
    const gauge = (curve: TrackDef['minApproval'], current: number | null, source: ReferendumGauge['source']): ReferendumGauge => {
      const thresholdPerbill = curveThresholdPerbill(curve, x)
      return { currentPerbill: current, thresholdPerbill, passing: current == null ? null : current >= thresholdPerbill, source: current == null ? null : source }
    }
    if (live) {
      approval = gauge(track.minApproval, perbillOfRational(big(live.ayes), big(live.ayes) + big(live.nays)), 'chain')
      support = gauge(track.minSupport, live.electorate ? perbillOfRational(big(live.support), big(live.electorate)) : null, 'chain')
    } else {
      // The indexed direct votes: the chain's tally minus delegated power. The
      // support share needs the electorate, which only the live read carries,
      // so without it the support gauge shows the bar it must clear alone.
      approval = gauge(track.minApproval, perbillOfRational(big(direct.ayes), big(direct.ayes) + big(direct.nays)), 'attributed')
      support = gauge(track.minSupport, null, null)
    }
  }
  // The projection: with both currents known, find when the decaying bars meet
  // them. The crossing x is the LATER of the two gauges' crossings; a crossing
  // past the period end (or a gauge below its end-of-period floor) is 'short'.
  let projection: ReferendumProgress['projection'] = null
  if (decisionStartBlock != null && approval?.currentPerbill != null && support?.currentPerbill != null) {
    if (approval.passing && support.passing) {
      projection = { state: 'passing', confirmableAtBlock: null }
    } else {
      const crossA = curveCrossingX(track.minApproval, approval.currentPerbill)
      const crossS = curveCrossingX(track.minSupport, support.currentPerbill)
      if (crossA == null || crossS == null) {
        projection = { state: 'short', confirmableAtBlock: null }
      } else {
        const cross = Math.max(crossA, crossS)
        const block = decisionStartBlock + Math.ceil(cross / PERBILL * track.decisionPeriod)
        projection = { state: 'on-track', confirmableAtBlock: Math.max(block, headBlock + 1) }
      }
    }
  }
  return {
    phase,
    decisionDepositPlaced,
    submittedBlock,
    decisionStartBlock,
    decisionEndBlock: decisionStartBlock != null ? decisionStartBlock + track.decisionPeriod : null,
    confirmStartBlock,
    confirmEndBlock: confirmStartBlock != null ? confirmStartBlock + track.confirmPeriod : null,
    earliestDecisionBlock: decisionStartBlock == null ? submittedBlock + track.preparePeriod : null,
    timeoutBlock: decisionStartBlock == null && !decisionDepositPlaced ? submittedBlock + undecidingTimeoutBlocks() : null,
    approval,
    support,
    projection,
  }
}

export interface VoteEventRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  ts: string
  who: string
  kind: string
  vote_byte: number
  balance: string
  aye: string
  nay: string
  abstain: string
  removed: number
}

interface VoteCallRow {
  block_height: number
  extrinsic_index: number | null
  ts: string
  who: string
  kind: string
  vote_byte: number
  balance: string
  aye: string
  nay: string
  abstain: string
}

// Successful vote CALLS one referendum's own index names, from the referendum-first
// projection `governance_vote_calls`.
//
// The index is a call argument, so resolving it from `raw_calls` means reading
// `args_json` — and that column averages ~11 KB per row across every call on the
// chain. A vote call is scattered through the window rather than clustered, so
// nearly every granule holds one and the read degenerates into the whole window's
// call JSON: 2.5 GiB and 3.66 GiB of peak memory for referendum 204, over the 3.73
// GiB request ceiling, which is why 21, 113 and 204 answered HTTP 500. The
// projection stores the decoded index and payload and is keyed by (pallet,
// ref_index) first, so the same answer is a few KB.
async function loadVoteCalls(pallet: ReferendumPallet, index: number, fromBlock: number, toBlock: number): Promise<VoteCallRow[]> {
  const res = await client.query({
    query: `SELECT block_height, extrinsic_index, toString(block_timestamp) AS ts,
                   who, vote_kind AS kind, vote_byte, balance, aye, nay, abstain
            FROM price_data.governance_vote_calls
            WHERE pallet = {pallet:String} AND ref_index = {idx:UInt32}
              AND call_name = {call:String} AND success = 1
              AND block_height >= {from:UInt32} AND block_height <= {to:UInt32}
              AND extrinsic_index IS NOT NULL
            ORDER BY block_height, extrinsic_index, call_address`,
    query_params: {
      pallet, idx: index, from: fromBlock, to: toBlock,
      call: pallet === 'opengov' ? 'ConvictionVoting.vote' : 'Democracy.vote',
    },
    format: 'JSONEachRow',
  })
  return res.json<VoteCallRow>()
}

export interface ExtrinsicVoteCount { block_height: number; extrinsic_index: number; n: number }

// Vote extrinsics whose ConvictionVoting.Voted events a direct vote call does NOT
// account for — the only ones whose referendum has to be recovered by decoding a
// wrapper payload.
//
// Compared by COUNT per extrinsic rather than by presence, because an extrinsic can
// carry several votes: `Utility.batch` items are indexed as their own call rows, so a
// batch of five votes has five. An extrinsic with as many successful vote calls as
// Voted events is therefore fully explained, whichever referenda those votes name —
// including votes on OTHER referenda, which is what made this set 2,755 extrinsics
// wide for referendum 204 when it was computed as "not one of THIS referendum's own
// calls". Across all history 67,766 Voted events resolve to 66,254 direct calls,
// leaving exactly the 1,512 wrapped votes, and no extrinsic mixes the two.
export function unexplainedVoteKeys(voted: ExtrinsicVoteCount[], calls: ExtrinsicVoteCount[]): Set<string> {
  const explained = new Map<string, number>()
  for (const row of calls) explained.set(`${row.block_height}:${row.extrinsic_index}`, Number(row.n))
  const keys = new Set<string>()
  for (const row of voted) {
    const key = `${row.block_height}:${row.extrinsic_index}`
    if (Number(row.n) > (explained.get(key) ?? 0)) keys.add(key)
  }
  return keys
}

async function unexplainedVoteExtrinsics(fromBlock: number, toBlock: number): Promise<Set<string>> {
  const perExtrinsic = (table: string, predicate: string) => client.query({
    query: `SELECT block_height, toUInt32(extrinsic_index) AS extrinsic_index, count() AS n
            FROM ${table}
            WHERE ${predicate}
              AND block_height >= {from:UInt32} AND block_height <= {to:UInt32}
              AND extrinsic_index IS NOT NULL
            GROUP BY block_height, extrinsic_index`,
    query_params: { from: fromBlock, to: toBlock }, format: 'JSONEachRow',
  })
  const [votedRes, callsRes] = await Promise.all([
    perExtrinsic('price_data.vote_activity', `event_name = 'ConvictionVoting.Voted'`),
    perExtrinsic('price_data.governance_vote_calls', `pallet = 'opengov' AND call_name = 'ConvictionVoting.vote' AND success = 1`),
  ])
  return unexplainedVoteKeys(await votedRes.json<ExtrinsicVoteCount>(), await callsRes.json<ExtrinsicVoteCount>())
}

// Top-level calls whose args can hide a ConvictionVoting call — the only place a wrapped
// vote or removal names its poll, because `raw_calls` keeps no row for the nested call.
const WRAPPER_CALL_NAMES = [
  'MultiTransactionPayment.dispatch_permit', 'Proxy.proxy', 'Proxy.proxy_announced',
  'Utility.batch', 'Utility.batch_all', 'Utility.force_batch', 'Multisig.as_multi',
  'Multisig.as_multi_threshold_1', 'Ethereum.transact',
]

// The (block, extrinsic) pairs that voted on this referendum.
//
// Democracy.Voted names its referendum in the event, so those need no lookup at
// all. ConvictionVoting.Voted does NOT: the index lives on the call. A direct
// ConvictionVoting.vote call row covers 66,254 of 67,766 conviction votes (97.8%);
// the remaining 1,512 are gasless app votes wrapped in
// MultiTransactionPayment.dispatch_permit (1,441) and proxy/EVM wrappers, whose
// index is only recoverable by decoding the payload — hence the second pass, which
// reuses the decoders the activity feed already relies on. Skipping it would drop
// 2.2% of votes with no visible sign, which is exactly the kind of silent
// incompleteness this codebase refuses.
async function convictionVoteExtrinsics(calls: VoteCallRow[], index: number, fromBlock: number, toBlock: number): Promise<Set<string>> {
  const keys = new Set<string>()
  for (const row of calls) keys.add(`${row.block_height}:${row.extrinsic_index}`)

  // Resolved in two steps on purpose: asking for args_json across every wrapper call
  // in a long window reads hundreds of MB of JSON and tripped the query memory
  // ceiling on referendum 44, while the unmatched set is tiny and can be addressed
  // by key.
  const candidateKeys = await unexplainedVoteExtrinsics(fromBlock, toBlock)
  if (!candidateKeys.size) return keys

  const wanted = String(index)
  const blocks = [...new Set([...candidateKeys].map(key => Number(key.split(':')[0])))]
  // Gasless app votes arrive as MultiTransactionPayment.dispatch_permit with the
  // SCALE-encoded vote in the permit payload (1,441 of the 1,512), the rest through
  // proxy/utility/multisig wrappers. Both are decoded by the helpers the activity
  // feed already uses, so a referendum page does not quietly omit 2.2% of its votes.
  const CHUNK = 2_000
  for (let start = 0; start < blocks.length; start += CHUNK) {
    const slice = blocks.slice(start, start + CHUNK)
    const res = await client.query({
      query: `SELECT block_height, extrinsic_index, args_json
              FROM price_data.raw_calls
              WHERE block_height IN {blocks:Array(UInt32)}
                AND extrinsic_index IS NOT NULL
                AND call_name IN {wrappers:Array(String)}`,
      query_params: { blocks: slice, wrappers: WRAPPER_CALL_NAMES }, format: 'JSONEachRow',
    })
    for (const row of await res.json<{ block_height: number; extrinsic_index: number; args_json: string }>()) {
      const key = `${row.block_height}:${row.extrinsic_index}`
      if (keys.has(key) || !candidateKeys.has(key)) continue
      let args: Record<string, unknown>
      try { args = JSON.parse(row.args_json) as Record<string, unknown> } catch { continue }
      const permit = voteFromPermitData((args as { data?: unknown }).data)
      if (permit?.ref === wanted) { keys.add(key); continue }
      if (nestedVoteInfos(args).some(info => info.ref === wanted)) keys.add(key)
    }
  }
  return keys
}

const VOTE_FIELDS = `
  block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts,
  if(JSONHas(args_json, 'who'), JSONExtractString(args_json, 'who'), JSONExtractString(args_json, 'voter')) AS who,
  JSONExtractString(args_json, 'vote', '__kind') AS kind,
  toUInt16(JSONExtractInt(args_json, 'vote', 'vote')) AS vote_byte,
  JSONExtractString(args_json, 'vote', 'balance') AS balance,
  JSONExtractString(args_json, 'vote', 'aye') AS aye,
  JSONExtractString(args_json, 'vote', 'nay') AS nay,
  JSONExtractString(args_json, 'vote', 'abstain') AS abstain`

async function loadDemocracyVotes(index: number): Promise<VoteEventRow[]> {
  const res = await client.query({
    query: `SELECT ${VOTE_FIELDS}, 0 AS removed
            FROM price_data.vote_activity
            WHERE event_name = 'Democracy.Voted' AND toUInt32(JSONExtractInt(args_json, 'refIndex')) = {idx:UInt32}
            ORDER BY block_height, event_index`,
    query_params: { idx: index }, format: 'JSONEachRow',
  })
  return res.json<VoteEventRow>()
}

// A vote CALL as a vote row, for the referenda that have no Voted event to read.
//
// The call carries the same AccountVote payload as the event and the voter is its
// signed origin: across the whole event era all 66,254 successful direct vote calls
// match a Voted event on (who, kind, vote byte, balance) exactly. There is no event
// index, so the extrinsic index doubles as one — an extrinsic holds at most one vote
// per account, which is all `latestVotePerAccount` orders by.
export function voteRowFromCall(row: VoteCallRow): VoteEventRow {
  return {
    block_height: row.block_height,
    event_index: row.extrinsic_index ?? 0,
    extrinsic_index: row.extrinsic_index,
    ts: row.ts,
    who: row.who,
    kind: row.kind,
    vote_byte: row.vote_byte,
    balance: row.balance,
    aye: row.aye,
    nay: row.nay,
    abstain: row.abstain,
    removed: 0,
  }
}

async function loadConvictionVotes(index: number, fromBlock: number, toBlock: number): Promise<VoteEventRow[]> {
  const calls = await loadVoteCalls('opengov', index, fromBlock, toBlock)
  // ConvictionVoting.Voted did not exist before block 7,175,436, but successful
  // ConvictionVoting.vote calls go back to 6,641,707. OpenGov referenda 0-43 closed
  // before the event existed, and the split is clean — no referendum's vote calls
  // straddle the boundary — so those 44 read their votes from the calls. Reading
  // events alone would show them as having received zero votes, which reads as
  // "nobody voted" rather than "this is not indexed".
  if (toBlock < CONVICTION_VOTED_FIRST_BLOCK) return calls.map(voteRowFromCall)

  const keys = await convictionVoteExtrinsics(calls, index, fromBlock, toBlock)
  if (!keys.size) return []
  const blocks = [...new Set([...keys].map(key => Number(key.split(':')[0])))]
  const res = await client.query({
    query: `SELECT ${VOTE_FIELDS}, 0 AS removed
            FROM price_data.vote_activity
            WHERE event_name = 'ConvictionVoting.Voted' AND block_height IN {blocks:Array(UInt32)}
            ORDER BY block_height, event_index`,
    query_params: { blocks }, format: 'JSONEachRow',
  })
  const rows = await res.json<VoteEventRow>()
  // A block can hold votes for several referenda at once, so keep only the
  // extrinsics this referendum's own calls named.
  return rows.filter(row => row.extrinsic_index != null && keys.has(`${row.block_height}:${row.extrinsic_index}`))
}

// Where in the chain a vote (or its removal) sits. Block plus extrinsic, because an
// account can remove a vote and cast a new one in the same block: Democracy 206 has
// exactly that, and only the LATER action stands.
export interface VotePosition { blockHeight: number; extrinsicIndex: number | null }

export function isAfter(a: VotePosition, b: VotePosition): boolean {
  if (a.blockHeight !== b.blockHeight) return a.blockHeight > b.blockHeight
  return (a.extrinsicIndex ?? -1) > (b.extrinsicIndex ?? -1)
}

const REMOVAL_CALLS: Record<ReferendumPallet, string[]> = {
  opengov: ['ConvictionVoting.remove_vote', 'ConvictionVoting.remove_other_vote', 'ConvictionVoting.force_remove_vote'],
  democracy: ['Democracy.remove_vote', 'Democracy.remove_other_vote', 'Democracy.force_remove_vote'],
}

// The (block, extrinsic) pairs that removed a vote on this referendum through a WRAPPER.
//
// `raw_calls` keeps only the top-level call of a wrapped extrinsic, so a
// ConvictionVoting.remove_vote inside a Utility batch or a gasless
// MultiTransactionPayment.dispatch_permit has no row of its own and never reaches
// `governance_vote_calls`. Such a withdrawal is invisible and its vote goes on being
// counted: 35 of the chain's 735 ConvictionVoting.VoteRemoved events sit in exactly that
// position (32 through dispatch_permit, 3 through Utility.batch_all, between blocks
// 7,199,364 and 13,162,739), which is why OpenGov 200's attributed support stood 100 HDX
// above the chain's own — an abstain-only vote, withdrawn before the close, still counted.
//
// Found the way wrapped VOTES already are (see convictionVoteExtrinsics): an extrinsic
// with more VoteRemoved events than the projection has removal calls is hiding one, and
// only those few wrappers are decoded. Only the extrinsic is resolved here — the event
// names the account, so loadWithdrawals reads it from there exactly as for a direct
// removal, which also means a wrapper that removes votes on several referenda at once
// cannot lend this one a sibling's account.
async function wrappedRemovalExtrinsics(index: number, fromBlock: number, toBlock: number): Promise<{ block_height: number; extrinsic_index: number }[]> {
  const perExtrinsic = (table: string, predicate: string) => client.query({
    query: `SELECT block_height, toUInt32(extrinsic_index) AS extrinsic_index, count() AS n
            FROM ${table}
            WHERE ${predicate}
              AND block_height >= {from:UInt32} AND block_height <= {to:UInt32}
              AND extrinsic_index IS NOT NULL
            GROUP BY block_height, extrinsic_index`,
    query_params: { from: fromBlock, to: toBlock }, format: 'JSONEachRow',
  })
  // VoteRemoved lives only in raw_events — vote_activity carries the Voted events, not
  // the removals.
  const [removedRes, callsRes] = await Promise.all([
    perExtrinsic('price_data.raw_events', `event_name = 'ConvictionVoting.VoteRemoved'`),
    perExtrinsic('price_data.governance_vote_calls',
      `pallet = 'opengov' AND success = 1 AND call_name IN ('ConvictionVoting.remove_vote', 'ConvictionVoting.remove_other_vote', 'ConvictionVoting.force_remove_vote')`),
  ])
  const candidateKeys = unexplainedVoteKeys(await removedRes.json<ExtrinsicVoteCount>(), await callsRes.json<ExtrinsicVoteCount>())
  if (!candidateKeys.size) return []

  const wanted = String(index)
  const blocks = [...new Set([...candidateKeys].map(key => Number(key.split(':')[0])))]
  const found: { block_height: number; extrinsic_index: number }[] = []
  const CHUNK = 2_000
  for (let start = 0; start < blocks.length; start += CHUNK) {
    const res = await client.query({
      query: `SELECT block_height, extrinsic_index, args_json
              FROM price_data.raw_calls
              WHERE block_height IN {blocks:Array(UInt32)}
                AND extrinsic_index IS NOT NULL
                AND call_name IN {wrappers:Array(String)}`,
      query_params: { blocks: blocks.slice(start, start + CHUNK), wrappers: WRAPPER_CALL_NAMES }, format: 'JSONEachRow',
    })
    for (const row of await res.json<{ block_height: number; extrinsic_index: number; args_json: string }>()) {
      if (!candidateKeys.has(`${row.block_height}:${row.extrinsic_index}`)) continue
      let args: Record<string, unknown>
      try { args = JSON.parse(row.args_json) as Record<string, unknown> } catch { continue }
      const removes = removalRefsFromPermitData((args as { data?: unknown }).data).includes(wanted)
        || nestedRemovalRefs(args).includes(wanted)
      if (removes) found.push({ block_height: Number(row.block_height), extrinsic_index: Number(row.extrinsic_index) })
    }
  }
  return found
}

// Votes WITHDRAWN, meaning removed while the referendum was still open — the LAST such
// removal per account, so a vote recast afterwards still counts.
//
// The window ends one block before the conclusion, not at the last lifecycle event: a
// removal once the vote has closed is just the voter unlocking their balance —
// treating those as withdrawals would silently delete votes that did count.
//
// Both pallets name the poll only on the CALL, so the referendum-first projection is
// what selects the removals; resolving the index out of `raw_calls.args_json` instead
// read 825 MiB of call JSON for referendum 204's window alone.
//
// OpenGov then confirms each one against ConvictionVoting.VoteRemoved, addressed by
// exact key. That event is not bookkeeping — `pallet_conviction_voting` emits it only
// while the poll is Ongoing, so it is precisely the "was this a withdrawal or a
// post-close unlock?" answer, and only 732 of 55,176 removal calls in all of history
// carry one. One extrinsic often removes votes on several referenda at once (4,019 do),
// but the window bound already drops the ones whose own poll had closed, and every
// remaining extrinsic has exactly as many in-window removal calls for the referendum
// as it has events — so keying the confirmation by extrinsic cannot borrow a sibling
// referendum's event.
//
// Democracy emits no event for a removal at all, so there the call is the only record:
// remove_vote drops the signer's own vote, while remove_other_vote/force_remove_vote
// name their target in the args (the projection's `who` already resolves both). Same for
// OpenGov removals below CONVICTION_VOTED_FIRST_BLOCK — the event did not exist yet
// (the first one is at 7,175,689), so demanding one there kept withdrawn votes in the
// tally and pushed referenda 14, 23, 27 and 32 ABOVE the chain's own figure.
async function loadWithdrawals(pallet: ReferendumPallet, index: number, fromBlock: number, toBlock: number): Promise<Map<string, VotePosition>> {
  const removalRes = await client.query({
    query: `SELECT who, block_height, extrinsic_index
            FROM price_data.governance_vote_calls
            WHERE pallet = {pallet:String} AND ref_index = {idx:UInt32}
              AND call_name IN {calls:Array(String)} AND success = 1
              AND block_height >= {from:UInt32} AND block_height <= {to:UInt32}`,
    query_params: { pallet, idx: index, calls: REMOVAL_CALLS[pallet], from: fromBlock, to: toBlock },
    format: 'JSONEachRow',
  })
  let removals = await removalRes.json<{ who: string; block_height: number; extrinsic_index: number | null }>()

  if (pallet === 'opengov') {
    // A wrapped removal has no call row at all, so its extrinsic is recovered by decoding
    // the wrapper. It then joins the same VoteRemoved confirmation as every other
    // post-event-era removal, which is where its account comes from.
    const wrapped = await wrappedRemovalExtrinsics(index, fromBlock, toBlock)
    const confirmable = [
      ...removals.filter(row => row.extrinsic_index != null && Number(row.block_height) >= CONVICTION_VOTED_FIRST_BLOCK),
      ...wrapped,
    ]
    const tuples = [...new Set(confirmable.map(row => `(${Number(row.block_height)},${Number(row.extrinsic_index)})`))].join(',')
    removals = removals.filter(row => Number(row.block_height) < CONVICTION_VOTED_FIRST_BLOCK)
    if (tuples) {
      const eventRes = await client.query({
        query: `SELECT JSONExtractString(args_json, 'who') AS who, block_height, extrinsic_index
                FROM price_data.raw_events
                WHERE event_name = 'ConvictionVoting.VoteRemoved'
                  AND (block_height, extrinsic_index) IN (${tuples})`,
        format: 'JSONEachRow',
      })
      removals = removals.concat(await eventRes.json<{ who: string; block_height: number; extrinsic_index: number | null }>())
    }
  }

  const latest = new Map<string, VotePosition>()
  for (const row of removals) {
    const who = (row.who ?? '').toLowerCase()
    if (!who) continue
    const at: VotePosition = { blockHeight: Number(row.block_height), extrinsicIndex: row.extrinsic_index }
    const held = latest.get(who)
    if (!held || isAfter(at, held)) latest.set(who, at)
  }
  return latest
}

const big = (value: string | null | undefined): bigint => (value && /^\d+$/.test(value) ? BigInt(value) : 0n)

// One row per ACCOUNT, not per event: 26 of 179 accounts changed their vote on
// Democracy 206, and only the last one counts toward the tally.
export function latestVotePerAccount(rows: VoteEventRow[]): VoteEventRow[] {
  const byAccount = new Map<string, VoteEventRow>()
  for (const row of rows) {
    const who = (row.who ?? '').toLowerCase()
    if (!who) continue
    const held = byAccount.get(who)
    if (!held || row.block_height > held.block_height
      || (row.block_height === held.block_height && row.event_index > held.event_index)) {
      byAccount.set(who, row)
    }
  }
  return [...byAccount.values()]
}

export function toVoter(row: VoteEventRow, withdrawals: Map<string, VotePosition>, priceUsd: number | null, decimals: number): ReferendumVoter {
  const kind: VoteKind = row.kind === 'Split' || row.kind === 'SplitAbstain' ? row.kind : 'Standard'
  const aye = big(row.aye), nay = big(row.nay), abstain = big(row.abstain)
  const standardBalance = big(row.balance)
  let side: ReferendumVoter['side']
  let convictionIndex: number | null = null
  let weightedAye = 0n, weightedNay = 0n, balance = 0n

  if (kind === 'Standard') {
    const decoded = decodeVoteByte(Number(row.vote_byte))
    side = decoded.side
    convictionIndex = decoded.convictionIndex
    balance = standardBalance
    const weighted = weightedVotePower(standardBalance, decoded.convictionIndex)
    if (decoded.side === 'Aye') weightedAye = weighted
    else weightedNay = weighted
  } else {
    // A Split/SplitAbstain vote carries no conviction, which in both pallets means
    // Conviction::None — the 0.1x class, NOT an unweighted balance. `Tally::add` runs each
    // leg through `Conviction::None.votes(balance)` (capital / 10), so a 1.5M HDX split leg
    // contributes 150k votes. Counting the full balance overstated it tenfold and pushed
    // the attributed nays of OpenGov 39 above the chain's own tally, which is impossible.
    // The abstain leg backs neither side but is still part of the capital.
    side = kind
    balance = aye + nay + abstain
    weightedAye = weightedVotePower(aye, 0)
    weightedNay = weightedVotePower(nay, 0)
  }

  const weighted = weightedAye + weightedNay
  const human = Number(weighted) / 10 ** decimals
  return {
    account: /^0x[0-9a-f]{64}$/i.test(row.who) ? accountRef(row.who.toLowerCase()) : null,
    kind,
    side,
    conviction: convictionIndex == null ? null : convictionName(convictionIndex),
    convictionIndex,
    balance: balance.toString(),
    ayeBalance: aye.toString(),
    nayBalance: nay.toString(),
    abstainBalance: abstain.toString(),
    weightedAye: weightedAye.toString(),
    weightedNay: weightedNay.toString(),
    weighted: weighted.toString(),
    valueUsd: priceUsd == null ? null : human * priceUsd,
    blockHeight: row.block_height,
    eventIndex: row.event_index,
    extrinsicIndex: row.extrinsic_index,
    timestamp: row.ts,
    // Withdrawn only if the removal came AFTER this vote. An account that removed a vote
    // and then voted again is voting, not withdrawing.
    removed: (() => {
      const at = withdrawals.get((row.who ?? '').toLowerCase())
      return at != null && isAfter(at, { blockHeight: row.block_height, extrinsicIndex: row.extrinsic_index })
    })(),
  }
}

export function tallyVoters(voters: ReferendumVoter[]): ReferendumDetail['directTally'] {
  let ayes = 0n, nays = 0n, rawAyes = 0n, rawNays = 0n, support = 0n
  let ayeVoters = 0, nayVoters = 0, splitVoters = 0
  for (const voter of voters) {
    // A withdrawn vote no longer backs anything, so it is listed but not tallied.
    if (voter.removed) continue
    ayes += big(voter.weightedAye)
    nays += big(voter.weightedNay)
    // Support is pre-conviction CAPITAL, and `Tally::add` moves only the capital that
    // is not a nay into it: aye capital and abstain capital, never nay capital.
    if (voter.kind === 'Standard') {
      if (voter.side === 'Aye') { rawAyes += big(voter.balance); support += big(voter.balance); ayeVoters++ }
      else { rawNays += big(voter.balance); nayVoters++ }
    } else {
      rawAyes += big(voter.ayeBalance)
      rawNays += big(voter.nayBalance)
      support += big(voter.ayeBalance) + big(voter.abstainBalance)
      splitVoters++
    }
  }
  return {
    ayes: ayes.toString(),
    nays: nays.toString(),
    rawAyes: rawAyes.toString(),
    rawNays: rawNays.toString(),
    support: support.toString(),
    ayeVoters,
    nayVoters,
    splitVoters,
    voters: voters.filter(voter => !voter.removed).length,
  }
}

// The chain's tally includes delegated power, which emits no Voted event, so the
// per-account votes can only ever sum to at most the on-chain figure. Report the
// residual instead of hiding it: OpenGov 39 attributes 1371548208681485335833 of the
// chain's 1374035885979727209137 ayes, and the 2487677298241873304 gap is precisely this.
// Where nothing was delegated the two agree to the planck and there is no row to show —
// OpenGov 60 and 368, and 25 of the 207 Democracy referenda, land there.
export function indirectTallyFrom(onChain: OnChainTally | null, direct: ReferendumDetail['directTally']): ReferendumTally | null {
  // Only a FINAL chain tally shares a moment with the direct sum. A decision-start
  // snapshot predates most of the votes, so their difference measures elapsed time,
  // not delegation — on OpenGov 370 it would have reported the whole 770M gap as
  // delegated power. (The LIVE storage tally does share the moment; getReferendum
  // routes it through tallyResidual directly.)
  if (!onChain?.final) return null
  return tallyResidual(onChain, direct)
}

export function tallyResidual(chain: Pick<ReferendumTally, 'ayes' | 'nays'>, direct: Pick<ReferendumDetail['directTally'], 'ayes' | 'nays'>): ReferendumTally | null {
  const diff = (chainValue: string, directValue: string) => {
    const delta = big(chainValue) - big(directValue)
    return delta > 0n ? delta.toString() : '0'
  }
  const ayes = diff(chain.ayes, direct.ayes)
  const nays = diff(chain.nays, direct.nays)
  return ayes === '0' && nays === '0' ? null : { ayes, nays, support: null }
}

// A Democracy referendum's proposal hash, from the block that ENACTED it.
//
// No Democracy event names a proposal: Started is {refIndex, threshold} and Executed is
// {refIndex, result}. But `do_enact_proposal` reads the preimage and dispatches it in one
// block, emitting Democracy.PreimageUsed{proposalHash, provider, deposit} before the
// Democracy.Executed{refIndex} that reports the outcome. So the pair is a single
// enactment, and the pairing is only trusted where it is unambiguous: each of the 49
// enactment blocks in Hydration's history holds exactly one PreimageUsed and exactly one
// Executed, and this returns null rather than a guess for anything else — showing a wrong
// proposal on a referendum page is worse than showing none.
//
// The referenda enacted after the pallet moved its proposals into the Preimage pallet
// emit no PreimageUsed, so they legitimately stay without a proposal.
async function democracyProposalHash(executedBlock: number, index: number): Promise<string | null> {
  const res = await client.query({
    query: `SELECT event_name, event_index, args_json
            FROM price_data.raw_events
            WHERE block_height = {b:UInt32}
              AND event_name IN ('Democracy.PreimageUsed', 'Democracy.Executed')
            ORDER BY event_index`,
    query_params: { b: executedBlock }, format: 'JSONEachRow',
  })
  const rows = await res.json<{ event_name: string; event_index: number; args_json: string }>()
  const used = rows.filter(row => row.event_name === 'Democracy.PreimageUsed')
  const executed = rows.filter(row => row.event_name === 'Democracy.Executed')
  if (used.length !== 1 || executed.length !== 1) return null
  const parse = (json: string) => { try { return JSON.parse(json) as Record<string, unknown> } catch { return {} } }
  if (Number(parse(executed[0].args_json).refIndex) !== index) return null
  const hash = parse(used[0].args_json).proposalHash
  return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash.toLowerCase() : null
}

interface ProposalCallRow {
  pallet: string
  call_name: string
  args_json: string
  encoded: string
  byte_length: number
  decode_error: string
}

async function loadProposalCall(hash: string): Promise<ReferendumDetail['proposalCall']> {
  const res = await client.query({
    query: `SELECT pallet, call_name, args_json, encoded, byte_length, decode_error
            FROM price_data.referendum_proposals FINAL
            WHERE proposal_hash = {hash:String} LIMIT 1`,
    query_params: { hash: hash.toLowerCase() }, format: 'JSONEachRow',
  })
  const row = (await res.json<ProposalCallRow>())[0]
  if (!row) return null
  let args: unknown = {}
  try { args = row.args_json ? JSON.parse(row.args_json) : {} } catch { args = {} }
  return {
    pallet: row.pallet,
    callName: row.call_name,
    args,
    encoded: row.encoded || null,
    byteLength: Number(row.byte_length),
    decodeError: row.decode_error || null,
  }
}

// How long a referendum's answer stays true. A concluded referendum can gain no vote
// and change no tally, so it is held for a minute; a running one is what the page polls
// for new votes, so holding it that long would make the poll show the same figures four
// times over. One block is the finest resolution the votes themselves have.
const RUNNING_TTL_MS = 6_000
const CONCLUDED_TTL_MS = 60_000

export async function getReferendum(pallet: ReferendumPallet, index: number, limit = 500): Promise<ReferendumDetail | null> {
  // Which of the two this is comes from the lifecycle, so that is read first — under
  // its own single-flight cache, so a page polling a running referendum still costs one
  // lifecycle query per window rather than one per reader.
  const lifecycle = await cached(`explorer:referendum:lifecycle:${pallet}:${index}`, RUNNING_TTL_MS, () => loadLifecycle(pallet, index))
  const ttlMs = lifecycle.some(row => isConcludingEvent(row.event_name)) ? CONCLUDED_TTL_MS : RUNNING_TTL_MS

  return cached(`explorer:referendum:${pallet}:${index}:${limit}`, ttlMs, async () => {
    // Deposit refunds and other housekeeping land long after the vote closes, and
    // votes cannot be cast after it, so vote windows end at the CONCLUSION. Using
    // the last lifecycle event instead widened some windows enough to read
    // hundreds of MB of call JSON.
    const conclusionBlock = [...lifecycle].reverse().find(row => isConcludingEvent(row.event_name))?.block_height ?? null
    // A running referendum needs the head twice: to close its vote window and to
    // place "now" on its track's decision-period clock. A concluded one needs
    // neither, so the read is skipped.
    const headBlock = conclusionBlock == null && lifecycle.length
      ? await (async () => {
        const headRes = await client.query({ query: 'SELECT max(block_height) AS h FROM price_data.blocks', format: 'JSONEachRow' })
        return Number((await headRes.json<{ h: number }>())[0]?.h ?? lifecycle[lifecycle.length - 1].block_height)
      })()
      : null
    const votes = pallet === 'democracy'
      ? await loadDemocracyVotes(index)
      // Votes can only be cast between submission and conclusion, so the
      // referendum's own lifecycle bounds every vote read. Without lifecycle rows
      // there is nothing to bound and nothing to show.
      : lifecycle.length
        ? await loadConvictionVotes(index, lifecycle[0].block_height, conclusionBlock ?? headBlock ?? lifecycle[lifecycle.length - 1].block_height)
        : ([] as VoteEventRow[])

    if (!lifecycle.length && !votes.length) return null

    const [prices, titles] = await Promise.all([ensurePrices(), referendumTitles()])
    const priceUsd = prices.get(HDX_ASSET_ID)?.price ?? null
    const assetRef = assetDescriptor(HDX_ASSET_ID)
    const decimals = assetRef.decimals

    // Withdrawals only count up to the moment the referendum closed (see
    // loadWithdrawals); a still-open referendum has no such ceiling.
    const withdrawals = lifecycle.length
      ? await loadWithdrawals(pallet, index, lifecycle[0].block_height, conclusionBlock != null ? conclusionBlock - 1 : 0xffff_ffff)
      : new Map<string, VotePosition>()

    const latest = latestVotePerAccount(votes)
    const voters = latest
      .map(row => toVoter(row, withdrawals, priceUsd, decimals))
      // Heaviest voice first: the page and its bubble map are about who moved the vote.
      .sort((a, b) => (big(b.weighted) > big(a.weighted) ? 1 : big(b.weighted) < big(a.weighted) ? -1 : 0))

    const directTally = tallyVoters(voters)
    const onChainTally = onChainTallyFrom(lifecycle)
    const submitted = lifecycle.find(row => row.event_name === 'Referenda.Submitted' || row.event_name === 'Democracy.Started')
    const concludedRow = [...lifecycle].reverse().find(row => isConcludingEvent(row.event_name))
    const submittedArgs = submitted ? (() => { try { return JSON.parse(submitted.args_json) as Record<string, unknown> } catch { return {} } })() : {}
    const proposal = submittedArgs.proposal as { hash?: unknown } | undefined
    // Democracy.Executed is the enactment, not the conclusion (see CONCLUDING_EVENTS), and
    // the enactment is where the proposal hash surfaces.
    const executedBlock = lifecycle.find(row => row.event_name === 'Democracy.Executed')?.block_height
    const proposalHash = typeof proposal?.hash === 'string'
      ? proposal.hash
      : executedBlock != null ? await democracyProposalHash(executedBlock, index) : null
    const proposalCall = proposalHash ? await loadProposalCall(proposalHash) : null

    // Only an approved OpenGov referendum has an enactment to look up. Democracy states its
    // own in Democracy.Executed, which the lifecycle projection already carries.
    const approved = pallet === 'opengov'
      && lifecycle.some(row => row.event_name === 'Referenda.Confirmed' || row.event_name === 'Referenda.Approved')
    const enactment = approved ? await loadEnactment(index) : null

    // The proposer: the submit extrinsic's signer (effective signer for proxied
    // and EVM-signed submissions).
    let proposer: AccountRef | null = null
    if (pallet === 'opengov' && submitted?.extrinsic_index != null) {
      const signerRes = await client.query({
        query: `SELECT ifNull(signer, effective_signer) AS who FROM price_data.raw_extrinsics
                WHERE block_height = {b:UInt32} AND extrinsic_index = {i:UInt32} LIMIT 1`,
        query_params: { b: submitted.block_height, i: submitted.extrinsic_index }, format: 'JSONEachRow',
      })
      const who = (await signerRes.json<{ who: string | null }>())[0]?.who
      if (who && /^0x[0-9a-f]{64}$/i.test(who)) proposer = accountRef(who.toLowerCase())
    }

    const trackId = typeof submittedArgs.track === 'number' ? submittedArgs.track : null
    const track = pallet === 'opengov' && trackId != null ? trackById(trackId) : null
    const phaseInfo = pallet === 'opengov' ? opengovPhase(lifecycle) : null
    const liveTally = phaseInfo && track ? await liveReferendumState(index) : null

    return {
      pallet,
      index,
      title: titles.get(`${pallet}:${index}`) ?? null,
      proposer,
      subsquareUrl: subsquareUrl(pallet, index),
      track: trackId,
      proposalHash,
      proposalCall,
      status: referendumStatusFrom(pallet, lifecycle.map(row => row.event_name)),
      submittedAt: submitted ? { blockHeight: submitted.block_height, extrinsicIndex: submitted.extrinsic_index, timestamp: submitted.ts } : null,
      // A conclusion is usually a block hook rather than an extrinsic, so its extrinsic
      // index is legitimately null and the UI falls back to a plain timestamp.
      concludedAt: concludedRow ? { blockHeight: concludedRow.block_height, extrinsicIndex: concludedRow.extrinsic_index, timestamp: concludedRow.ts } : null,
      asset: assetRef,
      onChainTally,
      directTally,
      // The residual next to a FINAL tally as before; while running, the live
      // storage tally shares the direct sum's moment just as well, so the same
      // subtraction is delegation there too (± the seconds between the two reads).
      indirectTally: indirectTallyFrom(onChainTally, directTally) ?? (liveTally ? tallyResidual(liveTally, directTally) : null),
      voters: voters.slice(0, limit),
      votesShown: Math.min(voters.length, limit),
      votesTotal: voters.length,
      timeline: referendumTimelineFrom(lifecycle, enactment),
      trackInfo: track ? {
        id: track.id, name: track.name,
        preparePeriod: track.preparePeriod, decisionPeriod: track.decisionPeriod,
        confirmPeriod: track.confirmPeriod, minEnactmentPeriod: track.minEnactmentPeriod,
        decisionDeposit: track.decisionDeposit,
      } : null,
      liveTally,
      progress: phaseInfo && track && headBlock != null
        ? progressFrom(phaseInfo, track, headBlock, liveTally, directTally)
        : null,
    }
  })
}

export interface ReferendumListRow {
  pallet: ReferendumPallet
  index: number
  title: string | null
  status: string
  // Not counted here. A referendum's voter count is the number of accounts whose LATEST
  // vote in its lifecycle window still stands, and neither half of that is a column: an
  // OpenGov `ConvictionVoting.Voted` event does not carry the poll index (it is recovered
  // from the vote call, gasless votes from a SCALE permit payload), and a withdrawal is a
  // removal call that may be wrapped in a batch/proxy/multisig. Reconstructing it costs
  // what `/explorer/referendum/:pallet/:index` pays per referendum, which is why this
  // states the absence rather than shipping a 0 that reads as "nobody voted".
  voters: number | null
  blockHeight: number
  timestamp: string
  // OpenGov enrichment (null for Democracy): the track off the Submitted event,
  // and the account that signed the submit extrinsic (effective signer for
  // proxied/EVM submissions). Democracy proposals were tabled from a queue and
  // name no single submitter.
  track: GovernanceTrackRef | null
  proposer: AccountRef | null
}

export interface GovernanceTrackRef { id: number; name: string }

// Referendum directory: every referendum either pallet has recorded, newest first.
// Grouped on the projection's own key prefix, so the whole directory is the three
// granules `referendum_lifecycle_events` occupies rather than two full passes over
// `raw_events` (see loadLifecycle for why that predicate could not be indexed).
//
// The last event's block is not a unique sort key — 84 of the 580 referenda share one
// with another, because a deposit-refund batch closes many at once (33 in the largest
// such block) — so (pallet, ref_index) breaks the tie. Without it the ordering is only
// partial and LIMIT/OFFSET pages it inconsistently: walking the four pages of the default
// limit back to back returned two referenda twice and silently dropped two others, and
// which two varied from one walk to the next.
export async function getReferenda(limit = 100, offset = 0): Promise<ReferendumListRow[]> {
  return cached(`explorer:referenda:${limit}:${offset}`, 60_000, async () => {
    const [res, titles] = await Promise.all([
      client.query({
        query: `
          SELECT pallet, ref_index, events, last_block AS block_height, ts, track_id, submit_block, submit_ext
          FROM (
            -- The inner aggregate must NOT alias max(block_height) to the column's
            -- own name: the alias shadows the column for the submit_block
            -- aggregate, which ClickHouse rejects as nested aggregation.
            SELECT pallet, ref_index, groupArray(event_name) AS events, max(block_height) AS last_block,
                   toString(max(block_timestamp)) AS ts,
                   if(countIf(event_name = 'Referenda.Submitted') > 0,
                      anyIf(JSONExtractInt(args_json, 'track'), event_name = 'Referenda.Submitted'), -1) AS track_id,
                   anyIf(block_height, event_name = 'Referenda.Submitted') AS submit_block,
                   anyIf(ifNull(extrinsic_index, -1), event_name = 'Referenda.Submitted') AS submit_ext
            FROM price_data.referendum_lifecycle_events FINAL
            GROUP BY pallet, ref_index
          )
          ORDER BY block_height DESC, pallet ASC, ref_index DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit, offset }, format: 'JSONEachRow',
      }),
      referendumTitles(),
    ])
    const raw = await res.json<{ pallet: string; ref_index: number; events: string[]; block_height: number; ts: string; track_id: number; submit_block: number; submit_ext: number }>()
    // Every submit extrinsic's signer in one primary-key batch (~400 tuples);
    // the directory result is cached, so this is not a per-request read.
    const submitKeys = raw.filter(r => r.pallet === 'opengov' && Number(r.submit_ext) >= 0)
      .map(r => `(${r.submit_block},${r.submit_ext})`)
    const signerByKey = new Map<string, string>()
    if (submitKeys.length) {
      const signerRes = await client.query({
        query: `SELECT block_height, extrinsic_index, ifNull(signer, effective_signer) AS who
                FROM price_data.raw_extrinsics
                WHERE (block_height, extrinsic_index) IN (${submitKeys.join(',')})`,
        format: 'JSONEachRow',
      })
      for (const row of await signerRes.json<{ block_height: number; extrinsic_index: number; who: string | null }>()) {
        if (row.who && /^0x[0-9a-f]{64}$/i.test(row.who)) signerByKey.set(`${row.block_height}:${row.extrinsic_index}`, row.who.toLowerCase())
      }
    }
    return raw.map(row => {
      const pallet = row.pallet as ReferendumPallet
      const trackId = Number(row.track_id)
      const track = pallet === 'opengov' && trackId >= 0 ? trackById(trackId) : null
      const who = signerByKey.get(`${row.submit_block}:${row.submit_ext}`)
      return {
        pallet,
        index: Number(row.ref_index),
        title: titles.get(`${pallet}:${Number(row.ref_index)}`) ?? null,
        status: referendumStatusFrom(pallet, row.events),
        voters: null,
        blockHeight: Number(row.block_height),
        timestamp: row.ts,
        track: track ? { id: track.id, name: track.name } : trackId >= 0 ? { id: trackId, name: `track ${trackId}` } : null,
        proposer: who ? accountRef(who) : null,
      }
    })
  })
}

/* ============ the /governance page ============ */

export type GovernanceReferendumRow = ReferendumListRow
export interface GovernanceReferendaPage { total: number; rows: GovernanceReferendumRow[] }

// The whole referendum directory (~600 rows, a few KB) — the single projection
// read getReferenda already caches, held whole and filtered per request, which
// is what gives the page exact totals and free status/track filters.
async function governanceDirectory(): Promise<GovernanceReferendumRow[]> {
  return getReferenda(2000, 0)
}

export async function getGovernanceReferenda(
  pallet: ReferendumPallet, status?: string, track?: number, limit = 25, offset = 0,
): Promise<GovernanceReferendaPage> {
  const rows = (await governanceDirectory()).filter(row =>
    row.pallet === pallet
    && (!status || row.status === status)
    && (track == null || row.track?.id === track))
  return { total: rows.length, rows: rows.slice(offset, offset + limit) }
}

// The status words a pallet's rows can actually carry — the page's status
// filter offers exactly these rather than a hardcoded list that drifts.
export function governanceStatusOptions(pallet: ReferendumPallet): string[] {
  const table = pallet === 'opengov' ? OPENGOV_STATUS : DEMOCRACY_STATUS
  return [...new Set(table.map(([, status]) => status))]
}

// One RUNNING OpenGov referendum, enriched for the live cards: track, phase
// clocks and the freshest tally — everything the /governance hero shows without
// the voters reconstruction the detail page pays for.
export interface ActiveReferendumCard {
  index: number
  title: string | null
  status: string
  track: GovernanceTrackRef | null
  proposer: AccountRef | null
  submittedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
  progress: ReferendumProgress | null
  // 'live' is the pallet's current storage tally; 'snapshot' the decision-start
  // figure every later vote has moved past (shown, but labeled).
  tally: { ayes: string; nays: string; support: string | null; source: 'live' | 'snapshot' } | null
}

export interface GovernanceOverview {
  active: ActiveReferendumCard[]
  counts: { opengov: number; democracy: number; tcMotions: number; councilMotions: number; tips: number }
}

const ACTIVE_STATUSES = new Set(['submitted', 'deciding', 'confirming'])

export async function getGovernanceOverview(): Promise<GovernanceOverview> {
  return cached('explorer:governance:overview', 6_000, async () => {
    const directory = await governanceDirectory()
    const activeRows = directory.filter(row => row.pallet === 'opengov' && ACTIVE_STATUSES.has(row.status))
    const headRes = activeRows.length
      ? await client.query({ query: 'SELECT max(block_height) AS h FROM price_data.blocks', format: 'JSONEachRow' })
      : null
    const head = headRes ? Number((await headRes.json<{ h: number }>())[0]?.h ?? 0) : 0
    const active = await Promise.all(activeRows.map(async row => {
      const lifecycle = await cached(`explorer:referendum:lifecycle:opengov:${row.index}`, RUNNING_TTL_MS, () => loadLifecycle('opengov', row.index))
      const phaseInfo = opengovPhase(lifecycle)
      const track = row.track ? trackById(row.track.id) : null
      const live = phaseInfo && track ? await liveReferendumState(row.index) : null
      const snapshot = onChainTallyFrom(lifecycle)
      const submitted = lifecycle.find(r => r.event_name === 'Referenda.Submitted')
      return {
        index: row.index,
        title: row.title,
        status: row.status,
        track: row.track,
        proposer: row.proposer,
        submittedAt: submitted ? { blockHeight: submitted.block_height, extrinsicIndex: submitted.extrinsic_index, timestamp: submitted.ts } : null,
        progress: phaseInfo && track && head > 0
          ? progressFrom(phaseInfo, track, head, live, { ayes: '0', nays: '0', support: '0' })
          : null,
        tally: live
          ? { ayes: live.ayes, nays: live.nays, support: live.support, source: 'live' as const }
          : snapshot ? { ayes: snapshot.ayes, nays: snapshot.nays, support: snapshot.support, source: 'snapshot' as const } : null,
      }
    }))
    const [motionsTc, motionsCouncil, tips] = await Promise.all([
      collectiveMotions('TechnicalCommittee'), collectiveMotions('Council'), treasuryTips(),
    ])
    return {
      active,
      counts: {
        opengov: directory.filter(r => r.pallet === 'opengov').length,
        democracy: directory.filter(r => r.pallet === 'democracy').length,
        tcMotions: motionsTc.length,
        councilMotions: motionsCouncil.length,
        tips: tips.length,
      },
    }
  })
}

/* ---- collective motions (Technical Committee + the historical Council) ---- */

export interface CollectiveMotionRow {
  index: number
  hash: string
  proposer: AccountRef | null
  threshold: number
  ayes: number
  nays: number
  // What the motion DOES: the proposed call's name, with a batch summarized by
  // its inner calls ("Utility.batch_all · AssetRegistry.update ×9") — decoded
  // from the propose extrinsic, which raw_calls carries in full.
  call: string | null
  status: 'open' | 'approved' | 'disapproved' | 'executed' | 'failed'
  proposedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string }
  closedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
}
export interface CollectiveMotionsPage { total: number; rows: CollectiveMotionRow[] }

// The proposed call, summarized to one line. A batch counts its inner calls per
// name; anything unparseable stays null rather than guessing.
export function motionCallSummary(argsJson: string): string | null {
  try {
    const proposal = (JSON.parse(argsJson) as { proposal?: { __kind?: string; value?: { __kind?: string; calls?: { __kind?: string; value?: { __kind?: string } }[] } } }).proposal
    if (!proposal?.__kind) return null
    const name = `${proposal.__kind}.${proposal.value?.__kind ?? ''}`.replace(/\.$/, '')
    const calls = proposal.value?.calls
    if (!Array.isArray(calls) || !calls.length) return name
    const counts = new Map<string, number>()
    for (const c of calls) {
      const inner = `${c?.__kind ?? '?'}.${c?.value?.__kind ?? '?'}`
      counts.set(inner, (counts.get(inner) ?? 0) + 1)
    }
    const parts = [...counts.entries()].sort((a, b) => b[1] - a[1])
    const shown = parts.slice(0, 2).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
    const more = parts.length > 2 ? ` +${parts.length - 2} more` : ''
    return `${name} · ${shown.join(', ')}${more}`
  } catch { return null }
}

const MOTION_EVENTS = ['Proposed', 'Voted', 'Approved', 'Disapproved', 'Closed', 'Executed'] as const

async function collectiveMotions(pallet: 'TechnicalCommittee' | 'Council'): Promise<CollectiveMotionRow[]> {
  return cached(`explorer:governance:motions:${pallet}`, 60_000, async () => {
    const names = MOTION_EVENTS.map(n => `${pallet}.${n}`)
    const res = await client.query({
      query: `SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, args_json
              FROM price_data.raw_events
              WHERE event_name IN (${names.map(n => `'${n}'`).join(',')})
              ORDER BY block_height, event_index`,
      format: 'JSONEachRow',
    })
    const events = await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; ts: string; event_name: string; args_json: string }>()
    const parse = (json: string) => { try { return JSON.parse(json) as Record<string, unknown> } catch { return {} } }
    const motions: (CollectiveMotionRow & { proposeKey: string })[] = []
    // A hash names a CALL, not a motion — the same call proposed twice is two
    // motions — so hash events attach to the latest open instance of their hash.
    const latestByHash = new Map<string, CollectiveMotionRow & { proposeKey: string }>()
    for (const ev of events) {
      const args = parse(ev.args_json)
      const hash = String(args.proposalHash ?? '')
      const kind = ev.event_name.slice(pallet.length + 1)
      if (kind === 'Proposed') {
        const proposer = typeof args.account === 'string' && /^0x[0-9a-f]{64}$/i.test(args.account) ? accountRef(args.account.toLowerCase()) : null
        const motion: CollectiveMotionRow & { proposeKey: string } = {
          index: Number(args.proposalIndex ?? -1),
          hash,
          proposer,
          threshold: Number(args.threshold ?? 0),
          ayes: 1, nays: 0,   // proposing votes aye implicitly in this pallet's UI sense
          call: null,
          status: 'open',
          proposedAt: { blockHeight: ev.block_height, extrinsicIndex: ev.extrinsic_index, timestamp: ev.ts },
          closedAt: null,
          proposeKey: `${ev.block_height}:${ev.extrinsic_index ?? -1}`,
        }
        motions.push(motion)
        latestByHash.set(hash, motion)
        continue
      }
      const motion = latestByHash.get(hash)
      if (!motion) continue
      const moment = { blockHeight: ev.block_height, extrinsicIndex: ev.extrinsic_index, timestamp: ev.ts }
      if (kind === 'Voted') {
        motion.ayes = Number(args.yes ?? motion.ayes)
        motion.nays = Number(args.no ?? motion.nays)
      } else if (kind === 'Closed') {
        motion.ayes = Number(args.yes ?? motion.ayes)
        motion.nays = Number(args.no ?? motion.nays)
        motion.closedAt = moment
      } else if (kind === 'Approved') {
        motion.status = 'approved'; motion.closedAt = moment
      } else if (kind === 'Disapproved') {
        motion.status = 'disapproved'; motion.closedAt = moment
      } else if (kind === 'Executed') {
        const result = (args.result as { __kind?: string } | undefined)?.__kind
        motion.status = result === 'Ok' ? 'executed' : 'failed'
        motion.closedAt = moment
      }
    }
    // What each motion proposes, off its propose extrinsic (raw_calls carries the
    // full decoded inner call). Keyed by (block, extrinsic) of the Proposed event.
    const keys = motions.filter(m => m.proposedAt.extrinsicIndex != null)
      .map(m => `(${m.proposedAt.blockHeight},${m.proposedAt.extrinsicIndex})`)
    if (keys.length) {
      const callRes = await client.query({
        query: `SELECT block_height, extrinsic_index, args_json
                FROM price_data.raw_calls
                WHERE (block_height, extrinsic_index) IN (${keys.join(',')})
                  AND call_name = '${pallet}.propose'
                ORDER BY length(call_address) ASC`,
        format: 'JSONEachRow',
      })
      const byKey = new Map<string, string>()
      for (const row of await callRes.json<{ block_height: number; extrinsic_index: number; args_json: string }>()) {
        const key = `${row.block_height}:${row.extrinsic_index}`
        if (!byKey.has(key)) byKey.set(key, row.args_json)
      }
      for (const motion of motions) {
        const argsJson = byKey.get(motion.proposeKey)
        if (argsJson) motion.call = motionCallSummary(argsJson)
      }
    }
    motions.reverse()   // newest first
    return motions.map(({ proposeKey: _unused, ...row }) => row)
  })
}

export async function getCollectiveMotions(body: 'tc' | 'council', limit = 25, offset = 0): Promise<CollectiveMotionsPage> {
  const rows = await collectiveMotions(body === 'tc' ? 'TechnicalCommittee' : 'Council')
  return { total: rows.length, rows: rows.slice(offset, offset + limit) }
}

/* ---- treasury tips (historical; the pallet went quiet in 2025-01) ---- */

export interface TreasuryTipRow {
  hash: string
  // The tip's reason — by convention a URL or a short sentence, carried as
  // bytes in the report_awesome/tip_new call.
  reason: string | null
  beneficiary: AccountRef | null
  payout: string | null
  status: 'open' | 'closing' | 'closed' | 'retracted'
  openedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string }
  closedAt: { blockHeight: number; extrinsicIndex: number | null; timestamp: string } | null
}
export interface TreasuryTipsPage { total: number; rows: TreasuryTipRow[] }

async function treasuryTips(): Promise<TreasuryTipRow[]> {
  return cached('explorer:governance:tips', 300_000, async () => {
    const res = await client.query({
      query: `SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, args_json
              FROM price_data.raw_events
              WHERE event_name IN ('Tips.NewTip', 'Tips.TipClosing', 'Tips.TipClosed', 'Tips.TipRetracted')
              ORDER BY block_height, event_index`,
      format: 'JSONEachRow',
    })
    const events = await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; ts: string; event_name: string; args_json: string }>()
    const parse = (json: string) => { try { return JSON.parse(json) as Record<string, unknown> } catch { return {} } }
    const byHash = new Map<string, TreasuryTipRow>()
    for (const ev of events) {
      const args = parse(ev.args_json)
      const hash = String(args.tipHash ?? '')
      const moment = { blockHeight: ev.block_height, extrinsicIndex: ev.extrinsic_index, timestamp: ev.ts }
      if (ev.event_name === 'Tips.NewTip') {
        byHash.set(hash, { hash, reason: null, beneficiary: null, payout: null, status: 'open', openedAt: moment, closedAt: null })
        continue
      }
      const tip = byHash.get(hash)
      if (!tip) continue
      if (ev.event_name === 'Tips.TipClosing') tip.status = 'closing'
      else if (ev.event_name === 'Tips.TipClosed') {
        tip.status = 'closed'
        tip.closedAt = moment
        tip.payout = typeof args.payout === 'string' || typeof args.payout === 'number' ? String(args.payout) : null
        if (typeof args.who === 'string' && /^0x[0-9a-f]{64}$/i.test(args.who)) tip.beneficiary = accountRef(args.who.toLowerCase())
      } else if (ev.event_name === 'Tips.TipRetracted') { tip.status = 'retracted'; tip.closedAt = moment }
    }
    const tips = [...byHash.values()]
    // Reason + beneficiary from the opening call — the events never carry them.
    const keys = tips.filter(t => t.openedAt.extrinsicIndex != null)
      .map(t => `(${t.openedAt.blockHeight},${t.openedAt.extrinsicIndex})`)
    if (keys.length) {
      const callRes = await client.query({
        query: `SELECT block_height, extrinsic_index, args_json
                FROM price_data.raw_calls
                WHERE (block_height, extrinsic_index) IN (${keys.join(',')})
                  AND call_name IN ('Tips.report_awesome', 'Tips.tip_new')
                ORDER BY length(call_address) ASC`,
        format: 'JSONEachRow',
      })
      const byKey = new Map<string, Record<string, unknown>>()
      for (const row of await callRes.json<{ block_height: number; extrinsic_index: number; args_json: string }>()) {
        const key = `${row.block_height}:${row.extrinsic_index}`
        if (!byKey.has(key)) byKey.set(key, parse(row.args_json))
      }
      for (const tip of tips) {
        const args = byKey.get(`${tip.openedAt.blockHeight}:${tip.openedAt.extrinsicIndex}`)
        if (!args) continue
        if (typeof args.reason === 'string' && args.reason.startsWith('0x')) {
          try { tip.reason = Buffer.from(args.reason.slice(2), 'hex').toString('utf8') } catch { /* stays null */ }
        }
        if (!tip.beneficiary && typeof args.who === 'string' && /^0x[0-9a-f]{64}$/i.test(args.who)) {
          tip.beneficiary = accountRef(args.who.toLowerCase())
        }
      }
    }
    tips.reverse()
    return tips
  })
}

export async function getTreasuryTips(limit = 25, offset = 0): Promise<TreasuryTipsPage> {
  const rows = await treasuryTips()
  return { total: rows.length, rows: rows.slice(offset, offset + limit) }
}
