import type { ClickHouseClient } from '../db/client.ts'
import { cached, cachedSwr } from './cache.ts'
import { CONCLUDED_TTL_MS, getReferendum } from './governanceService.ts'
import { getGovernanceTracks, opengovReferenda, type OpengovRef } from './governanceRead.ts'
import { CONVICTION_STATE_FROM_BLOCK } from './convictionState.ts'

// The hub's Stats view: how many take part and how it ends, from tables the explorer
// already reads — never a second definition of a figure another page shows.
//   - Turnout per referendum is the referendum page's own direct tally (getReferendum's
//     `directTally`: the standing votes at the conclusion, delegated power excluded) —
//     voters and the HDX behind each side, before conviction. A concluded referendum's
//     tally only changes when votes inside its window are indexed late (a backfill, a
//     repair), so it is remembered until vote rows in its window are ingested again
//     (`ConcludedTurnout`, by the rows' ingest time); the running ones are re-read.
//   - Active voters per month: accounts with a successful vote call in the month
//     (governance_vote_calls, OpenGov; direct, proxied, batched and permit calls alike).
//   - HDX locked in votes: the sum over accounts of their newest observed conviction lock
//     (account_vote_locks_state), weekly from the observations' start, carried forward.
//   - Pass rate per track: each track's outcomes (approved / (approved + rejected)).
// Support as a share of issuance is not shown for past referenda: active issuance is
// not indexed per block, so it would need a denominator the data does not have.

let client: ClickHouseClient
export function initGovernanceStats(c: ClickHouseClient, opts: { prewarm?: boolean } = {}): void {
  client = c
  // The first build reads every referendum's tally (~20 s under load), so the explorer
  // api builds it once in the background shortly after boot; readers then get the copy.
  if (opts.prewarm) setTimeout(() => { getGovernanceStats().catch(() => undefined) }, 60_000).unref()
}

export interface TurnoutRow {
  index: number
  track: number | null
  status: string
  /** The conclusion (null while it runs). */
  concludedAt: string | null
  submittedAt: string | null
  voters: number
  ayeVoters: number
  nayVoters: number
  splitVoters: number
  /** Raw HDX, before conviction. */
  ayeCapital: string
  nayCapital: string
  /** Aye plus abstain capital: the pallet's support. */
  support: string
}

export interface GovernanceStats {
  asOf: string
  turnout: TurnoutRow[]
  /** Calendar months (UTC), oldest first. */
  activeVoters: { month: string; voters: number; votes: number }[]
  locked: { now: string; accounts: number; since: number; weekly: { week: string; locked: string; accounts: number }[] }
  tracks: { id: number; name: string; approved: number; rejected: number; cancelled: number; timedOut: number; killed: number; ongoing: number; passRate: number | null }[]
}

/**
 * Concluded referenda's turnout, kept across rebuilds. Vote rows ingested late into a
 * concluded referendum's window [submitted, concluded] drop its row, and it is read
 * again on every rebuild — not remembered — until the read started `settleMs` after
 * the newest such row was ingested: the referendum page's own cached answer, which
 * the read goes through, may predate that row until then.
 */
export class ConcludedTurnout {
  private readonly rows = new Map<number, TurnoutRow>()
  private readonly settleAfter = new Map<number, number>()
  constructor(private readonly settleMs: number) {}

  get(index: number): TurnoutRow | undefined { return this.rows.get(index) }

  /** Vote rows ingested at `ingestedMs` into `block`, against the concluded referenda's windows. */
  touched(rows: ReadonlyArray<{ block: number; ingestedMs: number }>, windows: ReadonlyArray<{ index: number; from: number; to: number }>): void {
    if (!rows.length) return
    for (const w of windows) {
      let newest = -Infinity
      for (const r of rows) if (r.block >= w.from && r.block <= w.to && r.ingestedMs > newest) newest = r.ingestedMs
      if (newest === -Infinity) continue
      this.rows.delete(w.index)
      this.settleAfter.set(w.index, Math.max(this.settleAfter.get(w.index) ?? 0, newest + this.settleMs))
    }
  }

