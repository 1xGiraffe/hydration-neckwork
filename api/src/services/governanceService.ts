import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
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

// Conviction multipliers are 0.1x for a lock-free vote and 1x..6x for the locked
// classes. 0.1 has no exact binary representation and vote weight is a financial
// quantity, so weights are carried in TENTHS as integers (BigInt) and only divided
// for display: None -> 1, Locked1x -> 10, ... Locked6x -> 60.
const CONVICTION_TENTHS = [1n, 10n, 20n, 30n, 40n, 50n, 60n]
const CONVICTION_NAMES = ['None', 'Locked1x', 'Locked2x', 'Locked3x', 'Locked4x', 'Locked5x', 'Locked6x']

export function convictionTenths(convictionIndex: number): bigint {
  return CONVICTION_TENTHS[convictionIndex] ?? 1n
}

export function convictionName(convictionIndex: number): string {
  return CONVICTION_NAMES[convictionIndex] ?? `Conviction ${convictionIndex}`
}

// A Standard AccountVote packs the side into the high bit and the conviction class
// into the low 7 bits of one byte: >= 128 is Aye.
export function decodeVoteByte(voteByte: number): { side: 'Aye' | 'Nay'; convictionIndex: number } {
  return { side: voteByte >= 128 ? 'Aye' : 'Nay', convictionIndex: voteByte & 0x7f }
}

// Conviction-weighted vote power, in the same planck units as the balance. Integer
// throughout: (balance * tenths) / 10, so a 0.1x vote of 1 planck floors to 0
// rather than drifting through a float.
export function weightedVotePower(balancePlanck: bigint, convictionIndex: number): bigint {
  return (balancePlanck * convictionTenths(convictionIndex)) / 10n
}

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
  // Conviction-weighted power, planck. For Split/SplitAbstain this is the plain
  // balance: those variants have no conviction to apply.
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
  status: string
  submittedAt: { blockHeight: number; timestamp: string } | null
  concludedAt: { blockHeight: number; timestamp: string } | null
  asset: AssetRef
  // The chain's own tally from the lifecycle event, already conviction-weighted and
  // inclusive of delegated power. Authoritative when present.
  onChainTally: ReferendumTally | null
  // What the indexed per-account votes add up to.
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

const CONCLUDING_EVENTS = new Set([
  'Referenda.Confirmed', 'Referenda.Approved', 'Referenda.Rejected', 'Referenda.Cancelled',
  'Referenda.TimedOut', 'Referenda.Killed',
  'Democracy.Passed', 'Democracy.NotPassed', 'Democracy.Cancelled', 'Democracy.Vetoed', 'Democracy.Executed',
])

