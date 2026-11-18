import type { ClickHouseClient } from '../db/client.ts'
import { weightedVotePower } from './convictionWeight.ts'

// ConvictionVoting state per account: what each account is voting on now, what it has
// locked and until when, and what an unlock would free.
//
// The source is `conviction_voting_state` and `account_vote_locks_state`
// (022_governance_state.sql): materialized views over the raw indexer's observations
// of ConvictionVoting.VotingFor and Balances.Locks, taken at every block that changes
// them. The read is per block by construction — the newest row of an account IS its
// current state — and the api keeps the newest row of every account in memory
// (`refreshConvictionSnapshot`, reloaded whenever the tables' watermark moves), so the
// governance routes answer from memory with no per-request chain read.
//
// Lock rules are the pallet's (galacticcouncil polkadot-sdk fork,
// conviction-voting/src/lib.rs), with Hydration's VotingHooks:
//   - a class's lock is max(prior while unexpired, every vote still in `votes` at its
//     full balance, a delegation's balance) — `Voting::locked_balance` — and
//     ClassLocksFor only shrinks on `unlock(class)`; the account's 'pyconvot' lock is
//     the max over classes;
//   - removing a vote on a COMPLETED poll moves its lock into `prior`
//     (`prior.accumulate(end + lock_periods × VoteLockingPeriod, balance)`, which keeps
//     the max amount AND the max end): a winning Standard vote always; on Hydration a
//     LOSING Standard vote too when the account stakes (legacy staking or GIGAHDX), for
//     the staked part only (`lock_balance_on_unsuccessful_vote`); Split and
//     SplitAbstain votes never;
//   - a cancelled, killed or timed-out poll is no poll (`PollStatus::None`): nothing
//     is locked after it;
//   - lock periods per conviction: None 0, 1x 1, 2x 2, 3x 4, 4x 8, 5x 16, 6x 32.
// Heights are PARACHAIN blocks (AGENTS.md: conviction timing uses parachain height).

export const CONVICTION_LOCK_PERIODS = [0, 1, 2, 4, 8, 16, 32] as const

export function lockPeriods(conviction: number): number {
  return CONVICTION_LOCK_PERIODS[conviction] ?? 0
}

export type AccountVote =
  | { kind: 'Standard'; aye: boolean; conviction: number; balance: bigint }
  | { kind: 'Split'; aye: bigint; nay: bigint }
  | { kind: 'SplitAbstain'; aye: bigint; nay: bigint; abstain: bigint }

export interface PriorLock { until: number; amount: bigint }
export interface Delegations { votes: bigint; capital: bigint }

export type ClassVoting =
  | { cls: number; kind: 'casting'; votes: { poll: number; vote: AccountVote }[]; delegations: Delegations; prior: PriorLock }
  | { cls: number; kind: 'delegating'; target: string; balance: bigint; conviction: number; delegations: Delegations; prior: PriorLock }

const CONVICTION_KINDS = ['None', 'Locked1x', 'Locked2x', 'Locked3x', 'Locked4x', 'Locked5x', 'Locked6x']

const big = (v: unknown): bigint | null => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  if (typeof v === 'string' && /^(\d+|0x[0-9a-fA-F]+)$/.test(v)) return BigInt(v)
  return null
}

function parseDelegations(v: unknown): Delegations | null {
  const d = v as { votes?: unknown; capital?: unknown } | null
  const votes = big(d?.votes), capital = big(d?.capital)
  return votes == null || capital == null ? null : { votes, capital }
}

function parsePrior(v: unknown): PriorLock | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  const until = Number(v[0]), amount = big(v[1])
  return Number.isInteger(until) && until >= 0 && amount != null ? { until, amount } : null
}

export function parseAccountVote(v: unknown): AccountVote | null {
  const o = v as { __kind?: unknown; vote?: unknown; balance?: unknown; aye?: unknown; nay?: unknown; abstain?: unknown } | null
  if (o?.__kind === 'Standard') {
    const byte = Number(o.vote), balance = big(o.balance)
    if (!Number.isInteger(byte) || byte < 0 || byte > 255 || balance == null) return null
    const conviction = byte & 0x7f
    if (conviction > 6) return null
    return { kind: 'Standard', aye: byte >= 128, conviction, balance }
  }
  if (o?.__kind === 'Split') {
    const aye = big(o.aye), nay = big(o.nay)
    return aye == null || nay == null ? null : { kind: 'Split', aye, nay }
  }
  if (o?.__kind === 'SplitAbstain') {
    const aye = big(o.aye), nay = big(o.nay), abstain = big(o.abstain)
    return aye == null || nay == null || abstain == null ? null : { kind: 'SplitAbstain', aye, nay, abstain }
  }
  return null
}

