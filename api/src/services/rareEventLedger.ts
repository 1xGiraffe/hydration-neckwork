import type { ClickHouseClient } from '../db/client.ts'

// An in-process ledger of one rare `raw_events` family, extended by block.
//
// Several surfaces need EVERY row of an event family that holds a few thousand
// rows across the whole chain: collective votes, asset-registry limit changes,
// whitelisted calls. raw_events is keyed (block_height, event_index), so a read
// that names only the family cannot prune by key, and the event-name skip index
// still leaves millions of rows of args_json to read when the family is spread
// thinly over history — measured 2026-08-30: 6.3M rows / 700 MiB per read for
// the 1,644 AssetRegistry rows, 3.9M / 190 MiB for 199 Whitelist rows, 3–5M for
// ~3k collective votes. The security dashboard ran the first two on every 20 s
// rebuild and the votes are read on every account page: ~90B rows and 5 TiB a
// day for rows that do not change.
//
// The ledger reads the family once, keeps it, and afterwards asks only about the
// blocks above a settled floor — a range on the table's first key column, so the
// tail read costs a few thousand rows however busy the chain. The floor trails
// the ingested head by a reorg margin, so every block that can still change is
// re-read on every call; a row below the floor can only change under a backward
// backfill, which no timer-driven memo in this codebase observes either (the same
// contract as securityService's trip cache). A replayed raw range can hand the
// tail read a second copy of a row: rows are keyed by (block_height, event_index),
// so the newer copy replaces the older one.
//
// Families must stay small: the result travels whole through the client's
// 100k-row guard, and it is held in memory.

export interface RareEventRow { block_height: number; event_index: number }

export interface RareEventLedgerOptions {
  eventNames: readonly string[]
  // The SELECT list read from price_data.raw_events. It must yield `block_height`
  // and `event_index`, which identify a row.
  columnsSql: string
  // The ingested head the settled floor trails.
  head: () => Promise<number>
  client: () => ClickHouseClient
  reorgMarginBlocks?: number
}

export const RARE_EVENT_REORG_MARGIN_BLOCKS = 600

export interface RareEventWindow<T extends RareEventRow> { upTo: number; rows: Map<string, T> }

export function rareEventKey(row: RareEventRow): string {
  return `${row.block_height}:${row.event_index}`
}

// One incremental step: the whole family as it now stands, and the part of it
// that may be kept for the next step.
//
// The floor never moves backwards. A head that reads lower than the last one — a
// restarted ingester, a lagging replica — would otherwise drop rows out of the
// settled set while the next read only asks about blocks above the OLD floor, and
// the window between the two would be in neither.
export function mergeRareEventWindow<T extends RareEventRow>(
  settled: RareEventWindow<T> | null,
  fresh: readonly T[],
  headBlock: number,
  margin = RARE_EVENT_REORG_MARGIN_BLOCKS,
): { next: RareEventWindow<T>; all: T[] } {
  const merged = new Map(settled?.rows ?? [])
  for (const row of fresh) merged.set(rareEventKey(row), row)
  const floor = Math.max(settled?.upTo ?? -1, headBlock - margin)
  const rows = new Map<string, T>()
  for (const [key, row] of merged) if (row.block_height <= floor) rows.set(key, row)
  const all = [...merged.values()].sort((a, b) => a.block_height - b.block_height || a.event_index - b.event_index)
  return { next: { upTo: floor, rows }, all }
}

export class RareEventLedger<T extends RareEventRow> {
  private settled: RareEventWindow<T> | null = null
  private inflight: Promise<T[]> | null = null

  constructor(private readonly opts: RareEventLedgerOptions) {}

  // Every row of the family, oldest first. Concurrent callers share one read.
  rows(): Promise<T[]> {
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => { this.inflight = null })
    }
    return this.inflight
  }

  private async refresh(): Promise<T[]> {
    const from = this.settled?.upTo ?? -1
    // Both reads start inside Promise.all: a client that throws synchronously
    // (no database wired up) must reject THIS promise, not leave the head read
    // dangling as an unhandled rejection.
    const [headBlock, fresh] = await Promise.all([this.opts.head(), this.readTail(from)])
    const merged = mergeRareEventWindow(this.settled, fresh, headBlock, this.opts.reorgMarginBlocks)
    this.settled = merged.next
    return merged.all
  }

  private async readTail(from: number): Promise<T[]> {
    const res = await this.opts.client().query({
      query: `SELECT ${this.opts.columnsSql}
              FROM price_data.raw_events
              WHERE block_height > {from:Int64} AND event_name IN {names:Array(String)}
              ORDER BY block_height, event_index`,
      query_params: { from, names: [...this.opts.eventNames] },
      format: 'JSONEachRow',
    })
    return res.json<T>()
  }
}
