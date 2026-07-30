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
// Measured over 6 hours, the gap between consecutive raw_blocks INSERTs is 4.99 s
// at p10 and 10.02 s at the median, and not one gap was under 3 s — no buffer short
// enough to be safe can coalesce anything, while a buffer long enough to coalesce
// would be waited on by each of the ~15 sequential inserts a flush performs, since
// wait_for_async_insert blocks until the buffer is written.
//
// So batching has to be explicit, and it must not trade the freshness the explorer
// reads for parts nobody is paying for at head. Hence three independent triggers,
// whichever fires first:
//
//   atChainHead      At head there is nothing to batch (one block per ~6 s) and
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
