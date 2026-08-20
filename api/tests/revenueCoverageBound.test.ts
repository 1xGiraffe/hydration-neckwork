import { describe, expect, it } from 'vitest'
import { revenueCoverageThrough } from '../src/services/explorerService.ts'

// The activity feed leads the event table: page 0 prepends unfinalized rows, and
// raw_ingestion_state names a block before its event rows are queryable. Revenue is
// recomputed from those event rows, so a block the feed can show but the events have
// not reached yields no rows at all — indistinguishable, downstream, from an
// extrinsic that genuinely earned nothing.
//
// Reporting $0.00 there would be a confident wrong number on the newest and most-read
// rows of the page. So coverage never claims more than the events actually show.
describe('how far a page may claim revenue coverage', () => {
  it('covers the recomputed blocks when the events are all visible', () => {
    expect(revenueCoverageThrough(1000, [1200, 1300], 1400)).toBe(1300)
  })

  it('stops at the visible event head when the feed runs ahead of it', () => {
    // 1300 was shown by the feed but its events are not queryable yet.
    expect(revenueCoverageThrough(1000, [1200, 1300], 1250)).toBe(1250)
  })

  it('never regresses below what the derivation already booked', () => {
    // A lagging or empty event head cannot retract booked revenue.
    expect(revenueCoverageThrough(1000, [1200], 500)).toBe(1000)
    expect(revenueCoverageThrough(1000, [1200], 0)).toBe(1000)
  })

  it('is the booked watermark when there is nothing to recompute', () => {
    expect(revenueCoverageThrough(1000, [], 1400)).toBe(1000)
  })
})
