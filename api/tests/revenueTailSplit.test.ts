import { describe, expect, it } from 'vitest'
import { blocksNeedingRevenueTail } from '../src/services/explorerService.ts'

// The derivation publishes only up to an hour boundary, so the newest ~1-2h of
// blocks carry no booked revenue. Every eventful stream is a pure function of a
// single event though, so those blocks can be recomputed on demand instead of
// reading as a dash until the next partition rewrite.
//
// Which blocks that covers is the decision worth pinning: recomputing a block the
// derivation already booked is wasted work (and a second source of truth for the
// same number), so the tail is exactly the blocks above the watermark.
describe('choosing the blocks to recompute revenue for', () => {
  const rows = [
    { blockHeight: 100, extrinsicIndex: 1 },
    { blockHeight: 250, extrinsicIndex: 2 },
    { blockHeight: 300, extrinsicIndex: null },
    { blockHeight: 300, extrinsicIndex: 4 },
  ]

  it('takes only the blocks the derivation has not booked', () => {
    expect(blocksNeedingRevenueTail(rows, 200)).toEqual([250, 300])
  })

  it('deduplicates blocks that hold several rows', () => {
    expect(blocksNeedingRevenueTail(rows, 299)).toEqual([300])
  })

  it('is empty when the derivation has booked everything on the page', () => {
    expect(blocksNeedingRevenueTail(rows, 1000)).toEqual([])
  })

  it('recomputes the whole page when nothing is booked at all', () => {
    // bookedThrough 0 means the derivation has published no blocks; the page is
    // still answerable from the per-event recomputation alone.
    expect(blocksNeedingRevenueTail(rows, 0)).toEqual([100, 250, 300])
  })

  it('ignores rows with no usable block height', () => {
    expect(blocksNeedingRevenueTail([{ blockHeight: 0 }], 0)).toEqual([])
  })
})
