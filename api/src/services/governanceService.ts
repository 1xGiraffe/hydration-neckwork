import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { convictionName, decodeVoteByte, weightedVotePower } from './convictionWeight.ts'
import { assetDescriptor } from './explorerAssets.ts'
import { accountRef, ensurePrices, nestedVoteInfos, voteFromPermitData, type AccountRef, type AssetRef } from './explorerService.ts'
import { referendumTitles } from './referendumTitleService.ts'

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

export interface ReferendumDetail {
  pallet: ReferendumPallet
  index: number
  title: string | null
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
  // inclusive of delegated power. Authoritative when present.
  //
  // Only OpenGov has one. Referenda.DecisionStarted/ConfirmStarted/Confirmed/Rejected all
  // carry `tally`; the Democracy pallet carries none on any of its events
  // (Started{refIndex,threshold}, Passed{refIndex}, NotPassed{refIndex},
  // Cancelled{refIndex}, Executed{refIndex,result}) and keeps its Tally only inside
  // Democracy::ReferendumInfoOf while the referendum is Ongoing, replacing it with
  // Finished{approved,end} at the close. So this is null for every Democracy referendum
  // and the consumer must present `directTally` as what it is.
  onChainTally: ReferendumTally | null
  // What the indexed per-account votes add up to: the chain's DIRECT tally, excluding
  // delegated power. Verified account-by-account against Democracy::VotingOf at the last
  // block before the close — for referendum 61 the 22 counted votes reproduce the chain's
  // own non-delegated ayes (14669791677216312056) exactly, and the whole remaining gap to
  // the chain tally (142267191677216312056) is the inbound delegation of four voters.
  directTally: {
    ayes: string
    nays: string
    rawAyes: string
    rawNays: string
    ayeVoters: number
    nayVoters: number
    splitVoters: number
    voters: number
  }
  // onChainTally minus directTally. Delegated voting power produces no Voted event
  // of its own, so it can only ever show up as this residual — reported rather than
  // silently folded into a voter's own weight.
  indirectTally: ReferendumTally | null
  voters: ReferendumVoter[]
  votesShown: number
  votesTotal: number
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

// Every lifecycle event for one referendum. Keyed on the index inside the args, so
// the read is one narrow pass over the (few hundred) governance events rather than
// anything proportional to the vote count.
async function loadLifecycle(pallet: ReferendumPallet, index: number): Promise<LifecycleRow[]> {
  const indexField = pallet === 'opengov' ? 'index' : 'refIndex'
  const prefix = pallet === 'opengov' ? 'Referenda.' : 'Democracy.'
  const res = await client.query({
    query: `SELECT event_name, block_height, extrinsic_index, toString(block_timestamp) AS ts, args_json
            FROM price_data.raw_events
            WHERE event_name LIKE {prefix:String}
              AND event_name != 'Democracy.Voted'
              AND JSONExtractInt(args_json, {field:String}) = {idx:UInt32}
              AND JSONHas(args_json, {field:String})
            ORDER BY block_height, event_index`,
    query_params: { prefix: `${prefix}%`, field: indexField, idx: index },
    format: 'JSONEachRow',
  })
  return res.json<LifecycleRow>()
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
                AND call_name IN ('MultiTransactionPayment.dispatch_permit', 'Proxy.proxy', 'Proxy.proxy_announced',
                                  'Utility.batch', 'Utility.batch_all', 'Utility.force_batch', 'Multisig.as_multi',
                                  'Multisig.as_multi_threshold_1', 'Ethereum.transact')`,
      query_params: { blocks: slice }, format: 'JSONEachRow',
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
    const confirmable = removals.filter(row => row.extrinsic_index != null && Number(row.block_height) >= CONVICTION_VOTED_FIRST_BLOCK)
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
  let ayes = 0n, nays = 0n, rawAyes = 0n, rawNays = 0n
  let ayeVoters = 0, nayVoters = 0, splitVoters = 0
  for (const voter of voters) {
    // A withdrawn vote no longer backs anything, so it is listed but not tallied.
    if (voter.removed) continue
    ayes += big(voter.weightedAye)
    nays += big(voter.weightedNay)
    if (voter.kind === 'Standard') {
      if (voter.side === 'Aye') { rawAyes += big(voter.balance); ayeVoters++ }
      else { rawNays += big(voter.balance); nayVoters++ }
    } else {
      rawAyes += big(voter.ayeBalance)
      rawNays += big(voter.nayBalance)
      splitVoters++
    }
  }
  return {
    ayes: ayes.toString(),
    nays: nays.toString(),
    rawAyes: rawAyes.toString(),
    rawNays: rawNays.toString(),
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
export function indirectTallyFrom(onChain: ReferendumTally | null, direct: ReferendumDetail['directTally']): ReferendumTally | null {
  if (!onChain) return null
  const diff = (chainValue: string, directValue: string) => {
    const delta = big(chainValue) - big(directValue)
    return delta > 0n ? delta.toString() : '0'
  }
  const ayes = diff(onChain.ayes, direct.ayes)
  const nays = diff(onChain.nays, direct.nays)
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

export async function getReferendum(pallet: ReferendumPallet, index: number, limit = 500): Promise<ReferendumDetail | null> {
  return cached(`explorer:referendum:${pallet}:${index}:${limit}`, 60_000, async () => {
    const lifecycle = await loadLifecycle(pallet, index)
    const votes = pallet === 'democracy'
      ? await loadDemocracyVotes(index)
      : await (async () => {
        // Votes can only be cast between submission and conclusion, so the
        // referendum's own lifecycle bounds every vote read. Without lifecycle rows
        // there is nothing to bound and nothing to show.
        if (!lifecycle.length) return [] as VoteEventRow[]
        const first = lifecycle[0].block_height
        // Deposit refunds and other housekeeping land long after the vote closes, and
        // votes cannot be cast after it, so the window ends at the CONCLUSION. Using
        // the last lifecycle event instead widened some windows enough to read
        // hundreds of MB of call JSON.
        const conclusionBlock = [...lifecycle].reverse().find(row => isConcludingEvent(row.event_name))?.block_height
        let end = conclusionBlock
        if (end == null) {
          const headRes = await client.query({ query: 'SELECT max(block_height) AS h FROM price_data.blocks', format: 'JSONEachRow' })
          end = Number((await headRes.json<{ h: number }>())[0]?.h ?? lifecycle[lifecycle.length - 1].block_height)
        }
        return loadConvictionVotes(index, first, end)
      })()

    if (!lifecycle.length && !votes.length) return null

    const [prices, titles] = await Promise.all([ensurePrices(), referendumTitles()])
    const priceUsd = prices.get(HDX_ASSET_ID)?.price ?? null
    const assetRef = assetDescriptor(HDX_ASSET_ID)
    const decimals = assetRef.decimals

    // Withdrawals only count up to the moment the referendum closed (see
    // loadWithdrawals); a still-open referendum has no such ceiling.
    const concludedAtBlock = [...lifecycle].reverse().find(row => isConcludingEvent(row.event_name))?.block_height
    const withdrawals = lifecycle.length
      ? await loadWithdrawals(pallet, index, lifecycle[0].block_height, concludedAtBlock != null ? concludedAtBlock - 1 : 0xffff_ffff)
      : new Map<string, VotePosition>()

    const latest = latestVotePerAccount(votes)
    const voters = latest
      .map(row => toVoter(row, withdrawals, priceUsd, decimals))
      // Heaviest voice first: the page and its bubble map are about who moved the vote.
      .sort((a, b) => (big(b.weighted) > big(a.weighted) ? 1 : big(b.weighted) < big(a.weighted) ? -1 : 0))

    const directTally = tallyVoters(voters)
    // The most recent lifecycle event that carried a tally is the freshest on-chain
    // figure (DecisionStarted, ConfirmStarted, Confirmed, Rejected all carry one).
    const onChainTally = [...lifecycle].reverse().map(row => tallyFromArgs(row.args_json)).find(Boolean) ?? null
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

    return {
      pallet,
      index,
      title: titles.get(`${pallet}:${index}`) ?? null,
      subsquareUrl: subsquareUrl(pallet, index),
      track: typeof submittedArgs.track === 'number' ? submittedArgs.track : null,
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
      indirectTally: indirectTallyFrom(onChainTally, directTally),
      voters: voters.slice(0, limit),
      votesShown: Math.min(voters.length, limit),
      votesTotal: voters.length,
    }
  })
}

export interface ReferendumListRow {
  pallet: ReferendumPallet
  index: number
  title: string | null
  status: string
  voters: number
  blockHeight: number
  timestamp: string
}

// Referendum directory: every referendum either pallet has recorded, newest first.
export async function getReferenda(limit = 100, offset = 0): Promise<ReferendumListRow[]> {
  return cached(`explorer:referenda:${limit}:${offset}`, 60_000, async () => {
    const [res, titles] = await Promise.all([
      client.query({
        query: `
          SELECT pallet, ref_index, groupArray(event_name) AS events, max(block_height) AS block_height,
                 toString(max(block_timestamp)) AS ts
          FROM (
            SELECT 'opengov' AS pallet, toUInt32(JSONExtractInt(args_json, 'index')) AS ref_index,
                   event_name, block_height, block_timestamp
            FROM price_data.raw_events
            WHERE event_name LIKE 'Referenda.%' AND JSONHas(args_json, 'index')
            UNION ALL
            SELECT 'democracy' AS pallet, toUInt32(JSONExtractInt(args_json, 'refIndex')) AS ref_index,
                   event_name, block_height, block_timestamp
            FROM price_data.raw_events
            WHERE event_name LIKE 'Democracy.%' AND event_name != 'Democracy.Voted' AND JSONHas(args_json, 'refIndex')
          )
          GROUP BY pallet, ref_index
          ORDER BY block_height DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
        query_params: { limit, offset }, format: 'JSONEachRow',
      }),
      referendumTitles(),
    ])
    return (await res.json<{ pallet: string; ref_index: number; events: string[]; block_height: number; ts: string }>()).map(row => {
      const pallet = row.pallet as ReferendumPallet
      return {
        pallet,
        index: Number(row.ref_index),
        title: titles.get(`${pallet}:${Number(row.ref_index)}`) ?? null,
        status: referendumStatusFrom(pallet, row.events),
        voters: 0,
        blockHeight: Number(row.block_height),
        timestamp: row.ts,
      }
    })
  })
}
