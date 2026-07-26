import { describe, expect, it } from 'vitest'
import { shouldFlushRaw, type RawFlushLimits, type RawFlushState } from '../../src/raw/flushPolicy.js'

const limits: RawFlushLimits = { blocks: 10, rows: 50_000, elapsedMs: 5_000 }

function state(overrides: Partial<RawFlushState> = {}): RawFlushState {
  return {
    pendingBlocks: 1,
    pendingRows: 12,
    msSinceLastFlush: 100,
    atChainHead: false,
    reachedRangeEnd: false,
    ...overrides,
  }
}

describe('shouldFlushRaw', () => {
  it('never delays a batch at chain head', () => {
    // Freshness, not part count, is what matters where the explorer reads.
    expect(shouldFlushRaw(state({ atChainHead: true }), limits)).toBe(true)
  })

  it('never delays the last batch of a bounded range', () => {
    // The range is validated in ClickHouse immediately afterwards.
    expect(shouldFlushRaw(state({ reachedRangeEnd: true }), limits)).toBe(true)
  })

  it('accumulates a small batch that is behind head', () => {
    expect(shouldFlushRaw(state({ pendingBlocks: 9, msSinceLastFlush: 900 }), limits)).toBe(false)
  })

  it('flushes once the block budget is reached', () => {
    expect(shouldFlushRaw(state({ pendingBlocks: 10 }), limits)).toBe(true)
  })

  it('flushes a single batch that already fills one INSERT', () => {
    // One SQD batch can exceed the block budget on its own; the row bound keeps the
    // buffer within the per-INSERT chunk cap rather than growing unboundedly.
    expect(shouldFlushRaw(state({ pendingBlocks: 1, pendingRows: 50_000 }), limits)).toBe(true)
  })

  it('flushes on the wall-clock ceiling regardless of how little it holds', () => {
    // Bounds the added visibility lag if the at-head signal is ever wrong.
    expect(shouldFlushRaw(state({ pendingBlocks: 1, msSinceLastFlush: 5_000 }), limits)).toBe(true)
  })

  it('treats every limit as independent', () => {
    for (const only of [{ pendingBlocks: 10 }, { pendingRows: 50_000 }, { msSinceLastFlush: 5_000 }]) {
      expect(shouldFlushRaw(state({ pendingBlocks: 0, pendingRows: 0, msSinceLastFlush: 0, ...only }), limits)).toBe(true)
    }
  })
})
