import { describe, expect, it } from 'vitest'
import { windowCoveredTo, resolveWindow } from '../src/notifications/evaluator.ts'

// The cursor is anchored on the raw ingestion head, but the activity feed a lane
// reads is keyed and built on its own head — `indexedRawHead` (all pipelines, a
// 1.5s cache, plus an SSE-published floor) rather than the evaluator's own
// `queryLiveHead` (raw-live, uncached). ClickHouse has no cross-insert ordering
// either, so `raw_ingestion_state` can name a block whose event rows are not yet
// visible.
//
// Advancing the cursor to a block the source could not have shown is a permanent
// loss: the window only moves forward. Measured live 2026-08-20 — the lane
// evaluated (13706246, 13706261], the page's newest qualifying row was still
// 13706219, and the $1,091.96 swap in block 13706258 was never seen again.
//
// So a lane advances only as far as its SOURCE has demonstrably reached.
describe('the cursor a feed-backed lane may advance to', () => {
  const window = { from: 100, to: 200 }

  it('is the whole window when the source has reached past it', () => {
    expect(windowCoveredTo(window, 250)).toBe(200)
  })

  it('stops at the source when the source lags inside the window', () => {
    // Blocks 151..200 are not visible yet: hold the cursor so they are re-read.
    expect(windowCoveredTo(window, 150)).toBe(150)
  })

  it('never regresses below the window it started from', () => {
    expect(windowCoveredTo(window, 50)).toBe(100)
    expect(windowCoveredTo(window, 0)).toBe(100)
  })

  it('leaves the clamped remainder for the next window to re-read', () => {
    const covered = windowCoveredTo(window, 150)
    const next = resolveWindow(covered, 260)

    // The blocks the source had not revealed are still above the new cursor.
    expect(next.window.from).toBe(150)
    expect(next.skipped).toBe(0)
  })
})
