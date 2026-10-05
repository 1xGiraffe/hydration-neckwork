import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createDefaultDatabaseClickHouseClient, type ClickHouseClient } from './client.ts'
import { catchUpTransferDeltasWindow } from '../services/erc20WalletService.ts'

const DEFAULT_SCHEMA_DIRECTORY = fileURLToPath(new URL('../../../clickhouse/schema/', import.meta.url))

function containsSql(statement: string): boolean {
  return statement
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '')
    .trim().length > 0
}

// ClickHouse's HTTP interface accepts one statement per request. Split schema
// files without treating semicolons inside strings or comments as boundaries.
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let quote: "'" | '"' | '`' | null = null
  let lineComment = false
  let blockComment = false

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    const next = sql[i + 1]

    if (lineComment) {
      current += char
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      current += char
      if (char === '*' && next === '/') {
        current += next
        i++
        blockComment = false
      }
      continue
    }
    if (quote != null) {
      current += char
      if (char === '\\' && next != null) {
        current += next
        i++
      } else if (char === quote) {
        if (next === quote) {
          current += next
          i++
        } else {
          quote = null
        }
      }
      continue
    }

    if (char === '-' && next === '-') {
      current += char + next
      i++
      lineComment = true
    } else if (char === '/' && next === '*') {
      current += char + next
      i++
      blockComment = true
    } else if (char === "'" || char === '"' || char === '`') {
      current += char
      quote = char
    } else if (char === ';') {
      const statement = current.trim()
      if (containsSql(statement)) statements.push(statement)
      current = ''
    } else {
      current += char
    }
  }

  if (quote != null || blockComment) throw new Error('Unterminated SQL string or block comment')
  const statement = current.trim()
  if (containsSql(statement)) statements.push(statement)
  return statements
}

export function selectSchemaFiles(fileNames: string[]): string[] {
  return fileNames
    .map(fileName => ({ fileName, number: Number(fileName.match(/^(\d+)_.*\.sql$/)?.[1]) }))
    .filter(({ number }) => Number.isInteger(number))
    .sort((a, b) => a.number - b.number)
    .map(entry => entry.fileName)
}

/**
 * Materialized views whose definition changed in a way `CREATE … IF NOT EXISTS`
 * cannot carry to an existing deployment. Each names a marker its current
 * definition contains; a live view without it is dropped and recreated from the
 * schema file (the one idempotent upgrade step — a view already current is left
 * alone, so re-running the bootstrap changes nothing). Rows inserted between the
 * DROP and the CREATE reach neither view, so every entry carries its `catchUp`, which
 * swapView RUNS after every swap that leaves a definition live (clean, recovered or
 * restored) over the server-clock window from just before the DROP to just after the
 * CREATE (or restore). It must be bounded and idempotent — insert only the keys the
 * table lacks — because the bootstrap re-runs and windows overlap. `backfill` is the
 * operator's instruction for the states swapView cannot finish (UNKNOWN, ABSENT, a
 * failed catch-up): a re-run bootstrap finds the view current and swaps nothing, so it
 * never runs the catch-up again by itself.
 *
 *   erc20_transfer_deltas_mv — from a hand-kept contract list to the derived
 *   erc20_wallet_contracts set. Its catch-up is the ERC-20 wallet refresher's own
 *   insert-only-missing fill (erc20WalletService.catchUpTransferDeltasWindow: the
 *   active set's Transfer logs ingested in the window, by bucket, through this view's
 *   own SELECT). The refresher's whole-history check (syncTransferDeltas, on every api
 *   start and every 6 h) stays the net under it.
 */
export interface MvUpgrade {
  name: string
  marker: string
  backfill: string
  catchUp: (client: ClickHouseClient, window: { from: string; to: string }) => Promise<string>
}
export const MV_UPGRADES: ReadonlyArray<MvUpgrade> = [
  {
    name: 'price_data.erc20_transfer_deltas_mv',
    marker: 'erc20_wallet_contracts',
    backfill: 'erc20WalletService.catchUpTransferDeltasWindow over that window (or restart api: syncTransferDeltas compares the whole history on its first cycle)',
    catchUp: catchUpTransferDeltasWindow,
  },
]

/** The views to recreate: listed upgrades whose live definition (system.tables create_table_query) lacks the marker. */
export function mvUpgradePlan(live: ReadonlyMap<string, string>): string[] {
  return MV_UPGRADES.filter(u => live.has(u.name) && !live.get(u.name)!.includes(u.marker)).map(u => u.name)
}

/** The CREATE statement of a view in the schema's statements, by its qualified name. */
export function createStatementFor(statements: readonly string[], name: string): string | undefined {
  return statements.find(st => new RegExp(`^(--[^\\n]*\\n\\s*)*CREATE MATERIALIZED VIEW IF NOT EXISTS ${name.replace('.', '\\.')} `).test(st))
}

