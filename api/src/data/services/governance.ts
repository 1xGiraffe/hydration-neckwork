import type { ClickHouseClient } from '../../db/client.ts'
import { iso } from '../schemas/common.ts'
import { accountRefOrNull, type AccountRef } from './address.ts'
import { parseJsonColumn } from './chainCore.ts'
import type { Order } from './feed.ts'

// Governance reads for /v1/governance/*. Referendum state is folded at read
// time from referendum_lifecycle_events (605 referenda, ~2.8k rows — a
// three-granule table), which is the same seam the explorer's referenda
// surfaces read; votes come from governance_vote_calls (ref-first) and its
// voter-first twin governance_vote_calls_by_voter (009_data.sql).

export type ReferendumPallet = 'opengov' | 'democracy'

// The status each STATUS-BEARING lifecycle event moves a referendum into.
// Deposit bookkeeping (DecisionDepositPlaced/Refunded, SubmissionDepositRefunded)
// deliberately maps to nothing: a deposit refund lands AFTER Confirmed/Rejected
// and must not un-decide the referendum. Vocabulary pinned against the live
// table (SELECT DISTINCT event_name, 2026-08-29); Approved/Killed are in the
// pallet's vocabulary but have never fired on Hydration.
export const REFERENDUM_STATUSES = [
  'submitted', 'deciding', 'confirming', 'confirmed', 'approved', 'rejected',
  'timedOut', 'cancelled', 'killed', 'passed', 'notPassed', 'executed',
] as const

export type ReferendumStatus = (typeof REFERENDUM_STATUSES)[number]

const STATUS_BY_EVENT: Record<string, ReferendumStatus> = {
  'Referenda.Submitted': 'submitted',
  'Referenda.DecisionStarted': 'deciding',
  'Referenda.ConfirmStarted': 'confirming',
  'Referenda.ConfirmAborted': 'deciding',
  'Referenda.Confirmed': 'confirmed',
  'Referenda.Approved': 'approved',
  'Referenda.Rejected': 'rejected',
  'Referenda.TimedOut': 'timedOut',
  'Referenda.Cancelled': 'cancelled',
  'Referenda.Killed': 'killed',
  'Democracy.Started': 'deciding',
  'Democracy.Passed': 'passed',
  'Democracy.NotPassed': 'notPassed',
  'Democracy.Cancelled': 'cancelled',
  'Democracy.Executed': 'executed',
}

const TERMINAL_STATUSES = new Set<ReferendumStatus>(['confirmed', 'approved', 'rejected', 'timedOut', 'cancelled', 'killed', 'passed', 'notPassed', 'executed'])

export interface ReferendumTally { ayes: string; nays: string; support: string }

export interface ReferendumSummary {
  pallet: ReferendumPallet
  refIndex: number
  title: string | null
  status: ReferendumStatus
  track: number | null
  proposalHash: string | null
  tally: ReferendumTally | null
  submittedAt: string | null
  submittedAtBlock: number | null
  decidedAt: string | null
}

export interface LifecycleEventItem {
  eventName: string
  blockHeight: number
  eventIndex: number
  timestamp: string
  args: unknown
}

export interface ReferendumProposal {
  pallet: string
  callName: string
  args: unknown
  byteLength: number
  decodeError: string | null
}

export interface ReferendumDetail extends ReferendumSummary {
  events: LifecycleEventItem[]
  proposal: ReferendumProposal | null
}

interface LifecycleRow {
  pallet: string
  ref_index: number
  event_name: string
  block_height: number
  event_index: number
  ts: string
  args_json: string
  ingested_at: string
}

const LIFECYCLE_COLUMNS_SQL = `
      pallet, ref_index, event_name, block_height, event_index,
      toString(block_timestamp) AS ts, args_json, ingested_at`