/**
 * One account's VotingFor of every class, from the raw indexer's decoded JSON
 * (`{"<class>": {"__kind": "Casting"|"Delegating", "value": {…}}}`; '{}' = none).
 * Null when the shape is not one the pallet produces — never a partial read.
 */
export function parseVotingFor(json: string): ClassVoting[] | null {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return null }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: ClassVoting[] = []
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    const cls = Number(key)
    if (!Number.isInteger(cls) || cls < 0) return null
    const e = entry as { __kind?: unknown; value?: Record<string, unknown> } | null
    const value = e?.value
    if (!value) return null
    const delegations = parseDelegations(value.delegations)
    const prior = parsePrior(value.prior)
    if (!delegations || !prior) return null
    if (e.__kind === 'Casting') {
      if (!Array.isArray(value.votes)) return null
      const votes: { poll: number; vote: AccountVote }[] = []
      for (const item of value.votes) {
        if (!Array.isArray(item) || item.length !== 2) return null
        const poll = Number(item[0]), vote = parseAccountVote(item[1])
        if (!Number.isInteger(poll) || poll < 0 || !vote) return null
        votes.push({ poll, vote })
      }
      out.push({ cls, kind: 'casting', votes, delegations, prior })
    } else if (e.__kind === 'Delegating') {
      const balance = big(value.balance)
      const conviction = CONVICTION_KINDS.indexOf(String((value.conviction as { __kind?: unknown } | null)?.__kind ?? ''))
      const target = typeof value.target === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value.target) ? value.target.toLowerCase() : null
      if (balance == null || conviction < 0 || !target) return null
      out.push({ cls, kind: 'delegating', target, balance, conviction, delegations, prior })
    } else {
      return null
    }
  }
  return out.sort((a, b) => a.cls - b.cls)
}

/** What a vote locks while it sits in `votes` (`AccountVote::balance`). */
export function voteBalance(v: AccountVote): bigint {
  if (v.kind === 'Standard') return v.balance
  if (v.kind === 'Split') return v.aye + v.nay
  return v.aye + v.nay + v.abstain
}

/** What a vote adds to a poll's tally: conviction-weighted ayes/nays and support capital. */
export function voteTally(v: AccountVote, delegations: Delegations = { votes: 0n, capital: 0n }): { ayes: bigint; nays: bigint; support: bigint } {
  if (v.kind === 'Standard') {
    // Delegated power rides on a Standard vote only (`Tally::increase(aye, delegations)`).
    const votes = weightedVotePower(v.balance, v.conviction) + delegations.votes
    return v.aye
      ? { ayes: votes, nays: 0n, support: v.balance + delegations.capital }
      : { ayes: 0n, nays: votes, support: 0n }
  }
  // Split legs are Conviction::None (0.1x); support is aye (and abstain) capital.
  const ayes = weightedVotePower(v.aye, 0), nays = weightedVotePower(v.nay, 0)
  return { ayes, nays, support: v.aye + (v.kind === 'SplitAbstain' ? v.abstain : 0n) }
}

/** A poll as the pallet sees it when a vote on it is removed. */
export type PollOutcome =
  | { state: 'ongoing'; expectedEnd: number | null }
  | { state: 'completed'; end: number; approved: boolean }
  | { state: 'none' }
  | { state: 'unknown' }

/**
 * What one vote locks once its poll is over, as a lock that `removeVote` would move
 * into `prior`:
 *   'if-wins'    ongoing: a Standard vote locks for its conviction if its side wins
 *                (untilBlock is an estimate from the poll's expected end, or null);
 *   'won'        completed, the vote's side won: locked until end + periods × V;
 *   'lost-staker' completed, lost, the account stakes: Hydration locks the staked part
 *                for the vote's periods (amount is an upper bound, see below);
 *   'none'       nothing after the poll (lost without staking, Split/SplitAbstain, a
 *                cancelled/killed/timed-out poll, or a 0.1x vote, whose lock ends at
 *                the poll's end).
 *   'unknown'    the poll's outcome is not indexed.
 * `stakeCap` is the account's staked HDX (max of its legacy-staking and GIGAHDX locks)
 * — the staking hooks lock the vote amount capped by the stake recorded at vote time,
 * which only the hooks' storage holds, so the amount is labelled an estimate.
 */