/**
 * One-time data upgrades for existing deployments: a NEW MV table whose history an
 * upgrading database lacks (an MV only sees inserts made after it exists, while a
 * fresh database fills it from the declaration as raw is indexed). Each is the MV's
 * own SELECT/WHERE replayed from raw, and is
 *
 *   - complete by COVERAGE, not by a boundary: the required range is raw's first
 *     record of the event up to raw's head, cut into 100k-block chunks, and a chunk
 *     is complete only when every raw (block_height, event_index) key of the event
 *     in it is present in the table (an anti-join per chunk). A boundary test (the
 *     table's lowest row reaching raw's first record) would call a backfill whose
 *     LATER chunk failed complete, because chunks insert oldest-first;
 *   - idempotent: only incomplete chunks are replayed, and the table's
 *     ReplacingMergeTree key makes a replayed chunk harmless; a re-run (every
 *     deploy) costs one bounded anti-join per chunk;
 *   - bounded (AGENTS.md, Schema and derivations): raw_events is ordered by
 *     (block_height, event_index), so each chunk is ONE PREWHERE on a 100k-block
 *     range AND the event name (never an explicit PREWHERE paired with a separate
 *     WHERE: on CH 26.3 that form silently returns a fraction of the rows), with the
 *     event_name skip index pruning the rest, at max_threads 4 and a 3 GB memory cap;
 *     ~25 chunks of a few milliseconds each cover the pallet's history.
 *
 *   gigahdx_reward_records — GigaHdxRewards.UserRewardRecorded, the per-voter GIGAHDX
 *   reward records (016_user_revenue.sql). `fromBlock` sits below the pallet's first
 *   event (block 12,959,351; its first UserRewardRecorded is 12,971,080), and the
 *   search for raw's first record starts there.
 */
export interface DataUpgrade {
  table: string
  eventName: string
  fromBlock: number
  /** The MV's SELECT list over raw_events, verbatim. */
  select: string
}
export const DATA_UPGRADES: ReadonlyArray<DataUpgrade> = [
  {
    table: 'price_data.gigahdx_reward_records',
    eventName: 'GigaHdxRewards.UserRewardRecorded',
    fromBlock: 12_900_000,
    select: "JSONExtractUInt(args_json, 'refIndex') AS ref_index, lower(JSONExtractString(args_json, 'who')) AS who, JSONExtractString(args_json, 'rewardAmount') AS reward, block_height, event_index, block_timestamp, ingested_at",
  },
]
export const DATA_UPGRADE_CHUNK_BLOCKS = 100_000
const DATA_UPGRADE_SETTINGS = { max_threads: 4, max_memory_usage: '3000000000', max_execution_time: 600 } as const

/** The chunks covering raw's first record through its head ([from, to) each), or none when raw holds no record. */
export function dataUpgradeChunks(rawFirst: number | null, rawHead: number): Array<{ from: number; to: number }> {
  if (rawFirst == null) return []
  const out: Array<{ from: number; to: number }> = []
  for (let lo = rawFirst; lo <= rawHead; lo += DATA_UPGRADE_CHUNK_BLOCKS) out.push({ from: lo, to: Math.min(lo + DATA_UPGRADE_CHUNK_BLOCKS, rawHead + 1) })
  return out
}

/** Merges adjacent incomplete chunks into ranges, for reporting. */
export function mergeRanges(ranges: ReadonlyArray<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = []
  for (const r of [...ranges].sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1]
    if (last && last.to >= r.from) last.to = Math.max(last.to, r.to)
    else out.push({ ...r })
  }
  return out
}

async function scalar(client: ClickHouseClient, query: string, params: Record<string, unknown> = {}): Promise<number | null> {
  const res = await client.query({ query, query_params: params, format: 'JSONEachRow', clickhouse_settings: DATA_UPGRADE_SETTINGS })
  const v = (await res.json<{ v: string | number | null }>())[0]?.v
  return v == null ? null : Number(v)
}

/** raw's first record of the event at or above `from`, searched chunk by chunk (bounded). */
async function rawFirstRecord(client: ClickHouseClient, u: DataUpgrade, head: number): Promise<number | null> {
  for (let lo = u.fromBlock; lo <= head; lo += DATA_UPGRADE_CHUNK_BLOCKS) {
    const first = await scalar(client,
      `SELECT if(count() = 0, NULL, min(block_height)) AS v FROM price_data.raw_events
       PREWHERE block_height >= {lo:UInt32} AND block_height < {hi:UInt32} AND event_name = {ev:String}`,
      { lo, hi: lo + DATA_UPGRADE_CHUNK_BLOCKS, ev: u.eventName })
    if (first != null) return first
  }
  return null
}