  /** Keep a concluded referendum's row read at `startedMs`, unless it may predate a late row; whether it was kept. */
  remember(index: number, row: TurnoutRow, startedMs: number): boolean {
    if (startedMs <= (this.settleAfter.get(index) ?? -Infinity)) return false
    this.rows.set(index, row)
    this.settleAfter.delete(index)
    return true
  }
}

/** The referendum page's answer for a concluded referendum is cached this long; 30 s more covers clocks and insert visibility. */
const concludedTurnout = new ConcludedTurnout(CONCLUDED_TTL_MS + 30_000)
/** Ingest time (ClickHouse clock, unix seconds) read up to by the previous rebuild; null before the first. */
let lateVotesFrom: number | null = null
const STATS_CONCURRENCY = 3

/**
 * Tells the memo which vote rows were ingested since the last rebuild into blocks at or
 * below the newest conclusion (live votes land above every concluded window). The
 * first rebuild looks back the settle window, so a row ingested just before boot still
 * holds its referendum back. Returns the read's start on the same clock.
 */
async function noteLateVotes(all: OpengovRef[]): Promise<number> {
  const nowRes = await client.query({ query: 'SELECT toUnixTimestamp(now()) AS now', format: 'JSONEachRow' })
  const now = Number((await nowRes.json<{ now: number | string }>())[0]?.now)
  const windows = all.flatMap(r => (r.concluded ? [{ index: r.index, from: r.submitted?.block ?? 0, to: r.concluded.block }] : []))
  const since = (lateVotesFrom ?? now - Math.ceil((CONCLUDED_TTL_MS + 30_000) / 1000)) - 5 // a few seconds' overlap: ingest stamps are whole seconds
  if (windows.length) {
    const res = await client.query({
      query: `-- governance:stats-late-votes
        SELECT block_height AS b, toUnixTimestamp(max(ingested_at)) AS w FROM (
          SELECT block_height, ingested_at FROM price_data.vote_activity
          WHERE ingested_at >= toDateTime({since:UInt32}) AND block_height <= {upTo:UInt32}
          UNION ALL
          SELECT block_height, ingested_at FROM price_data.governance_vote_calls
          WHERE pallet = 'opengov' AND ingested_at >= toDateTime({since:UInt32}) AND block_height <= {upTo:UInt32}
        ) GROUP BY b`,
      query_params: { since, upTo: Math.max(...windows.map(w => w.to)) },
      format: 'JSONEachRow',
    })
    const rows = (await res.json<{ b: number | string; w: number | string }>()).map(r => ({ block: Number(r.b), ingestedMs: Number(r.w) * 1000 }))
    concludedTurnout.touched(rows, windows)
  }
  lateVotesFrom = now
  return now * 1000
}

async function turnout(): Promise<TurnoutRow[]> {
  const refs = await opengovReferenda()
  const all = [...refs.values()].sort((a, b) => a.index - b.index)
  const startedMs = await noteLateVotes(all)
  const todo = all.filter(r => !(r.concluded && concludedTurnout.get(r.index)))
  const fresh = new Map<number, TurnoutRow>()
  let next = 0
  const worker = async () => {
    while (next < todo.length) {
      const r = todo[next++]
      const d = await getReferendum('opengov', r.index, 1)
      if (!d) continue
      const t = d.directTally
      const row: TurnoutRow = {
        index: r.index, track: r.track, status: d.status,
        concludedAt: r.concluded?.ts ?? null, submittedAt: r.submitted?.ts ?? null,
        voters: t.voters, ayeVoters: t.ayeVoters, nayVoters: t.nayVoters, splitVoters: t.splitVoters,
        ayeCapital: t.rawAyes, nayCapital: t.rawNays, support: t.support,
      }
      if (!(r.concluded && concludedTurnout.remember(r.index, row, startedMs))) fresh.set(r.index, row)
    }
  }
  await Promise.all(Array.from({ length: STATS_CONCURRENCY }, worker))
  return all.flatMap(r => { const row = concludedTurnout.get(r.index) ?? fresh.get(r.index); return row ? [row] : [] })
}