export interface VoteAfterLock {
  kind: 'if-wins' | 'won' | 'lost-staker' | 'none' | 'unknown'
  amount: bigint
  untilBlock: number | null
  estimate: boolean
}

export function voteAfterLock(v: AccountVote, outcome: PollOutcome, votingPeriod: number, stakeCap: bigint): VoteAfterLock {
  const none: VoteAfterLock = { kind: 'none', amount: 0n, untilBlock: null, estimate: false }
  if (outcome.state === 'unknown') return { kind: 'unknown', amount: voteBalance(v), untilBlock: null, estimate: true }
  if (outcome.state === 'none' || v.kind !== 'Standard') return none
  const periods = lockPeriods(v.conviction)
  if (outcome.state === 'ongoing') {
    if (periods === 0) return none
    return { kind: 'if-wins', amount: v.balance, untilBlock: outcome.expectedEnd == null ? null : outcome.expectedEnd + periods * votingPeriod, estimate: true }
  }
  const until = outcome.end + periods * votingPeriod
  if (v.aye === outcome.approved) return periods === 0 ? none : { kind: 'won', amount: v.balance, untilBlock: until, estimate: false }
  if (stakeCap > 0n && periods > 0) {
    return { kind: 'lost-staker', amount: v.balance < stakeCap ? v.balance : stakeCap, untilBlock: until, estimate: true }
  }
  return none
}

/** A vote is finished — removable without forfeiting anything — once its poll is not ongoing. */
export function isFinished(outcome: PollOutcome): boolean {
  return outcome.state === 'completed' || outcome.state === 'none'
}

/**
 * A class's lock requirement at `atBlock` under one of three courses:
 *   'as-is'   only `unlock(class)`: prior while unexpired, every vote at full balance;
 *   'unlock'  remove the finished votes whose lock has expired by `atBlock`, then unlock
 *             (finished votes still locked stay, at full balance);
 *   'collect' remove EVERY finished vote (what collects staking/GIGAHDX rewards), then
 *             unlock: each removed vote's unexpired lock merges into prior.
 * Ongoing votes always count at full balance; a delegation counts its balance.
 */
export type CleanupMode = 'as-is' | 'unlock' | 'collect'

export function classRequirement(
  c: ClassVoting, atBlock: number, mode: CleanupMode,
  outcomeOf: (poll: number) => PollOutcome, votingPeriod: number, stakeCap: bigint,
): bigint {
  let req = c.prior.until > atBlock ? c.prior.amount : 0n
  const max = (x: bigint) => { if (x > req) req = x }
  if (c.kind === 'delegating') { max(c.balance); return req }
  for (const { poll, vote } of c.votes) {
    const outcome = outcomeOf(poll)
    if (mode === 'as-is' || !isFinished(outcome)) { max(voteBalance(vote)); continue }
    const after = voteAfterLock(vote, outcome, votingPeriod, stakeCap)
    const lockedAfter = after.untilBlock != null && after.untilBlock > atBlock ? after.amount : 0n
    if (mode === 'unlock') { if (lockedAfter > 0n) max(voteBalance(vote)) } // still locked: left in place
    else max(lockedAfter) // collect: merged into prior
  }
  return req
}

export interface UnlockPlan {
  /** The account's conviction-voting lock as last observed (Balances.Locks 'pyconvot'). */
  locked: bigint
  /** What `unlock` frees now without removing any vote. */
  unlockableAsIs: bigint
  /** What removing the expired finished votes and unlocking frees now. */
  unlockableNow: bigint
  /** What removing every finished vote (collecting rewards) and unlocking frees now. */
  unlockableCollect: bigint
  /** Future steps of the 'unlock' course: at each block, the amount freeable from then on. */
  schedule: { block: number; freeable: bigint }[]
  /** Locked open-endedly by ongoing votes and delegations (no date until their polls end). */
  openEnded: bigint
  /**
   * What each course makes SPENDABLE: Balances freezes the max of an account's locks,
   * so HDX another lock (staking, GIGAHDX, vesting) holds stays frozen when the vote
   * lock releases — `unlockable*` is the vote lock released, these are the HDX freed.
   */
  spendableAsIs: bigint
  spendableNow: bigint
  spendableCollect: bigint
}

