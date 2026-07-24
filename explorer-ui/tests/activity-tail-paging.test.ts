import { describe, it, expect } from 'vitest'
import { activityTailOffset } from '../src/utils/activityPaging'

const PAGE_SIZE = 25

// Account/tag activity pages past the forward window are served from the oldest
// end. The API's tail builder walks `tail + limit` classified rows out of a
// bounded candidate budget and rejects anything deeper, so a UI that offers a
// wider tail window turns whole bands of pages into guaranteed failures.
describe('activity tail offset', () => {
  it('keeps shallow pages on forward offsets', () => {
    expect(activityTailOffset(8752, 0)).toBeUndefined()
    expect(activityTailOffset(8752, 1_950)).toBeUndefined()
  })

  it('pages deep windows from the oldest end', () => {
    expect(activityTailOffset(4_600, 2_000)).toBe(4_600 - 2_000 - PAGE_SIZE)
  })

  it('stays inside the API tail budget', () => {
    // 8752 rows, page 111: a tail of 5952 is beyond what the API can serve, so
    // the page falls back to its forward offset rather than failing.
    expect(activityTailOffset(8752, 2_775)).toBeUndefined()
    // The deepest servable tail: tail + limit == the budget.
    expect(activityTailOffset(8752, 8752 - 4_500)).toBe(4_475)
    // One row shallower is over budget again.
    expect(activityTailOffset(8752, 8752 - 4_501)).toBeUndefined()
  })

  it('clamps the final page to the oldest window', () => {
    expect(activityTailOffset(8752, 8_750)).toBe(0)
  })

  it('has no tail without a known row count', () => {
    expect(activityTailOffset(null, 5_000)).toBeUndefined()
    expect(activityTailOffset(undefined, 5_000)).toBeUndefined()
  })
})
