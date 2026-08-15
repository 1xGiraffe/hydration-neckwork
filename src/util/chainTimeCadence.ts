// Periodic ingestion work that is *meant* to run every so often, expressed in the
// only clock that survives a block-time change: the chain's own timestamps.
//
// A block count is a block-time-dependent encoding of a duration. "every 7,200
// blocks" means 12 h only while a block is 6 s; at 2 s the same constant fires
// three times as often and triples whatever the job costs (for the money-market
// re-snapshot, an eth_call per known borrower). Reading the elapsed time off the
// blocks themselves keeps the cadence fixed through any future cadence change,
// and works identically during backfill — a historical block carries the chain
// time it was authored at, so replaying 2022 produces the same boundaries a live
// 2022 worker would have produced.
//
// Two shapes, because the two callers need different guarantees:
//
//   shouldRunOnElapsedChainTime  "at least N minutes of chain time since my last
//                                 run" — a per-worker stopwatch, the direct
//                                 translation of `height - lastHeight >= N`. Use
//                                 where the run's output is not keyed by the
//                                 height it happened at (the asset registry scan
//                                 writes changed assets, not a per-height row).
//   crossedChainTimeBoundary     "this block is the first past an absolute
//                                 chain-time boundary" — deterministic, because
//                                 it depends only on the two block timestamps and
//                                 not on where a worker started. Use where the
//                                 output IS keyed by height (money-market
//                                 positions), so parallel range workers and
//                                 replays must agree on which blocks fire.

export const MS_PER_MINUTE = 60_000

/** The 6 s cadence every legacy block-count interval in this repo was written against. */
export const LEGACY_NOMINAL_BLOCK_SECONDS = 6

/** Minutes a legacy block-count interval stood for at the cadence it was configured under. */
export function minutesForLegacyBlockInterval(
  blocks: number,
  nominalBlockSeconds: number = LEGACY_NOMINAL_BLOCK_SECONDS,
): number {
  return Math.max(1, Math.round((blocks * nominalBlockSeconds) / 60))
}

/**
 * Elapsed-chain-time stopwatch. Runs when the interval has passed since the last
 * run, and always on the first evaluation (mirroring the `lastSnapshotBlock = -1`
 * forced first scan). A block without a timestamp (only genesis carries none)
 * cannot advance the clock, so it never triggers on its own.
 */
export function shouldRunOnElapsedChainTime(
  lastRunTimestampMs: number | null,
  blockTimestampMs: number | null | undefined,
  intervalMs: number,
): boolean {
  if (lastRunTimestampMs == null) return true
  if (blockTimestampMs == null || !Number.isFinite(blockTimestampMs)) return false
  return blockTimestampMs - lastRunTimestampMs >= intervalMs
}

/**
 * Absolute chain-time grid. True when `blockTimestampMs` is the first timestamp
 * past a multiple of `intervalMs` after `previousTimestampMs` — i.e. the two
 * blocks fall in different interval buckets. Every worker that processes the same
 * consecutive pair answers the same way, so a boundary fires exactly once no
 * matter how the ranges are split, and a replay picks the same blocks.
 *
 * The one thing it cannot see is the boundary landing on a worker's *first*
 * block, where there is no previous block to compare against; that boundary is
 * skipped rather than guessed at (a guess would fire on every worker restart and
 * write position rows at heights a replay would not reproduce).
 */
export function crossedChainTimeBoundary(
  previousTimestampMs: number | null | undefined,
  blockTimestampMs: number | null | undefined,
  intervalMs: number,
): boolean {
  if (previousTimestampMs == null || blockTimestampMs == null) return false
  if (!Number.isFinite(previousTimestampMs) || !Number.isFinite(blockTimestampMs)) return false
  if (intervalMs <= 0) return false
  if (blockTimestampMs <= previousTimestampMs) return false
  return Math.floor(blockTimestampMs / intervalMs) !== Math.floor(previousTimestampMs / intervalMs)
}