function dedupLifecycle(rows: LifecycleRow[]): LifecycleRow[] {
  // ReplacingMergeTree replay identity is (pallet, ref_index, block, event);
  // rows arrive ordered …, ingested_at DESC so the first per identity wins.
  const seen = new Set<string>()
  const out: LifecycleRow[] = []
  for (const row of rows) {
    const key = `${row.pallet}:${row.ref_index}:${row.block_height}:${row.event_index}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

function extractTally(argsJson: string): ReferendumTally | null {
  const args = parseJsonColumn(argsJson) as { tally?: { ayes?: unknown; nays?: unknown; support?: unknown } } | null
  const tally = args?.tally
  if (!tally || typeof tally !== 'object') return null
  return {
    ayes: String(tally.ayes ?? '0'),
    nays: String(tally.nays ?? '0'),
    support: String(tally.support ?? '0'),
  }
}

// Fold one referendum's lifecycle rows (ascending block order) into its
// current state. `Democracy.Started` doubles as the legacy pallet's
// submission signal — it emitted no Submitted event.
export function foldReferendum(pallet: ReferendumPallet, refIndex: number, ordered: LifecycleRow[], title: string | null): ReferendumSummary {
  let status: ReferendumStatus = pallet === 'democracy' ? 'deciding' : 'submitted'
  let track: number | null = null
  let proposalHash: string | null = null
  let tally: ReferendumTally | null = null
  let submittedAt: string | null = null
  let submittedAtBlock: number | null = null
  let decidedAt: string | null = null
  for (const row of ordered) {
    const args = parseJsonColumn(row.args_json) as Record<string, unknown> | null
    if (row.event_name === 'Referenda.Submitted' || row.event_name === 'Democracy.Started') {
      if (submittedAtBlock == null) {
        submittedAt = iso(row.ts)
        submittedAtBlock = Number(row.block_height)
      }
    }
    // Track and proposal ride on Submitted and are repeated on DecisionStarted.
    const proposal = args?.proposal as { hash?: unknown } | undefined
    if (typeof proposal?.hash === 'string') proposalHash = proposal.hash.toLowerCase()
    if (typeof args?.track === 'number') track = args.track
    const withTally = extractTally(row.args_json)
    if (withTally) tally = withTally
    const mapped = STATUS_BY_EVENT[row.event_name]
    if (mapped) {
      status = mapped
      if (TERMINAL_STATUSES.has(mapped) && decidedAt == null) decidedAt = iso(row.ts)
    }
  }
  return { pallet, refIndex, title, status, track, proposalHash, tally, submittedAt, submittedAtBlock, decidedAt }
}

async function loadTitles(client: ClickHouseClient): Promise<Map<string, string>> {
  const res = await client.query({
    query: `-- data:governance:titles
        SELECT pallet, ref_index, title
        FROM price_data.referendum_titles FINAL
        WHERE title != ''`,
    format: 'JSONEachRow',
  })
  const titles = new Map<string, string>()
  for (const row of await res.json<{ pallet: string; ref_index: number; title: string }>()) {
    titles.set(`${row.pallet}:${row.ref_index}`, row.title)
  }
  return titles
}

// The whole referenda directory in one read: the lifecycle table is tiny by
// construction (see its 001_tables.sql note), so the fold is cheaper than any
// per-page slicing in SQL would be. Sorted newest submission first.
export async function loadReferenda(client: ClickHouseClient): Promise<ReferendumSummary[]> {
  const [res, titles] = await Promise.all([
    client.query({
      query: `-- data:governance:referenda
          SELECT ${LIFECYCLE_COLUMNS_SQL}
          FROM price_data.referendum_lifecycle_events
          ORDER BY pallet, ref_index, block_height, event_index, ingested_at DESC`,
      format: 'JSONEachRow',
    }),
    loadTitles(client),
  ])
  const rows = dedupLifecycle(await res.json<LifecycleRow>())
  const grouped = new Map<string, LifecycleRow[]>()
  for (const row of rows) {
    const key = `${row.pallet}:${row.ref_index}`
    const bucket = grouped.get(key)
    if (bucket) bucket.push(row)
    else grouped.set(key, [row])
  }
  const out: ReferendumSummary[] = []
  for (const [key, group] of grouped) {
    const [pallet, refIndex] = key.split(':')
    out.push(foldReferendum(pallet as ReferendumPallet, Number(refIndex), group, titles.get(key) ?? null))
  }
  return out.sort((a, b) => (b.submittedAtBlock ?? 0) - (a.submittedAtBlock ?? 0)
    || a.pallet.localeCompare(b.pallet)
    || b.refIndex - a.refIndex)
}

export async function loadReferendum(client: ClickHouseClient, pallet: ReferendumPallet, refIndex: number): Promise<ReferendumDetail | null> {
  const [res, titleRes] = await Promise.all([
    client.query({
      query: `-- data:governance:referendum
          SELECT ${LIFECYCLE_COLUMNS_SQL}
          FROM price_data.referendum_lifecycle_events
          WHERE pallet = {pallet:String} AND ref_index = {refIndex:UInt32}
          ORDER BY block_height, event_index, ingested_at DESC`,
      query_params: { pallet, refIndex },
      format: 'JSONEachRow',
    }),
    client.query({
      query: `-- data:governance:title
          SELECT title FROM price_data.referendum_titles FINAL
          WHERE pallet = {pallet:String} AND ref_index = {refIndex:UInt32} AND title != ''
          LIMIT 1`,
      query_params: { pallet, refIndex },
      format: 'JSONEachRow',
    }),
  ])
  const rows = dedupLifecycle(await res.json<LifecycleRow>())
  if (rows.length === 0) return null
  const title = (await titleRes.json<{ title: string }>())[0]?.title ?? null
  const summary = foldReferendum(pallet, refIndex, rows, title)
  const proposal = summary.proposalHash ? await loadProposal(client, summary.proposalHash) : null
  return {
    ...summary,
    proposal,
    events: rows.map(row => ({
      eventName: row.event_name,
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      timestamp: iso(row.ts),
      args: parseJsonColumn(row.args_json),
    })),
  }
}

async function loadProposal(client: ClickHouseClient, proposalHash: string): Promise<ReferendumProposal | null> {
  const res = await client.query({
    query: `-- data:governance:proposal
        SELECT pallet, call_name, args_json, byte_length, decode_error
        FROM price_data.referendum_proposals FINAL
        WHERE proposal_hash = {hash:String}
        LIMIT 1`,
    query_params: { hash: proposalHash },
    format: 'JSONEachRow',
  })
  const [row] = await res.json<{ pallet: string; call_name: string; args_json: string; byte_length: number; decode_error: string }>()
  if (!row) return null
  return {
    pallet: row.pallet,
    callName: row.call_name,
    args: parseJsonColumn(row.args_json),
    byteLength: Number(row.byte_length),
    decodeError: row.decode_error || null,
  }
}

// ---------------------------------------------------------------------------
// Votes
// ---------------------------------------------------------------------------

export interface VoteCallItem {
  voter: AccountRef | null
  pallet: ReferendumPallet
  refIndex: number
  callName: string
  voteKind: string | null
  voteByte: number
  /** Standard votes only: the AYE bit of the raw vote byte. */
  aye: boolean | null
  /** Standard votes only: conviction 0 (0.1x) … 6 (6x), the low 7 bits. */
  conviction: number | null
  balance: string | null
  ayeAmount: string | null
  nayAmount: string | null
  abstainAmount: string | null
  success: boolean
  blockHeight: number
  extrinsicIndex: number | null
  timestamp: string
}

interface VoteRow {
  who: string
  pallet: string
  ref_index: number
  call_name: string
  vote_kind: string
  vote_byte: number
  balance: string
  aye: string
  nay: string
  abstain: string
  success: number
  block_height: number
  extrinsic_index: number | null
  call_address: string
  ts: string
  ingested_at: string
}

const VOTE_COLUMNS_SQL = `
      call_name, vote_kind, vote_byte, balance, aye, nay, abstain, success,
      block_height, extrinsic_index, call_address, toString(block_timestamp) AS ts,
      ingested_at`

const rawAmount = (value: unknown): string | null => {
  const text = String(value ?? '').trim()
  return /^\d+$/.test(text) ? text : null
}

export function voteItem(row: VoteRow): VoteCallItem {
  const isVote = row.call_name.endsWith('.vote')
  const standard = isVote && row.vote_kind === 'Standard'
  return {
    voter: accountRefOrNull(row.who),
    pallet: row.pallet as ReferendumPallet,
    refIndex: Number(row.ref_index),
    callName: row.call_name,
    voteKind: isVote ? row.vote_kind || null : null,
    voteByte: Number(row.vote_byte),
    aye: standard ? Number(row.vote_byte) >= 128 : null,
    conviction: standard ? Number(row.vote_byte) & 0x7f : null,
    balance: rawAmount(row.balance),
    ayeAmount: rawAmount(row.aye),
    nayAmount: rawAmount(row.nay),
    abstainAmount: rawAmount(row.abstain),
    success: Number(row.success) === 1,
    blockHeight: Number(row.block_height),
    extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
    timestamp: iso(row.ts),
  }
}

// A vote's position in the feed: (block, extrinsic-or-max, call address) — the
// source key minus the referendum, unique per call. The cursor continues from
// the identity of the last item served, which stays stable while new votes
// land at the head.
export interface VoteKey { b: number; x: number; c: string }

export interface KeyedVote {
  item: VoteCallItem
  key: VoteKey
}

// Newest first: the feeds' canonical order.
function compareKeysDesc(a: VoteKey, b: VoteKey): number {
  return (b.b - a.b) || (b.x - a.x) || (a.c === b.c ? 0 : a.c < b.c ? 1 : -1)
}

// The replay identity is the source key (pallet, ref, block, extrinsic-or-max,
// call_address); the newest ingest wins and the result is newest call first.
function dedupAndSortVotes(rows: VoteRow[]): KeyedVote[] {
  const byIdentity = new Map<string, VoteRow>()
  for (const row of rows) {
    const key = `${row.pallet}:${row.ref_index}:${row.block_height}:${row.extrinsic_index ?? 'x'}:${row.call_address}`
    const prior = byIdentity.get(key)
    if (!prior || String(row.ingested_at) > String(prior.ingested_at)) byIdentity.set(key, row)
  }
  return [...byIdentity.values()]
    .map(row => ({
      item: voteItem(row),
      key: { b: Number(row.block_height), x: Number(row.extrinsic_index ?? 4294967295), c: String(row.call_address) },
    }))
    .sort((a, b) => compareKeysDesc(a.key, b.key))
}

// The cached set is newest first; `asc` is its reverse.
export function orderVotes(votes: KeyedVote[], order: Order): KeyedVote[] {
  return order === 'desc' ? votes : [...votes].reverse()
}

// Where a cursor's identity sits in a set ordered by `order`: the exact item
// when it is still present, else the slot just before the first item that
// sorts after it (-1 when everything sorts after it).
export function voteCursorPosition(votes: KeyedVote[], cursor: VoteKey, order: Order): number {
  const exact = votes.findIndex(v => v.key.b === cursor.b && v.key.x === cursor.x && v.key.c === cursor.c)
  if (exact >= 0) return exact
  const sign = order === 'desc' ? 1 : -1
  const after = votes.findIndex(v => sign * compareKeysDesc(cursor, v.key) < 0)
  return (after < 0 ? votes.length : after) - 1
}

// One referendum's raw vote-call history. The heaviest referendum on the live
// table carries 1,179 calls (democracy 116), so one referendum's rows are read
// whole and paged in memory — a key-prefix read on governance_vote_calls.
export async function votesForReferendum(client: ClickHouseClient, pallet: ReferendumPallet, refIndex: number): Promise<KeyedVote[]> {
  const res = await client.query({
    query: `-- data:governance:votes:by-ref
        SELECT who, pallet, ref_index, ${VOTE_COLUMNS_SQL}
        FROM price_data.governance_vote_calls
        WHERE pallet = {pallet:String} AND ref_index = {refIndex:UInt32}`,
    query_params: { pallet, refIndex },
    format: 'JSONEachRow',
  })
  return dedupAndSortVotes(await res.json<VoteRow>())
}

// One voter's whole call history, from the voter-first twin. A voter's history
// is bounded (the busiest voter cannot exceed the vote-call total per
// referendum times the referenda they touched), so it is read whole too.
export async function votesForVoter(client: ClickHouseClient, voterAccountId: string): Promise<KeyedVote[]> {
  const res = await client.query({
    query: `-- data:governance:votes:by-voter
        SELECT voter AS who, pallet, ref_index, ${VOTE_COLUMNS_SQL}
        FROM price_data.governance_vote_calls_by_voter
        WHERE voter = {voter:String}`,
    query_params: { voter: voterAccountId },
    format: 'JSONEachRow',
  })
  return dedupAndSortVotes(await res.json<VoteRow>())
}