/**
 * The HDX a release of the vote lock from `locked` down to `locked - released`
 * makes spendable while the account's other locks peak at `otherLocked`: the frozen
 * balance is the max of all locks, so only what rises above the other locks frees.
 */
export function spendableAfterRelease(locked: bigint, released: bigint, otherLocked: bigint): bigint {
  const before = locked > otherLocked ? locked : otherLocked
  const rest = locked - released
  const after = rest > otherLocked ? rest : otherLocked
  return before > after ? before - after : 0n
}

export function unlockPlan(
  classes: ClassVoting[], locked: bigint, head: number,
  outcomeOf: (poll: number) => PollOutcome, votingPeriod: number, stakeCap: bigint,
  otherLocked = 0n,
): UnlockPlan {
  const reqAt = (block: number, mode: CleanupMode) =>
    classes.reduce((m, c) => { const r = classRequirement(c, block, mode, outcomeOf, votingPeriod, stakeCap); return r > m ? r : m }, 0n)
  const freeable = (req: bigint) => (locked > req ? locked - req : 0n)
  // Every block at which some lock can end: priors and finished votes' locks.
  const steps = new Set<number>()
  let openEnded = 0n
  for (const c of classes) {
    if (c.prior.until > head && c.prior.amount > 0n) steps.add(c.prior.until)
    if (c.kind === 'delegating') { if (c.balance > openEnded) openEnded = c.balance; continue }
    for (const { poll, vote } of c.votes) {
      const outcome = outcomeOf(poll)
      if (!isFinished(outcome)) { const b = voteBalance(vote); if (b > openEnded) openEnded = b; continue }
      const after = voteAfterLock(vote, outcome, votingPeriod, stakeCap)
      if (after.untilBlock != null && after.untilBlock > head) steps.add(after.untilBlock)
    }
  }
  const schedule: { block: number; freeable: bigint }[] = []
  let prev = freeable(reqAt(head, 'unlock'))
  for (const block of [...steps].sort((a, b) => a - b)) {
    const f = freeable(reqAt(block, 'unlock'))
    if (f > prev) { schedule.push({ block, freeable: f }); prev = f }
  }
  const unlockableAsIs = freeable(reqAt(head, 'as-is'))
  const unlockableNow = freeable(reqAt(head, 'unlock'))
  const unlockableCollect = freeable(reqAt(head, 'collect'))
  return {
    locked,
    unlockableAsIs,
    unlockableNow,
    unlockableCollect,
    schedule,
    openEnded,
    spendableAsIs: spendableAfterRelease(locked, unlockableAsIs, otherLocked),
    spendableNow: spendableAfterRelease(locked, unlockableNow, otherLocked),
    spendableCollect: spendableAfterRelease(locked, unlockableCollect, otherLocked),
  }
}

// ---- the in-memory snapshot ----

export interface AccountConvictionState {
  accountId: string
  block: number
  classes: ClassVoting[] | null
}
export interface AccountLocks { block: number; conviction: bigint; staking: bigint; gigahdx: bigint }

interface Snapshot {
  states: Map<string, AccountConvictionState>
  locks: Map<string, AccountLocks>
  /** Accounts delegating to each target, per class. */
  delegatorsOf: Map<string, { accountId: string; cls: number; balance: bigint; conviction: number }[]>
  /** The watermark the snapshot was built at (see readMark). */
  mark: Mark
  /** Newest block either table holds — the snapshot's "as of". */
  block: number
  /** When the last full load ran; an incremental merge never resets it. */
  fullAt: number
}

/** Each table's row count and newest `ingested_at` (second resolution, as ClickHouse prints it). */
interface Mark { stateRows: number; stateIngested: string; lockRows: number; lockIngested: string }

let client: ClickHouseClient | null = null
let snapshot: Snapshot | null = null
let inflight: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | null = null

/** A full reload at least this often, which also picks up rows a replay inserted with an old ingest time. */
const FULL_RELOAD_MS = 60 * 60_000

export function initConvictionState(c: ClickHouseClient): void { client = c }