/** How many of raw's event keys in [from, to) the table lacks (0 = the chunk is complete). */
async function chunkMissingKeys(client: ClickHouseClient, u: DataUpgrade, from: number, to: number): Promise<number> {
  return (await scalar(client,
    `SELECT count() AS v FROM (
       SELECT DISTINCT block_height, event_index FROM price_data.raw_events
       PREWHERE block_height >= {lo:UInt32} AND block_height < {hi:UInt32} AND event_name = {ev:String}
     ) WHERE (block_height, event_index) NOT IN (
       SELECT block_height, event_index FROM ${u.table} WHERE block_height >= {lo:UInt32} AND block_height < {hi:UInt32}
     )`,
    { lo: from, hi: to, ev: u.eventName })) ?? 0
}

/** Each data upgrade's incomplete chunks (empty `incomplete` = complete) and `missing`, the same merged into ranges. */
export async function dataUpgradeState(client: ClickHouseClient): Promise<Array<{ table: string; incomplete: Array<{ from: number; to: number }>; missing: Array<{ from: number; to: number }> }>> {
  const head = (await scalar(client, 'SELECT max(block_height) AS v FROM price_data.raw_events')) ?? 0
  const out: Array<{ table: string; incomplete: Array<{ from: number; to: number }>; missing: Array<{ from: number; to: number }> }> = []
  for (const u of DATA_UPGRADES) {
    const incomplete: Array<{ from: number; to: number }> = []
    for (const chunk of dataUpgradeChunks(await rawFirstRecord(client, u, head), head)) {
      if (await chunkMissingKeys(client, u, chunk.from, chunk.to) > 0) incomplete.push(chunk)
    }
    out.push({ table: u.table, incomplete, missing: mergeRanges(incomplete) })
  }
  return out
}

/** Replays every incomplete chunk (and only those) from raw; a failed chunk throws, and the next run replays what is still incomplete. */
export async function applyDataUpgrades(client: ClickHouseClient): Promise<number> {
  let statements = 0
  for (const { table, incomplete, missing } of await dataUpgradeState(client)) {
    if (!incomplete.length) continue
    const u = DATA_UPGRADES.find(x => x.table === table)!
    console.log(`[schema-bootstrap] backfilling ${table} from raw: ${incomplete.length} incomplete chunk(s), blocks ${missing.map(r => `${r.from}..${r.to - 1}`).join(', ')}`)
    for (const { from, to } of incomplete) {
      await client.command({
        query: `INSERT INTO ${table} SELECT ${u.select} FROM price_data.raw_events
                PREWHERE block_height >= {lo:UInt32} AND block_height < {hi:UInt32} AND raw_events.event_name = {ev:String}`,
        query_params: { lo: from, hi: to, ev: u.eventName },
        clickhouse_settings: DATA_UPGRADE_SETTINGS,
      })
      statements++
    }
  }
  return statements
}

/** A view's live definition (system.tables create_table_query), or null when it is absent. */
async function liveDefinition(client: ClickHouseClient, name: string): Promise<string | null> {
  const res = await client.query({
    query: `SELECT create_table_query AS q FROM system.tables WHERE concat(database, '.', name) = {qname:String}`,
    query_params: { qname: name }, format: 'JSONEachRow',
  })
  return (await res.json<{ q: string }>())[0]?.q ?? null
}

/** The server's clock, so a reported gap is in the timestamps `ingested_at` carries. */
async function serverNow(client: ClickHouseClient): Promise<string> {
  const res = await client.query({ query: 'SELECT toString(now()) AS t', format: 'JSONEachRow' })
  return (await res.json<{ t: string }>())[0]?.t ?? 'unknown'
}

/**
 * How the swap's recovery reads the server back. Every readback is retried with
 * exponential backoff (`delayMs`, doubling, `attempts` tries): the recovery runs exactly
 * when the connection has just failed, and a readback that gave up on the first
 * transient error would leave a dropped view absent without even trying the restore.
 * `settleAttempts` bounds the wait for a statement whose client errored to leave
 * system.processes — an ambiguous DROP may still be EXECUTING when the error reaches
 * the client, and the view read back before it finishes is the view it is about to drop.
 */
export interface SwapViewOptions {
  attempts?: number
  delayMs?: number
  settleAttempts?: number
  sleep?: (ms: number) => Promise<void>
}
const SWAP_VIEW_DEFAULTS = { attempts: 6, delayMs: 500, settleAttempts: 20 } as const

async function withRetries<T>(what: string, attempts: number, delayMs: number, sleep: (ms: number) => Promise<void>, fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      last = error
      if (attempt < attempts) await sleep(delayMs * 2 ** (attempt - 1))
    }
  }
  throw new Error(`${what} failed after ${attempts} attempts: ${last instanceof Error ? last.message : String(last)}`)
}

