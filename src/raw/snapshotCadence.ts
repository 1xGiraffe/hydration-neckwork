// How often a raw_block_snapshots row is written.
//
// Today: every block. The payload is a full re-serialization of pool + registry
// state, measured at 272,909 B (essentially constant), 15.4k rows/day, 3.61 GiB/day
// uncompressed and 114.9 MiB/day on disk — the largest table in the database and
// 36% of all ClickHouse growth, with 70.2% of blocks reusing the previous pool
// state unchanged. At a 2 s block time all of that triples.
//
// RAW_SNAPSHOT_EVERY_N_BLOCKS is the lever that holds that volume flat: keep one
// snapshot per N blocks and the table's growth divides by N. It defaults to 1
// (today's behaviour, no change) because it is NOT free — see the coupling note on
// `assertSnapshotEveryNBlocks` below.
//
// The constraint the lever must respect: three materialized views in
// clickhouse/schema/003_materialized_views.sql sample the pool state at
// `block_height % 600 = 0` — omnipool_pool_state_history_mv,
// xyk_pool_reserve_history_mv and stableswap_pool_state_history_mv
// (`grep -n 'block_height % 600' clickhouse/schema/003_materialized_views.sql`;
// deliberately not cited by line, because line numbers in that file move and this
// comment exists to be read at the NEXT cadence change). Those MVs fire on the
// snapshot row's insertion, so a grid height with no row is a permanently missing
// sample. Only divisors of 600 are therefore allowed, which is checked at startup
// rather than discovered as a hole in a pool-history chart months later.

/** The `% 600` grid the pool-history MVs sample at. Every retained cadence must divide it. */
export const MV_SNAPSHOT_GRID_BLOCKS = 600

/** Divisors of 600 — the cadences that keep every MV grid height materialized. */
export function validSnapshotCadences(): number[] {
  const divisors: number[] = []
  for (let n = 1; n <= MV_SNAPSHOT_GRID_BLOCKS; n++) {
    if (MV_SNAPSHOT_GRID_BLOCKS % n === 0) divisors.push(n)
  }
  return divisors
}

/**
 * Validate a snapshot cadence. Throws rather than falling back, because a silent
 * fallback to 1 would hide a misconfiguration that the operator set precisely to
 * control disk growth, and a silent acceptance of a non-divisor would quietly stop
 * populating the pool-history MVs.
 */
export function assertSnapshotEveryNBlocks(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`RAW_SNAPSHOT_EVERY_N_BLOCKS must be a positive integer, got ${value}`)
  }
  if (MV_SNAPSHOT_GRID_BLOCKS % value !== 0) {
    throw new Error(
      `RAW_SNAPSHOT_EVERY_N_BLOCKS=${value} does not divide the ${MV_SNAPSHOT_GRID_BLOCKS}-block pool-history MV grid; ` +
      `grid heights would stop being snapshotted. Valid values: ${validSnapshotCadences().join(', ')}`,
    )
  }
  return value
}

/** Parse the cadence from its environment variable (absent/empty → 1, today's per-block behaviour). */
export function snapshotEveryNBlocksFromEnvironment(value: string | undefined = process.env.RAW_SNAPSHOT_EVERY_N_BLOCKS): number {
  if (value == null || value === '') return 1
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`RAW_SNAPSHOT_EVERY_N_BLOCKS must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return assertSnapshotEveryNBlocks(parsed)
}

/**
 * Whether this height keeps its snapshot row. Absolute-height arithmetic, so the
 * retained set is identical across parallel range workers and across replays — a
 * per-worker counter would retain different blocks on every restart.
 */
export function retainsSnapshotAtHeight(blockHeight: number, everyNBlocks: number): boolean {
  return everyNBlocks <= 1 || blockHeight % everyNBlocks === 0
}