async function readMark(c: ClickHouseClient): Promise<Mark> {
  const res = await c.query({
    query: `SELECT (SELECT count() FROM price_data.conviction_voting_state) AS sr,
                   (SELECT toString(max(ingested_at)) FROM price_data.conviction_voting_state) AS si,
                   (SELECT count() FROM price_data.account_vote_locks_state) AS lr,
                   (SELECT toString(max(ingested_at)) FROM price_data.account_vote_locks_state) AS li`,
    format: 'JSONEachRow',
  })
  const r = (await res.json<{ sr: number | string; si: string; lr: number | string; li: string }>())[0]
  return { stateRows: Number(r?.sr ?? 0), stateIngested: r?.si ?? '', lockRows: Number(r?.lr ?? 0), lockIngested: r?.li ?? '' }
}

const sameMark = (a: Mark, b: Mark) => a.stateRows === b.stateRows && a.stateIngested === b.stateIngested && a.lockRows === b.lockRows && a.lockIngested === b.lockIngested

const lockAmount = (v: string) => (/^\d+$/.test(v) ? BigInt(v) : 0n)

type StateRow = { account_id: string; b: number | string; v: string }
type LockRow = { account_id: string; b: number | string; cl: string; sl: string; gl: string }

/** Folds rows into the maps, each account keeping its NEWEST block (an older row arriving late changes nothing). */
function mergeStates(states: Map<string, AccountConvictionState>, rows: StateRow[]): void {
  for (const r of rows) {
    const b = Number(r.b)
    const held = states.get(r.account_id)
    if (held && held.block > b) continue
    states.set(r.account_id, { accountId: r.account_id, block: b, classes: parseVotingFor(r.v) })
  }
}

function mergeLocks(locks: Map<string, AccountLocks>, rows: LockRow[]): void {
  for (const r of rows) {
    const b = Number(r.b)
    const held = locks.get(r.account_id)
    if (held && held.block > b) continue
    // Kept even when all three are zero: the row is the account's newest word, and a
    // late, older row must not resurrect a lock it released.
    locks.set(r.account_id, { block: b, conviction: lockAmount(r.cl), staking: lockAmount(r.sl), gigahdx: lockAmount(r.gl) })
  }
}

function delegationIndex(states: Map<string, AccountConvictionState>): Snapshot['delegatorsOf'] {
  const out: Snapshot['delegatorsOf'] = new Map()
  for (const st of states.values()) for (const cv of st.classes ?? []) {
    if (cv.kind !== 'delegating') continue
    const list = out.get(cv.target) ?? []
    list.push({ accountId: st.accountId, cls: cv.cls, balance: cv.balance, conviction: cv.conviction })
    out.set(cv.target, list)
  }
  return out
}

function newestBlock(states: Map<string, AccountConvictionState>, locks: Map<string, AccountLocks>): number {
  let block = 0
  for (const st of states.values()) if (st.block > block) block = st.block
  for (const l of locks.values()) if (l.block > block) block = l.block
  return block
}

/** Every account's newest row of both tables: the one full read (boot, then hourly). */
async function loadFull(c: ClickHouseClient, mark: Mark): Promise<Snapshot> {
  const [stateRes, lockRes] = await Promise.all([
    c.query({
      query: `SELECT account_id, max(block_height) AS b, argMax(value_json, block_height) AS v
              FROM price_data.conviction_voting_state GROUP BY account_id`,
      format: 'JSONEachRow',
    }),
    c.query({
      query: `SELECT account_id, max(block_height) AS b,
                     argMax(conviction_lock, block_height) AS cl, argMax(staking_lock, block_height) AS sl, argMax(gigahdx_lock, block_height) AS gl
              FROM price_data.account_vote_locks_state GROUP BY account_id`,
      format: 'JSONEachRow',
    }),
  ])
  const states = new Map<string, AccountConvictionState>()
  const locks = new Map<string, AccountLocks>()
  mergeStates(states, await stateRes.json<StateRow>())
  mergeLocks(locks, await lockRes.json<LockRow>())
  return { states, locks, delegatorsOf: delegationIndex(states), mark, block: newestBlock(states, locks), fullAt: Date.now() }
}

/**
 * The rows ingested since the previous mark (inclusive of its second: ingested_at has
 * one-second resolution), merged into the held maps — a few rows per block instead of
 * a GROUP BY over every account. Null when the mark moved but nothing newer arrived
 * (a replay or a merge changed the count): the caller reloads whole.
 */
