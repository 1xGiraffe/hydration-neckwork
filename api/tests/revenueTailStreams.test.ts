import { describe, expect, it } from 'vitest'
import { REVENUE_STREAMS } from '../src/services/revenueStreams.ts'
import { eventfulRevenueStreams } from '../src/services/explorerService.ts'

// The read-time tail recomputes revenue per event for blocks the hourly derivation
// has not booked. It can only do that for streams that ARE per-event: `hollar_borrow`
// is an accrual whose rows all sit at block 0, so it has no event to attach to and no
// activity row can ever carry it.
//
// A stream added to REVENUE_STREAMS and forgotten here would silently vanish from
// every live activity row while still showing up once the derivation caught up —
// revenue that appears an hour late and disagrees with itself in the meantime. So the
// split is asserted rather than assumed.
describe('the streams the read-time tail recomputes', () => {
  it('covers every stream except the accrual one', () => {
    expect(eventfulRevenueStreams()).toEqual(REVENUE_STREAMS.filter(s => s !== 'hollar_borrow'))
  })

  it('excludes hollar_borrow, which has no event behind it', () => {
    expect(eventfulRevenueStreams()).not.toContain('hollar_borrow')
  })

  it('accounts for every known stream exactly once', () => {
    const covered = [...eventfulRevenueStreams(), 'hollar_borrow']
    expect([...covered].sort()).toEqual([...REVENUE_STREAMS].sort())
  })
})