/**
 * Whether the statements have left system.processes (true), or were still running
 * (or could not be checked) after `settleAttempts` polls `delayMs` apart (false).
 */
async function statementsSettled(client: ClickHouseClient, queryIds: string[], settleAttempts: number, delayMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let attempt = 1; attempt <= settleAttempts; attempt++) {
    try {
      const res = await client.query({
        query: 'SELECT toString(count()) AS n FROM system.processes WHERE query_id IN {ids:Array(String)}',
        query_params: { ids: queryIds }, format: 'JSONEachRow',
      })
      if (Number((await res.json<{ n: string }>())[0]?.n ?? 0) === 0) return true
    } catch { /* a failed check is not a settled statement: poll again */ }
    if (attempt < settleAttempts) await sleep(delayMs)
  }
  return false
}

/**
 * Runs an upgrade's catch-up over a swap window (retried as a whole: it is
 * idempotent) and logs it. Returns the catch-up's summary, or the error it ended on.
 */
async function runCatchUp(client: ClickHouseClient, name: string, upgrade: SwapViewUpgrade, window: { from: string; to: string }, attempts: number, delayMs: number, sleep: (ms: number) => Promise<void>): Promise<{ summary: string } | { error: string }> {
  console.log(`[schema-bootstrap] ${name}: running its catch-up for rows inserted ${window.from}..${window.to} (server clock)`)
  try {
    const summary = await withRetries(`${name}'s catch-up`, attempts, delayMs, sleep, () => upgrade.catchUp(client, window))
    console.log(`[schema-bootstrap] ${name}: catch-up done: ${summary}`)
    return { summary }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[schema-bootstrap] ${name}: catch-up failed: ${message}`)
    return { error: message }
  }
}

/** What swapView needs of an MV_UPGRADES entry. */
export type SwapViewUpgrade = Pick<MvUpgrade, 'marker' | 'backfill' | 'catchUp'>

/**
 * Replaces a live view with its schema definition, never leaving the database
 * without one and never trusting a client error about what the server did. The old
 * definition (system.tables create_table_query, the same text SHOW CREATE returns)
 * is captured by the caller before the drop. The DROP and the CREATE both sit
 * inside the recovery path, each under its own query_id. Whatever the client
 * reported, the swap then waits for both query_ids to leave system.processes and
 * reads the outcome back from system.tables — a statement can execute on the server
 * while the client times out, and one still listed can still change the view, so no
 * outcome (success included) is claimed for statements that have not settled; every
 * readback is retried with backoff (SwapViewOptions):
 *
 *   - the new definition is live (its marker present) and both statements have
 *     settled: the swap took (despite the error, if there was one), and the
 *     upgrade's catch-up is RUN over the window from just before the DROP to now —
 *     rows inserted between the DROP and the CREATE reached no view. A failed
 *     catch-up fails the upgrade, naming the window and the `backfill`;
 *   - the new definition is live but either statement is still in system.processes
 *     after the wait: the state is UNKNOWN — no success, no catch-up — and the error
 *     names the unsettled query_ids;
 *   - the old definition is still live and both statements have settled (the DROP
 *     never ran): nothing was missed, and the upgrade fails with the view untouched;
 *     if they had NOT settled, it fails saying so, without claiming nothing was missed;
 *   - the view is absent but either statement is still in system.processes after the
 *     wait: the state is UNKNOWN — a pending DROP could drop a restored view again, a
 *     pending CREATE could land beside it — so nothing is restored and the error names
 *     the unsettled query_ids for the operator to wait out and re-run;
 *   - the view is absent and both statements have settled: the old one is recreated
 *     from the captured text — the restore's own client error is reconciled the same
 *     way, by reading back — the catch-up is run over the window from just before the
 *     drop to just after the restore (the only rows that missed both views), and the
 *     upgrade fails NAMING THAT GAP and whether the catch-up filled it. Each restore
 *     runs under its own query_id and, when its client errored, is waited out of
 *     system.processes before it is read back. If even the restore fails, the error
 *     says the view is ABSENT — but only once the restore has settled and the state
 *     read back; a restore still running after the wait, or a state that cannot be
 *     read, is reported as UNKNOWN. The live definition is read back once more before
 *     returning, and the error states what is actually live.
 *   - the state cannot be read back at all: the error says the view may be ABSENT.
 *
 * After a clean CREATE the live definition is checked for the marker too: `CREATE …
 * IF NOT EXISTS` is a silent no-op when a DROP reported success but did not run.
 */
export async function swapView(client: ClickHouseClient, name: string, oldCreate: string, newCreate: string, upgrade: SwapViewUpgrade, options: SwapViewOptions = {}): Promise<number> {
  const { marker, backfill } = upgrade
  const attempts = options.attempts ?? SWAP_VIEW_DEFAULTS.attempts
  const delayMs = options.delayMs ?? SWAP_VIEW_DEFAULTS.delayMs
  const settleAttempts = options.settleAttempts ?? SWAP_VIEW_DEFAULTS.settleAttempts
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const readBack = (what: string) => withRetries(`reading ${name}'s live definition back (${what})`, attempts, delayMs, sleep, () => liveDefinition(client, name))
  const readClock = () => withRetries('reading the server clock', attempts, delayMs, sleep, () => serverNow(client))
  const from = await serverNow(client)
  const dropId = randomUUID()
  const createId = randomUUID()
  let cause: unknown
  try {
    await client.command({ query: `DROP VIEW IF EXISTS ${name}`, query_id: dropId })
    await client.command({ query: newCreate, query_id: createId })
  } catch (error) {
    cause = error
  }
  const why = cause == null ? 'the CREATE reported success' : cause instanceof Error ? cause.message : String(cause)
  const how = cause == null ? 'reported success' : `failed (${why})`
  // Settlement gates every outcome, success included: a client that returned does
  // not prove its statement left system.processes, and one still listed can still
  // change what reads back.
  const settled = await statementsSettled(client, [dropId, createId], settleAttempts, delayMs, sleep)
  const unsettledIds = `query_id ${dropId} [DROP], ${createId} [CREATE]`
  let live: string | null
  try {
    live = await readBack('after the swap')
  } catch (readError) {
    const rwhy = readError instanceof Error ? readError.message : String(readError)
    throw new Error(`[schema-bootstrap] ${name}: the swap ${how} and its outcome could not be read back (${rwhy}) — the view may be ABSENT; check system.tables, recreate it from the schema if so, then run its backfill for rows since ${from}: ${backfill}`)
  }
  if (live != null && live.includes(marker)) {
    if (!settled) {
      throw new Error(`[schema-bootstrap] ${name}: the swap ${how} and the NEW definition reads back live, but the view's state is UNKNOWN: the swap's statements (${unsettledIds}) were still in system.processes after the wait, so either may still change it — no success is claimed and NO catch-up was run; wait until those query_ids leave system.processes, check system.tables (recreate the view from the schema if it is absent), then run its backfill for rows since ${from}: ${backfill}`)
    }
    if (cause != null) console.warn(`[schema-bootstrap] ${name}: the swap reported an error (${why}) but the new definition is live and its statements have settled`)
    let to: string
    try {
      to = await readClock()
    } catch (clockError) {
      throw new Error(`[schema-bootstrap] ${name}: the NEW definition is live, but the end of its swap window could not be read (${clockError instanceof Error ? clockError.message : String(clockError)}), so its catch-up was NOT run; run its backfill for rows since ${from}: ${backfill}`)
    }
    const caught = await runCatchUp(client, name, upgrade, { from, to }, attempts, delayMs, sleep)
    if ('error' in caught) {
      throw new Error(`[schema-bootstrap] ${name}: the NEW definition is live, but its catch-up for rows inserted between ${from} and ${to} (server clock) failed (${caught.error}); those rows reached no view — run its backfill for that window: ${backfill}`)
    }
    return 2
  }
  if (live != null) {
    if (!settled) {
      throw new Error(`[schema-bootstrap] ${name}: the swap ${how} and its statements (${unsettledIds}) were still in system.processes after the wait — the OLD definition read back live but the DROP may still be executing; check system.tables, and if the view is gone recreate it and run its backfill for rows since ${from}: ${backfill}`)
    }
    throw new Error(`[schema-bootstrap] ${name}: the swap ${how} and the OLD definition is still live — the drop never ran, so no rows were missed; nothing to backfill`)
  }
  // Absent — but only a SETTLED absence may be restored. A DROP or CREATE still in
  // system.processes after the wait can land at any moment: the pending CREATE would
  // collide with (or be shadowed by) the restore, and a pending DROP that completes
  // after the restore drops the view again, leaving it ABSENT behind a "restored"
  // report. So no restore is issued and no outcome is claimed: the state is UNKNOWN
  // until the named statements leave system.processes, and the operator re-runs then.
  if (!settled) {
    throw new Error(`[schema-bootstrap] ${name}: the swap ${how} and the view's state is UNKNOWN: it read back absent, but the swap's statements (${unsettledIds}) were still in system.processes after the wait, so either may still land — NO restore was issued; wait until those query_ids leave system.processes, check system.tables, then re-run the bootstrap (or recreate the view by hand if it is absent) and run its backfill for rows since ${from}: ${backfill}`)
  }
  // Absent: restore the captured definition. The restore's client error is no more
  // trustworthy than the swap's, so each attempt runs under its own query_id and, when its
  // client errored, is waited out of system.processes before its outcome is read back —
  // a CREATE still executing reads back as an absent view it is about to restore. The
  // restore is retried only while the view is absent AND the previous attempt has
  // settled; one that never settles, or a state that cannot be read back, is reported as
  // UNKNOWN, never as ABSENT.
  let restoreError: unknown
  let restored: string | null = null
  let unsettledRestore: string | null = null
  let unread = false
  for (let attempt = 1; attempt <= attempts && restored == null; attempt++) {
    const restoreId = randomUUID()
    let restoreFailed = false
    try {
      await client.command({ query: oldCreate, query_id: restoreId })
      restoreError = undefined
    } catch (error) {
      restoreError = error
      restoreFailed = true
    }
    const restoreSettled = !restoreFailed || await statementsSettled(client, [restoreId], settleAttempts, delayMs, sleep)
    unread = false
    try {
      restored = await readBack('after the restore')
    } catch (readError) {
      restoreError = restoreError ?? readError
      unread = true
    }
    if (restored == null && !restoreSettled) { unsettledRestore = restoreId; break }
    if (restored == null && attempt < attempts) await sleep(delayMs * 2 ** (attempt - 1))
  }
  if (restored == null) {
    const rwhy = restoreError instanceof Error ? restoreError.message : restoreError == null ? 'the CREATE reported success but no view reads back' : String(restoreError)
    if (unsettledRestore != null) {
      throw new Error(`[schema-bootstrap] ${name}: the swap failed (${why}) and the view's state is UNKNOWN (restore may still be running): the restore (query_id ${unsettledRestore}) errored at the client (${rwhy}) and was still in system.processes after the wait; check system.tables — if the view is absent, recreate it by hand — then run its backfill for rows since ${from}: ${backfill}`)
    }
    if (unread) {
      throw new Error(`[schema-bootstrap] ${name}: the swap failed (${why}) and after the restore (${rwhy}) the view's state is UNKNOWN (it could not be read back); check system.tables — if the view is absent, recreate it by hand — then run its backfill for rows since ${from}: ${backfill}`)
    }
    throw new Error(`[schema-bootstrap] ${name}: the swap failed (${why}) AND restoring the old definition failed (${rwhy}) — the view is ABSENT and every row inserted since ${from} is missing from its table; recreate it by hand, then run its backfill: ${backfill}`)
  }
  // The final state, as read back: the captured definition, or — had something else
  // recreated it meanwhile — whatever is live now, named rather than assumed.
  const state = restored.includes(marker)
    ? 'the NEW definition is live after the restore (recreated concurrently)'
    : restored === oldCreate ? 'the old definition was restored' : `the old definition was restored (live definition differs from the captured text: ${restored.slice(0, 200)})`
  // A view is live again, so the gap is closed at its far end: the catch-up fills it
  // (the refresher fills the same rows by the same insert whichever definition is live).
  let to: string | null = null
  try { to = await readClock() } catch { /* named below */ }
  if (to == null) {
    throw new Error(`[schema-bootstrap] ${name}: the swap failed (${why}); ${state} — rows inserted from ${from} until the restore missed both views; the end of that window could not be read, so its catch-up was NOT run — run its backfill: ${backfill}`)
  }
  const caught = await runCatchUp(client, name, upgrade, { from, to }, attempts, delayMs, sleep)
  const gap = 'error' in caught
    ? `its catch-up FAILED (${caught.error}), so they need its backfill: ${backfill}`
    : `its catch-up filled them (${caught.summary})`
  throw new Error(`[schema-bootstrap] ${name}: the swap failed (${why}); ${state} — rows inserted between ${from} and ${to} (server clock) missed both views; ${gap}`)
}

/** Every object the schema files declare, by qualified name. */
export function declaredObjects(statements: readonly string[]): string[] {
  const out: string[] = []
  for (const st of statements) {
    const m = /^(?:--[^\n]*\n\s*)*CREATE (?:TABLE|MATERIALIZED VIEW|VIEW) IF NOT EXISTS ([A-Za-z0-9_]+\.[A-Za-z0-9_]+)[\s(]/.exec(st)
    if (m) out.push(m[1])
  }
  return out
}

// The statement without its `--` comments (outside quoted text), so an apostrophe in a
// comment is not read as a quote.
function stripLineComments(sql: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (quote) {
      out += c
      if (c === '\\' && i + 1 < sql.length) out += sql[++i]
      else if (c === quote) quote = null
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    out += c
  }
  return out
}

// The index of the parenthesis closing the one at `open`, skipping quoted text.
function closingParen(sql: string, open: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < sql.length; i++) {
    const c = sql[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

// Splits on the commas at parenthesis depth 0, outside quotes.
function topLevelItems(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) { out.push(body.slice(start, i)); start = i + 1 }
  }
  out.push(body.slice(start))
  return out.map(item => item.trim()).filter(Boolean)
}

// `name Type …modifiers` → [name, Type], the type read to the end of its balanced
// parentheses (`Nullable(String)`, `Array(Tuple(a UInt8, b String))`).
function columnDefinition(item: string): [string, string] | null {
  const m = /^(?:`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s+/.exec(item)
  if (!m) return null
  const name = m[1] ?? m[2]
  if (!m[1] && /^(INDEX|PROJECTION|CONSTRAINT|PRIMARY)$/i.test(name)) return null
  const rest = item.slice(m[0].length)
  const head = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
  if (!head) return null
  let end = head[0].length
  if (rest[end] === '(') end = closingParen(rest, end) + 1
  return [name, rest.slice(0, end)]
}

/** A column type compared as text with all whitespace removed, as system.columns spells it either way. */
export function normalizeColumnType(type: string): string {
  return type.replace(/\s+/g, '')
}

/**
 * Every column the schema files declare per table, with its type: the CREATE TABLE
 * column lists plus every `ALTER TABLE … ADD COLUMN`. Views are not included — a view's
 * columns are its SELECT's, not a declaration a migration could miss.
 */
export function declaredColumns(statements: readonly string[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  const columnsOf = (table: string) => out.get(table) ?? out.set(table, new Map()).get(table)!
  for (const raw of statements) {
    const st = stripLineComments(raw).trim()
    const create = /^CREATE TABLE IF NOT EXISTS ([A-Za-z0-9_]+\.[A-Za-z0-9_]+)\s*\(/.exec(st)
    if (create) {
      const open = create[0].length - 1
      const close = closingParen(st, open)
      if (close < 0) continue
      const columns = columnsOf(create[1])
      for (const item of topLevelItems(st.slice(open + 1, close))) {
        const def = columnDefinition(item)
        if (def) columns.set(def[0], def[1])
      }
      continue
    }
    const alter = /^ALTER TABLE ([A-Za-z0-9_]+\.[A-Za-z0-9_]+)\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([\s\S]*)$/.exec(st)
    if (alter) {
      const def = columnDefinition(alter[2].trim())
      if (def) columnsOf(alter[1]).set(def[0], def[1])
    }
  }
  return out
}

/** Declared columns the live table lacks or holds under another type (empty = in agreement). */
export function columnProblems(declared: ReadonlyMap<string, ReadonlyMap<string, string>>, live: ReadonlyMap<string, ReadonlyMap<string, string>>): string[] {
  const problems: string[] = []
  for (const [table, columns] of declared) {
    const liveColumns = live.get(table)
    if (!liveColumns) continue // the table itself is reported missing
    for (const [column, type] of columns) {
      const liveType = liveColumns.get(column)
      if (liveType == null) problems.push(`missing column: ${table}.${column} ${type}`)
      else if (normalizeColumnType(liveType) !== normalizeColumnType(type)) problems.push(`column type differs: ${table}.${column} is ${liveType}, declared ${type}`)
    }
  }
  return problems
}

/**
 * Checks a database against the schema files without changing it: every declared
 * table and view exists, every declared table column exists with its declared type
 * (system.columns — a missed ADD COLUMN fails here), every MV_UPGRADES view carries its
 * marker, and no data upgrade has a missing range. Returns the problems (empty = valid).
 */
export async function validateSchema(client: ClickHouseClient, schemaDir = DEFAULT_SCHEMA_DIRECTORY): Promise<string[]> {
  const statements: string[] = []
  for (const fileName of selectSchemaFiles(await readdir(schemaDir))) {
    statements.push(...splitSqlStatements(await readFile(join(schemaDir, fileName), 'utf8')))
  }
  const declared = declaredObjects(statements)
  const res = await client.query({
    query: `SELECT concat(database, '.', name) AS qname, create_table_query AS q FROM system.tables WHERE concat(database, '.', name) IN {names:Array(String)}`,
    query_params: { names: declared }, format: 'JSONEachRow',
  })
  const live = new Map((await res.json<{ qname: string; q: string }>()).map(r => [r.qname, r.q]))
  const problems = declared.filter(name => !live.has(name)).map(name => `missing: ${name}`)
  const columns = declaredColumns(statements)
  const colRes = await client.query({
    query: `SELECT concat(database, '.', table) AS qname, name AS column, type FROM system.columns WHERE concat(database, '.', table) IN {names:Array(String)}`,
    query_params: { names: [...columns.keys()] }, format: 'JSONEachRow',
  })
  const liveColumns = new Map<string, Map<string, string>>()
  for (const r of await colRes.json<{ qname: string; column: string; type: string }>()) {
    (liveColumns.get(r.qname) ?? liveColumns.set(r.qname, new Map()).get(r.qname)!).set(r.column, r.type)
  }
  problems.push(...columnProblems(columns, liveColumns))
  for (const name of mvUpgradePlan(live)) problems.push(`stale definition (MV_UPGRADES marker absent): ${name}`)
  for (const { table, missing } of await dataUpgradeState(client)) {
    if (missing.length) problems.push(`data upgrade incomplete: ${table} lacks raw rows in blocks ${missing.map(r => `${r.from}..${r.to - 1}`).join(', ')}`)
  }
  return problems
}

interface ApplySchemaOptions {
  schemaDir?: string
  onFile?: (fileName: string) => void
}

export async function applySchema(
  client: ClickHouseClient,
  options: ApplySchemaOptions = {},
): Promise<{ files: string[]; statements: number }> {
  const { schemaDir = DEFAULT_SCHEMA_DIRECTORY, onFile } = options
  const files = selectSchemaFiles(await readdir(schemaDir))
  let statements = 0
  const all: string[] = []
  for (const fileName of files) {
    onFile?.(fileName)
    const sql = await readFile(join(schemaDir, fileName), 'utf8')
    for (const query of splitSqlStatements(sql)) {
      await client.command({ query })
      all.push(query)
      statements++
    }
  }
  // Upgrades of existing deployments (MV_UPGRADES): after every file, so a view
  // recreated here reads tables the files just created. The qualified name is
  // aliased `qname`, never `name`: ClickHouse substitutes a SELECT alias into WHERE,
  // so `AS name` would turn the filter into concat(database, '.', concat(…)) and
  // match nothing — silently planning no upgrade at all.
  const res = await client.query({
    query: `SELECT concat(database, '.', name) AS qname, create_table_query AS q FROM system.tables WHERE concat(database, '.', name) IN {names:Array(String)}`,
    query_params: { names: MV_UPGRADES.map(u => u.name) },
    format: 'JSONEachRow',
  })
  const live = new Map((await res.json<{ qname: string; q: string }>()).map(r => [r.qname, r.q]))
  for (const name of mvUpgradePlan(live)) {
    const create = createStatementFor(all, name)
    if (!create) throw new Error(`[schema-bootstrap] no CREATE statement for ${name} in the schema files`)
    const upgrade = MV_UPGRADES.find(u => u.name === name)!
    console.log(`[schema-bootstrap] upgrading ${name}: live definition predates the schema (its catch-up runs over the swap window)`)
    statements += await swapView(client, name, live.get(name)!, create, upgrade)
  }
  // Data upgrades (DATA_UPGRADES): after the views exist, so the MV is already
  // catching new rows while the missing tail is replayed below it.
  statements += await applyDataUpgrades(client)
  return { files, statements }
}

// Resolves the schema directory for the CLI entrypoint: `SCHEMA_DIR` env var
// first (the compose service sets this to the read-only `/schema` mount),
// then a `--schema-dir=<path>` CLI arg, then `applySchema`'s own built-in
// relative default (undefined here defers to that default).
export function resolveSchemaDirArg(): string | undefined {
  const envDir = process.env.SCHEMA_DIR?.trim()
  if (envDir) return envDir
  const argPrefix = '--schema-dir='
  const argDir = process.argv.find(arg => arg.startsWith(argPrefix))?.slice(argPrefix.length).trim()
  return argDir || undefined
}

// One-shot CLI entrypoint for the `schema-bootstrap` compose service: applies
// every schema file to a fresh ClickHouse server (before `price_data` exists)
// and exits 0, or exits nonzero so `depends_on: service_completed_successfully`
// blocks `api`/`indexer`/`raw-live`/`ingestion-supervisor`/`derivations` on failure.
// `--apply` applies, then validates; `--validate` only validates (read-only). Either
// exits nonzero on a problem, which is what ops/deploy-api.sh gates its rollout on.
async function main(): Promise<void> {
  const client = createDefaultDatabaseClickHouseClient()
  try {
    if (process.argv.includes('--apply')) {
      const result = await applySchema(client, {
        schemaDir: resolveSchemaDirArg(),
        onFile: fileName => console.log('[schema-bootstrap] ' + fileName),
      })
      console.log(`[schema-bootstrap] applied ${result.files.length} file(s), ${result.statements} statement(s)`)
    }
    const problems = await validateSchema(client, resolveSchemaDirArg())
    for (const p of problems) console.error(`[schema-bootstrap] INVALID ${p}`)
    if (problems.length) throw new Error(`${problems.length} schema problem(s)`)
    console.log('[schema-bootstrap] valid: every declared object exists, MV upgrades current, data upgrades complete')
  } finally {
    await client.close().catch(() => {})
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule && (process.argv.includes('--apply') || process.argv.includes('--validate'))) {
  main()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('[schema-bootstrap] failed', error)
      process.exit(1)
    })
}