async function loadIncrement(c: ClickHouseClient, prev: Snapshot, mark: Mark): Promise<Snapshot | null> {
  const [stateRes, lockRes] = await Promise.all([
    c.query({
      query: `SELECT account_id, block_height AS b, value_json AS v FROM price_data.conviction_voting_state
              WHERE ingested_at >= {since:DateTime} ORDER BY block_height`,
      query_params: { since: prev.mark.stateIngested || '1970-01-01 00:00:00' }, format: 'JSONEachRow',
    }),
    c.query({
      query: `SELECT account_id, block_height AS b, conviction_lock AS cl, staking_lock AS sl, gigahdx_lock AS gl FROM price_data.account_vote_locks_state
              WHERE ingested_at >= {since:DateTime} ORDER BY block_height`,
      query_params: { since: prev.mark.lockIngested || '1970-01-01 00:00:00' }, format: 'JSONEachRow',
    }),
  ])
  const stateRows = await stateRes.json<StateRow>()
  const lockRows = await lockRes.json<LockRow>()
  if (!stateRows.length && !lockRows.length) return null
  const states = new Map(prev.states)
  const locks = new Map(prev.locks)
  mergeStates(states, stateRows)
  mergeLocks(locks, lockRows)
  return { states, locks, delegatorsOf: stateRows.length ? delegationIndex(states) : prev.delegatorsOf, mark, block: newestBlock(states, locks), fullAt: prev.fullAt }
}

/**
 * Brings the snapshot to the tables' current watermark: incrementally from the rows
 * ingested since the last one, whole at boot, hourly and whenever an increment cannot
 * account for the movement. A few-ms check when nothing moved.
 */
export function refreshConvictionSnapshot(): Promise<void> {
  if (inflight) return inflight
  const c = client
  if (!c) return Promise.resolve()
  inflight = (async () => {
    const mark = await readMark(c)
    const prev = snapshot
    if (prev && sameMark(prev.mark, mark) && Date.now() - prev.fullAt < FULL_RELOAD_MS) return
    const next = prev && Date.now() - prev.fullAt < FULL_RELOAD_MS ? await loadIncrement(c, prev, mark) : null
    snapshot = next ?? await loadFull(c, mark)
  })().finally(() => { inflight = null })
  return inflight
}

/** For tests: the merge rules on their own. */
export const __snapshotTest = { mergeStates, mergeLocks, delegationIndex }

export function startConvictionSnapshotRefresh(intervalMs = 6_000): void {
  if (timer) return
  timer = setInterval(() => { refreshConvictionSnapshot().catch(err => console.warn('[conviction-state] refresh failed; serving the previous snapshot', err instanceof Error ? err.message : err)) }, intervalMs)
  timer.unref()
}

export function stopConvictionSnapshotRefresh(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export function convictionSnapshotReady(): boolean { return snapshot != null }
export function convictionSnapshotBlock(): number | null { return snapshot?.block ?? null }

/** The newest VotingFor of each account (null when the account never held voting state). */
export function convictionStateOf(accountId: string): AccountConvictionState | null {
  return snapshot?.states.get(accountId) ?? null
}

export function voteLocksOf(accountId: string): AccountLocks | null {
  return snapshot?.locks.get(accountId) ?? null
}

/** A Balances lock other than the vote lock, by its 8-byte id (`ormlvest`, `stk_stks`, `ghdxlock`, …). */
export interface OtherLock { id: string; amount: bigint }

const VOTE_LOCK_ID = '0x7079636f6e766f74' // 'pyconvot'

/** A lock id as its ASCII name when it is printable, else its hex. */
export function lockIdName(hex: string): string {
  if (!/^0x([0-9a-f]{2}){1,8}$/i.test(hex)) return hex
  const bytes = hex.slice(2).match(/../g)!.map(b => parseInt(b, 16))
  return bytes.every(b => b >= 0x20 && b < 0x7f) ? String.fromCharCode(...bytes) : hex
}

/** Every lock in a Balances.Locks observation except the vote lock; null when the JSON is not a lock list. */
export function parseOtherLocks(json: string): OtherLock[] | null {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return null }
  if (!Array.isArray(raw)) return null
  const out: OtherLock[] = []
  for (const l of raw as { id?: unknown; amount?: unknown }[]) {
    const id = typeof l?.id === 'string' ? l.id.toLowerCase() : null
    const amount = big(l?.amount)
    if (!id || amount == null) return null
    if (id !== VOTE_LOCK_ID && amount > 0n) out.push({ id, amount })
  }
  return out
}