interface LifecycleRow {
  event_name: string
  block_height: number
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
    query: `SELECT event_name, block_height, toString(block_timestamp) AS ts, args_json
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

function tallyFromArgs(argsJson: string): ReferendumTally | null {
  try {
    const tally = (JSON.parse(argsJson) as { tally?: Record<string, unknown> }).tally
    if (!tally) return null
    const str = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? v : null)
    const ayes = str(tally.ayes), nays = str(tally.nays)
    if (ayes == null || nays == null) return null
    return { ayes, nays, support: str(tally.support) }
  } catch { return null }
}

interface VoteEventRow {
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

// The (block, extrinsic) pairs that voted on this referendum.
//
// Democracy.Voted names its referendum in the event, so those need no lookup at
// all. ConvictionVoting.Voted does NOT: the index lives on the call. A direct
// ConvictionVoting.vote call row covers 66,243 of 67,755 conviction votes (97.8%);
// the remaining 1,512 are gasless app votes wrapped in
// MultiTransactionPayment.dispatch_permit (1,441) and proxy/EVM wrappers, whose
// index is only recoverable by decoding the payload — hence the second pass, which
// reuses the decoders the activity feed already relies on. Skipping it would drop
// 2.2% of votes with no visible sign, which is exactly the kind of silent
// incompleteness this codebase refuses.
async function convictionVoteExtrinsics(index: number, fromBlock: number, toBlock: number): Promise<Set<string>> {
  const directRes = await client.query({
    query: `SELECT DISTINCT block_height, extrinsic_index
            FROM price_data.raw_calls
            WHERE call_name = 'ConvictionVoting.vote'
              AND block_height >= {from:UInt32} AND block_height <= {to:UInt32}
              AND toUInt32(JSONExtractInt(args_json, 'pollIndex')) = {idx:UInt32}
              AND extrinsic_index IS NOT NULL`,
    query_params: { idx: index, from: fromBlock, to: toBlock }, format: 'JSONEachRow',
  })
  const keys = new Set<string>()
  for (const row of await directRes.json<{ block_height: number; extrinsic_index: number }>()) {
    keys.add(`${row.block_height}:${row.extrinsic_index}`)
  }

  // Which vote extrinsics in the window a direct call did NOT explain. Resolved in
  // two steps on purpose: asking for args_json across every wrapper call in a long
  // window reads hundreds of MB of JSON and tripped the query memory ceiling on
  // referendum 44, while the unmatched set is tiny (1,512 in all of history) and can
  // be addressed by key.
  const candidateRes = await client.query({
    query: `SELECT DISTINCT block_height, extrinsic_index
            FROM price_data.vote_activity
            WHERE event_name = 'ConvictionVoting.Voted'
              AND block_height >= {from:UInt32} AND block_height <= {to:UInt32}
              AND extrinsic_index IS NOT NULL`,
    query_params: { from: fromBlock, to: toBlock }, format: 'JSONEachRow',
  })
  const candidates = (await candidateRes.json<{ block_height: number; extrinsic_index: number }>())
    .filter(row => !keys.has(`${row.block_height}:${row.extrinsic_index}`))
  if (!candidates.length) return keys

  const wanted = String(index)
  const blocks = [...new Set(candidates.map(row => row.block_height))]
  const candidateKeys = new Set(candidates.map(row => `${row.block_height}:${row.extrinsic_index}`))
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

async function loadConvictionVotes(index: number, fromBlock: number, toBlock: number): Promise<VoteEventRow[]> {
  const keys = await convictionVoteExtrinsics(index, fromBlock, toBlock)
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

// Pre-event-era votes, read from the CALLS.
//
// ConvictionVoting.Voted did not exist before block 7,175,436, but successful
// ConvictionVoting.vote calls go back to 6,641,707 — 13,651 of them. OpenGov
// referenda 0-43 therefore have vote calls and NO vote events at all, and the split
// is clean (no referendum straddles the boundary). Reading events alone would show
// those 44 referenda as having received zero votes, which reads as "nobody voted"
// rather than "this is not indexed" — so their votes come from the calls instead.
// The call carries the same AccountVote payload; the voter is the signed origin.
async function loadPreEventEraVotes(index: number): Promise<VoteEventRow[]> {
  const res = await client.query({
    query: `SELECT block_height, toUInt32(extrinsic_index) AS event_index, extrinsic_index,
                   toString(block_timestamp) AS ts,
                   JSONExtractString(origin_json, 'value', 'value') AS who,
                   JSONExtractString(args_json, 'vote', '__kind') AS kind,
                   toUInt16(JSONExtractInt(args_json, 'vote', 'vote')) AS vote_byte,
                   JSONExtractString(args_json, 'vote', 'balance') AS balance,
                   JSONExtractString(args_json, 'vote', 'aye') AS aye,
                   JSONExtractString(args_json, 'vote', 'nay') AS nay,
                   JSONExtractString(args_json, 'vote', 'abstain') AS abstain,
                   0 AS removed
            FROM price_data.raw_calls
            WHERE call_name = 'ConvictionVoting.vote'
              AND block_height < {eventEra:UInt32}
              AND success = 1
              AND toUInt32(JSONExtractInt(args_json, 'pollIndex')) = {idx:UInt32}
              AND extrinsic_index IS NOT NULL
            ORDER BY block_height, extrinsic_index`,
    query_params: { idx: index, eventEra: CONVICTION_VOTED_FIRST_BLOCK }, format: 'JSONEachRow',
  })
  return res.json<VoteEventRow>()
}

// Votes WITHDRAWN, meaning removed while the referendum was still open.
//
// ConvictionVoting.VoteRemoved carries the voter but not the poll index (same shape
// as Voted), so the index comes from the remove_vote call on the same extrinsic. The
// upper bound is the conclusion block, not the last lifecycle event: a removal after
// the vote closed is just the voter unlocking their balance, and 1,179 of 2,436
// removals are of that kind — treating those as withdrawals would silently delete
// votes that did count.
async function loadRemovedVoters(index: number, fromBlock: number, toBlock: number): Promise<Set<string>> {
  const res = await client.query({
    query: `SELECT DISTINCT JSONExtractString(e.args_json, 'who') AS who
            FROM price_data.raw_events e
            WHERE e.event_name = 'ConvictionVoting.VoteRemoved'
              AND e.block_height >= {from:UInt32} AND e.block_height <= {to:UInt32}
              AND (e.block_height, e.extrinsic_index) IN (
                SELECT block_height, extrinsic_index FROM price_data.raw_calls
                WHERE call_name IN ('ConvictionVoting.remove_vote', 'ConvictionVoting.remove_other_vote', 'ConvictionVoting.force_remove_vote')
                  AND block_height >= {from:UInt32} AND block_height <= {to:UInt32}
                  AND toUInt32(JSONExtractInt(args_json, 'index')) = {idx:UInt32})`,
    query_params: { idx: index, from: fromBlock, to: toBlock }, format: 'JSONEachRow',
  })
  return new Set((await res.json<{ who: string }>()).map(row => row.who.toLowerCase()))
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

function toVoter(row: VoteEventRow, removed: Set<string>, priceUsd: number | null, decimals: number): ReferendumVoter {
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
    // Split votes back both sides with no conviction, so their power is the plain
    // balance on each side; the abstain leg backs neither.
    side = kind
    balance = aye + nay + abstain
    weightedAye = aye
    weightedNay = nay
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
    removed: removed.has((row.who ?? '').toLowerCase()),
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
// residual instead of hiding it: for OpenGov 368 the direct votes came to 99.975%
// of the on-chain aye tally, and the missing 0.025% is precisely this.
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
        const conclusionBlock = [...lifecycle].reverse().find(row => CONCLUDING_EVENTS.has(row.event_name))?.block_height
        let end = conclusionBlock
        if (end == null) {
          const headRes = await client.query({ query: 'SELECT max(block_height) AS h FROM price_data.blocks', format: 'JSONEachRow' })
          end = Number((await headRes.json<{ h: number }>())[0]?.h ?? lifecycle[lifecycle.length - 1].block_height)
        }
        const fromEvents = await loadConvictionVotes(index, first, end)
        // A referendum wholly inside the pre-event era has no events to find.
        return fromEvents.length ? fromEvents : loadPreEventEraVotes(index)
      })()

    if (!lifecycle.length && !votes.length) return null

    const [prices, titles] = await Promise.all([ensurePrices(), referendumTitles()])
    const priceUsd = prices.get(HDX_ASSET_ID)?.price ?? null
    const assetRef = assetDescriptor(HDX_ASSET_ID)
    const decimals = assetRef.decimals

    // Withdrawals only count up to the moment the referendum closed (see
    // loadRemovedVoters); a still-open referendum has no such ceiling.
    const concludedAtBlock = [...lifecycle].reverse().find(row => CONCLUDING_EVENTS.has(row.event_name))?.block_height
    const removed = pallet === 'opengov' && lifecycle.length
      ? await loadRemovedVoters(index, lifecycle[0].block_height, concludedAtBlock != null ? concludedAtBlock - 1 : 0xffff_ffff)
      : new Set<string>()

    const latest = latestVotePerAccount(votes)
    const voters = latest
      .map(row => toVoter(row, removed, priceUsd, decimals))
      // Heaviest voice first: the page and its bubble map are about who moved the vote.
      .sort((a, b) => (big(b.weighted) > big(a.weighted) ? 1 : big(b.weighted) < big(a.weighted) ? -1 : 0))

    const directTally = tallyVoters(voters)
    // The most recent lifecycle event that carried a tally is the freshest on-chain
    // figure (DecisionStarted, ConfirmStarted, Confirmed, Rejected all carry one).
    const onChainTally = [...lifecycle].reverse().map(row => tallyFromArgs(row.args_json)).find(Boolean) ?? null
    const submitted = lifecycle.find(row => row.event_name === 'Referenda.Submitted' || row.event_name === 'Democracy.Started')
    const concludedRow = [...lifecycle].reverse().find(row => CONCLUDING_EVENTS.has(row.event_name))
    const submittedArgs = submitted ? (() => { try { return JSON.parse(submitted.args_json) as Record<string, unknown> } catch { return {} } })() : {}
    const proposal = submittedArgs.proposal as { hash?: unknown } | undefined

    return {
      pallet,
      index,
      title: titles.get(`${pallet}:${index}`) ?? null,
      subsquareUrl: subsquareUrl(pallet, index),
      track: typeof submittedArgs.track === 'number' ? submittedArgs.track : null,
      proposalHash: typeof proposal?.hash === 'string' ? proposal.hash : null,
      status: referendumStatusFrom(pallet, lifecycle.map(row => row.event_name)),
      submittedAt: submitted ? { blockHeight: submitted.block_height, timestamp: submitted.ts } : null,
      concludedAt: concludedRow ? { blockHeight: concludedRow.block_height, timestamp: concludedRow.ts } : null,
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