async function activeVoters(): Promise<GovernanceStats['activeVoters']> {
  const res = await client.query({
    query: `-- governance:stats-active-voters
      SELECT formatDateTime(toStartOfMonth(block_timestamp), '%Y-%m') AS month, uniqExact(who) AS voters, count() AS votes
      FROM price_data.governance_vote_calls FINAL
      WHERE pallet = 'opengov' AND call_name = 'ConvictionVoting.vote' AND success = 1
      GROUP BY month ORDER BY month`,
    format: 'JSONEachRow',
  })
  return (await res.json<{ month: string; voters: string | number; votes: string | number }>()).map(r => ({ month: r.month, voters: Number(r.voters), votes: Number(r.votes) }))
}

async function lockedInVotes(): Promise<GovernanceStats['locked']> {
  // Each account's lock is a step function over its observations; a week's figure is
  // every account's newest observation at or before the week's end, summed.
  const res = await client.query({
    query: `-- governance:stats-locked
      WITH obs AS (
        SELECT account_id, block_timestamp AS t, toUInt256OrZero(conviction_lock) AS l
        FROM price_data.account_vote_locks_state FINAL
      ),
      weeks AS (
        SELECT arrayJoin(arrayMap(i -> toDate(toMonday(min_t)) + 7 * (i + 1), range(toUInt32(dateDiff('week', toMonday(min_t), today()) + 1)))) AS week_end
        FROM (SELECT min(t) AS min_t FROM obs)
      )
      SELECT toString(week_end - 7) AS week, toString(sum(last_l)) AS locked, countIf(last_l > 0) AS accounts
      FROM (
        SELECT w.week_end AS week_end, o.account_id AS account_id, argMax(o.l, o.t) AS last_l
        FROM weeks AS w CROSS JOIN obs AS o
        WHERE o.t < toDateTime(w.week_end)
        GROUP BY week_end, account_id
      )
      GROUP BY week_end ORDER BY week_end`,
    format: 'JSONEachRow',
    clickhouse_settings: { max_threads: 4 },
  })
  const weekly = (await res.json<{ week: string; locked: string; accounts: string | number }>()).map(r => ({ week: r.week, locked: r.locked, accounts: Number(r.accounts) }))
  const nowRes = await client.query({
    query: `SELECT toString(sum(l)) AS locked, countIf(l > 0) AS accounts FROM (
              SELECT account_id, argMax(toUInt256OrZero(conviction_lock), block_height) AS l
              FROM price_data.account_vote_locks_state FINAL GROUP BY account_id)`,
    format: 'JSONEachRow',
  })
  const now = (await nowRes.json<{ locked: string; accounts: string | number }>())[0]
  return { now: now?.locked ?? '0', accounts: Number(now?.accounts ?? 0), since: CONVICTION_STATE_FROM_BLOCK, weekly }
}

export async function getGovernanceStats(): Promise<GovernanceStats> {
  // Served stale while one rebuild replaces it: the first build reads every
  // referendum's tally once (a few seconds); later ones only the running referenda.
  return cachedSwr('governance:stats', 300_000, 3_600_000, async () => {
    const [t, voters, locked, tracks] = await Promise.all([
      cached('governance:stats:turnout', 60_000, turnout),
      activeVoters(),
      lockedInVotes(),
      getGovernanceTracks(),
    ])
    return {
      asOf: new Date().toISOString(),
      turnout: t,
      activeVoters: voters,
      locked,
      tracks: tracks.tracks.map(tr => ({ id: tr.id, name: tr.name, ...tr.outcomes, passRate: tr.passRate })),
    }
  })
}
