import type { ClickHouseClient } from '../db/client.ts'

// Republish decision shared by the three account-value snapshot generations
// (per-account locks, money-market account values, Omnipool claims).
//
// Each of them publishes the same way: insert an immutable generation under a
// fresh `snapshot_id` partition, verify it round-trips, flip the `…_state`
// pointer, drop the superseded partition. Running that unconditionally on every
// cycle rewrites byte-identical data whenever nothing changed on chain, and —
// worse than the write cost — it advances the pointer's `computed_at`, which is
// what the persisted account-directory and tag snapshots compare themselves
// against. A no-op republish therefore discards read models that were still
// exactly right.
//
// So: hash the generation about to be written and compare it to the checksum
// the pointer already carries. Equal means the pointed-at generation is the one
// we would have written, and the whole cycle can be skipped.
//
// Two things make that safe:
//  - The checksum must cover every column a reader can observe. Each caller
//    hashes exactly the fields it inserts, in a deterministic row order, so
//    "equal checksum" means "identical published rows". A checksum over the
//    SOURCES of a generation would not do: it can miss state that changes the
//    published values (see the Omnipool claim builder, whose output depends on
//    pool state that no position row carries).
//  - The partition the pointer names must still exist with the row count the
//    pointer claims. That is read from part metadata, so it costs nothing, and
//    it turns "the partition vanished underneath us" into a republish instead
//    of a silently empty read model.
//
// The age floor is the backstop for the one failure neither check can see: a
// checksum that stopped covering a field someone added to the insert. It bounds
// how long such a bug could serve stale data, and it re-establishes the
// generation from scratch periodically without any marker state.

// Ten minutes. It is the freshness the account directory already declares for
// its own persisted snapshots (ACCOUNT_DIRECTORY_SNAPSHOT_MAX_AGE_SECONDS), so
// a skipped generation can never outlive the tolerance its main consumer
// already accepts. Against the 60s lock refresh that is a floor of one forced
// republish every 10 cycles (144/day instead of 1440); against the 300s
// money-market and Omnipool refreshes, one every 2 cycles.
export const REPUBLISH_FLOOR_MS = 10 * 60_000

export interface PublishedGeneration {
  snapshotId: string
  checksum: string
  rowCount: number
  ageMs: number
}

// The generation the state pointer currently names. `rowCountColumn` differs
// per table (`row_count` / `claim_count`); it is an internal constant, never
// request input.
async function loadPublishedGeneration(
  client: ClickHouseClient,
  stateTable: string,
  rowCountColumn: string,
): Promise<PublishedGeneration | null> {
  const res = await client.query({
    query: `SELECT argMax(snapshot_id, computed_at) AS snapshot_id,
        argMax(source_checksum, computed_at) AS checksum,
        argMax(${rowCountColumn}, computed_at) AS row_count,
        dateDiff('second', max(computed_at), now()) AS age_seconds
      FROM price_data.${stateTable} WHERE snapshot_key = 'current'`,
    format: 'JSONEachRow',
  })
  const row = (await res.json<{ snapshot_id: string; checksum: string; row_count: number; age_seconds: number }>())[0]
  if (!row?.snapshot_id || !row.checksum) return null
  return {
    snapshotId: row.snapshot_id,
    checksum: row.checksum,
    rowCount: Number(row.row_count),
    ageMs: Math.max(0, Number(row.age_seconds)) * 1000,
  }
}

// Rows currently stored in the named partition, from part metadata only.
async function activePartitionRows(client: ClickHouseClient, dataTable: string, snapshotId: string): Promise<number> {
  const res = await client.query({
    query: `SELECT sum(rows) AS rows FROM system.parts
      WHERE database = 'price_data' AND table = {table:String}
        AND active AND partition = {partition:String}`,
    query_params: { table: dataTable, partition: snapshotId }, format: 'JSONEachRow',
  })
  return Number((await res.json<{ rows: string | null }>())[0]?.rows ?? 0)
}

// The decision itself, kept pure so the invariant is testable without a server:
// skip only a byte-identical generation, whose partition is intact, below the
// age floor.
export function skipDecision(
  published: PublishedGeneration | null,
  next: { checksum: string; rowCount: number },
  partitionRows: number,
  floorMs: number = REPUBLISH_FLOOR_MS,
): boolean {
  if (!published) return false
  if (published.checksum !== next.checksum) return false
  if (published.rowCount !== next.rowCount) return false
  if (partitionRows !== published.rowCount) return false
  return published.ageMs < floorMs
}

// Whether the generation about to be published is the one already published.
export async function canSkipRepublish(
  client: ClickHouseClient,
  args: { dataTable: string; stateTable: string; rowCountColumn: string; checksum: string; rowCount: number },
  floorMs: number = REPUBLISH_FLOOR_MS,
): Promise<boolean> {
  const published = await loadPublishedGeneration(client, args.stateTable, args.rowCountColumn)
  if (!published || published.checksum !== args.checksum || published.rowCount !== args.rowCount) return false
  const partitionRows = await activePartitionRows(client, args.dataTable, published.snapshotId)
  return skipDecision(published, args, partitionRows, floorMs)
}
