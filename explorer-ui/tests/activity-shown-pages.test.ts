import { describe, expect, it } from 'vitest'
import { MAX_TAIL_PAGE, PAGE_SIZE, provenPageCount, tailOffsetForPage, tailPageParam } from '../src/utils/activityPaging'

// Mirrors MAX_TAIL_ROWS, which stays private to the paging module.
const MAX_TAIL_ROWS_FOR_TEST = 4_500

// The activity count is a sum of overlapping per-category counts, so it is an upper bound
// on the feed, not its length. One live account reported 1,209 where the classified feed
// holds 646 — trades 588 + dca 584 counted for the same 613 trade rows, xcm 3 for 1,
// transfers 20 for 19, staking 5 for 4. At 25 a page that advertised 49 pages when 26
// exist, and pages 26-48 loaded empty. The pager therefore reports only what the feed has
// proven.
describe('provenPageCount', () => {
  it('claims nothing while a page is loading', () => {
    expect(provenPageCount(0, 30, true)).toBeUndefined()
    expect(provenPageCount(PAGE_SIZE, 0, true)).toBeUndefined()
  })

  it('claims nothing on a full page — the next arrow covers "there may be more"', () => {
    expect(provenPageCount(PAGE_SIZE, 0, false)).toBeUndefined()
    expect(provenPageCount(PAGE_SIZE, 10, false)).toBeUndefined()
  })

  // The live feed: offset 625 (page 25) returned 21 rows, offset 650 returned 0.
  it('ends on a page that settled short, which is proof it is the last', () => {
    expect(provenPageCount(21, 25, false)).toBe(26)
    expect(provenPageCount(1, 25, false)).toBe(26)
  })

  // An empty page proves the end is EARLIER, not that it is here: claiming `page` would
  // still advertise pages that do not exist. Landing on ?apage=48 rendered "Page 49 of 48".
  it('claims nothing on an empty page, however deep the link', () => {
    expect(provenPageCount(0, 26, false)).toBeUndefined()
    expect(provenPageCount(0, 48, false)).toBeUndefined()
    expect(provenPageCount(0, 490, false)).toBeUndefined()
  })

  it('handles a feed that fits inside one page', () => {
    expect(provenPageCount(7, 0, false)).toBe(1)
    expect(provenPageCount(0, 0, false)).toBeUndefined()
  })

  it('never depends on the untrustworthy count at all', () => {
    // Same inputs, no count argument to disagree with: the signature makes the bug
    // unrepresentable rather than merely unlikely.
    expect(provenPageCount.length).toBe(3)
  })
})

// Reaching the last page cannot depend on the row count: it overshoots the classified
// feed (one account reports 2,082 rows where the feed ends at 1,650, so a count-derived
// last page lands 18 pages past the end). Tail paging counts back from the true oldest
// row instead, where page 0 IS the last page.
describe('tail paging', () => {
  it('reads a tail page from the url', () => {
    expect(tailPageParam('0')).toBe(0)
    expect(tailPageParam('7')).toBe(7)
  })

  it('treats absent or nonsense values as "not in tail mode"', () => {
    for (const raw of [null, undefined, '', 'last', '-1', 'NaN']) expect(tailPageParam(raw), String(raw)).toBeNull()
  })

  // The API rejects a tail beyond its own window, so the url is clamped to what it serves.
  it('clamps to the servable tail window', () => {
    expect(tailPageParam('999999')).toBe(MAX_TAIL_PAGE)
    expect(MAX_TAIL_PAGE).toBe(Math.floor(MAX_TAIL_ROWS_FOR_TEST / PAGE_SIZE) - 1)
  })

  it('converts a tail page to the row offset the API takes', () => {
    expect(tailOffsetForPage(0)).toBe(0)
    expect(tailOffsetForPage(3)).toBe(3 * PAGE_SIZE)
    expect(tailOffsetForPage(-5)).toBe(0)
  })
})