// The snapshot keeps three lock amounts per account; the rest of an account's locks
// (vesting, the retired democracy and elections locks, …) are read from the same
// Balances.Locks observation the snapshot row came from — a primary-key point read
// (block_height, kind, account_id) — and held per (account, block), which only a new
// observation changes.
const otherLockCache = new Map<string, { block: number; locks: OtherLock[] | null }>()
const OTHER_LOCK_CACHE_MAX = 20_000

/**
 * The non-vote locks of each account at its newest lock observation. An account the
 * snapshot holds no lock row for is absent; one whose observation could not be read
 * maps to null (unknown — never an empty list).
 */
export async function otherLocksOf(accountIds: string[]): Promise<Map<string, OtherLock[] | null>> {
  const out = new Map<string, OtherLock[] | null>()
  const want: { accountId: string; block: number }[] = []
  for (const id of accountIds) {
    const l = snapshot?.locks.get(id)
    if (!l) continue
    const hit = otherLockCache.get(id)
    if (hit && hit.block === l.block) out.set(id, hit.locks)
    else want.push({ accountId: id, block: l.block })
  }
  if (!want.length || !client) {
    for (const w of want) out.set(w.accountId, null)
    return out
  }
  const res = await client.query({
    query: `SELECT account_id, block_height AS b, argMax(value_json, ingested_at) AS v
            FROM price_data.raw_account_state_observations
            WHERE block_height IN {blocks:Array(UInt32)} AND kind = 'balances_locks' AND account_id IN {ids:Array(String)}
            GROUP BY account_id, block_height`,
    query_params: { blocks: [...new Set(want.map(w => w.block))], ids: want.map(w => w.accountId) },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ account_id: string; b: number | string; v: string }>()
  if (otherLockCache.size > OTHER_LOCK_CACHE_MAX) otherLockCache.clear()
  for (const w of want) {
    const row = rows.find(r => r.account_id === w.accountId && Number(r.b) === w.block)
    const locks = row ? parseOtherLocks(row.v) : null
    if (locks) otherLockCache.set(w.accountId, { block: w.block, locks })
    out.set(w.accountId, locks)
  }
  return out
}

/** Accounts currently delegating to `target`, per class. */
export function delegatorsOf(target: string): { accountId: string; cls: number; balance: bigint; conviction: number }[] {
  return snapshot?.delegatorsOf.get(target) ?? []
}

/** Every account's newest state — for the needs-vote and calendar reads. */
export function allConvictionStates(): Iterable<AccountConvictionState> {
  return snapshot?.states.values() ?? []
}

/**
 * Every observation of the given accounts at or below `toBlock`, oldest first — the
 * as-of source for delegation attribution and tally reconstruction (an account-first
 * key-prefix read).
 */
export async function convictionHistory(accounts: string[], toBlock: number): Promise<Map<string, { block: number; classes: ClassVoting[] | null }[]>> {
  const out = new Map<string, { block: number; classes: ClassVoting[] | null }[]>()
  if (!client || !accounts.length) return out
  const res = await client.query({
    query: `SELECT account_id, block_height AS b, any(value_json) AS v
            FROM price_data.conviction_voting_state
            WHERE account_id IN {accounts:Array(String)} AND block_height <= {to:UInt32}
            GROUP BY account_id, block_height
            ORDER BY account_id, block_height`,
    query_params: { accounts, to: toBlock },
    format: 'JSONEachRow',
  })
  for (const r of await res.json<{ account_id: string; b: number; v: string }>()) {
    const list = out.get(r.account_id) ?? []
    list.push({ block: Number(r.b), classes: parseVotingFor(r.v) })
    out.set(r.account_id, list)
  }
  return out
}

/** The newest observation at or below `block` from one account's ascending history. */
export function stateAsOf<T extends { block: number }>(history: readonly T[] | undefined, block: number): T | null {
  if (!history?.length) return null
  let lo = 0, hi = history.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (history[mid].block <= block) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found < 0 ? null : history[found]
}

/** The first block observations exist from (the seed read); earlier as-of reads are unknown. */
export const CONVICTION_STATE_FROM_BLOCK = 15_622_703
