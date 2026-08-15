// When the raw pipeline flushes, and why it is not simply "every SQD batch".
//
// Every batch used to end in flushAll(), which is one INSERT per non-empty table.
// A batch at chain head is ~2 blocks, so that produced ~6,550 parts per day into
// each of raw_blocks, raw_extrinsics, raw_calls, raw_events and
// raw_block_snapshots, and the merges that fold those into 3-41 GiB tables re-read
// ~128 GiB/day (uncompressed) to write ~9 GiB.
//
// ClickHouse's own answer to this, async_insert, cannot help here and is already
// enabled: async_insert=1 and wait_for_async_insert=1 are 26.3 server defaults.
// Measured over 6 hours (2026-07, at the chain's 6 s block time), the gap between
// consecutive raw_blocks INSERTs is 4.99 s at p10 and 10.02 s at the median, and not
// one gap was under 3 s — no buffer short enough to be safe can coalesce anything,
// while a buffer long enough to coalesce would be waited on by each of the ~15
// sequential inserts a flush performs, since wait_for_async_insert blocks until the
// buffer is written.
//
// That ruling survives a 6 s → 2 s block time, because the gap it measures is not a
// block-time property. raw-live follows the *finalized* head, so batches arrive on
// the relay chain's GRANDPA cadence: re-measured 2026-08-13 over 6 h, insert gaps
// were p10 4.0 s / median 8.1 s / p90 20.1 s / p99 42 s, carrying 2.1 blocks per
// flush. At 2 s the same finality burst carries ~3x the blocks, so the flush cadence
// (and with it part count and merge pressure) stays flat while rows per flush
// triple — inserts averaging 40 rows become ~120, which costs nothing.
// The pessimistic case, where head polling rather than finality gates the flush, is
// one block per 2 s: 43,200 flushes/day against today's 7,367 (5.9x), a 454 ms flush
// inside a 2 s window = 23% duty cycle, with active parts still one to two orders of
// magnitude below parts_to_delay_insert. Uncomfortable to look at, not a cliff.
// Re-measure the gap distribution after the migration before touching any of this;
// if finality cadence really did change, this comment's premise is what moved.
//
// So batching has to be explicit, and it must not trade the freshness the explorer
// reads for parts nobody is paying for at head. Hence three independent triggers,
// whichever fires first:
//
//   atChainHead      At head there is nothing to batch (one block per block time) and
//                    staleness is the only thing that matters, so flush at once.
//                    Steady state is therefore exactly what it was before.
//   reachedRangeEnd  A bounded range worker validates its range in ClickHouse right
//                    after this, so nothing may still be buffered.
//   blocks / rows /  While catching up or backfilling — where the parts actually
//   elapsedMs        pile up — accumulate up to `blocks` blocks. `rows` bounds
//                    memory in units of the existing per-INSERT chunk cap, and
//                    `elapsedMs` is a wall-clock ceiling so that if atChainHead is
//                    ever false while genuinely at head, the worst case is that
//                    much added lag rather than `blocks` x block time.
//
// The checkpoint advances only after a flush (RawDatabase.transact), so a crash
// re-indexes at most the buffered blocks. Raw ranges are replayable by construction
// and every raw table replaces on a stable key, so that costs repeated work, never
// correctness.

export interface RawFlushLimits {
  /** Blocks to accumulate per INSERT while behind head. */
  blocks: number
  /** Rows in the largest single table's buffer, in units of the per-INSERT chunk cap. */
  rows: number
  /** Wall-clock ceiling on how long rows may stay buffered. */
  elapsedMs: number
}

export interface RawFlushState {
  pendingBlocks: number
  /** Rows buffered for the single largest table, not the sum: it bounds one INSERT. */
  pendingRows: number
  msSinceLastFlush: number
  atChainHead: boolean
  reachedRangeEnd: boolean
}

export function shouldFlushRaw(state: RawFlushState, limits: RawFlushLimits): boolean {
  if (state.atChainHead || state.reachedRangeEnd) return true
  return (
    state.pendingBlocks >= limits.blocks ||
    state.pendingRows >= limits.rows ||
    state.msSinceLastFlush >= limits.elapsedMs
  )
}
