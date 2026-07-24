import { describe, it, expect } from 'vitest'
import { activityTailOffset, trimFinalTailPage } from '../src/utils/activityPaging'

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

// Tail 0 is the oldest window, so the last page — which holds only the remainder
// of the count — must not re-serve the rows the page before it already showed.
describe('final tail page', () => {
  const window = Array.from({ length: PAGE_SIZE }, (_, i) => `row-${i}`)

  it('keeps only the remainder of the count', () => {
    // 8752 rows, page 351: offset 8750 leaves 2 rows, which are the oldest two.
    expect(trimFinalTailPage(window, 8752, 8_750, 0)).toEqual(['row-23', 'row-24'])
  })

  it('leaves an exactly full final page untouched', () => {
    expect(trimFinalTailPage(window, 8_775, 8_750, 0)).toEqual(window)
  })

  it('leaves earlier tail pages untouched', () => {
    expect(trimFinalTailPage(window, 8752, 4_275, 4_452)).toEqual(window)
  })

  it('leaves forward-offset pages untouched', () => {
    expect(trimFinalTailPage(window, 8752, 0, undefined)).toEqual(window)
    expect(trimFinalTailPage(window, undefined, 8_750, 0)).toEqual(window)
  })

  it('empties a page past the end of the count', () => {
    expect(trimFinalTailPage(window, 8752, 8_800, 0)).toEqual([])
  })

  it('never over-trims a window shorter than the remainder', () => {
    expect(trimFinalTailPage(window.slice(0, 3), 8752, 8_740, 0)).toEqual(['row-0', 'row-1', 'row-2'])
  })
})
